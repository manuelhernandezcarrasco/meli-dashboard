import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./tokens", () => ({
  getTokens: () => Promise.resolve({ userId: 99 }),
  tokenAuth: { getAccessToken: () => Promise.resolve("tok"), refresh: () => Promise.resolve() },
}));

import { MlClient } from "./client";
import { compactOrder } from "./compact";
import { gtinFromAttrs } from "./gtin";
import { taxesFromPayment } from "./taxes";

afterEach(() => vi.unstubAllGlobals());

describe("ordersMonth", () => {
  it("paginates total 120 → offsets 0/50/100 with Argentina month bounds", async () => {
    const f = vi.fn(async (url: string) => {
      const off = Number(new URL(url).searchParams.get("offset"));
      return new Response(
        JSON.stringify({ results: Array.from({ length: off === 100 ? 20 : 50 }, (_, i) => ({ id: off + i })), paging: { total: 120 } }),
      );
    });
    vi.stubGlobal("fetch", f);
    const out = await new MlClient().ordersMonth(99, 2026, 12);
    expect(out).toHaveLength(120);
    const urls = f.mock.calls.map((c) => new URL(c[0]));
    expect(urls.map((u) => u.searchParams.get("offset"))).toEqual(["0", "50", "100"]);
    expect(urls[0]!.searchParams.get("order.date_created.from")).toBe("2026-12-01T00:00:00.000-03:00");
    expect(urls[0]!.searchParams.get("order.date_created.to")).toBe("2026-12-31T23:59:59.000-03:00");
    expect(urls[0]!.searchParams.get("sort")).toBe("date_asc");
  });
});

describe("shipmentSellerCost / itemsGtin / paymentTaxes", () => {
  it("sums senders costs, 0 on 404", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ senders: [{ cost: 10 }, { cost: 5.5 }] })))
      .mockResolvedValueOnce(new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", f);
    const c = new MlClient(() => Promise.resolve());
    expect(await c.shipmentSellerCost("1")).toBe(15.5);
    expect(await c.shipmentSellerCost("2")).toBe(0);
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "x-format-new": "true" });
  });
  it("chunks items by 20 and reads gtins incl. variations", async () => {
    const f = vi.fn(async () =>
      new Response(JSON.stringify([
        { code: 200, body: { id: "MLA1", attributes: [{ id: "GTIN", value_name: "7790001, 7790002" }], variations: [{ id: 55, attributes: [{ id: "EAN", value_name: "7791111" }] }] } },
      ])),
    );
    vi.stubGlobal("fetch", f);
    const ids = Array.from({ length: 25 }, (_, i) => `MLA${i}`);
    const r = await new MlClient().itemsGtin(ids);
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.MLA1).toEqual({ _item: "7790001", "55": "7791111" });
  });
  it("paymentTaxes hits Mercado Pago", async () => {
    const f = vi.fn(async (...[,]: [string]) => new Response(JSON.stringify({ charges_details: [{ type: "tax", name: "IIBB", accounts: { from: "collector" }, amounts: { original: 10, refunded: 0 } }] })));
    vi.stubGlobal("fetch", f);
    expect(await new MlClient().paymentTaxes("7")).toEqual({ total: 10, det: { IIBB: 10 } });
    expect(String(f.mock.calls[0]![0])).toBe("https://api.mercadopago.com/v1/payments/7");
  });
});

describe("taxesFromPayment", () => {
  const tax = (name: string, original: number, refunded = 0, from = "collector") => ({
    type: "tax", name, accounts: { from, to: "mp" }, amounts: { original, refunded },
  });
  it("ignores fees, sums taxes, subtracts refunds", () => {
    const r = taxesFromPayment({
      charges_details: [
        tax("IIBB Retención CABA", 100),
        tax("Imp. Débitos y Créditos", 50.555, 10),
        { type: "fee", name: "ml_sale_fee", accounts: { from: "collector", to: "ml" }, amounts: { original: 1, refunded: 0 } },
      ],
    });
    expect(r).toEqual({ total: 140.56, det: { "IIBB Retención CABA": 100, "Imp. Débitos y Créditos": 40.56 } });
  });
  it("skips taxes not billed to the seller", () => {
    expect(taxesFromPayment({ charges_details: [tax("X", 5, 0, "payer")] })).toEqual({ total: 0, det: {} });
  });
  it("missing charges_details → null", () => {
    expect(taxesFromPayment({})).toBeNull();
    expect(taxesFromPayment({ charges_details: null })).toBeNull();
  });
});

describe("gtinFromAttrs", () => {
  it("takes the first of GTIN/EAN/UPC, first value before comma", () => {
    expect(gtinFromAttrs([{ id: "BRAND", value_name: "x" }, { id: "EAN", value_name: "779123, 779456" }])).toBe("779123");
  });
  it("empty when absent", () => {
    expect(gtinFromAttrs(null)).toBe("");
    expect(gtinFromAttrs([{ id: "GTIN", value_name: " " }])).toBe("");
  });
});

describe("compactOrder", () => {
  it("maps a raw ML order", () => {
    const o = compactOrder({
      id: 5, pack_id: null, status: "paid", date_created: "2026-10-03T12:30:00.000-03:00",
      shipping: { id: 44000000001 }, extra: "ignored",
      payments: [{ id: 90000000005, status: "approved", other: 1 }],
      order_items: [{ item: { id: "mla123", title: "T", seller_sku: "", variation_id: null }, quantity: 2, unit_price: 1000, sale_fee: 140 }],
    });
    expect(o).toEqual({
      id: 5, packId: null, status: "paid", dateCreated: "2026-10-03T12:30:00.000-03:00", shippingId: 44000000001,
      items: [{ itemId: "MLA123", title: "T", sellerSku: "", sellerCustomField: null, variationId: null, quantity: 2, unitPrice: 1000, saleFee: 140 }],
      payments: [{ id: 90000000005, status: "approved" }],
    });
  });
  it("tolerates missing shipping/payments", () => {
    const o = compactOrder({ id: 1, status: "paid", date_created: "x", order_items: [] });
    expect(o.shippingId).toBeNull();
    expect(o.payments).toEqual([]);
  });
});
