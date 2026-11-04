import { useState } from "react";
import { pct, type KpiBlock, type KpiCard } from "~/lib/dashboard-math";
import { Badge, SectionLabel } from "./ui";

export function Kpi({ card, vs }: { card: KpiCard; vs: string }) {
  const hasDelta = card.delta !== null;
  const [open, setOpen] = useState(false);
  const bd = card.breakdown;
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
        {card.sub && bd ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            title="Ver desglose"
            className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            {card.sub} {open ? "▴" : "▾"}
          </button>
        ) : card.sub ? (
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
      {bd && open ? (
        <ul className="mt-2 space-y-0.5 border-t border-line pt-2 text-xs">
          {bd.map((b) => (
            <li key={b.label} className="flex items-baseline justify-between gap-2">
              <span className="text-mut">{b.label}</span>
              <span className="tabular-nums whitespace-nowrap">
                {pct(b.pct)} <span className="text-mut">· {b.amount}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
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
