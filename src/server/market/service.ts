import { TRPCError } from "@trpc/server";

import { db } from "~/server/db";
import { MlClient } from "~/server/ml";

/*
 * SEAM: these types/constants are copied verbatim from docs/tickets/MARKET-CONTRACTS.md.
 * Once T8 merges, delete this block and `export type {...}`/import from "~/lib/market" instead.
 */
export type MarketPoint = {
  itemId: string;
  sellerId: number;
  sellerNickname: string;
  title: string;
  price: number;
  soldQuantity: number;
  soldExact: boolean;
  permalink: string;
  isOurs: boolean;
};
export type RegressionMode = "log" | "linear";
export type Regression = { mode: RegressionMode; slope: number; intercept: number; r2: number; n: number };
export type MarketResearch = {
  catalogProductId: string;
  catalogTitle: string;
  points: MarketPoint[];
  excluded: { point: MarketPoint; reason: "price_outlier" | "sales_outlier" | "cap" }[];
  regression: { log: Regression | null; linear: Regression | null };
  fetchedAt: string;
};
export type MarketState =
  | { status: "none" }
  | { status: "running"; data: MarketResearch | null; startedAt: string }
  | { status: "ready"; data: MarketResearch }
  | { status: "failed"; data: MarketResearch | null; error: string };
export const MARKET_TTL_MS = 15 * 60_000;

/** Seconds a failed job blocks a retry through `touch`. */
export const MARKET_RETRY_COOLDOWN_S = 30;

/*
 * SEAM: injected dependencies. Real implementations come from T9 (fetchPoints) and T8
 * (buildResearch); their exact signatures are adapted in `defaultDeps` below once merged.
 */
export interface MarketDeps {
  /** T9: every seller's offer for the catalog product, as raw points. */
  fetchPoints(catalogProductId: string, ourSellerId: number): Promise<{ catalogTitle: string; points: MarketPoint[] }>;
  /** T8: outlier removal, cap and regressions. */
  buildResearch(input: {
    catalogProductId: string;
    catalogTitle: string;
    points: MarketPoint[];
    fetchedAt: string;
  }): MarketResearch;
  ourSellerId(): Promise<number>;
  store: {
    load(catalogProductId: string): Promise<MarketResearch | null>;
    save(research: MarketResearch): Promise<void>;
  };
  now(): Date;
}

export interface MarketService {
  get(catalogProductId: string): Promise<MarketState>;
  touch(catalogProductId: string): Promise<MarketState>;
}

interface Job { startedAt: string }
interface Failure { error: string; failedAt: number }

/** In-process job tracking, shared across service instances (same style as `rebuild`). */
const g = globalThis as unknown as { marketJobs?: Map<string, Job>; marketFailures?: Map<string, Failure> };
const jobs = () => (g.marketJobs ??= new Map());
const failures = () => (g.marketFailures ??= new Map());

export function createMarketService(ownerId: string, deps: MarketDeps): MarketService {
  const key = (id: string) => `${ownerId}:${id}`;

  async function get(catalogProductId: string): Promise<MarketState> {
    const k = key(catalogProductId);
    const data = await deps.store.load(catalogProductId);
    const job = jobs().get(k);
    if (job) return { status: "running", data, startedAt: job.startedAt };
    const fail = failures().get(k);
    if (fail) return { status: "failed", data, error: fail.error };
    return data ? { status: "ready", data } : { status: "none" };
  }

  async function run(catalogProductId: string): Promise<void> {
    const sellerId = await deps.ourSellerId();
    const { catalogTitle, points } = await deps.fetchPoints(catalogProductId, sellerId);
    const research = deps.buildResearch({
      catalogProductId,
      catalogTitle,
      points,
      fetchedAt: deps.now().toISOString(),
    });
    await deps.store.save(research);
  }

  async function touch(catalogProductId: string): Promise<MarketState> {
    const k = key(catalogProductId);
    // Everything up to jobs().set is synchronous, so concurrent touches can't both start a job.
    const current = await get(catalogProductId);
    if (current.status === "running") return current;
    if (
      current.status === "ready" &&
      deps.now().getTime() - Date.parse(current.data.fetchedAt) <= MARKET_TTL_MS
    ) {
      return current;
    }

    if (jobs().has(k)) return get(catalogProductId); // lost the race to a concurrent touch
    const fail = failures().get(k);
    if (fail) {
      const wait = Math.ceil(MARKET_RETRY_COOLDOWN_S - (deps.now().getTime() - fail.failedAt) / 1000);
      if (wait > 0) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Espere ${wait} s` });
    }
    jobs().set(k, { startedAt: deps.now().toISOString() });
    failures().delete(k);
    void run(catalogProductId)
      .catch((e: unknown) => {
        failures().set(k, { error: e instanceof Error ? e.message : String(e), failedAt: deps.now().getTime() });
      })
      .finally(() => {
        jobs().delete(k);
      });
    return get(catalogProductId);
  }

  return { get, touch };
}

/** Prisma-backed store. */
export function prismaMarketStore(ownerId: string): MarketDeps["store"] {
  return {
    async load(catalogProductId) {
      const row = await db.marketResearch.findUnique({
        where: { ownerId_catalogProductId: { ownerId, catalogProductId } },
      });
      return row ? (row.payload as unknown as MarketResearch) : null;
    },
    async save(r) {
      const payload = r as unknown as object;
      await db.marketResearch.upsert({
        where: { ownerId_catalogProductId: { ownerId, catalogProductId: r.catalogProductId } },
        create: { ownerId, catalogProductId: r.catalogProductId, payload, fetchedAt: new Date(r.fetchedAt) },
        update: { payload, fetchedAt: new Date(r.fetchedAt) },
      });
    },
  };
}

/**
 * SEAM: wire T9 `fetchPoints` and T8 `buildResearch` here once merged. Until then the job fails
 * with a clear message instead of calling ML.
 */
export function getMarketService(ownerId: string): MarketService {
  const client = new MlClient(ownerId);
  return createMarketService(ownerId, {
    fetchPoints: () => Promise.reject(new Error("fetchPoints (T9) is not wired yet")),
    buildResearch: () => {
      throw new Error("buildResearch (T8) is not wired yet");
    },
    ourSellerId: () => client.getSellerId(),
    store: prismaMarketStore(ownerId),
    now: () => new Date(),
  });
}
