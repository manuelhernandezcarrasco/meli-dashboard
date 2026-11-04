import { TRPCError } from "@trpc/server";
import { env } from "~/env";
import { DashboardDataSchema, type DashboardData } from "~/lib/contracts";
import { loadBusinessConfig } from "~/server/config";
import { db } from "~/server/db";
import { runSync } from "./run";
import { targetMonth } from "./rebuild";

export const COOLDOWN_SECONDS = 60;

export interface DashboardStatus {
  updatedAt: string;
  nextRefreshAt: string | null;
  cooldownSeconds: number;
  source: "demo" | "live";
  syncing: boolean;
  lastError?: string;
}

export interface SyncServiceDeps {
  ownerId: string;
  clock: () => Date;
  sync: (now: Date) => Promise<DashboardData>;
  refreshMinutes: () => number;
  source: "demo" | "live";
}

interface Stored {
  data: DashboardData;
  computedAt: Date;
}

/** The snapshot of the month the dashboard shows (other months are kept only as history). */
async function latestSnapshot(ownerId: string, now: Date): Promise<Stored | null> {
  const row = await db.snapshot.findUnique({
    where: { ownerId_month: { ownerId, month: targetMonth(now) } },
  });
  if (!row) return null;
  return { data: DashboardDataSchema.parse(row.payload), computedAt: row.computedAt };
}

export function createSyncService(deps: SyncServiceDeps) {
  let inFlight: Promise<DashboardData> | null = null;
  let lastStartedAt: number | null = null;
  let lastError: string | undefined;

  /** One sync at a time; concurrent callers share the same promise. */
  function start(): Promise<DashboardData> {
    if (inFlight) return inFlight;
    const now = deps.clock();
    lastStartedAt = now.getTime();
    inFlight = deps
      .sync(now)
      .then((d) => {
        lastError = undefined;
        return d;
      })
      .catch((e: unknown) => {
        lastError = e instanceof Error ? e.message : String(e);
        console.error(`[sync] falló: ${lastError}`);
        throw e;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  const cooldown = () =>
    lastStartedAt === null
      ? 0
      : Math.max(0, Math.ceil(COOLDOWN_SECONDS - (deps.clock().getTime() - lastStartedAt) / 1000));

  async function getDashboard(): Promise<DashboardData> {
    const snap = await latestSnapshot(deps.ownerId, deps.clock());
    if (!snap) return start();
    const ageMs = deps.clock().getTime() - snap.computedAt.getTime();
    if (ageMs > deps.refreshMinutes() * 60_000) {
      void start().catch(() => undefined); // errors surface through status().lastError
    }
    return snap.data;
  }

  async function forceRefresh(): Promise<DashboardData> {
    const wait = cooldown();
    if (wait > 0) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Espere ${wait} s` });
    }
    return start();
  }

  async function status(): Promise<DashboardStatus> {
    const snap = await latestSnapshot(deps.ownerId, deps.clock());
    return {
      updatedAt: snap?.data.updatedAt ?? "",
      nextRefreshAt: snap
        ? new Date(snap.computedAt.getTime() + deps.refreshMinutes() * 60_000).toISOString()
        : null,
      cooldownSeconds: cooldown(),
      source: deps.source,
      syncing: inFlight !== null,
      ...(lastError ? { lastError } : {}),
    };
  }

  /** Recompute now, skipping the cooldown (a person just changed what the numbers depend on). */
  const recompute = (): Promise<DashboardData> => start();

  return { getDashboard, forceRefresh, recompute, status };
}

export type SyncService = ReturnType<typeof createSyncService>;

const g = globalThis as unknown as { syncServices?: Map<string, SyncService> };

/** One service per user, process-wide (survives Next dev HMR). */
export function getSyncService(ownerId: string): SyncService {
  g.syncServices ??= new Map();
  let svc = g.syncServices.get(ownerId);
  if (!svc) {
    svc = createSyncService({
      ownerId,
      clock: () => new Date(),
      sync: (now) => runSync(ownerId, now),
      refreshMinutes: () => loadBusinessConfig().refreshMinutes,
      source: env.DATA_SOURCE,
    });
    g.syncServices.set(ownerId, svc);
  }
  return svc;
}
