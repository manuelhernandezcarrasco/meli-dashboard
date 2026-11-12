/**
 * Stock module — service interfaces. Owned by S0; do not edit from other tickets.
 *
 * Each ticket implements the interface named in its comment and codes against the others with fakes
 * until they merge. Types only (plus `StockError`): no implementation lives here.
 *
 * Numbers: ledger math uses Prisma `Decimal` (exact); anything crossing to the UI uses `number`
 * (see src/lib/stock-contracts.ts). Every write is idempotent through its `idempotencyKey`.
 */
import type { Prisma } from "../../../generated/prisma";

import type {
  Actor, AlertType, CostReason, Marketplace, MovementType, ParsedInvoice, PushTrigger, SyncMode,
} from "~/lib/stock-contracts";

export type Decimal = Prisma.Decimal;
/** Accepted wherever a quantity or amount goes in; converted to Decimal at the boundary. */
export type DecimalInput = Decimal | number | string;

/** Machine-readable failure reasons shared by every stock service. */
export type StockErrorCode =
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_ARCHIVED"
  | "INVALID_QUANTITY"        // zero, NaN, wrong sign for the movement type
  | "IDEMPOTENCY_CONFLICT"    // same key, different payload
  | "LINK_NOT_FOUND"
  | "LINK_EXISTS"             // listing/variation already linked
  | "INVOICE_DUPLICATE"       // (supplierTaxId, number) already stored
  | "INVOICE_NOT_DRAFT"
  | "INVOICE_UNRESOLVED"      // confirm with unresolved lines
  | "PDF_UNREADABLE"          // no text layer / not an invoice we know
  | "RETURN_TRANSITION"       // outcome change not allowed
  | "ML_WRITE_BLOCKED";       // push attempted without live mode / without permission

export class StockError extends Error {
  constructor(readonly code: StockErrorCode, message?: string) {
    super(message ?? code);
    this.name = "StockError";
  }
}

/* ---------- S1: ledger and costing (src/server/stock/ledger.ts + store/stockMovements.ts) ---------- */

export interface AppendMovementInput {
  accountId: string;
  productId: number;
  type: MovementType;
  /**
   * Signed units. Sign rules: purchase_in / initial_count / sale_cancel / return_restock / repair_in > 0;
   * sale / loss / repair_out < 0; manual_adjust and excel_reset may be either (excel_reset is the delta to the
   * target stock). repair_out/repair_in also move `inRepair` in the opposite direction.
   */
  quantity: DecimalInput;
  occurredAt: Date;
  /** Required for purchase_in, initial_count and excel_reset (they set cost); ignored for the rest. */
  unitCost?: DecimalInput;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  reason?: string;
  actor: Actor;
}

export interface MovementResult {
  movementId: number;
  /** False when the idempotencyKey already existed: nothing was written and the stored movement is returned. */
  created: boolean;
  onHandAfter: Decimal;
  unitCostAfter: Decimal;
}

export interface LedgerService {
  /**
   * The ONLY way to change onHand/inRepair/unitCost: appends the movement, updates the product caches and
   * (when cost changes) a ProductCostEntry in one transaction. Moving weighted average on inbound movements.
   * Errors: PRODUCT_NOT_FOUND, PRODUCT_ARCHIVED, INVALID_QUANTITY, IDEMPOTENCY_CONFLICT.
   */
  appendMovement(input: AppendMovementInput): Promise<MovementResult>;
  /**
   * Cost per unit in effect at `at` (latest ProductCostEntry with effectiveFrom <= at). Used to freeze the cost
   * of a sale. Returns null when the product has no cost yet at that time (caller raises `missing_cost`).
   * Errors: PRODUCT_NOT_FOUND.
   */
  costAt(accountId: string, productId: number, at: Date): Promise<Decimal | null>;
}

/** Pure helper (S1 implements, S3/S5/UI call): available units of a listing made of components. */
export interface Component {
  onHand: DecimalInput;
  /** Units of the product per unit of listing; > 0. */
  quantity: DecimalInput;
}
/**
 * min over components of floor(onHand / quantity). May be negative when stock is negative (callers clamp with
 * `max(0, …)` before sending to a marketplace). Empty list → 0.
 */
export type AvailableQuantity = (components: Component[]) => number;

/* ---------- S3: push engine (src/server/stock/push.ts) ---------- */

export interface PushTriggerInfo {
  type: PushTrigger;
  /** Order id, invoice id, ... */
  ref?: string;
}

