import { TRPCError } from "@trpc/server";
import { env } from "~/env";
import { DashboardDataSchema, type DashboardData } from "~/lib/contracts";
import { loadBusinessConfig } from "~/server/config";
import { db } from "~/server/db";
import { runSync } from "./run";

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
  clock: () => Date;
  sync: (now: Date) => Promise<DashboardData>;
  refreshMinutes: () => number;
  source: "demo" | "live";
}

interface Stored {
  data: DashboardData;
  computedAt: Date;
}

async function latestSnapshot(): Promise<Stored | null> {
  const row = await db.snapshot.findFirst({ orderBy: { computedAt: "desc" } });
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
    const snap = await latestSnapshot();
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
    const snap = await latestSnapshot();
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

  return { getDashboard, forceRefresh, status };
}

export type SyncService = ReturnType<typeof createSyncService>;

const g = globalThis as unknown as { syncService?: SyncService };

/** Process-wide singleton (survives Next dev HMR). */
export function getSyncService(): SyncService {
  g.syncService ??= createSyncService({
    clock: () => new Date(),
    sync: (now) => runSync(now),
    refreshMinutes: () => loadBusinessConfig().refreshMinutes,
    source: env.DATA_SOURCE,
  });
  return g.syncService;
}
