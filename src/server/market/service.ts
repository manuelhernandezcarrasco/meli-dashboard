import { TRPCError } from "@trpc/server";

import { buildResearch } from "~/server/market/stats";
import { MlClient } from "~/server/ml";
import { MlMarketClient } from "~/server/ml/market";
import { MERCADOLIBRE } from "~/server/store/marketplace";
import { loadLatestScan, saveScan } from "~/server/store/market";

import { MARKET_TTL_MS, type MarketPoint, type MarketResearch, type MarketState } from "~/lib/market";

export type { MarketPoint, MarketResearch, MarketState };
export { MARKET_TTL_MS };

/** Seconds a failed job blocks a retry through `touch`. */
export const MARKET_RETRY_COOLDOWN_S = 30;

/** Injected dependencies: T9 (fetchPoints), T8 (buildResearch), store, clock. */
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

/** Store backed by `MarketScan` / `MarketOffer`: loads the latest scan, saving appends a new one. */
export function prismaMarketStore(ownerId: string): MarketDeps["store"] {
  return {
    load: (catalogProductId) => loadLatestScan(ownerId, MERCADOLIBRE, catalogProductId),
    save: (r) => saveScan(ownerId, MERCADOLIBRE, r),
  };
}

export function getMarketService(ownerId: string): MarketService {
  const client = new MlClient(ownerId);
  const market = new MlMarketClient(ownerId);
  return createMarketService(ownerId, {
    fetchPoints: (id, sellerId) => market.fetchMarketPoints(id, sellerId),
    buildResearch,
    ourSellerId: () => client.getSellerId(),
    store: prismaMarketStore(ownerId),
    now: () => new Date(),
  });
}