export interface PushService {
  /**
   * Recompute the desired quantity of every link that uses any of `productIds` and push it, honouring each
   * product's syncMode (dry_run → MlPushLog row with result dry_run, nothing sent). Only linked listings are
   * touched; never pushes for unknown products. Retries transient failures; on permanent failure sets
   * ListingSyncState.failed and raises `push_failed`. Drift or negative stock never auto-pushes: raises
   * `stock_drift` / `negative_stock` instead. Never throws for ML errors (logged), only for bad input.
   */
  requestPush(accountId: string, productIds: number[], trigger: PushTriggerInfo): Promise<void>;
  /** Switch a product live/dry-run. Going live requires an openingStock confirmation (see GoLiveInput). Errors: PRODUCT_NOT_FOUND. */
  setSyncMode(accountId: string, productId: number, mode: SyncMode): Promise<void>;
}

/* ---------- S7: alerts (src/server/stock/alerts.ts + store/stockAlerts.ts) ---------- */

export interface RaiseAlertInput {
  accountId: string;
  type: AlertType;
  /** Identity of the situation; at most one non-resolved alert per (accountId, dedupeKey). */
  dedupeKey: string;
  title: string;
  detail?: string;
  productId?: number;
  marketplace?: Marketplace;
  itemId?: string;
  quantity?: DecimalInput;
  amount?: DecimalInput;
}

export interface AlertService {
  /** Creates the alert, or refreshes title/detail/numbers of the existing non-resolved one. Returns its id. Never reopens a resolved one (a new row is created instead). */
  raiseAlert(input: RaiseAlertInput): Promise<{ alertId: number; created: boolean }>;
  /** Marks resolved (resolution "auto" when the condition cleared). No-op when none is open for the key. */
  resolveAlert(accountId: string, dedupeKey: string, resolution: string): Promise<void>;
}

/* ---------- S5: linking (src/server/stock/linking.ts + store/stockLinks.ts) ---------- */

export interface LinkListingArgs {
  accountId: string;
  marketplace: Marketplace;
  itemId: string;
  variationId: number | null;
  components: { productId: number; quantity: DecimalInput }[];
}

export interface LinkingService {
  /** Create the link and its components; seeds ListingSyncState(never). Errors: PRODUCT_NOT_FOUND, LINK_EXISTS, INVALID_QUANTITY. */
  linkListing(args: LinkListingArgs): Promise<{ linkId: number }>;
  /** Remove a link (components and sync state cascade). Errors: LINK_NOT_FOUND. */
  unlinkListing(accountId: string, linkId: number): Promise<void>;
  /** Link by exact EAN/GTIN only: for each unlinked listing whose gtin equals an InventoryProduct.ean. Returns the new link ids. */
  autoLinkByEan(accountId: string): Promise<{ linkIds: number[] }>;
}

/* ---------- S2: invoice parser (src/server/stock/invoice-parser/*, pure) ---------- */

/**
 * Text-layer PDF → ParsedInvoice. Pure: no DB, no network. Normalizes EANs to GTIN-13 (null if the check digit fails).
 * Errors: PDF_UNREADABLE (no text layer, unknown layout). Totals that do not add up become `warnings`, not errors.
 */
export type ParseInvoicePdf = (buffer: Buffer) => Promise<ParsedInvoice>;

/* ---------- S9: invoice service (src/server/stock/invoices.ts + store/stockInvoices.ts) ---------- */

export interface InvoiceService {
  /** Parse + store as draft + auto-resolve lines by exact EAN. Writes no stock. Errors: PDF_UNREADABLE, INVOICE_DUPLICATE. */
  createDraft(accountId: string, file: { name: string; buffer: Buffer }): Promise<{ invoiceId: number }>;
  /**
   * Apply a draft: one purchase_in movement per line (idempotencyKey `invoice:<id>:<lineNo>`), fills only the
   * missing product fields, writes cost entries with reason "invoice", then requests a push. Atomic.
   * Errors: INVOICE_NOT_DRAFT, INVOICE_UNRESOLVED.
   */
  confirm(accountId: string, invoiceId: number): Promise<void>;
  /** Draft → voided. Applied invoices cannot be voided in v1. Errors: INVOICE_NOT_DRAFT. */
  voidDraft(accountId: string, invoiceId: number): Promise<void>;
}

/* ---------- S6: cutover (src/server/stock/cutover.ts) ---------- */

export interface CostResetInput {
  accountId: string;
  productId: number;
  unitCost: DecimalInput;
  /** Target stock; the ledger gets an excel_reset movement for the difference. */
  targetOnHand: DecimalInput;
  reason: Extract<CostReason, "excel" | "initial">;
  at: Date;
  idempotencyKey: string;
}
