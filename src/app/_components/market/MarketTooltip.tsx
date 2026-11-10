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
  // The fit line shares the tooltip, so payload[0] is not always a seller's point.
  const point = payload
    ?.map((p) => p.payload as Partial<MarketPoint> | undefined)
    .find((p): p is MarketPoint => !!p && typeof p.itemId === "string");
  if (!active || !point) return null;
  return <MarketTooltipBody point={point} />;
}
