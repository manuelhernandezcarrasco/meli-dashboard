/** Today in Argentina (fixed UTC-3) as "YYYY-MM-DD". */
export function todayAr(now: Date = new Date()): string {
  return new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → ISO instant at 00:00 Argentina time, or null when it is not a real date. */
export function cutoverIso(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00-03:00`);
  if (Number.isNaN(d.getTime())) return null;
  return todayAr(d) === day ? d.toISOString() : null; // rejects e.g. 2026-02-31 that Date would roll over
}

/** ISO instant → "dd/mm/aaaa" in Argentina time. */
export function fmtCutoverDate(iso: string): string {
  const [y, m, d] = new Date(new Date(iso).getTime() - 3 * 3_600_000).toISOString().slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}
