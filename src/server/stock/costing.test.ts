import { describe, expect, it } from "vitest";
import { Prisma } from "../../../generated/prisma";
import { availableQuantity, computeMovementEffect, weightedAverageCost } from "./costing";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

describe("weightedAverageCost", () => {
  it("invoice example: 58 units at 55.095,86 x 1,27001 = 69.971,74 per unit", () => {
    // feeFactor = total / subtotal is not rounded to 5 decimals: 55095.86 x 1.27001 would be 69972.29.
    const landed = D("55095.86").mul(D("69971.7449").div("55095.86"));
    expect(landed.toDecimalPlaces(2).toString()).toBe("69971.74");
    const cost = weightedAverageCost({ onHand: 0, oldCost: 0, qtyIn: 58, landedUnitCost: landed });
    expect(cost.toString()).toBe("69971.7449");
  });

  it("blends a second purchase with existing stock", () => {
    // 10 @ 100 + 30 @ 200 = 7000 / 40 = 175
    expect(weightedAverageCost({ onHand: 10, oldCost: 100, qtyIn: 30, landedUnitCost: 200 }).toString()).toBe("175");
  });

  it("rounds to 4 decimals", () => {
    // (1*10 + 2*10.0001)/3 = 10.00006666… -> 10.0001
    expect(weightedAverageCost({ onHand: 1, oldCost: 10, qtyIn: 2, landedUnitCost: "10.0001" }).toString()).toBe("10.0001");
    expect(weightedAverageCost({ onHand: 2, oldCost: 10, qtyIn: 1, landedUnitCost: 11 }).toString()).toBe("10.3333");
  });

  it("uses the landed cost when stock is 0", () => {
    expect(weightedAverageCost({ onHand: 0, oldCost: 999, qtyIn: 5, landedUnitCost: 50 }).toString()).toBe("50");
  });

  it("negative stock never contributes weight", () => {
    expect(weightedAverageCost({ onHand: -4, oldCost: 999, qtyIn: 5, landedUnitCost: 50 }).toString()).toBe("50");
  });
});

describe("availableQuantity", () => {
  it("min over components of floor(max(onHand,0)/quantity)", () => {
    expect(availableQuantity([{ onHand: 10, quantity: 1 }])).toBe(10);
    expect(availableQuantity([{ onHand: 10, quantity: 3 }, { onHand: 7, quantity: 2 }])).toBe(3);
    expect(availableQuantity([{ onHand: "5.5", quantity: 2 }])).toBe(2);
  });
  it("empty list is 0; negative stock clamps to 0", () => {
    expect(availableQuantity([])).toBe(0);
    expect(availableQuantity([{ onHand: -3, quantity: 1 }, { onHand: 9, quantity: 1 }])).toBe(0);
  });
});

describe("computeMovementEffect", () => {
  const state = { onHand: D(10), inRepair: D(0), unitCost: D(100) };
  it("sale keeps cost and records it", () => {
    const e = computeMovementEffect(state, { type: "sale", quantity: D(-3) });
    expect(e.onHandAfter.toString()).toBe("7");
    expect(e.unitCostAfter.toString()).toBe("100");
    expect(e.costEntry).toBeNull();
  });
  it("repair_out moves units into the repair bucket and repair_in back", () => {
    const out = computeMovementEffect(state, { type: "repair_out", quantity: D(-2) });
    expect(out.onHandAfter.toString()).toBe("8");
    expect(out.inRepairAfter.toString()).toBe("2");
    const back = computeMovementEffect({ ...state, inRepair: D(2) }, { type: "repair_in", quantity: D(2) });
    expect(back.onHandAfter.toString()).toBe("12");
    expect(back.inRepairAfter.toString()).toBe("0");
  });
  it("purchase_in with the same cost writes no cost entry", () => {
    const e = computeMovementEffect(state, { type: "purchase_in", quantity: D(5), unitCost: D(100) });
    expect(e.costEntry).toBeNull();
  });
  it("purchase_in with a new cost writes an entry with the old weight", () => {
    const e = computeMovementEffect(state, { type: "purchase_in", quantity: D(10), unitCost: D(200) });
    expect(e.unitCostAfter.toString()).toBe("150");
    expect(e.costEntry).toEqual({ unitCost: D(150), onHandAtChange: D(10), reason: "invoice" });
  });
  it("excel_reset sets cost and always writes an entry", () => {
    const e = computeMovementEffect(state, { type: "excel_reset", quantity: D(-4), unitCost: D(100) });
    expect(e.onHandAfter.toString()).toBe("6");
    expect(e.costEntry?.reason).toBe("excel");
  });
  it("initial_count sets the cost", () => {
    const e = computeMovementEffect({ onHand: D(0), inRepair: D(0), unitCost: D(0) }, { type: "initial_count", quantity: D(8), unitCost: D(33) });
    expect(e.unitCostAfter.toString()).toBe("33");
    expect(e.costEntry?.reason).toBe("initial");
  });
});
