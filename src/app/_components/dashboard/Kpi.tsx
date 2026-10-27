import type { KpiBlock, KpiCard } from "~/lib/dashboard-math";
import { Badge, SectionLabel } from "./ui";

export function Kpi({ card, vs }: { card: KpiCard; vs: string }) {
  const hasDelta = card.delta !== null;
  return (
    <div
      className={`min-w-0 rounded-xl border bg-card px-3.5 py-3 ${
        card.highlight ? "border-navy shadow-[inset_3px_0_0_var(--navy)]" : "border-line"
      }`}
    >
      <div className="text-xs text-mut">{card.label}</div>
      <div className="mt-0.5 truncate text-[21px] font-semibold whitespace-nowrap tabular-nums">
        {card.value}
      </div>
      <div className="mt-[3px] flex flex-wrap items-center gap-1.5 text-xs text-mut">
        {hasDelta ? <Badge value={card.delta} inverse={card.inverse} /> : null}
        {hasDelta && vs ? <span>{vs}</span> : null}
        {card.sub ? (
          <span className={card.warn ? "text-warn" : ""}>
            {card.sub}
            {card.subDelta !== undefined ? (
              <>
                {" ("}
                <Badge value={card.subDelta} /> {card.subSuffix})
              </>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function KpiRow({ block }: { block: KpiBlock }) {
  return (
    <>
      <SectionLabel>{block.title}</SectionLabel>
      <div className="grid grid-cols-2 gap-2.5 min-[600px]:grid-cols-3 min-[1000px]:grid-cols-5">
        {block.cards.map((c) => (
          <Kpi key={c.label} card={c} vs={block.vs} />
        ))}
      </div>
    </>
  );
}
