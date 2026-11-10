"use client";

import { useState, type ReactNode } from "react";

import {
  fmtDec1, fmtInt, fmtShortDate, marginAmount, marginRatio, missingCosts, pct, short,
  STOCK_STATES, type Agg, type CategoryRow, type Row, type StockRow, type StockState,
  type TopProduct,
} from "~/lib/dashboard-math";
import type { DashboardData, MatchProposal } from "~/lib/contracts";
import { InvestigateButton, MarketSearchBox, type MarketSearch } from "./MarketSearchBox";
import { ScrollPane } from "./ScrollPane";
import { SortTh, useSort } from "./sort";
import { Badge, Card } from "./ui";

export function CategoryTable({ rows: all, total }: { rows: CategoryRow[]; total: Agg }) {
  const { rows, sort, toggle } = useSort(all, {
    cat: (r) => r.cat, venta: (r) => r.t.venta, net: (r) => r.t.net, mb: (r) => r.t.mb, mg: (r) => r.t.mg,
  });
  return (
    <Card title="Por categoría" small="mes acumulado">
      <ScrollPane className="max-h-[330px]">
        <table className="tbl">
          <thead>
            <tr>
              <SortTh col="cat" sort={sort} onSort={toggle}>Categoría</SortTh>
              <SortTh col="venta" sort={sort} onSort={toggle}>Venta</SortTh>
              <SortTh col="net" sort={sort} onSort={toggle}>Ing. Netos</SortTh>
              <SortTh col="mb" sort={sort} onSort={toggle}>Mg. Bruto</SortTh>
              <SortTh col="mg" sort={sort} onSort={toggle}>Mg.%</SortTh>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ cat, t, share }) => (
              <tr key={cat}>
                <td>
                  {cat}
                  <div className="mt-[3px] h-1.5 overflow-hidden rounded bg-bg">
                    <i className="block h-full bg-blue" style={{ width: `${share}%` }} />
                  </div>
                </td>
                <td>{short(t.venta)}</td><td>{short(t.net)}</td><td>{short(t.mb)}</td><td>{pct(t.mg)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td><td>{short(total.venta)}</td><td>{short(total.net)}</td>
              <td>{short(total.mb)}</td><td>{pct(total.mg)}</td>
            </tr>
          </tfoot>
        </table>
      </ScrollPane>
    </Card>
  );
}

export function SalesFeed({ rows: all }: { rows: Row[] }) {
  const { rows, sort, toggle } = useSort(all, {
    date: (r) => `${r.date} ${r.time}`, sale: (r) => r.sale, mb: marginAmount, mg: marginRatio,
  });
  return (
    <Card title="Últimas ventas">
      <ScrollPane className="max-h-[330px]">
        <table className="tbl">
          <thead>
            <tr>
              <SortTh col="date" sort={sort} onSort={toggle}>Cuándo / producto</SortTh>
              <SortTh col="sale" sort={sort} onSort={toggle}>Venta</SortTh>
              <SortTh col="mb" sort={sort} onSort={toggle} className="ctr">Mg. bruto</SortTh>
              <SortTh col="mg" sort={sort} onSort={toggle} className="ctr">Mg.%</SortTh>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.order}-${r.ean}-${i}`}>
                <td>
                  <span className="rounded bg-bg px-1.5 text-[11px] font-semibold text-mut">{r.channel}</span>{" "}
                  {r.date.slice(8, 10)}/{r.date.slice(5, 7)} {r.time}
                  <br />
                  <span className="text-mut">{r.qty > 1 ? `${fmtInt(r.qty)}× ` : ""}{r.desc}</span>
                </td>
                <td>{short(r.sale)}</td>
                <td className="ctr">{short(marginAmount(r))}</td>
                <td className="ctr"><Badge value={marginRatio(r)} plain margin /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollPane>
    </Card>
  );
}

export function TopProducts({ rows: all }: { rows: TopProduct[] }) {
  const { rows, sort, toggle } = useSort(all, {
    desc: (r) => r.desc, qty: (r) => r.t.qty, venta: (r) => r.t.venta, mg: (r) => r.t.mg,
  });
  return (
    <Card title="Top productos del mes">
      <ScrollPane className="max-h-[330px]">
        <table className="tbl">
          <thead>
            <tr>
              <SortTh col="desc" sort={sort} onSort={toggle}>Producto</SortTh>
              <SortTh col="qty" sort={sort} onSort={toggle}>Uds</SortTh>
              <SortTh col="venta" sort={sort} onSort={toggle}>Venta</SortTh>
              <SortTh col="mg" sort={sort} onSort={toggle}>Mg.%</SortTh>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.desc}>
                <td>{x.desc}</td><td>{fmtInt(x.t.qty)}</td><td>{short(x.t.venta)}</td><td>{pct(x.t.mg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollPane>
    </Card>
  );
}

export interface MatchDecisionInput {
  itemId: string;
  ean: string;
  decision: "confirmed" | "rejected";
}

function AlertSection({ title, hint, children, className = "" }: {
  title: ReactNode; hint: string; children: ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 border-0 bg-transparent p-0 text-left"
      >
        <h4 className="m-0 text-[13px] font-semibold text-warn">{title}</h4>
        <svg
          width="12" height="12" viewBox="0 0 12 12" aria-hidden
          className={`shrink-0 text-mut transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M2 4 L6 8 L10 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          <p className="m-0 mt-0.5 mb-2 text-xs text-mut">{hint}</p>
          {children}
        </>
      )}
    </section>
  );
}

