/**
 * S9 — invoice service: PDF → reviewable draft → atomic apply to the ledger.
 *
 * Nothing is written to stock until `confirm`. The review model (`getDraft`) shows exactly what confirm will do,
 * including the projected stock and weighted cost, computed with the same pure functions the ledger uses.
 */
import { Prisma } from "../../../generated/prisma";

import type { InvoiceListRow, InvoiceReview, InvoiceReviewLine, ProductFill, PushTrigger, CreateProductInput } from "~/lib/stock-contracts";
import { parseInvoicePdf } from "~/server/invoices/parse";
import { createProduct, DuplicateEanError, eanIndex, getProductIdentities, type ProductIdentity } from "~/server/store/inventoryProducts";
import { db } from "~/server/db";
import * as store from "~/server/store/stockInvoices";
import { evaluateAlerts } from "./alerts";
import { StockError, type Decimal, type PushTriggerInfo } from "./contracts";
import { weightedAverageCost } from "./costing";
import { requestPush } from "./push";

/** Duplicate upload: carries the existing invoice so the UI can link to it. */
export class DuplicateInvoiceError extends StockError {
  constructor(readonly existingInvoiceId: number, message: string) {
    super("INVOICE_DUPLICATE", message);
  }
}

export interface InvoiceDeps {
  parse: typeof parseInvoicePdf;
  push: (accountId: string, productIds: number[], trigger: PushTriggerInfo) => Promise<void>;
  evaluateAlerts: (accountId: string) => Promise<unknown>;
  now: () => Date;
}

const defaultDeps: InvoiceDeps = {
  parse: parseInvoicePdf,
  push: requestPush,
  evaluateAlerts: (a) => evaluateAlerts(a),
  now: () => new Date(),
};

export interface SuggestedProduct {
  productId: number; name: string; ean: string | null; onHand: number; unitCost: number;
  /** What matching this line to the product would fill (only what is empty today). */
  willFill: Partial<ProductFill>;
}

export interface DraftLine extends InvoiceReviewLine {
  /** Landed total of the line = quantity × landed unit cost. */
  landedTotal: number;
  /** Product state now; null when unresolved. */
  current: { onHand: number; unitCost: number } | null;
  /** State after this invoice, replaying the lines in order (several lines may hit one product). */
  projected: { onHand: number; unitCost: number } | null;
  diff: { stock: number; cost: number; costPct: number | null } | null;
  suggestions: SuggestedProduct[];
}

export interface DraftReview extends Omit<InvoiceReview, "lines"> {
  lines: DraftLine[];
  sourceFileName: string;
  /** Sentence-ready, e.g. "impuestos y percepciones: +27,00 %, no se descuenta IVA". */
  feeSentence: string;
  unresolvedCount: number;
  /** ISO timestamp the invoice was applied; null for drafts. */
  appliedAt: string | null;
  /** Spanish reason why confirm is blocked; null when it is not. */
  blockedReason: string | null;
}

const AR = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function feeSentence(feeFactor: number, overridden: boolean): string {
  const pct = (feeFactor - 1) * 100;
  const signed = `${pct >= 0 ? "+" : "−"}${AR.format(Math.abs(pct))} %`;
  return overridden
    ? `factor ajustado a mano: ${signed} sobre el precio, no se descuenta IVA`
    : `impuestos y percepciones: ${signed}, no se descuenta IVA`;
}

const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((t) => t.length >= 3));

/** What a manual match would fill: only fields the product lacks (never overwrites). */
export function fillPlan(
  line: { ean: string | null; supplierCode: string },
  product: { ean: string | null; sku: string | null },
  eanOwners: ReadonlyMap<string, number>,
): Partial<ProductFill> {
  const f: Partial<ProductFill> = {};
  if (!product.ean && line.ean && !eanOwners.has(line.ean)) f.ean = line.ean;
  if (!product.sku && line.supplierCode.trim()) f.sku = line.supplierCode.trim();
  return f;
}

const num = (d: Decimal) => d.toNumber();

const TOLERANCE = 0.05;

/**
 * The parser's warnings are not persisted (no column), so the checks that only need stored numbers are re-derived.
 * `createDraft` also returns the parser's full list once, right after the upload.
 */
function storedWarnings(inv: store.InvoiceRecord): string[] {
  const out: string[] = [];
  const expected = inv.subtotal.add(inv.ivaAmount).add(inv.perceptionsAmount).add(inv.otherTaxesAmount);
  if (expected.sub(inv.total).abs().gt(TOLERANCE)) {
    out.push(`Subtotal + impuestos (${expected.toFixed(2)}) no coincide con el total (${inv.total.toFixed(2)}).`);
  }
  for (const l of inv.lines) {
    if (l.quantity.mul(l.unitPrice).sub(l.discount).sub(l.lineSubtotal).abs().gt(TOLERANCE)) {
      out.push(`Línea ${l.lineNo}: cantidad × precio − descuento no coincide con el subtotal de la línea.`);
    }
  }
  return out;
}

