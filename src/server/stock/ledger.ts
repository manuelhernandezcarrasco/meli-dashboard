/**
 * The only entry point that changes stock or cost (S1). Validates the event, then the store writes it
 * atomically and idempotently. Implements `LedgerService` from contracts.ts.
 */
import { Prisma } from "../../../generated/prisma";

import type { MovementType } from "~/lib/stock-contracts";
import * as store from "~/server/store/stockLedger";
import { toDecimal } from "./costing";
import { StockError, type AppendMovementInput, type Decimal, type MovementResult } from "./contracts";

export { availableQuantity } from "./costing";
export type { ProductBalance, StoredMovement } from "~/server/store/stockLedger";

export interface AppendMovementResult extends MovementResult {
  /** True when the product's stock is below zero after this movement; the caller raises `negative_stock`. */
  wentNegative: boolean;
}

const POSITIVE: ReadonlySet<MovementType> = new Set(["purchase_in", "initial_count", "sale_cancel", "return_restock", "repair_in"]);
const NEGATIVE: ReadonlySet<MovementType> = new Set(["sale", "loss", "repair_out"]);
const NEEDS_COST: ReadonlySet<MovementType> = new Set(["purchase_in", "initial_count", "excel_reset"]);
const NEEDS_REASON: ReadonlySet<MovementType> = new Set(["manual_adjust", "loss"]);
const EXCEL_REASON = "Excel upload: set cost and stock";

function dec(v: Prisma.Decimal.Value, what: string): Decimal {
  try {
    const d = toDecimal(v);
    if (d.isFinite()) return d;
  } catch {
    /* falls through */
  }
  throw new StockError("INVALID_QUANTITY", `${what} is not a number`);
}

export async function appendMovement(input: AppendMovementInput): Promise<AppendMovementResult> {
  const quantity = dec(input.quantity, "quantity");
  const { type } = input;
  if (quantity.isZero() && type !== "excel_reset") throw new StockError("INVALID_QUANTITY", "quantity cannot be zero");
  if (POSITIVE.has(type) && quantity.isNegative()) throw new StockError("INVALID_QUANTITY", `${type} needs a positive quantity`);
  if (NEGATIVE.has(type) && quantity.gt(0)) throw new StockError("INVALID_QUANTITY", `${type} needs a negative quantity`);

  let unitCost: Decimal | undefined;
  if (NEEDS_COST.has(type)) {
    if (input.unitCost === undefined || input.unitCost === null) throw new StockError("INVALID_QUANTITY", `${type} needs a unitCost`);
    unitCost = dec(input.unitCost, "unitCost");
    if (unitCost.isNegative()) throw new StockError("INVALID_QUANTITY", "unitCost cannot be negative");
  }

  let reason = input.reason?.trim() || undefined;
  if (NEEDS_REASON.has(type) && !reason) throw new Error(`${type} requires a reason`);
  if (type === "excel_reset" && !reason) reason = EXCEL_REASON;
  if (type === "initial_count" && !reason) reason = "Opening stock and cost set";

  const { movement, created } = await store.writeMovement({
    accountId: input.accountId, productId: input.productId, type, quantity, occurredAt: input.occurredAt, unitCost,
    idempotencyKey: input.idempotencyKey, refType: input.refType, refId: input.refId, reason, actor: input.actor,
  });
  return {
    movementId: movement.id,
    created,
    onHandAfter: movement.onHandAfter,
    unitCostAfter: movement.unitCostAfter,
    wentNegative: movement.onHandAfter.isNegative(),
  };
}

/**
 * Sets a product's cost by hand (alerts `missing_cost` / `link_cost_review`). Writes a `manual` cost entry and the
 * cost cache; stock is untouched. A no-op (`changed: false`) when the cost is already that value.
 */
export async function setManualCost(input: {
  accountId: string; productId: number; unitCost: Prisma.Decimal.Value; occurredAt: Date; note?: string;
}): Promise<{ changed: boolean; unitCost: Decimal; onHand: Decimal }> {
  const unitCost = dec(input.unitCost, "unitCost");
  if (unitCost.isNegative()) throw new StockError("INVALID_QUANTITY", "unitCost cannot be negative");
  return store.writeManualCost({
    accountId: input.accountId, productId: input.productId, unitCost: unitCost.toDecimalPlaces(4),
    occurredAt: input.occurredAt, note: input.note?.trim() || undefined,
  });
}

/** Cost per unit in effect at `at`, or null when the product has no cost yet at that time. */
export const costAt = store.readCostAt;

export const listMovements = store.readMovements;
export const getProductBalance = store.readBalance;
/** Sum of the product's movements; equals the `onHand` cache (consistency test, admin repair path). */
export const recomputeOnHand = store.sumMovements;
