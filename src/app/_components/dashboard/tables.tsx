import {
  fmtDec1, fmtInt, fmtShortDate, marginAmount, marginRatio, missingCosts, pct, short,
  STOCK_STATES, type Agg, type CategoryRow, type Row, type StockRow, type StockState,
  type TopProduct,
} from "~/lib/dashboard-math";
import type { DashboardData, MatchProposal } from "~/lib/contracts";
import { ScrollPane } from "./ScrollPane";
import { Badge, Card } from "./ui";

export function CategoryTable({ rows, total }: { rows: CategoryRow[]; total: Agg }) {
  return (
    <Card title="Por categoría" small="mes acumulado">
      <ScrollPane className="max-h-[330px]">
        <table className="tbl">
          <thead>
            <tr><th>Categoría</th><th>Venta</th><th>Ing. Netos</th><th>Mg. Bruto</th><th>Mg.%</th></tr>
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

export function SalesFeed({ rows }: { rows: Row[] }) {
  return (
    <Card title="Últimas ventas">
      <ScrollPane className="max-h-[330px]">
        <table className="tbl">
          <thead><tr><th>Cuándo / producto</th><th>Venta</th><th className="ctr">Mg. bruto</th><th className="ctr">Mg.%</th></tr></thead>
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
                <td className="ctr"><Badge value={marginRatio(r)} plain /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollPane>
    </Card>
  );
}

export function TopProducts({ rows }: { rows: TopProduct[] }) {
  return (
    <Card title="Top productos del mes">
      <ScrollPane className="max-h-[330px]">
        <table className="tbl">
          <thead><tr><th>Producto</th><th>Uds</th><th>Venta</th><th>Mg.%</th></tr></thead>
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

function MatchSection({ title, hint, items, yes, no, pending, onDecide, className = "" }: {
  title: string; hint: string; items: MatchProposal[]; yes: string; no: string; pending: boolean;
  onDecide?: (d: MatchDecisionInput) => void; className?: string;
}) {
  if (!items.length) return null;
  const btn = "cursor-pointer rounded-md border border-line bg-card px-2 py-0.5 text-xs text-ink disabled:opacity-60";
  return (
    <section className={className}>
      <h4 className="m-0 text-[13px] font-semibold text-warn">{title}</h4>
      <p className="m-0 mt-0.5 mb-2 text-xs text-mut">{hint}</p>
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
    </section>
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
            <section>
              <h4 className="m-0 text-[13px] font-semibold text-warn">
                {missing.length} {missing.length === 1 ? "producto sin costo real" : "productos sin costo real"}
              </h4>
              <p className="m-0 mt-0.5 mb-2 text-xs text-mut">
                Se usó un margen asumido porque no hay costo unitario en el cierre de {prev}. Cargá el costo
                de estos productos para que el margen sea exacto.
              </p>
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
            </section>
          )}
          {unmatched.length > 0 && (
            <section className={missing.length ? "mt-4" : ""}>
              <h4 className="m-0 text-[13px] font-semibold text-warn">
                {unmatched.length} {unmatched.length === 1 ? "publicación" : "publicaciones"} de ML sin EAN
              </h4>
              <p className="m-0 mt-0.5 mb-2 text-xs text-mut">
                Completá la hoja “Mapeo ML” con el EAN de cada una para poder asignarle costo.
              </p>
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
            </section>
          )}
        </ScrollPane>
      )}
    </Card>
  );
}

const STATE_DOT = ["bg-neg", "bg-neg", "bg-cost", "bg-warn", "bg-pos"] as const;

export function StockTable({ data, rows, counts, selected, onToggle, prevMonth }: {
  data: DashboardData;
  rows: StockRow[];
  counts: Record<StockState, number>;
  selected: ReadonlySet<StockState>;
  onToggle: (s: StockState) => void;
  prevMonth: string;
}) {
  const U = data.thresholds;
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
        </span>
      }
    >
      <ScrollPane className="max-h-[460px]">
        <table className="tbl">
          <thead>
            <tr>
              <th>Estado</th><th className="left">Producto</th><th>Stock ini</th><th>Ingresos</th>
              <th>Vendidas</th><th>Restante</th><th>Uds/día</th><th>Cobertura</th>
              <th>Quiebre est.</th><th>Reponer</th>
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
                  </tr>
                );
              })
            ) : (
              <tr><td colSpan={10} className="text-mut">Sin productos en los estados seleccionados.</td></tr>
            )}
          </tbody>
        </table>
      </ScrollPane>
    </Card>
  );
}
