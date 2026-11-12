/**
 * S6 — one-time cutover from the P&L workbook, and later Excel uploads as cost+stock events.
 *
 * Stock and cost change only through the S1 ledger (`appendMovement`); products are created through the S5 store.
 */
import { toArgParts } from "~/lib/dates";
import { createProduct, DuplicateEanError } from "~/server/store/inventoryProducts";
import {
  countLinks, getCutoverAt, productsByEan, readSnapshotProducts, setCutoverAtOnce, type SnapshotProduct,
} from "~/server/store/stockCutover";
import { appendMovement } from "./ledger";
import { linking } from "./linking";
import type { AppendMovementInput } from "./contracts";

export class CutoverError extends Error {
  constructor(readonly code: "NO_SNAPSHOT" | "CUTOVER_DATE_MISMATCH", message: string) {
    super(message);
    this.name = "CutoverError";
  }
}

export interface CutoverDeps {
  appendMovement: (i: AppendMovementInput) => Promise<unknown>;
  autoLink: (accountId: string) => Promise<{ linkIds: number[] }>;
  unlinkedCount: (accountId: string) => Promise<number>;
}

const defaultDeps: CutoverDeps = {
  appendMovement,
  autoLink: (a) => linking.autoLink(a),
  unlinkedCount: async (a) => (await linking.unlinkedListings(a)).length,
};

export interface CutoverReport {
  cutoverAt: string;
  /** True when the cutover had already run (with the same date) and this call only filled gaps. */
  alreadyDone: boolean;
  productsCreated: number;
  productsExisting: number;
  listingsLinked: number;
  listingsUnlinked: number;
}

interface ResetBase {
  accountId: string; productId: number; occurredAt: Date; idempotencyKey: string; refType: string; refId: string;
  reason: string; actor: "system" | "user";
}

/**
 * Sets stock and cost through `excel_reset`. The database refuses a zero-quantity movement, so when only the cost
 * changes the cost entry is written with a +1 / -1 pair of resets (net stock 0); when nothing changes, nothing is written.
 */
async function resetTo(
  deps: CutoverDeps, b: ResetBase, now: { onHand: number; unitCost: number }, target: { stock: number; unitCost: number },
): Promise<boolean> {
  const delta = target.stock - now.onHand;
  if (delta !== 0) {
    await deps.appendMovement({ ...b, type: "excel_reset", quantity: delta, unitCost: target.unitCost });
    return true;
  }
  if (target.unitCost === now.unitCost) return false;
  const reason = `${b.reason} (solo cambia el costo)`;
  await deps.appendMovement({ ...b, reason, type: "excel_reset", quantity: 1, unitCost: target.unitCost, idempotencyKey: `${b.idempotencyKey}:up` });
  await deps.appendMovement({ ...b, reason, type: "excel_reset", quantity: -1, unitCost: target.unitCost, idempotencyKey: `${b.idempotencyKey}:down` });
  return true;
}

/** Creates the product and its opening stock + cost through the ledger. False when the EAN already has a product. */
async function seedProduct(accountId: string, p: SnapshotProduct, at: Date, keyPrefix: string, reason: string, deps: CutoverDeps): Promise<boolean> {
  let id: number;
  try {
    id = (await createProduct(accountId, { name: p.description || p.ean, ean: p.ean, model: p.model, category: p.category })).id;
  } catch (e) {
    if (e instanceof DuplicateEanError) return false;
    throw e;
  }
  const base = {
    accountId, productId: id, occurredAt: at, idempotencyKey: `${keyPrefix}:${p.ean}`,
    refType: "cutover", refId: p.ean, reason, actor: "system" as const,
  };
  const unitCost = Math.max(0, p.unitCost);
  // initial_count only accepts a positive quantity; an empty or negative opening stock is a reset to that number
  if (p.stockFinal > 0) await deps.appendMovement({ ...base, type: "initial_count", quantity: p.stockFinal, unitCost });
  else await resetTo(deps, base, { onHand: 0, unitCost: 0 }, { stock: p.stockFinal, unitCost });
  return true;
}

/**
 * Imports the account's current P&L snapshot as the ledger's starting point. Idempotent for the same date;
 * a different `cutoverAt` once one is set is refused.
 */
export async function runCutover(
  accountId: string, opts: { cutoverAt: Date }, deps: CutoverDeps = defaultDeps,
): Promise<CutoverReport> {
  const snapshot = await readSnapshotProducts(accountId);
  if (snapshot.length === 0) throw new CutoverError("NO_SNAPSHOT", "Subí primero el Excel del P&L: no hay productos para importar.");
  const existingDate = await getCutoverAt(accountId);
  if (existingDate && existingDate.getTime() !== opts.cutoverAt.getTime()) {
    throw new CutoverError("CUTOVER_DATE_MISMATCH", `El corte ya se hizo el ${existingDate.toISOString()}; no se puede cambiar la fecha.`);
  }
  const at = await setCutoverAtOnce(accountId, opts.cutoverAt);

  let created = 0;
  let existing = 0;
  for (const p of snapshot) {
    if (await seedProduct(accountId, p, at, "cutover", "Corte inicial: stock y costo del P&L", deps)) created++;
    else existing++;
  }
  await deps.autoLink(accountId);
  const [linked, unlinked] = await Promise.all([countLinks(accountId), deps.unlinkedCount(accountId)]);
  return {
    cutoverAt: at.toISOString(), alreadyDone: existingDate !== null, productsCreated: created, productsExisting: existing,
    listingsLinked: linked, listingsUnlinked: unlinked,
  };
}

export interface ExcelEventReport { reset: number; created: number }

/**
 * A P&L upload after the cutover: each EAN already in the ledger gets an `excel_reset` (cost = CU Pond., stock =
 * Stock final) effective at upload time; new EANs become products as in the cutover. No-op before the cutover.
 * A CU Pond. of 0 means "no cost in the workbook": the stock is set but the current cost is kept.
 */
export async function applyExcelEvents(
  accountId: string, products: SnapshotProduct[], upload: { fileName: string; uploadedAt: Date }, deps: CutoverDeps = defaultDeps,
): Promise<ExcelEventReport | null> {
  if (!(await getCutoverAt(accountId))) return null;
  const { date } = toArgParts(upload.uploadedAt.toISOString());
  const reason = `Excel ${upload.fileName} ${date}: costo y stock`;
  const stamp = upload.uploadedAt.getTime();
  const byEan = await productsByEan(accountId);
  const report: ExcelEventReport = { reset: 0, created: 0 };
  for (const p of products) {
    const known = byEan.get(p.ean);
    if (!known) {
      if (await seedProduct(accountId, p, upload.uploadedAt, `excel:${stamp}`, reason, deps)) report.created++;
      continue;
    }
    const wrote = await resetTo(
      deps,
      {
        accountId, productId: known.id, occurredAt: upload.uploadedAt, idempotencyKey: `excel:${stamp}:${p.ean}`,
        refType: "excel_upload", refId: upload.fileName, reason, actor: "user",
      },
      known, { stock: p.stockFinal, unitCost: p.unitCost > 0 ? p.unitCost : known.unitCost },
    );
    if (wrote) report.reset++;
  }
  if (report.created > 0) await deps.autoLink(accountId);
  return report;
}
