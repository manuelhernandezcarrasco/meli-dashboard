import { toNum } from "~/lib/normalize";
import type { Gtins, PaymentTaxes } from "~/lib/contracts";
import { gtinFromAttrs } from "./gtin";
import { mlFetch, type MlFetchOpts } from "./http";
import { getTokens, tokenAuthFor } from "./tokens";
import { taxesFromPayment } from "./taxes";

const API = "https://api.mercadolibre.com";
const MP_API = "https://api.mercadopago.com";
const PAGE = 50;

/* eslint-disable @typescript-eslint/no-explicit-any */
const p2 = (n: number) => String(n).padStart(2, "0");

/** Formats a UTC instant as Argentina local time: YYYY-MM-DDTHH:MM:SS.000-03:00 */
function fmtArg(ms: number): string {
  const a = new Date(ms - 3 * 3600_000);
  return (
    `${a.getUTCFullYear()}-${p2(a.getUTCMonth() + 1)}-${p2(a.getUTCDate())}` +
    `T${p2(a.getUTCHours())}:${p2(a.getUTCMinutes())}:${p2(a.getUTCSeconds())}.000-03:00`
  );
}

export class MlClient {
  private readonly auth;

  constructor(
    private readonly ownerId: string,
    private readonly sleep?: MlFetchOpts["sleep"],
  ) {
    this.auth = tokenAuthFor(ownerId);
  }

  private get(url: string, query?: Record<string, string | number>, headers?: Record<string, string>) {
    return mlFetch("GET", url, { query, headers, auth: this.auth, sleep: this.sleep });
  }

  async getSellerId(): Promise<number> {
    const t = await getTokens(this.ownerId);
    if (t?.userId) return t.userId;
    const me = (await this.get(`${API}/users/me`)) as any;
    return toNum(me?.id);
  }

  /** Raw orders created in month (y, m), Argentina time. */
  async ordersMonth(sellerId: number, y: number, m: number): Promise<any[]> {
    const start = Date.UTC(y, m - 1, 1, 3);
    const end = Date.UTC(y + (m === 12 ? 1 : 0), m % 12, 1, 3) - 1;
    const out: any[] = [];
    let offset = 0;
    for (;;) {
      const r = (await this.get(`${API}/orders/search`, {
        seller: sellerId,
        "order.date_created.from": fmtArg(start),
        "order.date_created.to": fmtArg(end),
        sort: "date_asc",
        limit: PAGE,
        offset,
      })) as any;
      const res: any[] = r?.results ?? [];
      out.push(...res);
      const total = r?.paging?.total ?? 0;
      offset += PAGE;
      if (offset >= total || res.length === 0) break;
    }
    return out;
  }

  /**
   * Net shipping cost for the seller (positive = charged, negative = credited).
   * The /costs body alone is ambiguous (`cost` and `save` are present in both cases); the
   * indicator is the shipment's `logistic_type`:
   *  - `self_service` (Flex, the seller delivers): ML does not charge shipping and pays a
   *    bonus (`senders[].save`) -> returned as a NEGATIVE cost.
   *  - anything else (drop-off, agencies, fulfillment...): ML deducts `senders[].cost`.
   */
  async shipmentSellerCost(id: string): Promise<number> {
    const [r, ship] = (await Promise.all([
      this.get(`${API}/shipments/${id}/costs`, undefined, { "x-format-new": "true" }),
      this.get(`${API}/shipments/${id}`),
    ])) as any[];
    if (!r) return 0;
    const senders = (r.senders ?? []) as any[];
    if (ship?.logistic_type === "self_service") {
      return -senders.reduce((s, x) => s + toNum(x.save), 0);
    }
    return senders.reduce((s, x) => s + toNum(x.cost), 0);
  }

  async itemsGtin(ids: string[]): Promise<Gtins> {
    const res: Gtins = {};
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const r = ((await this.get(`${API}/items`, {
        ids: chunk.join(","),
        attributes: "id,attributes,variations,seller_custom_field",
      })) ?? []) as any[];
      for (const it of r) {
        const body = it.body ?? {};
        if (!body.id) continue;
        const d: Record<string, string> = { _item: gtinFromAttrs(body.attributes) };
        for (const v of body.variations ?? []) {
          const g = gtinFromAttrs(v.attributes);
          if (g) d[String(v.id)] = g;
        }
        res[body.id as string] = d;
      }
    }
    return res;
  }

  /** itemId -> `catalog_product_id` (null when the listing is not linked to the ML catalog). */
  async itemsCatalogId(ids: string[]): Promise<Record<string, string | null>> {
    const res: Record<string, string | null> = {};
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const r = ((await this.get(`${API}/items`, {
        ids: chunk.join(","),
        attributes: "id,catalog_product_id",
      })) ?? []) as any[];
      for (const it of r) {
        const body = it.body ?? {};
        if (!body.id) continue;
        const c = body.catalog_product_id;
        res[String(body.id).toUpperCase()] = typeof c === "string" && c ? c : null;
      }
    }
    return res;
  }

  async paymentTaxes(id: string): Promise<PaymentTaxes | null> {
    const r = (await this.get(`${MP_API}/v1/payments/${id}`)) as any;
    return r ? taxesFromPayment(r) : null;
  }
}
