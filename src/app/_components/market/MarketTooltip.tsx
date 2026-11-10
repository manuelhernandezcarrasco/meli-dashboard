import { ars, fmtInt } from "~/lib/dashboard-math";
import type { MarketPoint } from "~/lib/market";

export function MarketTooltipBody({ point }: { point: MarketPoint }) {
  return (
    <div className="max-w-[260px] rounded-lg border border-line bg-card px-2.5 py-2 text-xs text-ink shadow-md">
      <div className="font-bold">{point.sellerNickname}</div>
      <div className="mt-0.5 text-mut">{point.title}</div>
      <div className="mt-1">Precio: {ars(point.price)}</div>
      <div>Vendidos: {point.soldExact ? "" : "+"}{fmtInt(point.soldQuantity)}</div>
    </div>
  );
}

/** recharts `content` renderer. */
export function MarketTooltip({ active, payload }: {
  active?: boolean;
  payload?: readonly { payload?: unknown }[];
}) {
  const point = payload?.[0]?.payload as MarketPoint | undefined;
  if (!active || !point || !("itemId" in point)) return null;
  return <MarketTooltipBody point={point} />;
}
