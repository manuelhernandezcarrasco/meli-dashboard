import { Prisma } from "../../../generated/prisma";
import type {
  Gtins,
  Order,
  PaymentTaxes,
  ShipCosts,
  TaxMap,
} from "~/lib/contracts";
import { db } from "~/server/db";
import type { DataSource } from "~/server/datasource/types";

const DAY_MS = 86_400_000;
const CHUNK = 500;
const TAX_BATCH = 20;
const MAX_TAX_FAILURES = 5;

export interface Enriched {
  shipCosts: ShipCosts;
  gtins: Gtins;
  taxes: TaxMap;
}

type Log = (msg: string) => void;

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
/** Whole days elapsed, like Python's `(now - created).days`. */
const ageDays = (iso: string, now: Date) =>
  Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS);

async function readCache(ownerId: string, keys: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const part of chunks(keys, 5000)) {
    const rows = await db.apiCache.findMany({ where: { ownerId, key: { in: part } } });
    for (const r of rows) out.set(r.key, r.value);
  }
  return out;
}

async function writeCache(ownerId: string, entries: [string, unknown][]): Promise<void> {
  for (const part of chunks(entries, CHUNK)) {
    await db.$transaction(
      part.map(([key, value]) => {
        const v = (value === null ? Prisma.JsonNull : value) as Prisma.InputJsonValue;
        return db.apiCache.upsert({
          where: { ownerId_key: { ownerId, key } },
          create: { ownerId, key, value: v },
          update: { value: v },
        });
      }),
    );
  }
}

/** Port of `enrich` (legacy 1167–1212) on top of the `ApiCache` table. */
export async function enrich(
  ownerId: string,
  ds: DataSource,
  orders: Order[],
  now: Date,
  log: Log = () => undefined,
): Promise<Enriched> {
  // --- shipment costs: cached per id; re-fetched while the order is < 3 days old
  const paid = orders.filter((o) => o.status === "paid");
  const shipKeys = uniq(
    paid.filter((o) => o.shippingId).map((o) => `ship3:${o.shippingId}`),
  );
  const shipCache = await readCache(ownerId, shipKeys);
  const needShip = uniq(
    paid
      .filter(
        (o) =>
          o.shippingId &&
          (!shipCache.has(`ship3:${o.shippingId}`) || ageDays(o.dateCreated, now) < 3),
      )
      .map((o) => String(o.shippingId)),
  );
  if (needShip.length) {
    log(`Consultando costo de envío de ${needShip.length} envíos…`);
    const got = await ds.getShipmentCosts(needShip);
    const entries: [string, unknown][] = Object.entries(got).map(([id, c]) => [`ship3:${id}`, c]);
    await writeCache(ownerId, entries);
    for (const [k, v] of entries) shipCache.set(k, v);
  }
  const shipCosts: ShipCosts = {};
  for (const [k, v] of shipCache) shipCosts[k.slice(6)] = v as number;

  // --- GTINs: cached per item id (all orders, like Python)
  const itemIds = uniq(
    orders.flatMap((o) => o.items.map((i) => i.itemId.toUpperCase())).filter(Boolean),
  );
  const gtinCache = await readCache(ownerId, itemIds.map((i) => `gtin:${i}`));
  const missing = itemIds.filter((i) => !gtinCache.has(`gtin:${i}`));
  if (missing.length) {
    const got = await ds.getGtins(missing);
    const entries: [string, unknown][] = Object.entries(got).map(([id, g]) => [`gtin:${id}`, g]);
    await writeCache(ownerId, entries);
    for (const [k, v] of entries) gtinCache.set(k, v);
  }
  const gtins: Gtins = {};
  for (const [k, v] of gtinCache) gtins[k.slice(5)] = v as Record<string, string>;

  // --- payment taxes: cached per payment; re-fetched if null or order < 2 days old
  const pays = paid.flatMap((o) =>
    o.payments
      .filter((p) => p.status === "approved")
      .map((p) => ({ id: String(p.id), fresh: ageDays(o.dateCreated, now) < 2 })),
  );
  const taxCache = await readCache(ownerId, uniq(pays.map((p) => `tax:${p.id}`)));
  const pend = uniq(
    pays
      .filter((p) => {
        const c = taxCache.get(`tax:${p.id}`) as PaymentTaxes | null | undefined;
        // entries cached before the financing split lack `financing`: refetch once
        return p.fresh || (c ?? null) === null || c?.financing === undefined;
      })
      .map((p) => p.id),
  );
  if (pend.length) {
    log(`Consultando impuestos de ${pend.length} pagos en Mercado Pago…`);
    let failures = 0;
    for (const batch of chunks(pend, TAX_BATCH)) {
      let got: Record<string, PaymentTaxes | null>;
      try {
        got = await ds.getPaymentTaxes(batch);
      } catch (e) {
        failures++;
        if (failures === 1) {
          log(
            `Aviso: no pude leer pagos de Mercado Pago (${String((e as Error).message).slice(0, 120)}); uso el % estimado`,
          );
        }
        // keep what we had; payments never seen stay null
        const entries: [string, unknown][] = batch
          .filter((id) => !taxCache.has(`tax:${id}`))
          .map((id) => [`tax:${id}`, null]);
        await writeCache(ownerId, entries);
        for (const [k, v] of entries) taxCache.set(k, v);
        if (failures >= MAX_TAX_FAILURES) {
          log("Aviso: demasiados errores en Mercado Pago; dejo de consultar impuestos en esta corrida");
          break;
        }
        continue;
      }
      const entries: [string, unknown][] = batch.map((id) => [`tax:${id}`, got[id] ?? null]);
      await writeCache(ownerId, entries);
      for (const [k, v] of entries) taxCache.set(k, v);
    }
  }
  const taxes: TaxMap = {};
  for (const [k, v] of taxCache) if (v !== null && v !== undefined) taxes[k.slice(4)] = v as PaymentTaxes;

  return { shipCosts, gtins, taxes };
}

/**
 * Port of `fetch_month` (legacy 1152–1164). The current month is never cached; a closed
 * month is cached and re-downloaded only during days 1–5 of the following month.
 */
export async function fetchMonth(
  ownerId: string,
  ds: DataSource,
  y: number,
  m: number,
  closed: boolean,
  todayDay: number,
): Promise<Order[]> {
  if (!closed) return ds.getOrdersMonth(y, m);
  const key = `orders:${y}-${String(m).padStart(2, "0")}`;
  const hit = await db.apiCache.findUnique({ where: { ownerId_key: { ownerId, key } } });
  const cached = hit?.value as { orders: Order[]; final: boolean } | undefined;
  if (cached?.final) return cached.orders;
  const orders = await ds.getOrdersMonth(y, m);
  await writeCache(ownerId, [[key, { orders, final: todayDay > 5 }]]);
  return orders;
}
