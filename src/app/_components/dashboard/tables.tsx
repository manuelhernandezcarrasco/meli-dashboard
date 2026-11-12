"use client";

import {
  fmtInt, marginAmount, marginRatio, pct, short,
  type Agg, type CategoryRow, type Row, type TopProduct,
} from "~/lib/dashboard-math";
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
