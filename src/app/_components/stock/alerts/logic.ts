import type { AlertRow, AlertStatus, AlertType, LinkListingInput } from "~/lib/stock-contracts";

export type Severity = "neg" | "warn" | "info";

export const TYPE_LABEL: Record<AlertType, string> = {
  negative_stock: "Stock negativo",
  out_of_stock: "Sin stock",
  push_failed: "Envío a ML fallido",
  stock_drift: "Diferencia con ML",
  low_stock: "Stock bajo",
  margin_drop: "Caída de margen",
  missing_cost: "Costo faltante",
  link_cost_review: "Confirmar costo",
  unmatched_listing: "Publicación sin vincular",
  unmatched_sale: "Venta sin vincular",
  suggested_match: "Vínculo sugerido",
  auto_match: "Vínculo automático",
};

export const TYPE_SEVERITY: Record<AlertType, Severity> = {
  negative_stock: "neg", out_of_stock: "neg", push_failed: "neg", stock_drift: "neg",
  low_stock: "warn", margin_drop: "warn", missing_cost: "warn", link_cost_review: "warn",
  unmatched_listing: "warn", unmatched_sale: "warn",
  suggested_match: "info", auto_match: "info",
};

const SEVERITY_ORDER: Record<Severity, number> = { neg: 0, warn: 1, info: 2 };
const TYPE_ORDER = Object.keys(TYPE_LABEL) as AlertType[];

export const SEVERITY_CLASS: Record<Severity, { dot: string; chip: string }> = {
  neg: { dot: "bg-neg", chip: "bg-negbg text-neg" },
  warn: { dot: "bg-warn", chip: "bg-warnbg text-warn" },
  info: { dot: "bg-blue", chip: "bg-line text-navy" },
};

/** Status filter options of the UI; "active" = open + acknowledged (the router default). */
export type StatusFilter = "active" | "open" | "acknowledged" | "resolved";
export const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Activas" },
  { value: "open", label: "Abiertas" },
  { value: "acknowledged", label: "Reconocidas" },
  { value: "resolved", label: "Resueltas" },
];
export const statusesOf = (f: StatusFilter): AlertStatus[] =>
  f === "active" ? ["open", "acknowledged"] : [f];

export interface AlertGroup { type: AlertType; label: string; severity: Severity; rows: AlertRow[] }

/** Groups by type (most severe first, then most numerous); rows newest first. */
export function groupAlerts(rows: AlertRow[]): AlertGroup[] {
  const by = new Map<AlertType, AlertRow[]>();
  for (const r of rows) by.set(r.type, [...(by.get(r.type) ?? []), r]);
  return [...by.entries()]
    .map(([type, list]) => ({
      type, label: TYPE_LABEL[type], severity: TYPE_SEVERITY[type],
      rows: [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id),
    }))
    .sort((a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.rows.length - a.rows.length
      || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
}

/** "hace 5 min" / "hace 3 h" / "hace 2 d". */
export function ageLabel(iso: string, now: number): string {
  const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.floor(min / 60)} h`;
  return `hace ${Math.floor(min / 1440)} d`;
}

/** Mercado Libre item page ("MLA123" -> MLA-123). */
export function listingUrl(itemId: string): string {
  const m = /^([A-Z]{3})(\d+)$/.exec(itemId);
  return `https://articulo.mercadolibre.com.ar/${m ? `${m[1]}-${m[2]}` : itemId}`;
}

/** The product drawer lives in the products tab (U1) and opens from `?producto=<id>`. */
export const productHref = (productId: number): string => `/stock/products?producto=${productId}`;

/* ---------- validation + payloads (pure so every form is testable) ---------- */

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const num = (s: string): number => (s.trim() === "" ? NaN : Number(s.replace(",", ".")));

export function checkCost(s: string): Checked<number> {
  const n = num(s);
  if (!Number.isFinite(n)) return { ok: false, error: "Ingresá un costo" };
  if (n <= 0) return { ok: false, error: "El costo debe ser mayor a 0" };
  return { ok: true, value: n };
}

export function checkAdjust(delta: string, reason: string): Checked<{ delta: number; reason: string }> {
  const d = num(delta);
  if (!Number.isFinite(d) || d === 0) return { ok: false, error: "Ingresá una cantidad distinta de 0" };
  if (reason.trim() === "") return { ok: false, error: "El motivo es obligatorio" };
  return { ok: true, value: { delta: d, reason: reason.trim() } };
}

export function checkQuantity(s: string): Checked<number> {
  const n = num(s);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "La cantidad debe ser mayor a 0" };
  return { ok: true, value: n };
}

export interface NewProduct { ean: string | null; sku: string | null; name: string }
export function checkNewProduct(f: { name: string; gtin: string; sku: string }): Checked<NewProduct> {
  const name = f.name.trim();
  if (name === "") return { ok: false, error: "El nombre es obligatorio" };
  const gtin = f.gtin.trim();
  if (gtin !== "" && !/^\d{13}$/.test(gtin)) return { ok: false, error: "El GTIN debe tener 13 dígitos" };
  return { ok: true, value: { name, ean: gtin === "" ? null : gtin, sku: f.sku.trim() === "" ? null : f.sku.trim() } };
}

export function linkInput(itemId: string, variationId: number | null, productId: number, quantity: number): LinkListingInput {
  return { marketplace: "mercadolibre", itemId, variationId, components: [{ productId, quantity }] };
}
