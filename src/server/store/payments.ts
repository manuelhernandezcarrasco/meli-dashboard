import type { PaymentTaxes } from "~/lib/contracts";
import { db } from "~/server/db";
import { BATCH, chunks, ensureAccount, txt } from "./bulk";
import type { Marketplace } from "./marketplace";

export interface PaymentTaxState {
  /** null = never asked. */
  fetchedAt: Date | null;
  /** null = asked, Mercado Pago has no detail (or never asked). */
  taxes: PaymentTaxes | null;
  /** Cached before the financing split (total known, financing not): ask again once. */
  legacyNoFinancing: boolean;
}

interface Row {
  id: string;
  total: number | null;
  financing: number | null;
  fetched: Date | null;
  det: Record<string, number>;
}

/** Tax state of the given payments (ids unknown to the table simply do not appear). */
export async function readPaymentTaxes(ownerId: string, mp: Marketplace, paymentIds: string[]): Promise<Map<string, PaymentTaxState>> {
  const out = new Map<string, PaymentTaxState>();
  for (const part of chunks(paymentIds, 20_000)) {
    const rows = await db.$queryRaw<Row[]>`
      SELECT p."paymentId"::text AS id, p."taxTotal"::float8 AS total, p."financingFee"::float8 AS financing,
             p."taxFetchedAt" AS fetched,
             COALESCE(jsonb_object_agg(t."name", t."amount"::float8) FILTER (WHERE t."name" IS NOT NULL), '{}'::jsonb) AS det
      FROM "Payment" p
      LEFT JOIN "PaymentTax" t ON t."accountId" = p."accountId" AND t."marketplace" = p."marketplace" AND t."paymentId" = p."paymentId"
      WHERE p."accountId" = ${ownerId} AND p."marketplace" = ${mp}::"Marketplace" AND p."paymentId" = ANY(${part}::text[]::bigint[])
      GROUP BY p."accountId", p."marketplace", p."paymentId"`;
    for (const r of rows) {
      out.set(r.id, {
        fetchedAt: r.fetched,
        taxes:
          r.total === null
            ? null
            : { total: r.total, det: r.det, ...(r.financing === null ? {} : { financing: r.financing }) },
        legacyNoFinancing: r.total !== null && r.financing === null,
      });
    }
  }
  return out;
}

/** Stores what Mercado Pago answered per payment (null = no detail) and marks them as fetched at `at` (the sync's clock). */
export async function savePaymentTaxes(
  ownerId: string,
  mp: Marketplace,
  entries: [string, PaymentTaxes | null][],
  at: Date = new Date(),
): Promise<void> {
  if (!entries.length) return;
  await ensureAccount(ownerId);
  const sorted = [...entries].sort(([a], [b]) => Number(a) - Number(b));
  for (const part of chunks(sorted, BATCH)) {
    const ids = part.map(([id]) => id);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "Payment" ("accountId", "marketplace", "paymentId", "taxTotal", "financingFee", "taxFetchedAt")
        SELECT ${ownerId}, ${mp}::"Marketplace", t.id::bigint, t.total::numeric, t.fin::numeric, ${at.toISOString()}::timestamptz
        FROM unnest(${ids}::text[], ${txt(part.map(([, t]) => t?.total))}::text[],
                    ${txt(part.map(([, t]) => (t ? (t.financing ?? 0) : null)))}::text[]) AS t(id, total, fin)
        ON CONFLICT ("accountId", "marketplace", "paymentId") DO UPDATE
          SET "taxTotal" = EXCLUDED."taxTotal", "financingFee" = EXCLUDED."financingFee",
              "taxFetchedAt" = EXCLUDED."taxFetchedAt"`;
      await tx.$executeRaw`
        DELETE FROM "PaymentTax" WHERE "accountId" = ${ownerId} AND "marketplace" = ${mp}::"Marketplace" AND "paymentId" = ANY(${ids}::text[]::bigint[])`;
      const lines = part.flatMap(([id, t]) => Object.entries(t?.det ?? {}).map(([name, amount]) => ({ id, name, amount })));
      for (const l of chunks(lines, BATCH)) {
        await tx.$executeRaw`
          INSERT INTO "PaymentTax" ("accountId", "marketplace", "paymentId", "name", "amount")
          SELECT ${ownerId}, ${mp}::"Marketplace", t.id::bigint, t.name, t.amount::numeric
          FROM unnest(${l.map((x) => x.id)}::text[], ${l.map((x) => x.name)}::text[], ${txt(l.map((x) => x.amount))}::text[])
               AS t(id, name, amount)
          ON CONFLICT DO NOTHING`;
      }
    });
  }
}
