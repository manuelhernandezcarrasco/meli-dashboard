import type { Order } from "~/lib/contracts";
import { monthRangeArg, toArgIso } from "~/lib/dates";
import { normalizeText } from "~/lib/normalize";
import { db } from "~/server/db";
import { BATCH, chunks, ensureAccount, txt, type Db } from "./bulk";
import type { Marketplace } from "./marketplace";

/**
 * Orders live in Order / OrderItem / OrderPayment (with Listing, Shipment and Payment stubs as
 * their parents). Every write is an idempotent bulk upsert that skips rows that did not change, so
 * persisting the whole current month on each sync costs reads, not rewrites.
 */
export async function saveOrders(ownerId: string, mp: Marketplace, orders: Order[]): Promise<void> {
  if (!orders.length) return;
  await ensureAccount(ownerId);
  for (const part of chunks(orders, 1000)) {
    await db.$transaction((tx) => writeChunk(tx, ownerId, mp, part), { timeout: 120_000 });
  }
}

async function writeChunk(tx: Db, ownerId: string, mp: Marketplace, orders: Order[]): Promise<void> {
  // Sorted so concurrent writers (sync + rebuild) take row locks in the same order.
  const sorted = [...orders].sort((a, b) => a.id - b.id);

  // 1. parents: listings and shipments referenced by the orders
  const titles = new Map<string, string>();
  for (const o of sorted) {
    for (const it of o.items) {
      const id = it.itemId.toUpperCase();
      if (!titles.has(id)) titles.set(id, it.title);
    }
  }
  const itemIds = [...titles.keys()].sort();
  if (itemIds.length) {
    await tx.$executeRaw`
      INSERT INTO "Listing" ("accountId", "marketplace", "itemId", "title", "searchText")
      SELECT ${ownerId}, ${mp}::"Marketplace", t.id, t.title, t.search
      FROM unnest(${itemIds}::text[], ${itemIds.map((i) => titles.get(i)!)}::text[],
                  ${itemIds.map((i) => normalizeText(titles.get(i)!))}::text[]) AS t(id, title, search)
      ON CONFLICT ("accountId", "marketplace", "itemId") DO UPDATE
        SET "title" = EXCLUDED."title", "searchText" = EXCLUDED."searchText", "updatedAt" = now()
        WHERE "Listing"."title" IS NULL`;
  }
  const shippingIds = [...new Set(sorted.flatMap((o) => (o.shippingId ? [o.shippingId] : [])))].sort((a, b) => a - b);
  if (shippingIds.length) {
    await tx.$executeRaw`
      INSERT INTO "Shipment" ("accountId", "marketplace", "shippingId")
      SELECT ${ownerId}, ${mp}::"Marketplace", s::bigint FROM unnest(${txt(shippingIds)}::text[]) AS s
      ON CONFLICT DO NOTHING`;
  }
  const paymentIds = [...new Set(sorted.flatMap((o) => o.payments.map((p) => p.id)))].sort((a, b) => a - b);
  if (paymentIds.length) {
    await tx.$executeRaw`
      INSERT INTO "Payment" ("accountId", "marketplace", "paymentId")
      SELECT ${ownerId}, ${mp}::"Marketplace", p::bigint FROM unnest(${txt(paymentIds)}::text[]) AS p
      ON CONFLICT DO NOTHING`;
  }

  // 2. orders
  await tx.$executeRaw`
    INSERT INTO "Order" ("accountId", "marketplace", "orderId", "packId", "status", "createdAt", "shippingId")
    SELECT ${ownerId}, ${mp}::"Marketplace", t.id::bigint, t.pack::bigint, t.status, t.created::timestamptz, t.ship::bigint
    FROM unnest(${txt(sorted.map((o) => o.id))}::text[], ${txt(sorted.map((o) => o.packId))}::text[],
                ${sorted.map((o) => o.status)}::text[], ${sorted.map((o) => o.dateCreated)}::text[],
                ${txt(sorted.map((o) => o.shippingId))}::text[]) AS t(id, pack, status, created, ship)
    ON CONFLICT ("accountId", "marketplace", "orderId") DO UPDATE
      SET "packId" = EXCLUDED."packId", "status" = EXCLUDED."status", "createdAt" = EXCLUDED."createdAt",
          "shippingId" = EXCLUDED."shippingId", "updatedAt" = now()
      WHERE ("Order"."packId", "Order"."status", "Order"."createdAt", "Order"."shippingId")
            IS DISTINCT FROM (EXCLUDED."packId", EXCLUDED."status", EXCLUDED."createdAt", EXCLUDED."shippingId")`;

  // 3. order items
  const items = sorted.flatMap((o) => o.items.map((it, i) => ({ o, it, line: i })));
  for (const part of chunks(items, BATCH)) {
    await tx.$executeRaw`
      INSERT INTO "OrderItem" ("accountId", "marketplace", "orderId", "lineNo", "itemId", "title", "sellerSku",
                               "sellerCustomField", "variationId", "quantity", "unitPrice", "saleFee")
      SELECT ${ownerId}, ${mp}::"Marketplace", t.oid::bigint, t.line::int, t.item, t.title, t.sku, t.cf, t.var::bigint,
             round(t.qty::numeric)::int, t.price::numeric, t.fee::numeric
      FROM unnest(${txt(part.map((x) => x.o.id))}::text[], ${txt(part.map((x) => x.line))}::text[],
                  ${part.map((x) => x.it.itemId.toUpperCase())}::text[], ${part.map((x) => x.it.title)}::text[],
                  ${txt(part.map((x) => x.it.sellerSku))}::text[], ${txt(part.map((x) => x.it.sellerCustomField))}::text[],
                  ${txt(part.map((x) => x.it.variationId))}::text[], ${txt(part.map((x) => x.it.quantity))}::text[],
                  ${txt(part.map((x) => x.it.unitPrice))}::text[], ${txt(part.map((x) => x.it.saleFee))}::text[])
           AS t(oid, line, item, title, sku, cf, var, qty, price, fee)
      ON CONFLICT ("accountId", "marketplace", "orderId", "lineNo") DO UPDATE
        SET "itemId" = EXCLUDED."itemId", "title" = EXCLUDED."title", "sellerSku" = EXCLUDED."sellerSku",
            "sellerCustomField" = EXCLUDED."sellerCustomField", "variationId" = EXCLUDED."variationId",
            "quantity" = EXCLUDED."quantity", "unitPrice" = EXCLUDED."unitPrice", "saleFee" = EXCLUDED."saleFee"
        WHERE ("OrderItem"."itemId", "OrderItem"."title", "OrderItem"."sellerSku", "OrderItem"."sellerCustomField",
               "OrderItem"."variationId", "OrderItem"."quantity", "OrderItem"."unitPrice", "OrderItem"."saleFee")
              IS DISTINCT FROM (EXCLUDED."itemId", EXCLUDED."title", EXCLUDED."sellerSku", EXCLUDED."sellerCustomField",
                                EXCLUDED."variationId", EXCLUDED."quantity", EXCLUDED."unitPrice", EXCLUDED."saleFee")`;
  }
  // an order that now has fewer lines than stored: drop the extra ones
  await tx.$executeRaw`
    DELETE FROM "OrderItem" i
    USING unnest(${txt(sorted.map((o) => o.id))}::text[], ${txt(sorted.map((o) => o.items.length))}::text[]) AS t(oid, n)
    WHERE i."accountId" = ${ownerId} AND i."marketplace" = ${mp}::"Marketplace" AND i."orderId" = t.oid::bigint AND i."lineNo" >= t.n::int`;

  // 4. order <-> payment links
  const links = new Map<string, { o: number; p: number; status: string }>();
  for (const o of sorted) for (const p of o.payments) links.set(`${o.id}:${p.id}`, { o: o.id, p: p.id, status: p.status });
  const linkList = [...links.values()];
  for (const part of chunks(linkList, BATCH)) {
    await tx.$executeRaw`
      INSERT INTO "OrderPayment" ("accountId", "marketplace", "orderId", "paymentId", "status")
      SELECT ${ownerId}, ${mp}::"Marketplace", t.oid::bigint, t.pid::bigint, t.status
      FROM unnest(${txt(part.map((x) => x.o))}::text[], ${txt(part.map((x) => x.p))}::text[],
                  ${part.map((x) => x.status)}::text[]) AS t(oid, pid, status)
      ON CONFLICT ("accountId", "marketplace", "orderId", "paymentId") DO UPDATE SET "status" = EXCLUDED."status"
      WHERE "OrderPayment"."status" IS DISTINCT FROM EXCLUDED."status"`;
  }
  await tx.$executeRaw`
    DELETE FROM "OrderPayment" op
    WHERE op."accountId" = ${ownerId} AND op."marketplace" = ${mp}::"Marketplace" AND op."orderId" = ANY(${txt(sorted.map((o) => o.id))}::text[]::bigint[])
      AND NOT EXISTS (
        SELECT 1 FROM unnest(${txt(linkList.map((x) => x.o))}::text[], ${txt(linkList.map((x) => x.p))}::text[]) AS t(oid, pid)
        WHERE t.oid::bigint = op."orderId" AND t.pid::bigint = op."paymentId")`;
}

