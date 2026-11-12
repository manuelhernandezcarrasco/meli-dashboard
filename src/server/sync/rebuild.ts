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
 * Every month we have anything for: stored snapshots, months whose orders were downloaded, the month
 * before the target (always compared against), and optionally everything from `from` ("YYYY-MM").
 * Sorted oldest first; the target month is always last.
 */
export async function monthsToRebuild(ownerId: string, now: Date, from?: string): Promise<string[]> {
  const target = targetMonth(now);
  const found = new Set<string>();
  const [snaps, periods] = await Promise.all([
    db.snapshot.findMany({ where: { accountId: ownerId }, select: { month: true } }),
    db.orderPeriod.findMany({ where: { accountId: ownerId }, select: { month: true } }),
  ]);
  for (const s of snaps) found.add(s.month);
  for (const p of periods) found.add(p.month);
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

/** Forgets that anything was fetched, so the next sync asks Mercado Libre / Mercado Pago again. */
async function markEverythingStale(ownerId: string): Promise<void> {
  const where = { accountId: ownerId };
  await db.$transaction([
    db.orderPeriod.updateMany({ where, data: { isFinal: false } }),
    db.shipment.updateMany({ where, data: { costFetchedAt: null } }),
    db.payment.updateMany({ where, data: { taxFetchedAt: null } }),
    db.listing.updateMany({ where, data: { gtinCheckedAt: null, catalogCheckedAt: null } }),
  ]);
}

/**
 * Re-computes every month (see `monthsToRebuild`) from the data we already have, so a change in
 * the calculation or in the product costs applies to history too, not only to the next sync.
 *
 * By default what was already downloaded (shipping, GTINs, taxes, closed-month orders) is reused,
 * so this is fast and makes few or no Mercado Libre calls. `refetch: true` marks all of it stale,
 * forcing a full re-download (slow, and subject to API rate limits); the old values stay in place
 * until the new ones arrive, so an interrupted refetch loses nothing.
 */
export async function rebuildAll(
  ownerId: string,
  opts: { now?: Date; refetch?: boolean; from?: string; onProgress?: (p: Partial<RebuildProgress>) => void } = {},
): Promise<RebuildResult> {
  const now = opts.now ?? new Date();
  if (opts.refetch) await markEverythingStale(ownerId);

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
