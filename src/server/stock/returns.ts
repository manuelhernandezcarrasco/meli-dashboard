import type { Marketplace, ReturnOutcome } from "~/lib/stock-contracts";
import { returnsStore } from "~/server/store/stockReturns";
import { evaluateProducts } from "./alerts";
import {
  StockError, type LedgerService, type PushService,
} from "./contracts";
import { appendMovement } from "./ledger";
import { requestPush } from "./push";

/**
 * Returns domain (S8). A returned unit never touches stock by itself: a person resolves each case.
 *
 *   pending   → lost | in_repair | restocked
 *   in_repair → restocked | lost          (lost and restocked are final)
 *
 * Every stock change goes through the S1 ledger with a deterministic idempotency key, so retrying a
 * half-finished resolve (movement written, state not yet saved) completes it without double counting.
 */

export interface ReturnRecord {
  id: number;
  accountId: string;
  marketplace: Marketplace;
  orderId: number;
  lineNo: number;
  productId: number;
  quantity: number;
  outcome: ReturnOutcome;
  reason: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
  note: string | null;
}

export interface OpenReturnInput {
  accountId: string;
  orderId: number;
  lineNo: number;
  productId: number;
  quantity: number;
  reason?: string;
}

/** Persistence port (SQL in src/server/store/stockReturns.ts). The only writer of ReturnCase. */
export interface ReturnsStore {
  /** Insert as pending; when the order line already has a case, return it with created=false. */
  insert(input: OpenReturnInput): Promise<{ record: ReturnRecord; created: boolean }>;
  get(accountId: string, id: number): Promise<ReturnRecord | null>;
  /** Compare-and-set: only moves the case if it is still in `from`. Returns null when it was not. */
  transition(
    accountId: string, id: number, from: ReturnOutcome, to: ReturnOutcome, note: string | undefined, resolvedAt: Date | null,
  ): Promise<ReturnRecord | null>;
}

/**
 * "Alert evaluation (S7) via its interface": S0's AlertService only has raise/resolve, so the post-restock
 * re-evaluation (e.g. clears out_of_stock) is a narrow port S7 must satisfy.
 */
export interface StockAlertEvaluator {
  evaluateProducts(accountId: string, productIds: number[]): Promise<void>;
}

export interface ReturnsDeps {
  store: ReturnsStore;
  ledger: Pick<LedgerService, "appendMovement">;
  push: Pick<PushService, "requestPush">;
  alerts: StockAlertEvaluator;
  now?: () => Date;
}

export class ReturnNotFoundError extends Error {
  constructor(id: number) {
    super(`Return case ${id} not found`);
    this.name = "ReturnNotFoundError";
  }
}

export interface ResolveReturnArgs {
  accountId: string;
  returnId: number;
  outcome: "lost" | "in_repair" | "restocked";
  note?: string;
  /** Must be true for `restocked`: putting units back on sale is always a conscious decision. */
  confirmRestock?: boolean;
}

const ALLOWED: Record<ReturnOutcome, readonly ReturnOutcome[]> = {
  pending: ["lost", "in_repair", "restocked"],
  in_repair: ["restocked", "lost"],
  lost: [],
  restocked: [],
};

export function createReturnsService(deps: ReturnsDeps) {
  const { store, ledger, push } = deps;
  const now = deps.now ?? (() => new Date());
  const evaluator = deps.alerts;

  async function openReturn(input: OpenReturnInput) {
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new StockError("INVALID_QUANTITY", "Return quantity must be positive");
    }
    return store.insert(input);
  }

  async function afterRestock(rec: ReturnRecord) {
    await push.requestPush(rec.accountId, [rec.productId], { type: "adjust", ref: `return:${rec.id}` });
    await evaluator.evaluateProducts(rec.accountId, [rec.productId]);
  }

  async function resolveReturn(args: ResolveReturnArgs): Promise<ReturnRecord> {
    const { accountId, returnId, outcome } = args;
    const rec = await store.get(accountId, returnId);
    if (!rec) throw new ReturnNotFoundError(returnId);

    // Replay of an outcome already reached: nothing to write. A restock still re-requests the push (it may
    // have been lost after the state was saved); push is idempotent by design.
    if (rec.outcome === outcome) {
      if (outcome === "restocked") await afterRestock(rec);
      return rec;
    }
    if (!ALLOWED[rec.outcome].includes(outcome)) {
      throw new StockError("RETURN_TRANSITION", `Cannot move a ${rec.outcome} return to ${outcome}`);
    }
    if (outcome === "restocked" && args.confirmRestock !== true) {
      throw new StockError("RETURN_TRANSITION", "Restocking must be explicitly confirmed");
    }

    const at = now();
    const base = {
      accountId, productId: rec.productId, occurredAt: at, refType: "return", refId: String(rec.id),
      reason: args.note, actor: "user" as const,
    };
    const key = (suffix: string) => `return:${rec.id}:${suffix}`;

    // From the repair bucket the units must leave it first (repair_out), then follow the normal outcome.
    if (rec.outcome === "in_repair") {
      await ledger.appendMovement({
        ...base, type: "repair_out", quantity: -rec.quantity, idempotencyKey: key(`${outcome}:repair_out`),
      });
    }
    if (outcome === "in_repair") {
      await ledger.appendMovement({ ...base, type: "repair_in", quantity: rec.quantity, idempotencyKey: key("in_repair") });
    } else if (outcome === "restocked") {
      await ledger.appendMovement({ ...base, type: "return_restock", quantity: rec.quantity, idempotencyKey: key("restocked") });
    }
    // lost: stock already left at the sale; the ReturnCase row (outcome + note) is the audit record.

    const resolvedAt = outcome === "in_repair" ? null : at;
    const updated = await store.transition(accountId, returnId, rec.outcome, outcome, args.note, resolvedAt);
    if (!updated) {
      // A concurrent resolve won. Same target → idempotent success; otherwise it is an illegal move now.
      const cur = await store.get(accountId, returnId);
      if (cur?.outcome === outcome) return cur;
      throw new StockError("RETURN_TRANSITION", `Return ${returnId} changed concurrently (now ${cur?.outcome})`);
    }
    if (outcome === "restocked") await afterRestock(updated);
    return updated;
  }

  return { openReturn, resolveReturn };
}

export type ReturnsService = ReturnType<typeof createReturnsService>;

/* ---------- wiring ---------- */

let configured: ReturnsService | undefined;

/** Test seam: replaces the service `getReturnsService` returns. Production needs no call: the defaults are the real services. */
export function configureReturnsService(deps: ReturnsDeps): ReturnsService {
  configured = createReturnsService(deps);
  return configured;
}

/** The returns service wired with the real ledger (S1), push engine (S3) and alert evaluator (S7). */
export function getReturnsService(): ReturnsService {
  return (configured ??= createReturnsService({
    store: returnsStore, ledger: { appendMovement }, push: { requestPush }, alerts: { evaluateProducts },
  }));
}
