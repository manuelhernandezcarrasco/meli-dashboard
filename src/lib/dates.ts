/** Argentina is a fixed UTC-3 (no DST). */
export const ARG_OFFSET_HOURS = -3;

const MESES = [
  "",
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
] as const;

const p2 = (n: number) => String(n).padStart(2, "0");

export interface ArgParts {
  date: string;
  time: string;
  y: number;
  m: number;
  d: number;
}

export function partsOfDate(dt: Date): ArgParts {
  const a = new Date(dt.getTime() + ARG_OFFSET_HOURS * 3600_000);
  const y = a.getUTCFullYear();
  const m = a.getUTCMonth() + 1;
  const d = a.getUTCDate();
  return {
    date: `${y}-${p2(m)}-${p2(d)}`,
    time: `${p2(a.getUTCHours())}:${p2(a.getUTCMinutes())}`,
    y,
    m,
    d,
  };
}

/** Argentina instants as Mercado Libre writes them: `2026-09-01T23:05:00.000-03:00`. */
export function toArgIso(dt: Date): string {
  const a = new Date(dt.getTime() + ARG_OFFSET_HOURS * 3600_000);
  return (
    `${a.getUTCFullYear()}-${p2(a.getUTCMonth() + 1)}-${p2(a.getUTCDate())}` +
    `T${p2(a.getUTCHours())}:${p2(a.getUTCMinutes())}:${p2(a.getUTCSeconds())}.` +
    `${String(a.getUTCMilliseconds()).padStart(3, "0")}-03:00`
  );
}

/** First instant of Argentine month (y, m) and of the next one: `[start, end)`. */
export function monthRangeArg(y: number, m: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(y, m - 1, 1, 3)),
    end: new Date(Date.UTC(y + (m === 12 ? 1 : 0), m % 12, 1, 3)),
  };
}

/** Converts an ISO 8601 string (any offset) to Argentina date/time. */
export function toArgParts(iso: string): ArgParts {
  return partsOfDate(new Date(iso));
}

export function nowArg(now: Date = new Date()): ArgParts {
  return partsOfDate(now);
}

export function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function prevYm(y: number, m: number): [number, number] {
  return m === 1 ? [y - 1, 12] : [y, m - 1];
}

export function monthLabel(y: number, m: number): string {
  return `${MESES[m]} ${y}`;
}
