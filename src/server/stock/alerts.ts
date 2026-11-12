import { DashboardDataSchema, type DashboardData } from "~/lib/contracts";
import { missingCosts } from "~/lib/dashboard-math";
import { nowArg } from "~/lib/dates";
import type { AlertType } from "~/lib/stock-contracts";
import { loadBusinessConfig } from "~/server/config";
import * as store from "~/server/store/stockAlerts";
import type { AlertService, RaiseAlertInput } from "./contracts";
import { coverageOf, factsWindow } from "./forecast";

/* ---------- lifecycle (AlertService) ---------- */

/** Upsert by (accountId, dedupeKey) while not resolved. A resolved alert is never reopened: a new row is created. */
export const raiseAlert: AlertService["raiseAlert"] = (input: RaiseAlertInput) => store.upsertAlert(input);

/** Marks the open alert of the key resolved (no-op when none). */
export const resolveAlert: AlertService["resolveAlert"] = async (accountId, dedupeKey, resolution) => {
  await store.resolveByKey(accountId, dedupeKey, resolution);
};

export const acknowledgeAlert = (accountId: string, id: number) => store.acknowledgeById(accountId, id);

/** User resolution by id; returns false when it was already resolved or does not exist. */
export async function resolveAlertById(accountId: string, id: number, resolution: string): Promise<boolean> {
  const alert = await store.getAlert(accountId, id);
  const resolved = (await store.resolveByIds(accountId, [id], resolution)) > 0;
  if (resolved && alert?.type === "link_cost_review") await applyPendingAfterCostReview(accountId, alert);
  return resolved;
}

/**
 * The cost review of a new link is the gate for the sales parked while the listing was unlinked: once the person
 * accepts or edits the cost, those sales are applied (S4). Key: `link_cost_review:<marketplace>:<itemId>:<variationId|0>[:<productId>]`.
 */
async function applyPendingAfterCostReview(accountId: string, alert: Pick<store.StoredAlert, "itemId" | "dedupeKey">): Promise<void> {
  const [, , itemKey, variation] = alert.dedupeKey.split(":");
  const itemId = alert.itemId ?? itemKey;
  if (!itemId) return;
  const variationId = Number(variation);
  // lazy import: sales raises alerts, so a static import would be circular
  const { applyPendingForListing } = await import("./sales");
  await applyPendingForListing(accountId, itemId, Number.isInteger(variationId) && variationId > 0 ? variationId : null);
}

/* ---------- evaluator ---------- */

/** Types whose condition the evaluator derives from the ledger and therefore also clears. */
const LEDGER_TYPES: AlertType[] = ["out_of_stock", "negative_stock", "low_stock"];
const MARGIN_DROP_POINTS = 0.05;
const MARGIN_WINDOW_DAYS = 30;

