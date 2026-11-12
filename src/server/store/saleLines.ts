import type { Line } from "~/lib/contracts";
import { db } from "~/server/db";
import { chunks, ensureAccount } from "./bulk";
import type { Marketplace } from "./marketplace";

/**
 * Replaces the economics lines of one month (`period` = "YYYY-MM") with the ones just computed.
 * Derived data: always rebuildable from orders, uploads and decisions.
 */
export async function replaceSaleLines(ownerId: string, mp: Marketplace, period: string, lines: Line[]): Promise<void> {
  await ensureAccount(ownerId);
  const rows = lines.map((l, i) => ({
    accountId: ownerId,
    period,
    lineNo: i,
    saleDate: new Date(`${l.date}T00:00:00.000Z`),
    saleTime: l.time,
    marketplace: l.channel === "ML" ? mp : null,
    channel: l.channel === "ML" ? ("marketplace" as const) : ("direct" as const),
    orderRef: l.order,
    itemId: l.itemId || null,
    sku: l.sku || null,
    ean: l.ean || null,
    matchVia: l.matchVia,
    matchScore: l.matchScore ?? null,
    suggestedEan: l.suggestEan ?? null,
    description: l.desc,
    listingTitle: l.titleMl || null,
    category: l.cat,
    quantity: l.qty,
    unitPrice: l.pu,
    revenue: l.venta,
    saleFee: l.cargoVenta,
    financingFee: l.cuotas,
    shippingCost: l.envio,
    taxAmount: l.impEst,
    marketplaceCost: l.costoMl,
    unitCost: l.cu,
    cogs: l.qty * l.cu,
    costSource: l.costSource,
    taxSource: l.taxSource,
    taxDetail: l.taxDetail || null,
  }));
  await db.$transaction([
    db.saleLine.deleteMany({ where: { accountId: ownerId, period } }),
    ...chunks(rows, 500).map((data) => db.saleLine.createMany({ data })),
  ]);
}
