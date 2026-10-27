import { daysIn, monthLabel, nowArg, prevYm } from "~/lib/dates";
import type { Line, PrevCierre, Totals } from "~/lib/contracts";
import { acum, dailySeries } from "./series";

const round2 = (x: number) => Math.round(x * 100) / 100;

export interface Comparison {
  prevLabel: string;
  prevCierre: Totals;
  prevDaily: Totals[];
  nDays: number;
  prevToday: Totals | null;
  cutTime: string | null;
  prevAccumAtCut: Totals;
  cutDay: number;
  curDaily: Totals[];
}

/** Cut day as `run_sync` (non-demo) derives it (legacy 1303–1308). */
export function cutDayFor(lines: Line[], y: number, m: number, now: Date): number {
  const nDays = daysIn(y, m);
  const t = nowArg(now);
  if (t.y === y && t.m === m) return t.d;
  if (t.y * 12 + t.m > y * 12 + m) return nDays;
  return lines.reduce((mx, l) => Math.max(mx, Number(l.date.slice(8, 10))), 0) || nDays;
}

/** Port of the `comp` block (legacy 1301–1334); `now` and `cutDay` are parameters. */
export function buildComparison(args: {
  lines: Line[];
  prevLines: Line[];
  prevCierre: PrevCierre;
  y: number;
  m: number;
  now: Date;
  cutDay: number;
}): Comparison {
  const { lines, prevLines, y, m, now, cutDay } = args;
  const [py, pm] = prevYm(y, m);
  const prevDaily = dailySeries(prevLines, py, pm);
  let prevCierre = args.prevCierre;
  if (!prevCierre.venta && !prevCierre.cogs) prevCierre = acum(prevDaily, prevDaily.length);

  // the day in progress compares the previous month up to the same time of day
  const t = nowArg(now);
  const inProgress = t.y === y && t.m === m && cutDay === t.d;
  let prevToday: Totals | null = null;
  if (inProgress && cutDay <= prevDaily.length) {
    const part = prevLines.filter(
      (l) => Number(l.date.slice(8, 10)) === cutDay && (l.time || "00:00") <= t.time,
    );
    prevToday = dailySeries(part, py, pm)[cutDay - 1]!;
  }

  let prevAccumAtCut = acum(prevDaily, Math.min(cutDay, prevDaily.length));
  if (prevToday) {
    prevAccumAtCut = acum(prevDaily, cutDay - 1);
    for (const k of Object.keys(prevAccumAtCut) as (keyof Totals)[]) {
      prevAccumAtCut[k] += prevToday[k];
    }
  }

  const rounded = { ...prevCierre };
  for (const k of Object.keys(rounded) as (keyof Totals)[]) rounded[k] = round2(rounded[k]);

  return {
    prevLabel: monthLabel(py, pm),
    prevCierre: rounded,
    prevDaily,
    nDays: daysIn(y, m),
    prevToday,
    cutTime: prevToday ? t.time : null,
    prevAccumAtCut,
    cutDay,
    curDaily: dailySeries(lines, y, m),
  };
}
