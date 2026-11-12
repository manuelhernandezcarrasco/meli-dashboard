/**
 * Stock module — wire contracts (zod + TS) shared by routers (S3, S5, S7, S8, S9) and UI (U1-U5).
 * Owned by S0: do not edit from other tickets; report needed changes.
 *
 * Conventions
 *  - Quantities and money cross the wire as plain `number` (JS), like the rest of the app. The database
 *    keeps Decimal; stores convert with `Number(decimal)` at the edge, never inside the ledger math.
 *  - Instants are ISO-8601 strings with offset ("2026-11-12T15:04:05.000Z"); calendar days are "YYYY-MM-DD".
 *  - Ids of the stock tables are bigint in Postgres and `number` here (safe far beyond our volume).
 *  - Marketplace item ids are upper case.
 */
import { z } from "zod";

/* ---------- Enums (mirror prisma/schema.prisma; a test in S1 may assert they stay equal) ---------- */
export const MarketplaceSchema = z.enum(["mercadolibre"]);
export const MovementTypeSchema = z.enum([
  "initial_count", "purchase_in", "sale", "sale_cancel", "return_restock",
  "repair_in", "repair_out", "loss", "manual_adjust", "excel_reset",
]);
export const SyncModeSchema = z.enum(["dry_run", "live"]);
export const AlertTypeSchema = z.enum([
  "low_stock", "out_of_stock", "negative_stock", "push_failed", "stock_drift", "margin_drop",
  "unmatched_sale", "suggested_match", "auto_match", "missing_cost", "unmatched_listing", "link_cost_review",
]);
export const AlertStatusSchema = z.enum(["open", "acknowledged", "resolved"]);
export const InvoiceStatusSchema = z.enum(["draft", "applied", "voided"]);
export const ReturnOutcomeSchema = z.enum(["pending", "lost", "in_repair", "restocked"]);
export const PushResultSchema = z.enum(["dry_run", "ok", "failed", "skipped"]);
export const LineResolutionSchema = z.enum(["auto_ean", "manual_match", "created_product", "unresolved"]);
export const CostReasonSchema = z.enum(["invoice", "excel", "initial", "manual"]);
export const SyncStatusSchema = z.enum(["never", "in_sync", "drift", "failed"]);
export const PushTriggerSchema = z.enum(["sale", "invoice", "adjust", "reconcile", "manual"]);
export const ActorSchema = z.enum(["system", "user", "webhook"]);

export type Marketplace = z.infer<typeof MarketplaceSchema>;
export type MovementType = z.infer<typeof MovementTypeSchema>;
export type SyncMode = z.infer<typeof SyncModeSchema>;
export type AlertType = z.infer<typeof AlertTypeSchema>;
export type AlertStatus = z.infer<typeof AlertStatusSchema>;
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;
export type ReturnOutcome = z.infer<typeof ReturnOutcomeSchema>;
export type PushResult = z.infer<typeof PushResultSchema>;
export type LineResolution = z.infer<typeof LineResolutionSchema>;
export type CostReason = z.infer<typeof CostReasonSchema>;
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
export type PushTrigger = z.infer<typeof PushTriggerSchema>;
export type Actor = z.infer<typeof ActorSchema>;

const id = z.number().int().positive();
const instant = z.string();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ---------- Products (router stockProducts, S5; UI U1) ---------- */

/** A listing (or variation) tied to a product, as shown in the product table/drawer. */
export const LinkedListingSchema = z.object({
  linkId: id,
  marketplace: MarketplaceSchema,
  itemId: z.string(),
  variationId: z.number().nullable(),
  title: z.string().nullable(),
  /** Units of this product consumed per unit of the listing (combos > 1 component). */
  componentQuantity: z.number(),
  componentCount: z.number().int(),
  syncStatus: SyncStatusSchema,
  lastPushedQty: z.number().int().nullable(),
  lastObservedMlQty: z.number().int().nullable(),
});
export type LinkedListing = z.infer<typeof LinkedListingSchema>;

