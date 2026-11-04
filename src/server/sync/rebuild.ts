import { nowArg } from "~/lib/dates";
import { db } from "~/server/db";
import { runSync } from "./run";

export interface RebuildResult {
  months: string[];
  failed: { month: string; error: string }[];
}

/**
 * Re-computes every stored snapshot (all months we have, plus the current one) from the data we
 * already have, so a change in the calculation applies to history too, not only to the next sync.
 *
 * By default the API cache (shipping, GTINs, taxes, closed-month orders) is kept, so this is fast
 * and makes few or no Mercado Libre calls. `refetch: true` also wipes that cache, forcing a full
 * re-download (slow, and subject to API rate limits).
 */
export async function rebuildAll(
  ownerId: string,
  opts: { now?: Date; refetch?: boolean } = {},
): Promise<RebuildResult> {
  const now = opts.now ?? new Date();
  const t = nowArg(now);
  const current = `${t.y}-${String(t.m).padStart(2, "0")}`;

  if (opts.refetch) await db.apiCache.deleteMany({ where: { ownerId } });

  const stored = await db.snapshot.findMany({ where: { ownerId }, select: { month: true } });
  // Current month last: getDashboard serves the newest `computedAt`, which must stay the current one.
  const months = [...new Set(stored.map((s) => s.month))].filter((m) => m !== current).sort();
  months.push(current);

  const result: RebuildResult = { months: [], failed: [] };
  for (const [i, month] of months.entries()) {
    const computedAt = new Date(now.getTime() - (months.length - 1 - i) * 1000);
    try {
      await runSync(ownerId, now, { month, computedAt });
      result.months.push(month);
    } catch (e) {
      result.failed.push({ month, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