interface Desired {
  type: AlertType;
  dedupeKey: string;
  title: string;
  detail: string;
  productId: number;
  quantity?: number;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Out of stock, negative and low stock per product, from one set-based read. Exported for tests. */
export function desiredStockAlerts(
  facts: store.ProductStockFacts[],
  w: ReturnType<typeof factsWindow>,
  cfg: { stockCriticoDias: number; stockBajoDias: number; reposicionDias: number },
): Desired[] {
  const out: Desired[] = [];
  for (const f of facts) {
    const base = { productId: f.productId };
    if (f.onHand <= 0 && f.linkCount > 0) {
      out.push({
        ...base, type: "out_of_stock", dedupeKey: `out_of_stock:${f.productId}`, quantity: f.onHand,
        title: `Sin stock: ${f.name}`,
        detail: `Tiene ${f.linkCount} publicación(es) vinculada(s) y quedan ${fmt(f.onHand)} unidades.`,
      });
    }
    if (f.onHand < 0) {
      out.push({
        ...base, type: "negative_stock", dedupeKey: `negative_stock:${f.productId}`, quantity: f.onHand,
        title: `Stock negativo: ${f.name}`,
        detail: `El stock es ${fmt(f.onHand)}. Antes de corregirlo, verificá que la migración desde Mercado Libre esté completa (stock inicial y compras cargadas).`,
      });
    }
    if (f.onHand > 0) {
      const cov = coverageOf(f, w, cfg.reposicionDias).coverageDays;
      const belowMin = f.minUnits !== null && f.onHand < f.minUnits;
      const critical = cov !== null && cov < cfg.stockCriticoDias;
      const low = cov !== null && cov < cfg.stockBajoDias;
      if (critical || low || belowMin) {
        const reasons: string[] = [];
        if (cov !== null && low) reasons.push(`alcanza para ${fmt(cov)} días`);
        if (belowMin) reasons.push(`por debajo del mínimo de ${fmt(f.minUnits!)} unidades`);
        out.push({
          ...base, type: "low_stock", dedupeKey: `low_stock:${f.productId}`, quantity: cov ?? f.onHand,
          title: `${critical ? "Stock crítico" : "Stock bajo"}: ${f.name}`,
          detail: `Quedan ${fmt(f.onHand)} unidades: ${reasons.join("; ")}.`,
        });
      }
    }
  }
  return out;
}

/**
 * Raises what is true and resolves (resolution "auto") what stopped being true, for the ledger-derived types,
 * margin drops and the push/drift alerts that S3 raises. Cheap: a handful of set-based reads, writes only on change.
 */
export async function evaluateAlerts(accountId: string, now = new Date()): Promise<{ raised: number; resolved: number }> {
  const cfg = loadBusinessConfig();
  const w = factsWindow(now);
  let raised = 0;
  let resolved = 0;

  // 1. ledger-derived
  const desired = desiredStockAlerts(await store.readStockFacts(accountId, w.window), w, cfg);
  const live = await store.readLiveAlerts(accountId, LEDGER_TYPES);
  const want = new Map(desired.map((d) => [d.dedupeKey, d]));
  const liveByKey = new Map(live.map((a) => [a.dedupeKey, a]));
  const stale = live.filter((a) => !want.has(a.dedupeKey)).map((a) => a.id);
  resolved += await store.resolveByIds(accountId, stale, "auto", now);
  for (const d of desired) {
    const cur = liveByKey.get(d.dedupeKey);
    if (cur && cur.title === d.title && cur.detail === d.detail && cur.quantity === (d.quantity ?? null)) continue;
    const r = await store.upsertAlert({ accountId, ...d });
    if (r.created) raised++;
  }

  // 2. margin drop after a cost change (once per cost entry)
  raised += await evaluateMarginDrops(accountId, now);

  // 3. alerts raised by S3: clear when the sync state recovered
  resolved += await autoResolveSyncAlerts(accountId, now);
  return { raised, resolved };
}

/**
 * Evaluator entry used by returns (S8): the evaluation is one set-based pass over the account, so the product
 * ids only document what changed.
 */
export async function evaluateProducts(accountId: string, _productIds?: number[]): Promise<void> {
  await evaluateAlerts(accountId);
}

async function evaluateMarginDrops(accountId: string, now: Date): Promise<number> {
  const t = nowArg(new Date(now.getTime() - MARGIN_WINDOW_DAYS * 86_400_000));
  const since = new Date(now.getTime() - MARGIN_WINDOW_DAYS * 86_400_000);
  const changes = await store.readRecentCostChanges(accountId, since);
  const prices = await store.readAvgUnitPrices(accountId, changes.flatMap((c) => (c.ean ? [c.ean] : [])), t.date);
  let n = 0;
  for (const c of changes) {
    const price = c.ean ? prices.get(c.ean) : undefined;
    if (!price || price <= 0) continue;
    const before = (price - c.previousCost) / price;
    const after = (price - c.newCost) / price;
    if (before - after <= MARGIN_DROP_POINTS) continue;
    const dedupeKey = `margin_drop:${c.productId}:${c.entryId}`;
    if (await store.keyEverUsed(accountId, dedupeKey)) continue; // once per cost change, even if the user resolved it
    await store.upsertAlert({
      accountId, type: "margin_drop", dedupeKey, productId: c.productId, quantity: after * 100, amount: c.newCost,
      title: `Bajó el margen: ${c.name}`,
      detail: `El costo pasó de $${c.previousCost.toFixed(2)} a $${c.newCost.toFixed(2)}. Con el precio promedio de los últimos ${MARGIN_WINDOW_DAYS} días ($${price.toFixed(2)}) el margen cae de ${(before * 100).toFixed(1)}% a ${(after * 100).toFixed(1)}%.`,
    });
    n++;
  }
  return n;
}

/** push_failed / stock_drift are raised elsewhere; here they are cleared when no link of the item has the problem. */
async function autoResolveSyncAlerts(accountId: string, now: Date): Promise<number> {
  const live = await store.readLiveAlerts(accountId, ["push_failed", "stock_drift"]);
  if (live.length === 0) return 0;
  const problems = await store.readProblemItems(accountId);
  const stale = live
    .filter((a) => a.itemId !== null && !(a.type === "push_failed" ? problems.failed : problems.drift).has(a.itemId))
    .map((a) => a.id);
  return store.resolveByIds(accountId, stale, "auto", now);
}

/* ---------- the four data-quality alerts (fed by the dashboard snapshot) ---------- */

const DataQualityInput = DashboardDataSchema.pick({ rows: true, suggestions: true, autoMatches: true, unmatched: true });
export type DataQualityInput = Pick<DashboardData, "rows" | "suggestions" | "autoMatches" | "unmatched">;

interface DqAlert { type: AlertType; dedupeKey: string; title: string; detail: string; itemId?: string; quantity?: number; amount?: number }

const DQ_TYPES: AlertType[] = ["suggested_match", "auto_match", "missing_cost", "unmatched_listing"];

/** The data-quality alerts that hold for a dashboard payload. Pure; same sources and logic as the old dashboard card. */
export function dataQualityAlerts(d: DataQualityInput, linkedItemIds: ReadonlySet<string> = new Set()): DqAlert[] {
  const out: DqAlert[] = [];
  for (const s of d.suggestions) {
    out.push({
      type: "suggested_match", dedupeKey: `suggested_match:${s.itemId}:${s.ean}`, itemId: s.itemId, quantity: s.score, amount: s.venta,
      title: `Posible coincidencia: ${s.title}`,
      detail: `¿La publicación ${s.itemId} es "${s.desc}" (EAN ${s.ean})? Similitud ${Math.round(s.score * 100)}%.`,
    });
  }
  for (const s of d.autoMatches) {
    out.push({
      type: "auto_match", dedupeKey: `auto_match:${s.itemId}:${s.ean}`, itemId: s.itemId, quantity: s.score, amount: s.venta,
      title: `Vinculada automáticamente: ${s.title}`,
      detail: `Se vinculó ${s.itemId} con "${s.desc}" (EAN ${s.ean}) por similitud de nombre (${Math.round(s.score * 100)}%). Confirmala o deshacela.`,
    });
  }
  for (const m of missingCosts(d.rows)) {
    out.push({
      type: "missing_cost", dedupeKey: `missing_cost:${m.key}`, quantity: m.qty, amount: m.venta,
      title: `Falta el costo: ${m.desc}`,
      detail: `${m.lines} venta(s) usan un costo supuesto. Cargá el costo real${m.ean ? ` (EAN ${m.ean})` : ""}.`,
    });
  }
  const suggested = new Set(d.suggestions.map((x) => x.itemId));
  for (const u of d.unmatched) {
    if (suggested.has(u.itemId) || linkedItemIds.has(u.itemId.toUpperCase())) continue;
    out.push({
      type: "unmatched_listing", dedupeKey: `unmatched_listing:${u.itemId}`, itemId: u.itemId, quantity: u.qty, amount: u.venta,
      title: `Publicación sin producto: ${u.title}`,
      detail: `${u.itemId} vendió ${u.qty} unidad(es) y no está vinculada a ningún producto.`,
    });
  }
  return out;
}

/** Raises the data-quality alerts of the latest snapshot and resolves (auto) the ones that no longer apply. */
export async function syncDataQualityAlerts(accountId: string, now = new Date()): Promise<{ raised: number; resolved: number }> {
  const parsed = DataQualityInput.safeParse(await store.readLatestSnapshotPayload(accountId));
  if (!parsed.success) return { raised: 0, resolved: 0 };
  const want = dataQualityAlerts(parsed.data, await store.readLinkedItemIds(accountId));
  const live = await store.readLiveAlerts(accountId, DQ_TYPES);
  const wantKeys = new Set(want.map((a) => a.dedupeKey));
  const resolved = await store.resolveByIds(accountId, live.filter((a) => !wantKeys.has(a.dedupeKey)).map((a) => a.id), "auto", now);
  let raised = 0;
  for (const a of want) {
    const r = await store.upsertAlert({ accountId, marketplace: a.itemId ? "mercadolibre" : undefined, ...a });
    if (r.created) raised++;
  }
  return { raised, resolved };
}

/* ---------- resolution forms (rendered by U3, written through S5 / S1) ---------- */

export interface FormField {
  name: string;
  label: string;
  kind: "product" | "number" | "text";
  required: boolean;
  /** Pre-filled from the alert. */
  defaultValue?: string | number;
}
export interface FormSpec {
  title: string;
  fields: FormField[];
  /** tRPC procedure the form posts to (not owned by S7); `context` is merged into the input. */
  submit: { procedure: string; label: string; context: Record<string, string | number | null> };
}

/** Form to resolve an alert that needs data, or null when the alert has none. */
export function resolutionForm(a: Pick<store.StoredAlert, "type" | "itemId" | "productId" | "dedupeKey">): FormSpec | null {
  switch (a.type) {
    case "unmatched_listing":
      return {
        title: "Vincular publicación a un producto",
        fields: [
          { name: "productId", label: "Producto", kind: "product", required: true },
          { name: "quantity", label: "Unidades por venta", kind: "number", required: true, defaultValue: 1 },
        ],
        submit: { procedure: "stockProducts.link", label: "Vincular", context: { marketplace: "mercadolibre", itemId: a.itemId, variationId: null } },
      };
    case "missing_cost":
      return {
        title: "Cargar costo",
        fields: [
          { name: "unitCost", label: "Costo unitario (ARS)", kind: "number", required: true },
          { name: "note", label: "Nota", kind: "text", required: false },
        ],
        submit: { procedure: "stockProducts.setCost", label: "Guardar costo", context: { alertKey: a.dedupeKey, productId: a.productId } },
      };
    default:
      return null;
  }
}
