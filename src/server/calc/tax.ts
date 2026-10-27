import type { Line, PrevCierre } from "~/lib/contracts";

/** "auto" branch of `run_sync` (legacy 1263–1278). `prevLines` must be built with tax pct 0. */
export function calibrateTaxPct(prevLines: Line[], prevCierre: PrevCierre): number {
  const ml = prevLines.filter((l) => l.channel === "ML");
  const v0 = ml.reduce((s, l) => s + l.venta, 0);
  const c0 = ml.reduce((s, l) => s + l.cargoVenta + l.envio, 0);
  if (!v0 || !prevCierre.costoMl) return 0;
  const pct = Math.max(0, Math.min(0.15, (prevCierre.costoMl - c0) / v0));
  return Math.round(pct * 10000) / 10000;
}

/** `um` block of `run_sync` (legacy 1291–1299). */
export function unmatchedFrom(lines: Line[]) {
  const um = new Map<
    string,
    { itemId: string; sku: string; title: string; qty: number; venta: number }
  >();
  for (const l of lines) {
    if (l.channel !== "ML" || l.cat !== "SIN MATCH") continue;
    const u = um.get(l.itemId) ?? {
      itemId: l.itemId,
      sku: l.sku,
      title: l.titleMl,
      qty: 0,
      venta: 0,
    };
    u.qty += l.qty;
    u.venta += l.venta;
    um.set(l.itemId, u);
  }
  return [...um.values()].sort((a, b) => b.venta - a.venta).slice(0, 30);
}
