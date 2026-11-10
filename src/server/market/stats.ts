import {
  MARKET_MAX_SELLERS,
  type MarketPoint,
  type MarketResearch,
  type Regression,
  type RegressionMode,
} from "~/lib/market";

/** Below this many points Tukey fences are meaningless, so the rule is skipped. */
export const MIN_POINTS_FOR_FENCES = 8;

/** Quantile by linear interpolation (R-7). `sorted` must be ascending. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (pos - lo);
}

export function tukeyFences(values: number[]): { lo: number; hi: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  return { lo: q1 - 1.5 * iqr, hi: q3 + 1.5 * iqr };
}

/** OLS of ys on xs. Null when n < 3 or zero variance in X. */
export function ols(
  xs: number[],
  ys: number[],
  mode: RegressionMode,
): Regression | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx <= 1e-12 * Math.max(1, mx * mx)) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { mode, slope, intercept, r2, n };
}

export function fitLinear(points: MarketPoint[]): Regression | null {
  return ols(
    points.map((p) => p.soldQuantity),
    points.map((p) => p.price),
    "linear",
  );
}

/** ln(price) vs ln(sold); points with sold < 1 or price <= 0 are not fitted. */
export function fitLog(points: MarketPoint[]): Regression | null {
  const usable = points.filter((p) => p.soldQuantity >= 1 && p.price > 0);
  return ols(
    usable.map((p) => Math.log(p.soldQuantity)),
    usable.map((p) => Math.log(p.price)),
    "log",
  );
}

export function buildResearch(input: {
  catalogProductId: string;
  catalogTitle: string;
  points: MarketPoint[];
  fetchedAt: string;
}): MarketResearch {
  const excluded: MarketResearch["excluded"] = [];
  let kept = input.points;

  // 1. Cap: top sellers by sold desc, ties lower price first. Ours always stay.
  if (kept.length > MARKET_MAX_SELLERS) {
    const ours = kept.filter((p) => p.isOurs);
    const others = kept
      .filter((p) => !p.isOurs)
      .sort((a, b) => b.soldQuantity - a.soldQuantity || a.price - b.price);
    const room = Math.max(0, MARKET_MAX_SELLERS - ours.length);
    const keepOthers = new Set(others.slice(0, room));
    for (const p of others.slice(room)) excluded.push({ point: p, reason: "cap" });
    kept = kept.filter((p) => p.isOurs || keepOthers.has(p));
  }

  // 2. Tukey fences, independently on price and sold (skipped when n < 8).
  if (kept.length >= MIN_POINTS_FOR_FENCES) {
    const pf = tukeyFences(kept.map((p) => p.price));
    const sf = tukeyFences(kept.map((p) => p.soldQuantity));
    const next: MarketPoint[] = [];
    for (const p of kept) {
      if (p.isOurs) next.push(p);
      else if (p.price < pf.lo || p.price > pf.hi)
        excluded.push({ point: p, reason: "price_outlier" });
      else if (p.soldQuantity < sf.lo || p.soldQuantity > sf.hi)
        excluded.push({ point: p, reason: "sales_outlier" });
      else next.push(p);
    }
    kept = next;
  }

  return {
    catalogProductId: input.catalogProductId,
    catalogTitle: input.catalogTitle,
    points: kept,
    excluded,
    regression: { log: fitLog(kept), linear: fitLinear(kept) },
    fetchedAt: input.fetchedAt,
  };
}

/**
 * Sample the fitted line in original units. `xMin`/`xMax` are units sold
 * (the regression's X); the returned `price` is the fitted price.
 * A log fit becomes a curve. Log mode clamps xMin to >= 1.
 */
export function predictLine(
  reg: Regression,
  xMin: number,
  xMax: number,
  steps: number,
): { price: number; sold: number }[] {
  const n = Math.max(1, Math.floor(steps));
  const lo = reg.mode === "log" ? Math.max(xMin, 1) : xMin;
  const out: { price: number; sold: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const sold = lo + ((xMax - lo) * i) / n;
    const price =
      reg.mode === "log"
        ? Math.exp(reg.intercept + reg.slope * Math.log(sold))
        : reg.intercept + reg.slope * sold;
    out.push({ price, sold });
  }
  return out;
}