function MatchSection({ title, hint, items, yes, no, pending, onDecide, className = "" }: {
  title: string; hint: string; items: MatchProposal[]; yes: string; no: string; pending: boolean;
  onDecide?: (d: MatchDecisionInput) => void; className?: string;
}) {
  if (!items.length) return null;
  const btn = "cursor-pointer rounded-md border border-line bg-card px-2 py-0.5 text-xs text-ink disabled:opacity-60";
  return (
    <AlertSection title={title} hint={hint} className={className}>
      <table className="tbl">
        <tbody>
          {items.map((p) => (
            <tr key={p.itemId}>
              <td className="left">
                {p.title}
                <div className="text-[11px] text-mut">
                  ¿es <b>{p.desc}</b>? · {Math.round(p.score * 100)}% · {fmtInt(p.qty)} uds · {short(p.venta)}
                </div>
              </td>
              {onDecide && (
                <td className="whitespace-nowrap">
                  <button type="button" disabled={pending} className={btn}
                    onClick={() => onDecide({ itemId: p.itemId, ean: p.ean, decision: "confirmed" })}>{yes}</button>{" "}
                  <button type="button" disabled={pending} className={btn}
                    onClick={() => onDecide({ itemId: p.itemId, ean: p.ean, decision: "rejected" })}>{no}</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </AlertSection>
  );
}

export function Alerts({ data, assumed, onMatchDecision, matchPending = false }: {
  data: DashboardData; assumed: number; onMatchDecision?: (d: MatchDecisionInput) => void; matchPending?: boolean;
}) {
  const missing = missingCosts(data.rows);
  const suggested = new Set(data.suggestions.map((x) => x.itemId));
  const unmatched = data.unmatched.filter((u) => !suggested.has(u.itemId));
  const prev = data.comp.prevLabel.split(" ")[0] ?? "";
  const ok = !missing.length && !unmatched.length && !assumed && !data.suggestions.length && !data.autoMatches.length;
  return (
    <Card title="Alertas de datos" small={ok ? undefined : `${missing.length + unmatched.length + data.suggestions.length} por revisar`}>
      {ok ? (
        <p className="m-0 text-[13px] text-pos">✓ Todo en orden: todos los productos tienen costo real.</p>
      ) : (
        <ScrollPane className="max-h-[330px]">
          <MatchSection
            title={`${data.suggestions.length} publicaciones que parecen un producto del Excel`}
            hint="No estoy seguro: confirmá si son el mismo producto para usar su costo real."
            items={data.suggestions} yes="Sí, es" no="No" pending={matchPending} onDecide={onMatchDecision}
            className="mb-4"
          />
          <MatchSection
            title={`${data.autoMatches.length} vinculadas automáticamente por nombre`}
            hint="Se usó el costo del producto parecido. Si alguna está mal, deshacela."
            items={data.autoMatches} yes="OK" no="Deshacer" pending={matchPending}
            onDecide={onMatchDecision}
            className="mb-4"
          />
          {missing.length > 0 && (
            <AlertSection
              title={`${missing.length} ${missing.length === 1 ? "producto sin costo real" : "productos sin costo real"}`}
              hint={`Se usó un margen asumido porque no hay costo unitario en el cierre de ${prev}. Cargá el costo de estos productos para que el margen sea exacto.`}
            >
              <table className="tbl">
                <thead><tr><th>Producto</th><th>Uds</th><th>Venta</th></tr></thead>
                <tbody>
                  {missing.map((p) => (
                    <tr key={p.key}>
                      <td>
                        {p.desc}
                        <div className="text-[11px] text-mut">{p.ean ? `EAN ${p.ean}` : "sin EAN"} · {p.cat}</div>
                      </td>
                      <td>{fmtInt(p.qty)}</td><td>{short(p.venta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </AlertSection>
          )}
          {unmatched.length > 0 && (
            <AlertSection
              title={`${unmatched.length} ${unmatched.length === 1 ? "publicación" : "publicaciones"} de ML sin EAN`}
              hint="Completá la hoja “Mapeo ML” con el EAN de cada una para poder asignarle costo."
              className={missing.length ? "mt-4" : ""}
            >
              <table className="tbl">
                <thead><tr><th>Publicación</th><th>Uds</th><th>Venta</th></tr></thead>
                <tbody>
                  {unmatched.map((u) => (
                    <tr key={u.itemId}>
                      <td>
                        {u.title}
                        <div className="text-[11px] text-mut">{u.itemId}{u.sku ? ` · SKU ${u.sku}` : ""}</div>
                      </td>
                      <td>{fmtInt(u.qty)}</td><td>{short(u.venta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </AlertSection>
          )}
        </ScrollPane>
      )}
    </Card>
  );
}

const STATE_DOT = ["bg-neg", "bg-neg", "bg-cost", "bg-warn", "bg-pos"] as const;

export function StockTable({ data, rows: all, counts, selected, onToggle, prevMonth, marketSearch }: {
  data: DashboardData;
  rows: StockRow[];
  counts: Record<StockState, number>;
  selected: ReadonlySet<StockState>;
  onToggle: (s: StockState) => void;
  prevMonth: string;
  /** Looks up our own products by title; without it the market-research entry points are hidden. */
  marketSearch?: MarketSearch;
}) {
  const U = data.thresholds;
  const { rows, sort, toggle } = useSort(all, {
    state: (x) => STOCK_STATES.indexOf(x.state), desc: (x) => x.desc, initial: (x) => x.initial,
    inflow: (x) => x.inflow, sold: (x) => x.sold, remaining: (x) => x.remaining, rate: (x) => x.rate,
    coverage: (x) => (x.remaining <= 0 ? 0 : x.coverage),
    breakDate: (x) => (x.remaining <= 0 ? "" : x.breakDate), reorder: (x) => x.reorder,
  });
  return (
    <Card
      className="mt-3"
      title={
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Stock crítico{" "}
            <small className="ml-1.5 font-normal text-mut">
              crítico &lt; {U.crit} días · bajo &lt; {U.low} días · reponer = {U.repo} días
            </small>
          </span>
          <span className="flex flex-wrap gap-1.5 font-normal">
            {STOCK_STATES.map((e, i) => (
              <button
                key={e}
                type="button"
                aria-pressed={selected.has(e)}
                onClick={() => onToggle(e)}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-card px-2.5 py-[3px] text-xs text-ink ${
                  selected.has(e) ? "border-navy shadow-[inset_0_0_0_1px_var(--navy)]" : "border-line"
                }`}
              >
                <span className={`inline-block h-2 w-2 rounded-full ${STATE_DOT[i]}`} />
                {e} <b className="tabular-nums">{counts[e]}</b>
              </button>
            ))}
          </span>
          {marketSearch ? <MarketSearchBox search={marketSearch} /> : null}
        </span>
      }
    >
      <ScrollPane className="max-h-[460px]">
        <table className="tbl">
          <thead>
            <tr>
              <SortTh col="state" sort={sort} onSort={toggle} className="left">Estado</SortTh>
              <SortTh col="desc" sort={sort} onSort={toggle} className="left">Producto</SortTh>
              <SortTh col="initial" sort={sort} onSort={toggle}>Stock ini</SortTh>
              <SortTh col="inflow" sort={sort} onSort={toggle}>Ingresos</SortTh>
              <SortTh col="sold" sort={sort} onSort={toggle}>Vendidas</SortTh>
              <SortTh col="remaining" sort={sort} onSort={toggle}>Restante</SortTh>
              <SortTh col="rate" sort={sort} onSort={toggle}>Uds/día</SortTh>
              <SortTh col="coverage" sort={sort} onSort={toggle}>Cobertura</SortTh>
              <SortTh col="breakDate" sort={sort} onSort={toggle}>Quiebre est.</SortTh>
              <SortTh col="reorder" sort={sort} onSort={toggle}>Reponer</SortTh>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((x) => {
                const i = STOCK_STATES.indexOf(x.state);
                return (
                  <tr key={x.ean || x.desc} className={i === 0 ? "[&>td]:bg-negbg" : ""}>
                    <td className="left">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                        <span className={`inline-block h-2 w-2 rounded-full ${STATE_DOT[i]}`} />
                        {x.state}
                      </span>
                    </td>
                    <td className="left">
                      {x.desc}
                      <br />
                      <span className="text-[11px] text-mut">
                        {x.cat}{x.rateSource === "mes anterior" ? ` · ritmo de ${prevMonth}` : ""}
                      </span>
                    </td>
                    <td>{fmtInt(x.initial)}</td>
                    <td>{x.inflow ? fmtInt(x.inflow) : "–"}</td>
                    <td>{fmtInt(x.sold)}</td>
                    <td><b>{fmtInt(x.remaining)}</b></td>
                    <td>{fmtDec1(x.rate)}</td>
                    <td>{x.coverage == null ? "–" : x.remaining <= 0 ? "0 d" : `${fmtInt(x.coverage)} d`}</td>
                    <td>
                      {x.remaining <= 0
                        ? <span className="inline-block rounded-full bg-negbg px-1.5 text-xs leading-[19px] font-semibold text-neg">ya</span>
                        : fmtShortDate(x.breakDate)}
                    </td>
                    <td>{x.reorder ? fmtInt(x.reorder) : "–"}</td>
                    <td className="whitespace-nowrap text-xs">
                      {marketSearch ? <InvestigateButton search={marketSearch} desc={x.desc} /> : null}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr><td colSpan={11} className="text-mut">Sin productos en los estados seleccionados.</td></tr>
            )}
          </tbody>
        </table>
      </ScrollPane>
    </Card>
  );
}
