import { db } from "~/server/db";
import { BATCH, chunks, ensureAccount, txt } from "./bulk";
import type { Marketplace } from "./marketplace";

export interface ShipmentState {
  /** Net cost for the seller (negative = credited); null while never fetched. */
  cost: number | null;
  fetchedAt: Date | null;
}

/** Cost state of the given shipments (ids that are unknown simply do not appear). */
export async function readShipments(ownerId: string, mp: Marketplace, shippingIds: string[]): Promise<Map<string, ShipmentState>> {
  const out = new Map<string, ShipmentState>();
  for (const part of chunks(shippingIds, 20_000)) {
    const rows = await db.$queryRaw<{ id: string; cost: number | null; fetched: Date | null }[]>`
      SELECT "shippingId"::text AS id, "sellerCost"::float8 AS cost, "costFetchedAt" AS fetched
      FROM "Shipment"
      WHERE "accountId" = ${ownerId} AND "marketplace" = ${mp}::"Marketplace" AND "shippingId" = ANY(${part}::text[]::bigint[])`;
    for (const r of rows) out.set(r.id, { cost: r.cost, fetchedAt: r.fetched });
  }
  return out;
}

/** Stores the seller cost of each shipment and marks it as fetched at `at` (the sync's clock). */
export async function saveShipmentCosts(
  ownerId: string,
  mp: Marketplace,
  costs: Record<string, number>,
  at: Date = new Date(),
): Promise<void> {
  const entries = Object.entries(costs).sort(([a], [b]) => Number(a) - Number(b));
  if (!entries.length) return;
  await ensureAccount(ownerId);
  for (const part of chunks(entries, BATCH)) {
    await db.$executeRaw`
      INSERT INTO "Shipment" ("accountId", "marketplace", "shippingId", "sellerCost", "costFetchedAt")
      SELECT ${ownerId}, ${mp}::"Marketplace", t.id::bigint, t.cost::numeric, ${at.toISOString()}::timestamptz
      FROM unnest(${part.map(([id]) => id)}::text[], ${txt(part.map(([, c]) => c))}::text[]) AS t(id, cost)
      ON CONFLICT ("accountId", "marketplace", "shippingId") DO UPDATE
        SET "sellerCost" = EXCLUDED."sellerCost", "costFetchedAt" = EXCLUDED."costFetchedAt"`;
  }
}
