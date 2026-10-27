import type { ReactNode } from "react";

import { fmtDelta } from "~/lib/dashboard-math";

export function Card({ title, small, children, className = "" }: {
  title: ReactNode; small?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <div className={`min-w-0 rounded-xl border border-line bg-card px-4 py-3.5 ${className}`}>
      <h3 className="mb-2.5 text-sm font-semibold">
        {title}
        {small ? <small className="ml-1.5 font-normal text-mut">{small}</small> : null}
      </h3>
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5 mb-2 text-xs font-semibold tracking-[0.06em] text-mut uppercase">
      {children}
    </div>
  );
}

export function Badge({ value, inverse = false, plain = false }: {
  value: number | null;
  inverse?: boolean;
  /** hide the leading "+" (feed margins) */
  plain?: boolean;
}) {
  if (value == null || !Number.isFinite(value)) {
    return <span className="inline-block rounded-full px-1.5 text-xs leading-[19px] font-semibold text-mut">–</span>;
  }
  const good = inverse ? value <= 0 : value >= 0;
  return (
    <span
      className={`inline-block rounded-full px-1.5 text-xs leading-[19px] font-semibold ${
        good ? "bg-posbg text-pos" : "bg-negbg text-neg"
      }`}
    >
      {plain ? fmtDelta(value).replace("+", "") : fmtDelta(value)}
    </span>
  );
}
