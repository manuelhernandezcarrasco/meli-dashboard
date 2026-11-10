export type MarketPoint = {
  itemId: string; // MLA…
  sellerId: number;
  sellerNickname: string;
  title: string;
  price: number; // ARS
  soldQuantity: number | null; // null = unknown (other sellers' items are closed to us); else exact if soldExact, else lower bound of ML bucket
  soldExact: boolean;
  permalink: string;
  isOurs: boolean; // sellerId === our ML user id
};

export type RegressionMode = "log" | "linear";
export type Regression = {
  mode: RegressionMode;
  slope: number;
  intercept: number;
  r2: number;
  n: number;
};

export type MarketResearch = {
  catalogProductId: string;
  catalogTitle: string;
  points: MarketPoint[]; // outliers already removed, capped (see T8)
  excluded: {
    point: MarketPoint;
    reason: "price_outlier" | "sales_outlier" | "cap";
  }[];
  regression: { log: Regression | null; linear: Regression | null }; // null when n < 3
  fetchedAt: string; // ISO, when ML data was pulled
};

export type MarketState =
  | { status: "none" } // never researched
  | { status: "running"; data: MarketResearch | null; startedAt: string } // data = previous result, if any
  | { status: "ready"; data: MarketResearch }
  | { status: "failed"; data: MarketResearch | null; error: string };

export const MARKET_TTL_MS = 15 * 60_000; // staleness + client re-poll interval
export const MARKET_MAX_SELLERS = 500; // cap applied in T8
