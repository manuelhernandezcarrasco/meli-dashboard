// STUB (T10): verbatim copy of docs/tickets/MARKET-CONTRACTS.md types. T8 owns this file; dedupe on merge.
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
export const MARKET_MAX_SELLERS = 500;
