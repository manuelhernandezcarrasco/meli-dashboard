// TEMPORARY STUB (T13): the real chart is owned by T10 — take T10's file on merge.
import type { MarketResearch } from "~/lib/market";

export function MarketChart({ data }: { data: MarketResearch }) {
  return <div data-testid="market-chart">{data.points.length} ofertas</div>;
}