export const ProductRowSchema = z.object({
  id,
  ean: z.string().nullable(),
  sku: z.string().nullable(),
  name: z.string(),
  model: z.string(),
  category: z.string(),
  onHand: z.number(),
  inRepair: z.number(),
  unitCost: z.number(),
  minUnits: z.number().nullable(),
  syncMode: SyncModeSchema,
  /** Units sold per day over the recent window (forecast base); null when unknown. */
  dailyRate: z.number().nullable(),
  /** onHand / dailyRate; null when dailyRate is null or 0. */
  coverageDays: z.number().nullable(),
  linkedListings: z.number().int(),
  openAlerts: z.number().int(),
  archived: z.boolean(),
});
export type ProductRow = z.infer<typeof ProductRowSchema>;

export const ProductListInputSchema = z.object({
  query: z.string().max(200).optional(),
  category: z.string().optional(),
  includeArchived: z.boolean().default(false),
});
export type ProductListInput = z.infer<typeof ProductListInputSchema>;

export const MovementRowSchema = z.object({
  id,
  productId: id,
  type: MovementTypeSchema,
  quantity: z.number(),
  occurredAt: instant,
  recordedAt: instant,
  onHandAfter: z.number(),
  unitCostAfter: z.number(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  reason: z.string().nullable(),
  actor: ActorSchema,
});
export type MovementRow = z.infer<typeof MovementRowSchema>;

export const CostEntryRowSchema = z.object({
  id,
  effectiveFrom: instant,
  unitCost: z.number(),
  onHandAtChange: z.number(),
  reason: CostReasonSchema,
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  note: z.string().nullable(),
});
export type CostEntryRow = z.infer<typeof CostEntryRowSchema>;

export const ProductDetailSchema = z.object({
  product: ProductRowSchema,
  listings: z.array(LinkedListingSchema),
  recentMovements: z.array(MovementRowSchema),
  costHistory: z.array(CostEntryRowSchema),
});
export type ProductDetail = z.infer<typeof ProductDetailSchema>;

export const ManualAdjustInputSchema = z.object({
  productId: id,
  /** Signed delta in units. Must not be 0. */
  delta: z.number().refine((n) => n !== 0, "delta must not be 0"),
  reason: z.string().min(1).max(500),
  /** Client-generated; makes a double click harmless. */
  idempotencyKey: z.string().min(1).max(200),
});
export type ManualAdjustInput = z.infer<typeof ManualAdjustInputSchema>;

export const CreateProductInputSchema = z.object({
  ean: z.string().regex(/^\d{13}$/).nullable(),
  sku: z.string().max(100).nullable().default(null),
  name: z.string().min(1).max(300),
  model: z.string().max(200).default(""),
  category: z.string().max(100).default(""),
  minUnits: z.number().nonnegative().nullable().default(null),
});
export type CreateProductInput = z.infer<typeof CreateProductInputSchema>;

/** Link a listing (or variation) to one or more products. A simple listing has one component with quantity 1. */
export const LinkListingInputSchema = z.object({
  marketplace: MarketplaceSchema,
  itemId: z.string().min(1),
  variationId: z.number().int().nullable(),
  components: z.array(z.object({ productId: id, quantity: z.number().positive() })).min(1),
});
export type LinkListingInput = z.infer<typeof LinkListingInputSchema>;

/* ---------- Sync / push (router stockSync, S3; UI U5) ---------- */

export const SyncStatusRowSchema = z.object({
  linkId: id,
  marketplace: MarketplaceSchema,
  itemId: z.string(),
  variationId: z.number().nullable(),
  productNames: z.array(z.string()),
  /** Quantity we would send now = max(0, availableQuantity(components)). */
  desiredQty: z.number().int(),
  status: SyncStatusSchema,
  lastObservedMlQty: z.number().int().nullable(),
  lastObservedAt: instant.nullable(),
  lastPushedQty: z.number().int().nullable(),
  lastPushedAt: instant.nullable(),
  lastError: z.string().nullable(),
  mode: SyncModeSchema,
});
export type SyncStatusRow = z.infer<typeof SyncStatusRowSchema>;

export const PushLogRowSchema = z.object({
  id,
  marketplace: MarketplaceSchema,
  itemId: z.string(),
  variationId: z.number().nullable(),
  requestedQty: z.number().int(),
  previousMlQty: z.number().int().nullable(),
  mode: SyncModeSchema,
  result: PushResultSchema,
  httpStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  triggerType: PushTriggerSchema,
  triggerRef: z.string().nullable(),
  createdAt: instant,
});
export type PushLogRow = z.infer<typeof PushLogRowSchema>;

/** Shown before switching a product live: what ML has vs what we have. The user confirms or edits `openingStock`. */
export const GoLivePreviewSchema = z.object({
  productId: id,
  productName: z.string(),
  ourOnHand: z.number(),
  /** One entry per linked listing; null mlQty = could not be read. */
  listings: z.array(z.object({ linkId: id, itemId: z.string(), variationId: z.number().nullable(), mlQty: z.number().int().nullable() })),
});
export type GoLivePreview = z.infer<typeof GoLivePreviewSchema>;

export const GoLiveInputSchema = z.object({
  productId: id,
  /** Confirmed opening stock (may differ from ourOnHand; the delta is written as a manual_adjust). */
  openingStock: z.number(),
  idempotencyKey: z.string().min(1).max(200),
});
export type GoLiveInput = z.infer<typeof GoLiveInputSchema>;

/* ---------- Alerts (router stockAlerts, S7; UI U3) ---------- */

export const AlertRowSchema = z.object({
  id,
  type: AlertTypeSchema,
  status: AlertStatusSchema,
  productId: id.nullable(),
  productName: z.string().nullable(),
  marketplace: MarketplaceSchema.nullable(),
  itemId: z.string().nullable(),
  dedupeKey: z.string(),
  title: z.string(),
  detail: z.string(),
  quantity: z.number().nullable(),
  amount: z.number().nullable(),
  createdAt: instant,
  acknowledgedAt: instant.nullable(),
  resolvedAt: instant.nullable(),
  resolution: z.string().nullable(),
});
export type AlertRow = z.infer<typeof AlertRowSchema>;

export const AlertListInputSchema = z.object({
  status: z.array(AlertStatusSchema).default(["open", "acknowledged"]),
  type: z.array(AlertTypeSchema).optional(),
});
export type AlertListInput = z.infer<typeof AlertListInputSchema>;

/** Numeric badge for the dashboard ("N alertas"): open + acknowledged-not-resolved. */
export const AlertSummarySchema = z.object({ open: z.number().int(), total: z.number().int() });
export type AlertSummary = z.infer<typeof AlertSummarySchema>;

/* ---------- Returns (router stockReturns, S8; UI U4) ---------- */

export const ReturnRowSchema = z.object({
  id,
  marketplace: MarketplaceSchema,
  orderId: z.number(),
  lineNo: z.number().int(),
  productId: id,
  productName: z.string(),
  quantity: z.number(),
  outcome: ReturnOutcomeSchema,
  reason: z.string().nullable(),
  openedAt: instant,
  resolvedAt: instant.nullable(),
  note: z.string().nullable(),
});
export type ReturnRow = z.infer<typeof ReturnRowSchema>;

/** Allowed moves: pending → lost | in_repair | restocked; in_repair → restocked | lost. Others are rejected. */
export const ResolveReturnInputSchema = z.object({
  returnId: id,
  outcome: z.enum(["lost", "in_repair", "restocked"]),
  note: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(200),
});
export type ResolveReturnInput = z.infer<typeof ResolveReturnInputSchema>;

/* ---------- Invoices (router stockInvoices, S9; parser S2; UI U2) ---------- */

/** One line as read from the PDF by the parser (S2). Nothing is resolved yet. */
export const ParsedInvoiceLineSchema = z.object({
  lineNo: z.number().int().positive(),
  supplierCode: z.string(),
  /** Normalized GTIN-13, null when the line has none or it fails the check digit. */
  ean: z.string().nullable(),
  description: z.string(),
  quantity: z.number().positive(),
  /** Unit price before discount. */
  unitPrice: z.number(),
  /** Discount amount for the whole line (ARS), >= 0. */
  discount: z.number(),
  /** quantity * unitPrice - discount. */
  lineSubtotal: z.number(),
});
export type ParsedInvoiceLine = z.infer<typeof ParsedInvoiceLineSchema>;

export const ParsedInvoiceSchema = z.object({
  supplierName: z.string(),
  supplierTaxId: z.string(),
  number: z.string(),
  issueDate: day,
  currency: z.string().default("ARS"),
  subtotal: z.number(),
  ivaAmount: z.number(),
  perceptionsAmount: z.number(),
  otherTaxesAmount: z.number(),
  total: z.number(),
  lines: z.array(ParsedInvoiceLineSchema).min(1),
  /** Human-readable parser doubts (totals that do not add up, lines skipped, ...). Shown in the review. */
  warnings: z.array(z.string()).default([]),
});
export type ParsedInvoice = z.infer<typeof ParsedInvoiceSchema>;

/** Fields a manual match would fill on the product (only those missing today; never overwrites). */
export const ProductFillSchema = z.object({
  ean: z.string().nullable(),
  sku: z.string().nullable(),
  model: z.string().nullable(),
  category: z.string().nullable(),
});
export type ProductFill = z.infer<typeof ProductFillSchema>;

export const InvoiceReviewLineSchema = ParsedInvoiceLineSchema.extend({
  landedUnitCost: z.number(),
  resolution: LineResolutionSchema,
  productId: id.nullable(),
  productName: z.string().nullable(),
  /** Exactly what confirming will write into the matched product (empty when nothing). */
  willFill: ProductFillSchema.partial().default({}),
});
export type InvoiceReviewLine = z.infer<typeof InvoiceReviewLineSchema>;

/** The review screen payload. Nothing is written to stock until `confirm`. */
export const InvoiceReviewSchema = z.object({
  invoiceId: id,
  status: InvoiceStatusSchema,
  supplierName: z.string(),
  supplierTaxId: z.string(),
  number: z.string(),
  issueDate: day,
  currency: z.string(),
  subtotal: z.number(),
  ivaAmount: z.number(),
  perceptionsAmount: z.number(),
  otherTaxesAmount: z.number(),
  total: z.number(),
  /** total / subtotal unless overridden. */
  feeFactor: z.number(),
  feeFactorOverridden: z.boolean(),
  lines: z.array(InvoiceReviewLineSchema),
  warnings: z.array(z.string()),
  /** True when every line is resolved: the only condition to confirm. */
  canConfirm: z.boolean(),
});
export type InvoiceReview = z.infer<typeof InvoiceReviewSchema>;

export const InvoiceListRowSchema = z.object({
  invoiceId: id,
  supplierName: z.string(),
  number: z.string(),
  issueDate: day,
  total: z.number(),
  status: InvoiceStatusSchema,
  lineCount: z.number().int(),
  unresolvedLines: z.number().int(),
});
export type InvoiceListRow = z.infer<typeof InvoiceListRowSchema>;

export const ResolveInvoiceLineInputSchema = z.object({
  invoiceId: id,
  lineNo: z.number().int().positive(),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("match"), productId: id }),
    z.object({ kind: z.literal("create"), product: CreateProductInputSchema }),
  ]),
});
export type ResolveInvoiceLineInput = z.infer<typeof ResolveInvoiceLineInputSchema>;

export const SetFeeFactorInputSchema = z.object({
  invoiceId: id,
  /** null clears the override (back to total / subtotal). */
  feeFactor: z.number().positive().nullable(),
});
export type SetFeeFactorInput = z.infer<typeof SetFeeFactorInputSchema>;
