import type { CostReason, MovementType, ProductRow } from "~/lib/stock-contracts";

export const fmtNum = (n: number, digits = 0) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: digits }).format(n);
export const fmtSigned = (n: number) => (n > 0 ? "+" : "") + fmtNum(n, 2);
export const fmtArs = (n: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 }).format(n);
export const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(iso));

export type StockState = "none" | "negative" | "critical" | "low" | "ok";
export const STATE_LABEL: Record<StockState, string> = {
  none: "Sin stock", negative: "Negativo", critical: "Crítico", low: "Bajo", ok: "OK",
};
export const STATE_TONE: Record<StockState, string> = {
  none: "bg-negbg text-neg", negative: "bg-negbg text-neg", critical: "bg-warnbg text-warn",
  low: "bg-warnbg text-warn", ok: "bg-posbg text-pos",
};
export const CRITICAL_DAYS = 7;
export const LOW_DAYS = 15;

/** Same buckets as the old stock table: <7 days of cover (or under half the minimum) is critical, <15 low. */
export function stockState(p: Pick<ProductRow, "onHand" | "minUnits" | "coverageDays">): StockState {
  if (p.onHand < 0) return "negative";
  if (p.onHand === 0) return "none";
  const min = p.minUnits ?? 0;
  if ((p.coverageDays !== null && p.coverageDays < CRITICAL_DAYS) || (min > 0 && p.onHand < min / 2)) return "critical";
  if ((p.coverageDays !== null && p.coverageDays < LOW_DAYS) || (min > 0 && p.onHand <= min)) return "low";
  return "ok";
}

export const breakDate = (coverageDays: number | null, now = new Date()): string | null =>
  coverageDays === null
    ? null
    : new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", timeZone: "America/Argentina/Buenos_Aires" })
        .format(new Date(now.getTime() + coverageDays * 86_400_000));

export const FORECAST_TIP = "Cobertura = stock ÷ ritmo de ventas (unidades por día, ventana reciente).";

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  initial_count: "Conteo inicial", purchase_in: "Compra", sale: "Venta", sale_cancel: "Venta cancelada",
  return_restock: "Devolución a stock", repair_in: "A reparación", repair_out: "De reparación", loss: "Pérdida",
  manual_adjust: "Ajuste manual", excel_reset: "Reinicio por Excel",
};
export const COST_REASON_LABEL: Record<CostReason, string> = {
  invoice: "Factura", excel: "Excel", initial: "Inicial", manual: "Manual",
};
export const FILL_LABEL: Record<string, string> = {
  ean: "EAN", sku: "SKU", name: "Nombre", model: "Modelo", category: "Categoría",
};