export function createInvoiceService(over: Partial<InvoiceDeps> = {}) {
  const deps: InvoiceDeps = { ...defaultDeps, ...over };

  async function createDraft(accountId: string, file: { name: string; buffer: Buffer }): Promise<{ invoiceId: number; warnings: string[] }> {
    const parsed = await deps.parse(file.buffer);
    const existing = await store.findByNumber(accountId, parsed.supplierTaxId, parsed.number);
    if (existing !== null) {
      throw new DuplicateInvoiceError(existing, `La factura ${parsed.number} de ${parsed.supplierName} ya está cargada.`);
    }
    const byEan = await eanIndex(accountId);
    const resolved = new Map<number, number>();
    for (const l of parsed.lines) {
      const pid = l.ean ? byEan.get(l.ean) : undefined;
      if (pid !== undefined) resolved.set(l.lineNo, pid);
    }
    try {
      return { invoiceId: await store.insertDraft(accountId, parsed, file.name.slice(0, 200), resolved), warnings: parsed.warnings };
    } catch (e) {
      // Lost a race with a concurrent upload of the same invoice.
      if (e instanceof StockError && e.code === "INVOICE_DUPLICATE") {
        const id = await store.findByNumber(accountId, parsed.supplierTaxId, parsed.number);
        if (id !== null) throw new DuplicateInvoiceError(id, e.message);
      }
      throw e;
    }
  }

  async function load(accountId: string, invoiceId: number) {
    const inv = await store.getInvoice(accountId, invoiceId);
    if (!inv) throw new StockError("INVOICE_NOT_DRAFT", `Factura ${invoiceId} no existe`);
    return inv;
  }

  async function getDraft(accountId: string, invoiceId: number): Promise<DraftReview> {
    const inv = await load(accountId, invoiceId);
    const ids = [...new Set(inv.lines.flatMap((l) => (l.productId === null ? [] : [l.productId])))];
    const products = await getProductIdentities(accountId, ids);
    const balances = await db.inventoryProduct.findMany({
      where: { accountId, id: { in: ids } }, select: { id: true, onHand: true, unitCost: true },
    });
    const running = new Map(balances.map((b) => [Number(b.id), { onHand: b.onHand as Decimal, unitCost: b.unitCost as Decimal }]));
    const now = new Map(balances.map((b) => [Number(b.id), { onHand: num(b.onHand), unitCost: num(b.unitCost) }]));
    const eanOwners = await eanIndex(accountId);

    const needsSuggestions = inv.lines.some((l) => l.productId === null);
    const catalog = needsSuggestions && inv.status === "draft"
      ? await db.inventoryProduct.findMany({ where: { accountId, archivedAt: null } })
      : [];

    const lines: DraftLine[] = inv.lines.map((l) => {
      const base = {
        lineNo: l.lineNo, supplierCode: l.supplierCode, ean: l.ean, description: l.description, quantity: num(l.quantity),
        unitPrice: num(l.unitPrice), discount: num(l.discount), lineSubtotal: num(l.lineSubtotal),
        landedUnitCost: num(l.landedUnitCost), landedTotal: num(l.landedUnitCost.mul(l.quantity)), resolution: l.resolution,
      };
      if (l.productId === null) {
        const lt = tokens(`${l.description} ${l.supplierCode}`);
        const suggestions = catalog
          .map((p) => {
            const pt = tokens(`${p.name} ${p.model} ${p.sku ?? ""}`);
            let score = [...lt].filter((t) => pt.has(t)).length;
            if (l.supplierCode && p.sku && p.sku.toLowerCase() === l.supplierCode.toLowerCase()) score += 5;
            return { p, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
          .slice(0, 5)
          .map(({ p }): SuggestedProduct => ({
            productId: Number(p.id), name: p.name, ean: p.ean, onHand: num(p.onHand), unitCost: num(p.unitCost),
            willFill: fillPlan(l, p, eanOwners),
          }));
        return { ...base, productId: null, productName: null, willFill: {}, current: null, projected: null, diff: null, suggestions };
      }
      const p = products.get(l.productId) as ProductIdentity | undefined;
      const state = running.get(l.productId);
      const cur = now.get(l.productId);
      let projected: DraftLine["projected"] = null;
      let diff: DraftLine["diff"] = null;
      if (state && cur) {
        const cost = weightedAverageCost({ onHand: state.onHand, oldCost: state.unitCost, qtyIn: l.quantity, landedUnitCost: l.landedUnitCost });
        const onHand = state.onHand.add(l.quantity);
        running.set(l.productId, { onHand, unitCost: cost });
        projected = { onHand: num(onHand), unitCost: num(cost) };
        diff = {
          stock: projected.onHand - cur.onHand, cost: projected.unitCost - cur.unitCost,
          costPct: cur.unitCost > 0 ? (projected.unitCost - cur.unitCost) / cur.unitCost : null,
        };
      }
      const willFill = inv.status === "draft" && p && l.resolution !== "created_product"
        ? fillPlan(l, { ean: p.ean, sku: p.sku }, eanOwners) : {};
      return { ...base, productId: l.productId, productName: p?.name ?? null, willFill, current: cur ?? null, projected, diff, suggestions: [] };
    });

    const unresolvedCount = lines.filter((l) => l.productId === null).length;
    const feeFactor = num(inv.feeFactor);
    const canConfirm = inv.status === "draft" && unresolvedCount === 0 && lines.length > 0;
    return {
      invoiceId: inv.id, status: inv.status, supplierName: inv.supplierName, supplierTaxId: inv.supplierTaxId, number: inv.number,
      issueDate: inv.issueDate, currency: inv.currency, subtotal: num(inv.subtotal), ivaAmount: num(inv.ivaAmount),
      perceptionsAmount: num(inv.perceptionsAmount), otherTaxesAmount: num(inv.otherTaxesAmount), total: num(inv.total),
      feeFactor, feeFactorOverridden: inv.feeFactorOverridden, lines,
      warnings: storedWarnings(inv),
      canConfirm, sourceFileName: inv.sourceFileName, feeSentence: feeSentence(feeFactor, inv.feeFactorOverridden),
      unresolvedCount, appliedAt: inv.appliedAt?.toISOString() ?? null,
      blockedReason: inv.status !== "draft" ? "La factura ya fue aplicada." : unresolvedCount > 0
        ? `Faltan ${unresolvedCount} línea(s) por asignar a un producto (o saltearlas).` : lines.length === 0 ? "No quedan líneas para aplicar." : null,
    };
  }

  async function list(accountId: string): Promise<(InvoiceListRow & { appliedAt: string | null })[]> {
    return (await store.listInvoices(accountId)).map((r) => ({
      invoiceId: r.id, supplierName: r.supplierName, number: r.number, issueDate: r.issueDate, total: num(r.total),
      status: r.status, appliedAt: r.appliedAt?.toISOString() ?? null, lineCount: r.lineCount, unresolvedLines: r.unresolvedLines,
    }));
  }

  async function setFeeFactor(accountId: string, invoiceId: number, feeFactor: number | null): Promise<void> {
    await store.setFeeFactor(accountId, invoiceId, feeFactor === null ? null : new Prisma.Decimal(feeFactor));
  }

  async function matchLine(accountId: string, invoiceId: number, lineNo: number, productId: number): Promise<void> {
    await store.setLineProduct(accountId, invoiceId, lineNo, productId, "manual_match");
  }

  async function createProductFromLine(accountId: string, invoiceId: number, lineNo: number, input: CreateProductInput): Promise<{ productId: number }> {
    return db.$transaction(async (tx) => {
      const inv = await store.getInvoice(accountId, invoiceId, tx);
      if (!inv || inv.status !== "draft") throw new StockError("INVOICE_NOT_DRAFT", `La factura ${invoiceId} no es un borrador`);
      if (!inv.lines.some((l) => l.lineNo === lineNo)) throw new StockError("INVALID_QUANTITY", `La factura no tiene la línea ${lineNo}`);
      const p = await createProduct(accountId, input, tx);
      await store.setLineProduct(accountId, invoiceId, lineNo, p.id, "created_product", tx);
      return { productId: p.id };
    });
  }

  async function skipLine(accountId: string, invoiceId: number, lineNo: number): Promise<void> {
    await store.deleteLine(accountId, invoiceId, lineNo);
  }

  async function confirm(accountId: string, invoiceId: number): Promise<{ applied: boolean }> {
    const r = await store.applyDraft(accountId, invoiceId, deps.now());
    if (!r.applied) return { applied: false };
    // After commit: the invoice is applied whatever happens next, so follow-ups must not fail the call.
    const trigger: PushTriggerInfo = { type: "invoice" satisfies PushTrigger, ref: String(invoiceId) };
    await deps.push(accountId, r.productIds, trigger).catch((e) => console.error("[stock] push after invoice failed", e));
    await deps.evaluateAlerts(accountId).catch((e) => console.error("[stock] alert evaluation after invoice failed", e));
    return { applied: true };
  }

  async function discard(accountId: string, invoiceId: number): Promise<void> {
    await store.deleteDraft(accountId, invoiceId);
  }

  return { createDraft, getDraft, list, setFeeFactor, matchLine, createProductFromLine, skipLine, confirm, discard };
}

export type InvoiceService = ReturnType<typeof createInvoiceService>;

let service: InvoiceService | undefined;
export const getInvoiceService = (): InvoiceService => (service ??= createInvoiceService());
/** Test seam / wiring point. */
export const configureInvoiceService = (over: Partial<InvoiceDeps>): void => { service = createInvoiceService(over); };
export { DuplicateEanError };
