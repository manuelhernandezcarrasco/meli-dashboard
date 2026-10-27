import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DemoDataSource } from "./demo";
import { OrderSchema, PaymentTaxesSchema, type Base } from "~/lib/contracts";

const base: Base = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../tests/fixtures/demo/base.json"),
    "utf8",
  ),
);
const now = new Date("2026-10-20T15:30:00-03:00");
const make = () => new DemoDataSource({ base, now });

describe("DemoDataSource", () => {
  it("is deterministic for the same seed", async () => {
    expect(await make().getOrdersMonth(2026, 10)).toEqual(
      await make().getOrdersMonth(2026, 10),
    );
  });
  it("produces valid orders, up to today in the current month", async () => {
    const orders = await make().getOrdersMonth(2026, 10);
    expect(orders.length).toBeGreaterThan(100);
    for (const o of orders) OrderSchema.parse(o);
    expect(orders.every((o) => o.dateCreated.slice(0, 7) === "2026-10")).toBe(true);
    expect(Math.max(...orders.map((o) => Number(o.dateCreated.slice(8, 10))))).toBe(20);
    expect(new Set(orders.map((o) => o.id)).size).toBe(orders.length);
  });
  it("has the unmatched combo only in the current month", async () => {
    const ds = make();
    const has = (os: { items: { itemId: string }[] }[]) =>
      os.some((o) => o.items.some((i) => i.itemId === "MLA1999999999"));
    expect(has(await ds.getOrdersMonth(2026, 10))).toBe(true);
    const sep = await ds.getOrdersMonth(2026, 9);
    expect(has(sep)).toBe(false);
    expect(Math.max(...sep.map((o) => Number(o.dateCreated.slice(8, 10))))).toBe(30);
  });
  it("includes cancelled orders and ~86% single-unit lines", async () => {
    const orders = await make().getOrdersMonth(2026, 9);
    expect(orders.some((o) => o.status === "cancelled")).toBe(true);
    const q1 = orders.filter((o) => o.items[0]!.quantity === 1).length / orders.length;
    expect(q1).toBeGreaterThan(0.8);
    expect(q1).toBeLessThan(0.92);
  });
  it("serves shipping, gtins and taxes for generated orders", async () => {
    const ds = make();
    const orders = await ds.getOrdersMonth(2026, 9);
    const sids = orders.map((o) => String(o.shippingId));
    const ships = await ds.getShipmentCosts(sids);
    expect(Object.keys(ships).length).toBeGreaterThan(0);
    const iids = [...new Set(orders.map((o) => o.items[0]!.itemId))];
    const g = await ds.getGtins(iids);
    for (const id of iids) expect(base[g[id]!._item!]).toBeDefined();
    const pids = orders.flatMap((o) => o.payments.map((p) => String(p.id)));
    const taxes = await ds.getPaymentTaxes(pids);
    const nulls = pids.filter((p) => taxes[p] === null).length / pids.length;
    expect(nulls).toBeGreaterThan(0.05);
    expect(nulls).toBeLessThan(0.15);
    for (const t of Object.values(taxes)) if (t) PaymentTaxesSchema.parse(t);
  });
});
