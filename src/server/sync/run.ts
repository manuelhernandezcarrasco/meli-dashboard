import path from "node:path";
import { env } from "~/env";
import { nowArg, prevYm, monthLabel } from "~/lib/dates";
import { DashboardDataSchema, type DashboardData } from "~/lib/contracts";
import { buildLines, computeDashboard } from "~/server/calc";
import { computeStock } from "~/server/calc/stock";
import { loadBusinessConfig } from "~/server/config";
import { db } from "~/server/db";
import { getDataSource } from "~/server/datasource";
import type { DataSource } from "~/server/datasource/types";
import { workbooks } from "~/server/workbooks";
import { enrich, fetchMonth } from "./enrich";

const log = (msg: string) => console.log(`[sync] ${msg}`);
const resolve = (p: string) => path.resolve(process.cwd(), p);
const p2 = (n: number) => String(n).padStart(2, "0");
const ars = (v: number) => Math.round(v).toLocaleString("en-US");

export interface RunSyncOptions {
  /** Overrides the data source (tests); defaults to `getDataSource`. */
  dataSource?: DataSource;
}

/** Port of `run_sync` (legacy 1215–1334): fetch → enrich → compute → store snapshot. */
export async function runSync(
  now: Date = new Date(),
  opts: RunSyncOptions = {},
): Promise<DashboardData> {
  const cfg = loadBusinessConfig();
  const t = nowArg(now);
  let [y, m] = [t.y, t.m];
  if (cfg.mes) {
    const [yy, mm] = cfg.mes.split("-").map(Number);
    if (!yy || !mm) throw new Error(`mes inválido en business.json: ${cfg.mes}`);
    [y, m] = [yy, mm];
  }
  const [py, pm] = prevYm(y, m);

  const { base, prev: prevCierre } = await workbooks.readBase(resolve(env.BASE_PNL_PATH), cfg);
  const inputs = await workbooks.readInputs(
    env.VENTAS_DIRECTAS_PATH ? resolve(env.VENTAS_DIRECTAS_PATH) : undefined,
  );
  const ds = opts.dataSource ?? getDataSource(base, now);

  log(`Descargando órdenes de ${monthLabel(y, m)}…`);
  const orders = await fetchMonth(ds, y, m, false, t.d);
  log(`${orders.length} órdenes (${orders.filter((o) => o.status === "paid").length} pagas)`);
  const prevOrders = await fetchMonth(ds, py, pm, true, t.d);
  log(`${monthLabel(py, pm)}: ${prevOrders.length} órdenes (para comparar a igual día)`);

  const { shipCosts, gtins, taxes } = await enrich(ds, [...orders, ...prevOrders], now, log);

  const data = computeDashboard({
    orders, prevOrders, shipCosts, gtins, taxes, base, prevCierre, inputs, cfg,
    y, m, now, stockFn: computeStock,
  });

  // Control lines (legacy 1280–1290); never log order contents.
  const calCfg = { ...cfg, impuestosMlPctEstimado: data.taxPct };
  const lines = buildLines(orders, shipCosts, gtins, base, inputs, calCfg, y, m, taxes);
  const ml = lines.filter((l) => l.channel === "ML");
  if (ml.length) {
    const con = ml.filter((l) => l.taxSource === "Mercado Pago").length;
    log(`Impuestos: ${con}/${ml.length} líneas ML con detalle real de Mercado Pago; el resto, estimado`);
  }
  const pml = buildLines(prevOrders, shipCosts, gtins, base, inputs, calCfg, py, pm, taxes).filter(
    (l) => l.channel === "ML",
  );
  if (pml.length && prevCierre.costoMl) {
    const cApi = pml.reduce((s, l) => s + l.costoMl, 0);
    const diff = (cApi / prevCierre.costoMl - 1) * 100;
    log(
      `Control ${monthLabel(py, pm)}: Costo ML según API+MP ${ars(cApi)} vs P&L cierre ${ars(prevCierre.costoMl)} (${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%)`,
    );
  }

  const parsed = DashboardDataSchema.parse(data);
  const month = `${y}-${p2(m)}`;
  const computedAt = now;
  await db.snapshot.upsert({
    where: { month },
    create: { month, payload: parsed, computedAt },
    update: { payload: parsed, computedAt },
  });
  return parsed;
}
