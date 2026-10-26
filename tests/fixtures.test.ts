import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  BaseSchema,
  DashboardDataSchema,
  InputsSchema,
  LineSchema,
  OrderSchema,
  PaymentTaxesSchema,
  StockItemSchema,
  TotalsSchema,
} from "~/lib/contracts";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/demo/${name}`, "utf-8"));

describe("demo fixtures match the contracts", () => {
  it("orders", () => {
    expect(z.array(OrderSchema).parse(load("orders.json")).length).toBeGreaterThan(0);
    expect(z.array(OrderSchema).parse(load("prev_orders.json")).length).toBeGreaterThan(0);
  });
  it("base / prev / inputs", () => {
    expect(Object.keys(BaseSchema.parse(load("base.json"))).length).toBe(26);
    TotalsSchema.parse(load("prev_cierre.json"));
    InputsSchema.parse(load("inputs.json"));
  });
  it("taxes / ship / gtins", () => {
    z.record(PaymentTaxesSchema).parse(load("taxes.json"));
    z.record(z.number()).parse(load("ship_costs.json"));
    z.record(z.record(z.string())).parse(load("gtins.json"));
  });
  it("lines / daily / stock", () => {
    expect(z.array(LineSchema).parse(load("lines.json")).length).toBeGreaterThan(0);
    z.array(LineSchema).parse(load("prev_lines.json"));
    expect(z.array(TotalsSchema).parse(load("daily.json")).length).toBe(31);
    z.array(TotalsSchema).parse(load("prev_daily.json"));
    z.array(StockItemSchema).parse(load("stock.json"));
  });
  it("sample dashboard", () => {
    const sample = JSON.parse(
      readFileSync("src/lib/sample-dashboard.json", "utf-8"),
    ) as unknown;
    DashboardDataSchema.parse(sample);
  });
});
