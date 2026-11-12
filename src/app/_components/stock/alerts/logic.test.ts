import { describe, expect, it } from "vitest";

import type { AlertRow } from "~/lib/stock-contracts";
import {
  ageLabel, checkAdjust, checkCost, checkNewProduct, checkQuantity, groupAlerts, linkInput, listingUrl, statusesOf,
} from "./logic";

const row = (o: Partial<AlertRow>): AlertRow => ({
  id: 1, type: "low_stock", status: "open", productId: null, productName: null, marketplace: null, itemId: null,
  dedupeKey: "k", title: "t", detail: "d", quantity: null, amount: null,
  createdAt: "2026-11-01T00:00:00.000Z", acknowledgedAt: null, resolvedAt: null, resolution: null, ...o,
});

describe("groupAlerts", () => {
  it("puts severe types first, newest first inside a group", () => {
    const g = groupAlerts([
      row({ id: 1, type: "low_stock" }),
      row({ id: 2, type: "negative_stock", createdAt: "2026-11-01T00:00:00.000Z" }),
      row({ id: 3, type: "negative_stock", createdAt: "2026-11-02T00:00:00.000Z" }),
      row({ id: 4, type: "suggested_match" }),
    ]);
    expect(g.map((x) => x.type)).toEqual(["negative_stock", "low_stock", "suggested_match"]);
    expect(g[0]!.rows.map((r) => r.id)).toEqual([3, 2]);
  });
});

describe("helpers", () => {
  it("formats age", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect(ageLabel("2026-11-12T11:58:00Z", now)).toBe("hace 2 min");
    expect(ageLabel("2026-11-12T09:00:00Z", now)).toBe("hace 3 h");
    expect(ageLabel("2026-11-10T12:00:00Z", now)).toBe("hace 2 d");
  });
  it("builds ML urls and status lists", () => {
    expect(listingUrl("MLA123")).toBe("https://articulo.mercadolibre.com.ar/MLA-123");
    expect(statusesOf("active")).toEqual(["open", "acknowledged"]);
    expect(statusesOf("resolved")).toEqual(["resolved"]);
  });
});

describe("validation", () => {
  it("cost", () => {
    expect(checkCost("")).toMatchObject({ ok: false });
    expect(checkCost("0")).toMatchObject({ ok: false });
    expect(checkCost("1234,5")).toEqual({ ok: true, value: 1234.5 });
  });
  it("adjust requires a reason and a non-zero delta", () => {
    expect(checkAdjust("0", "x")).toMatchObject({ ok: false });
    expect(checkAdjust("3", "  ")).toMatchObject({ ok: false });
    expect(checkAdjust("-2", " conteo ")).toEqual({ ok: true, value: { delta: -2, reason: "conteo" } });
  });
  it("quantity", () => {
    expect(checkQuantity("0")).toMatchObject({ ok: false });
    expect(checkQuantity("2")).toEqual({ ok: true, value: 2 });
  });
  it("new product", () => {
    expect(checkNewProduct({ name: " ", gtin: "", sku: "" })).toMatchObject({ ok: false });
    expect(checkNewProduct({ name: "A", gtin: "123", sku: "" })).toMatchObject({ ok: false });
    expect(checkNewProduct({ name: "A", gtin: "7791234567890", sku: "" })).toEqual({
      ok: true, value: { name: "A", ean: "7791234567890", sku: null },
    });
  });
  it("link payload", () => {
    expect(linkInput("MLA1", null, 5, 1)).toEqual({
      marketplace: "mercadolibre", itemId: "MLA1", variationId: null, components: [{ productId: 5, quantity: 1 }],
    });
  });
});
