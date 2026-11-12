/**
 * Pure stock math: moving weighted-average cost, the effect of one movement on a product's caches,
 * and the available quantity of a listing. No I/O. All amounts are exact `Decimal`s.
 */
import { Prisma } from "../../../generated/prisma";

import type { CostReason, MovementType } from "~/lib/stock-contracts";
import type { Component, Decimal, DecimalInput } from "./contracts";

export const toDecimal = (v: DecimalInput): Decimal => new Prisma.Decimal(v);

const ZERO = new Prisma.Decimal(0);
const COST_PLACES = 4;

/**
 * newCost = (max(onHand,0)·oldCost + qtyIn·landed) / (max(onHand,0) + qtyIn), rounded to 4 decimals.
 * When there is no positive stock before the purchase the landed cost is the new cost.
 */
export function weightedAverageCost(a: { onHand: DecimalInput; oldCost: DecimalInput; qtyIn: DecimalInput; landedUnitCost: DecimalInput }): Decimal {
  const onHand = toDecimal(a.onHand);
  const qtyIn = toDecimal(a.qtyIn);
  const landed = toDecimal(a.landedUnitCost);
  const weight = onHand.gt(ZERO) ? onHand : ZERO;
  if (weight.isZero()) return landed.toDecimalPlaces(COST_PLACES);
  return weight.mul(toDecimal(a.oldCost)).add(qtyIn.mul(landed)).div(weight.add(qtyIn)).toDecimalPlaces(COST_PLACES);
}

/** min over components of floor(max(onHand,0) / quantity); an empty list is 0. */
export function availableQuantity(components: Component[]): number {
  if (components.length === 0) return 0;
  let min = Infinity;
  for (const c of components) {
    const onHand = toDecimal(c.onHand);
    const q = toDecimal(c.quantity).div(1);
    const units = (onHand.gt(ZERO) ? onHand : ZERO).div(q).floor().toNumber();
    if (units < min) min = units;
  }
  return min;
}

export interface ProductState {
  onHand: Decimal;
  inRepair: Decimal;
  unitCost: Decimal;
}

export interface MovementEffect {
  onHandAfter: Decimal;
  inRepairAfter: Decimal;
  unitCostAfter: Decimal;
  /** Present when a ProductCostEntry must be written. */
  costEntry: { unitCost: Decimal; onHandAtChange: Decimal; reason: CostReason } | null;
}

/** What one movement does to a product. Validation of signs and required fields is the caller's job. */
export function computeMovementEffect(
  state: ProductState,
  m: { type: MovementType; quantity: Decimal; unitCost?: Decimal },
): MovementEffect {
  const onHandAfter = state.onHand.add(m.quantity);
  let inRepairAfter = state.inRepair;
  if (m.type === "repair_out") inRepairAfter = state.inRepair.sub(m.quantity); // quantity < 0
  if (m.type === "repair_in") inRepairAfter = state.inRepair.sub(m.quantity); // quantity > 0

  const base = { onHandAfter, inRepairAfter };
  const entry = (unitCost: Decimal, reason: CostReason) => ({ unitCost, onHandAtChange: state.onHand, reason });

  if (m.type === "purchase_in" && m.unitCost) {
    const cost = weightedAverageCost({ onHand: state.onHand, oldCost: state.unitCost, qtyIn: m.quantity, landedUnitCost: m.unitCost });
    return { ...base, unitCostAfter: cost, costEntry: cost.eq(state.unitCost) ? null : entry(cost, "invoice") };
  }
  if ((m.type === "initial_count" || m.type === "excel_reset") && m.unitCost) {
    const cost = m.unitCost.toDecimalPlaces(COST_PLACES);
    return { ...base, unitCostAfter: cost, costEntry: entry(cost, m.type === "initial_count" ? "initial" : "excel") };
  }
  return { ...base, unitCostAfter: state.unitCost, costEntry: null };
}
