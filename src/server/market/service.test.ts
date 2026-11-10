import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/ml", () => ({ MlClient: class {} }));

import {
  createMarketService, MARKET_TTL_MS, type MarketDeps, type MarketResearch, type MarketService,
} from "./service";

const CAT = "MLA1";
let clock = new Date("2026-11-10T12:00:00Z").getTime();
let stored: MarketResearch | null;
let fetchPoints: ReturnType<typeof vi.fn<MarketDeps["fetchPoints"]>>;
let release: (() => void) | null;
let nextFetchFails: boolean;
let owner = 0;

const research = (fetchedAt: string): MarketResearch => ({
  catalogProductId: CAT, catalogTitle: "T", points: [], excluded: [],
  regression: { log: null, linear: null }, fetchedAt,
});

function make(): MarketService {
  const deps: MarketDeps = {
    fetchPoints: (...a) => fetchPoints(...a),
    buildResearch: (i) => research(i.fetchedAt),
    ourSellerId: () => Promise.resolve(7),
    store: {
      load: () => Promise.resolve(stored),
      save: (r) => { stored = r; return Promise.resolve(); },
    },
    now: () => new Date(clock),
  };
  return createMarketService(`owner${owner}`, deps);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  owner++; // fresh in-process job maps per test
  stored = null;
  nextFetchFails = false;
  release = null;
  fetchPoints = vi.fn<MarketDeps["fetchPoints"]>(
    () => new Promise((resolve, reject) => {
      release = () => (nextFetchFails ? reject(new Error("boom")) : resolve({ catalogTitle: "T", points: [] }));
    }),
  );
});

describe("MarketService", () => {
  it("touch with no data starts one job and reports running", async () => {
    const s = make();
    const st = await s.touch(CAT);
    expect(st.status).toBe("running");
    expect(fetchPoints).toHaveBeenCalledTimes(1);
    release!(); await flush();
    expect((await s.get(CAT)).status).toBe("ready");
  });

  it("10 concurrent touches -> 1 fetch", async () => {
    const s = make();
    await Promise.all(Array.from({ length: 10 }, () => s.touch(CAT)));
    expect(fetchPoints).toHaveBeenCalledTimes(1);
    release!(); await flush();
  });

  it("fresh data does not fetch", async () => {
    stored = research(new Date(clock - 60_000).toISOString());
    const st = await make().touch(CAT);
    expect(st.status).toBe("ready");
    expect(fetchPoints).not.toHaveBeenCalled();
  });

  it("stale data fetches and running carries the old data", async () => {
    stored = research(new Date(clock - MARKET_TTL_MS - 1).toISOString());
    const old = stored;
    const st = await make().touch(CAT);
    expect(st).toMatchObject({ status: "running", data: old });
    expect(fetchPoints).toHaveBeenCalledTimes(1);
    release!(); await flush();
  });

  it("failure keeps old data, reports failed, and blocks retry for 30 s", async () => {
    stored = research(new Date(clock - MARKET_TTL_MS - 1).toISOString());
    const old = stored;
    const s = make();
    nextFetchFails = true;
    await s.touch(CAT);
    release!(); await flush();
    expect(await s.get(CAT)).toEqual({ status: "failed", data: old, error: "boom" });
    expect(stored).toBe(old);

    clock += 10_000;
    await expect(s.touch(CAT)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(fetchPoints).toHaveBeenCalledTimes(1);

    clock += 21_000;
    nextFetchFails = false;
    expect((await s.touch(CAT)).status).toBe("running");
    expect(fetchPoints).toHaveBeenCalledTimes(2);
    release!(); await flush();
    expect((await s.get(CAT)).status).toBe("ready");
  });

  it("get never fetches", async () => {
    const s = make();
    expect(await s.get(CAT)).toEqual({ status: "none" });
    stored = research(new Date(clock - 10 * MARKET_TTL_MS).toISOString());
    expect((await s.get(CAT)).status).toBe("ready");
    expect(fetchPoints).not.toHaveBeenCalled();
  });
});
