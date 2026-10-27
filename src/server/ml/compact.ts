import type { Order } from "~/lib/contracts";
import { toNum } from "~/lib/normalize";

/* eslint-disable @typescript-eslint/no-explicit-any */
const str = (x: unknown): string | null =>
  typeof x === "string" ? x : typeof x === "number" ? String(x) : null;
const numOrNull = (x: unknown): number | null =>
  x === null || x === undefined || x === "" ? null : toNum(x);

/** Maps Mercado Libre's raw order JSON to the contract `Order` (port of `compact_order`). */
export function compactOrder(o: any): Order {
  return {
    id: toNum(o.id),
    packId: numOrNull(o.pack_id),
    status: String(o.status ?? ""),
    dateCreated: String(o.date_created ?? ""),
    shippingId: numOrNull(o.shipping?.id),
    items: ((o.order_items ?? []) as any[]).map((it) => ({
      itemId: String(it.item?.id ?? "").toUpperCase(),
      title: String(it.item?.title ?? ""),
      sellerSku: str(it.item?.seller_sku),
      sellerCustomField: str(it.item?.seller_custom_field),
      variationId: numOrNull(it.item?.variation_id),
      quantity: toNum(it.quantity),
      unitPrice: toNum(it.unit_price),
      saleFee: toNum(it.sale_fee),
    })),
    payments: ((o.payments ?? []) as any[]).map((p) => ({
      id: toNum(p.id),
      status: String(p.status ?? ""),
    })),
  };
}
