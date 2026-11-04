import {
  alerts as buildAlerts, fmtDec1, fmtInt, fmtShortDate, marginAmount, marginRatio, pct, short,
  STOCK_STATES, type Agg, type CategoryRow, type Row, type StockRow, type StockState,
  type TopProduct,
} from "~/lib/dashboard-math";
import type { DashboardData } from "~/lib/contracts";
import { Badge, Card } from "./ui";

export function CategoryTable({ rows, total }: { rows: CategoryRow[]; total: Agg }) {
  return (
    <Card title="Por categoría" small="mes acumulado">
      <div className="max-h-[330px] overflow-auto">
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
      </div>
    </Card>
  );
}

export function SalesFeed({ rows }: { rows: Row[] }) {
  return (
    <Card title="Últimas ventas">
      <div className="max-h-[330px] overflow-auto">
        <table className="tbl">
          <thead><tr><th>Cuándo / producto</th><th>Venta</th><th>Mg.</th></tr></thead>
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
                <td>{short(marginAmount(r))} <Badge value={marginRatio(r)} plain /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function TopProducts({ rows }: { rows: TopProduct[] }) {
  return (
    <Card title="Top productos del mes">
      <div className="max-h-[330px] overflow-auto">
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
      </div>
    </Card>
  );
}

export function Alerts({ data, assumed }: { data: DashboardData; assumed: number }) {
  const items = buildAlerts(data, { assumed });
  return (
    <Card title="Alertas de datos">
      <ul className="m-0 pl-[18px]">
        {items.map((a) => (
          <li key={a} className="my-[3px] text-warn">{a}</li>
        ))}
      </ul>
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
      <div className="max-h-[460px] overflow-auto">
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
      </div>
    </Card>
  );
}