/** Orders created in Argentine month (y, m), in the shape the calculation expects. */
export async function loadOrdersMonth(ownerId: string, mp: Marketplace, y: number, m: number): Promise<Order[]> {
  const { start, end } = monthRangeArg(y, m);
  const range = { gte: start, lt: end };
  const [orders, items, pays] = await Promise.all([
    db.order.findMany({
      where: { accountId: ownerId, marketplace: mp, createdAt: range },
      orderBy: [{ createdAt: "asc" }, { orderId: "asc" }],
    }),
    db.orderItem.findMany({
      where: { accountId: ownerId, marketplace: mp, order: { createdAt: range } },
      orderBy: [{ orderId: "asc" }, { lineNo: "asc" }],
    }),
    db.orderPayment.findMany({
      where: { accountId: ownerId, marketplace: mp, order: { createdAt: range } },
      orderBy: [{ orderId: "asc" }, { paymentId: "asc" }],
    }),
  ]);
  const itemsBy = new Map<bigint, Order["items"]>();
  for (const i of items) {
    const list = itemsBy.get(i.orderId) ?? [];
    list.push({
      itemId: i.itemId,
      title: i.title,
      sellerSku: i.sellerSku,
      sellerCustomField: i.sellerCustomField,
      variationId: i.variationId === null ? null : Number(i.variationId),
      quantity: i.quantity,
      unitPrice: i.unitPrice.toNumber(),
      saleFee: i.saleFee.toNumber(),
    });
    itemsBy.set(i.orderId, list);
  }
  const paysBy = new Map<bigint, Order["payments"]>();
  for (const p of pays) {
    const list = paysBy.get(p.orderId) ?? [];
    list.push({ id: Number(p.paymentId), status: p.status });
    paysBy.set(p.orderId, list);
  }
  return orders.map((o) => ({
    id: Number(o.orderId),
    packId: o.packId === null ? null : Number(o.packId),
    status: o.status,
    dateCreated: toArgIso(o.createdAt),
    shippingId: o.shippingId === null ? null : Number(o.shippingId),
    items: itemsBy.get(o.orderId) ?? [],
    payments: paysBy.get(o.orderId) ?? [],
  }));
}

export async function isPeriodFinal(ownerId: string, mp: Marketplace, month: string): Promise<boolean> {
  const row = await db.orderPeriod.findUnique({
    where: { accountId_marketplace_month: { accountId: ownerId, marketplace: mp, month } },
    select: { isFinal: true },
  });
  return row?.isFinal ?? false;
}

export async function markPeriod(ownerId: string, mp: Marketplace, month: string, isFinal: boolean, orderCount: number): Promise<void> {
  await db.orderPeriod.upsert({
    where: { accountId_marketplace_month: { accountId: ownerId, marketplace: mp, month } },
    create: { accountId: ownerId, marketplace: mp, month, isFinal, orderCount },
    update: { isFinal, orderCount, fetchedAt: new Date() },
  });
}
