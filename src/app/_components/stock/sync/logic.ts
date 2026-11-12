import type {
  AlertRow, ProductRow, PushLogRow, PushResult, PushTrigger, SyncMode, SyncStatusRow,
} from "~/lib/stock-contracts";

export const RESULT_LABEL: Record<PushResult, string> = {
  ok: "OK", failed: "Falló", skipped: "Omitido", dry_run: "Simulado",
};
export const MODE_LABEL: Record<SyncMode, string> = { dry_run: "Simulación", live: "En vivo" };
export const TRIGGER_LABEL: Record<PushTrigger, string> = {
  sale: "Venta", invoice: "Factura", adjust: "Ajuste", reconcile: "Conciliación", manual: "Manual",
};

export interface LogFilters {
  result: PushResult | "all";
  mode: SyncMode | "all";
  /** Free text matched against the listing id (case-insensitive). */
  listing: string;
}
export const NO_FILTERS: LogFilters = { result: "all", mode: "all", listing: "" };

export function filterLog(rows: PushLogRow[], f: LogFilters): PushLogRow[] {
  const q = f.listing.trim().toUpperCase();
  return rows.filter(
    (r) =>
      (f.result === "all" || r.result === f.result) &&
      (f.mode === "all" || r.mode === f.mode) &&
      (q === "" || r.itemId.toUpperCase().includes(q)),
  );
}

export type BlockReason = "negative" | "drift" | "alerts";
export const BLOCK_LABEL: Record<BlockReason, string> = {
  negative: "Stock negativo",
  drift: "Diferencia con Mercado Libre sin resolver",
  alerts: "Alertas sin resolver",
};

export interface ProductReadiness {
  product: ProductRow;
  blocked: BlockReason[];
}

/** Products that can be switched live need links; blockers are listed, never hidden. */
export function classifyProducts(
  products: ProductRow[], alerts: AlertRow[], status: SyncStatusRow[],
): { ready: ProductReadiness[]; blocked: ProductReadiness[]; live: ProductRow[] } {
  const driftNames = new Set(status.filter((s) => s.status === "drift").flatMap((s) => s.productNames));
  const alertsOf = new Map<number, AlertRow[]>();
  for (const a of alerts) {
    if (a.productId === null || a.status === "resolved") continue;
    alertsOf.set(a.productId, [...(alertsOf.get(a.productId) ?? []), a]);
  }
  const ready: ProductReadiness[] = [];
  const blocked: ProductReadiness[] = [];
  const live: ProductRow[] = [];
  for (const p of products) {
    if (p.archived || p.linkedListings === 0) continue;
    if (p.syncMode === "live") { live.push(p); continue; }
    const mine = alertsOf.get(p.id) ?? [];
    const reasons: BlockReason[] = [];
    if (p.onHand < 0) reasons.push("negative");
    if (driftNames.has(p.name) || mine.some((a) => a.type === "stock_drift")) reasons.push("drift");
    if (mine.some((a) => a.type !== "stock_drift" && a.type !== "negative_stock") || (p.openAlerts > 0 && mine.length === 0)) {
      reasons.push("alerts");
    }
    (reasons.length ? blocked : ready).push({ product: p, blocked: reasons });
  }
  return { ready, blocked, live };
}

export interface OpeningEdit { productId: number; ours: number; opening: number; reason: string }

/** Validation of wizard step 2: a changed opening stock needs a reason. */
export function editsValid(edits: OpeningEdit[]): boolean {
  return edits.every((e) => Number.isFinite(e.opening) && (e.opening === e.ours || e.reason.trim().length > 0));
}

/** Adjust payloads (stockProducts.adjustStock) for the edited ones; unchanged products produce none. */
export function adjustPayloads(edits: OpeningEdit[], runKey: string) {
  return edits
    .filter((e) => e.opening !== e.ours)
    .map((e) => ({
      productId: e.productId,
      delta: e.opening - e.ours,
      reason: e.reason.trim(),
      idempotencyKey: `golive-adjust:${runKey}:${e.productId}`,
    }));
}

/** Confirmations for stockSync.goLive; the opening stock is the confirmed value (adjustment already written). */
export function goLivePayload(edits: OpeningEdit[], runKey: string) {
  return {
    confirmations: edits.map((e) => ({
      productId: e.productId, openingStock: e.opening, idempotencyKey: `golive:${runKey}:${e.productId}`,
    })),
  };
}

export function lastObserved(status: SyncStatusRow[]): string | null {
  const times = status.map((s) => s.lastObservedAt).filter((t): t is string => t !== null);
  return times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
}

/** "Lo que se enviaría ahora": simulated listings whose desired quantity differs from what ML had. */
export function dryRunRows(status: SyncStatusRow[]): (SyncStatusRow & { differs: boolean })[] {
  return status
    .filter((s) => s.mode === "dry_run")
    .map((s) => ({ ...s, differs: s.lastObservedMlQty === null || s.lastObservedMlQty !== s.desiredQty }));
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
