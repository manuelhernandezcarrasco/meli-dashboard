import type { Gtins, Order, PaymentTaxes, ShipCosts, TaxMap } from "~/lib/contracts";
import type { DataSource } from "~/server/datasource/types";
import { CATALOG_RECHECK_MS, readListings, saveCatalogIds, saveGtins } from "~/server/store/listings";
import { isPeriodFinal, loadOrdersMonth, markPeriod, saveOrders } from "~/server/store/orders";
import { readPaymentTaxes, savePaymentTaxes } from "~/server/store/payments";
import { readShipments, saveShipmentCosts } from "~/server/store/shipments";

const DAY_MS = 86_400_000;
const TAX_BATCH = 20;
const MAX_TAX_FAILURES = 5;
/** A payment Mercado Pago had no tax detail for is asked again after this long (or while the order is fresh). */
const NO_DETAIL_RECHECK_MS = 6 * 3_600_000;

export interface Enriched {
  shipCosts: ShipCosts;
  gtins: Gtins;
  taxes: TaxMap;
  /** itemId -> catalog_product_id (null: the listing has no catalog product). */
  catalogIds: Record<string, string | null>;
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
const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Port of `enrich` (legacy 1167–1212) on top of the typed tables: what was already fetched is read
 * from Shipment / Listing / Payment (one indexed query each), only the missing or stale part is
 * asked to Mercado Libre / Mercado Pago, and the answers are bulk-upserted.
 */
export async function enrich(
  ownerId: string,
  ds: DataSource,
  orders: Order[],
  now: Date,
  log: Log = () => undefined,
): Promise<Enriched> {
  // --- shipment costs: stored per shipment; re-fetched while the order is < 3 days old
  const paid = orders.filter((o) => o.status === "paid");
  const mp = ds.marketplace;
  const shipIds = uniq(paid.filter((o) => o.shippingId).map((o) => String(o.shippingId)));
  const ships = await readShipments(ownerId, mp, shipIds);
  const needShip = uniq(
    paid
      .filter((o) => o.shippingId && (!ships.get(String(o.shippingId))?.fetchedAt || ageDays(o.dateCreated, now) < 3))
      .map((o) => String(o.shippingId)),
  );
  if (needShip.length) {
    log(`Consultando costo de envío de ${needShip.length} envíos…`);
    const got = await ds.getShipmentCosts(needShip);
    await saveShipmentCosts(ownerId, mp, got, now);
    for (const [id, cost] of Object.entries(got)) ships.set(id, { cost, fetchedAt: now });
  }
  const shipCosts: ShipCosts = {};
  for (const [id, s] of ships) if (s.fetchedAt && s.cost !== null) shipCosts[id] = s.cost;

  // --- GTINs: stored per listing (all orders, like Python)
  const itemIds = uniq(orders.flatMap((o) => o.items.map((i) => i.itemId.toUpperCase())).filter(Boolean));
  const listings = await readListings(ownerId, mp, itemIds);
  const missing = itemIds.filter((i) => !listings.get(i)?.gtinCheckedAt);
  if (missing.length) {
    const got = await ds.getGtins(missing);
    await saveGtins(ownerId, mp, got, now);
    for (const [id, g] of Object.entries(got)) {
      const prev = listings.get(id.toUpperCase());
      listings.set(id.toUpperCase(), {
        gtinCheckedAt: now,
        gtins: g,
        catalogProductId: prev?.catalogProductId ?? null,
        catalogCheckedAt: prev?.catalogCheckedAt ?? null,
      });
    }
  }
  const gtins: Gtins = {};
  for (const [id, l] of listings) if (l.gtinCheckedAt) gtins[id] = l.gtins;

  // --- catalog ids: stored on the listing (the market search reads the same column). A listing
  // with no catalog product is asked again after CATALOG_RECHECK_MS (it can get linked later); a
  // listing ML did not answer for is asked again next time. A failure here never breaks the sync.
  const catalogIds: Record<string, string | null> = {};
  const needCat: string[] = [];
  for (const i of itemIds) {
    const st = listings.get(i);
    catalogIds[i] = st?.catalogProductId ?? null;
    if (!st?.catalogProductId && (!st?.catalogCheckedAt || now.getTime() - st.catalogCheckedAt.getTime() >= CATALOG_RECHECK_MS)) {
      needCat.push(i);
    }
  }
  if (needCat.length) {
    try {
      const got = await ds.getCatalogIds(needCat);
      const found: Record<string, string | null> = {};
      for (const i of needCat) {
        if (!(i in got)) continue; // not returned (e.g. ML error): try again next time
        catalogIds[i] = got[i] ?? null;
        found[i] = catalogIds[i]!;
      }
      await saveCatalogIds(ownerId, mp, found, now);
    } catch (e) {
      log(`Aviso: no pude leer los catálogos de ML (${String((e as Error).message).slice(0, 120)})`);
    }
  }

  // --- payment taxes: stored per payment; re-fetched if never asked, if the order is < 2 days old,
  // if the entry predates the financing split, or if "no detail" is older than NO_DETAIL_RECHECK_MS
  const pays = paid.flatMap((o) =>
    o.payments
      .filter((p) => p.status === "approved")
      .map((p) => ({ id: String(p.id), fresh: ageDays(o.dateCreated, now) < 2 })),
  );
  const taxState = await readPaymentTaxes(ownerId, mp, uniq(pays.map((p) => p.id)));
  const pend = uniq(
    pays
      .filter((p) => {
        const st = taxState.get(p.id);
        if (p.fresh || !st?.fetchedAt || st.legacyNoFinancing) return true;
        return st.taxes === null && now.getTime() - st.fetchedAt.getTime() >= NO_DETAIL_RECHECK_MS;
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
        // keep what we had; payments never seen stay without detail
        if (failures >= MAX_TAX_FAILURES) {
          log("Aviso: demasiados errores en Mercado Pago; dejo de consultar impuestos en esta corrida");
          break;
        }
        continue;
      }
      const entries: [string, PaymentTaxes | null][] = batch.map((id) => [id, got[id] ?? null]);
      await savePaymentTaxes(ownerId, mp, entries, now);
      for (const [id, t] of entries) taxState.set(id, { fetchedAt: now, taxes: t, legacyNoFinancing: false });
    }
  }
  const taxes: TaxMap = {};
  for (const p of pays) {
    const t = taxState.get(p.id)?.taxes;
    if (t) taxes[p.id] = t;
  }

  return { shipCosts, gtins, taxes, catalogIds };
}

/**
 * Port of `fetch_month` (legacy 1152–1164). The current month is always downloaded; a closed month
 * is read from the Order tables once it is final and re-downloaded only during days 1–5 of the
 * following month (late cancellations / payments). Every download is persisted.
 */
export async function fetchMonth(
  ownerId: string,
  ds: DataSource,
  y: number,
  m: number,
  closed: boolean,
  todayDay: number,
): Promise<Order[]> {
  const month = `${y}-${p2(m)}`;
  if (closed && (await isPeriodFinal(ownerId, ds.marketplace, month))) {
    return loadOrdersMonth(ownerId, ds.marketplace, y, m);
  }
  const orders = await ds.getOrdersMonth(y, m);
  await saveOrders(ownerId, ds.marketplace, orders);
  await markPeriod(ownerId, ds.marketplace, month, closed && todayDay > 5, orders.length);
  return orders;
}
