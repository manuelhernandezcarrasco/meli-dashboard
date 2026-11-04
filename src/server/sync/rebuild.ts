import { nowArg, prevYm } from "~/lib/dates";
import { loadBusinessConfig } from "~/server/config";
import { db } from "~/server/db";
import { runSync } from "./run";

export interface RebuildResult {
  months: string[];
  failed: { month: string; error: string }[];
}

export interface RebuildProgress extends RebuildResult {
  running: boolean;
  total: number;
  current: string | null;
  finishedAt: string | null;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** The month the dashboard shows: the configured one, else the current one (Argentina time). */
export function targetMonth(now: Date): string {
  const cfg = loadBusinessConfig();
  if (cfg.mes) return cfg.mes;
  const t = nowArg(now);
  return `${t.y}-${p2(t.m)}`;
}

/**
 * Every month we have anything for: stored snapshots, months whose orders are cached, the month
 * before the target (always compared against), and optionally everything from `from` ("YYYY-MM").
 * Sorted oldest first; the target month is always last.
 */
export async function monthsToRebuild(ownerId: string, now: Date, from?: string): Promise<string[]> {
  const target = targetMonth(now);
  const found = new Set<string>();
  for (const s of await db.snapshot.findMany({ where: { ownerId }, select: { month: true } })) found.add(s.month);
  const cached = await db.apiCache.findMany({
    where: { ownerId, key: { startsWith: "orders:" } },
    select: { key: true },
  });
  for (const c of cached) found.add(c.key.slice("orders:".length));
  const [ty, tm] = target.split("-").map(Number) as [number, number];
  const [py, pm] = prevYm(ty, tm);
  found.add(`${py}-${p2(pm)}`);
  if (from && /^\d{4}-\d{2}$/.test(from)) {
    let [y, m] = from.split("-").map(Number) as [number, number];
    while (`${y}-${p2(m)}` < target) {
      found.add(`${y}-${p2(m)}`);
      [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    }
  }
  return [...found].filter((x) => /^\d{4}-\d{2}$/.test(x) && x < target).sort().concat(target);
}

/**
 * Re-computes every month (see `monthsToRebuild`) from the data we already have, so a change in
 * the calculation or in the product costs applies to history too, not only to the next sync.
 *
 * By default the API cache (shipping, GTINs, taxes, closed-month orders) is kept, so this is fast
 * and makes few or no Mercado Libre calls. `refetch: true` also wipes that cache, forcing a full
 * re-download (slow, and subject to API rate limits).
 */
export async function rebuildAll(
  ownerId: string,
  opts: { now?: Date; refetch?: boolean; from?: string; onProgress?: (p: Partial<RebuildProgress>) => void } = {},
): Promise<RebuildResult> {
  const now = opts.now ?? new Date();
  if (opts.refetch) await db.apiCache.deleteMany({ where: { ownerId } });

  const months = await monthsToRebuild(ownerId, now, opts.from);
  const result: RebuildResult = { months: [], failed: [] };
  opts.onProgress?.({ total: months.length });
  for (const [i, month] of months.entries()) {
    // Target month last, and newest `computedAt`: the dashboard serves the target month's snapshot.
    const computedAt = new Date(now.getTime() - (months.length - 1 - i) * 1000);
    opts.onProgress?.({ current: month });
    try {
      await runSync(ownerId, now, { month, computedAt });
      result.months.push(month);
    } catch (e) {
      result.failed.push({ month, error: e instanceof Error ? e.message : String(e) });
    }
    opts.onProgress?.({ months: [...result.months], failed: [...result.failed] });
  }
  return result;
}

const g = globalThis as unknown as { rebuildJobs?: Map<string, RebuildProgress> };
const IDLE: RebuildProgress = { running: false, total: 0, current: null, months: [], failed: [], finishedAt: null };

export function rebuildStatus(ownerId: string): RebuildProgress {
  return g.rebuildJobs?.get(ownerId) ?? IDLE;
}

/**
 * Runs `rebuildAll` in the background (a full history can take minutes: far longer than an HTTP
 * request may last) and returns at once; poll `rebuildStatus`. One job per user at a time.
 */
export function startRebuild(
  ownerId: string,
  opts: { refetch?: boolean; from?: string } = {},
): RebuildProgress {
  g.rebuildJobs ??= new Map();
  const cur = rebuildStatus(ownerId);
  if (cur.running) return cur;
  const job: RebuildProgress = { ...IDLE, running: true };
  g.rebuildJobs.set(ownerId, job);
  void rebuildAll(ownerId, { ...opts, onProgress: (p) => Object.assign(job, p) })
    .catch((e: unknown) => {
      job.failed.push({ month: "*", error: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      job.running = false;
      job.current = null;
      job.finishedAt = new Date().toISOString();
    });
  return job;
}
