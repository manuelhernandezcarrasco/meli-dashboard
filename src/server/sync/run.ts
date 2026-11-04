import path from "node:path";
import { env } from "~/env";
import { nowArg, prevYm, monthLabel } from "~/lib/dates";
import {
  DashboardDataSchema,
  type BusinessConfig,
  type DashboardData,
  type Inputs,
  type PrevCierre,
} from "~/lib/contracts";
import { buildLines, computeDashboard } from "~/server/calc";
import { computeStock } from "~/server/calc/stock";
import { loadBusinessConfig } from "~/server/config";
import { db } from "~/server/db";
import { getDataSource } from "~/server/datasource";
import type { DataSource } from "~/server/datasource/types";
import { createMatcher } from "~/lib/product-match";
import { workbooks } from "~/server/workbooks";
import { loadUploaded } from "~/server/workbooks/store";
import { enrich, fetchMonth } from "./enrich";
import { loadDecisions, withConfirmed } from "./matches";

const log = (msg: string) => console.log(`[sync] ${msg}`);
const resolve = (p: string) => path.resolve(process.cwd(), p);
const p2 = (n: number) => String(n).padStart(2, "0");
const ars = (v: number) => Math.round(v).toLocaleString("en-US");

const ZERO_TOTALS: PrevCierre = {
  ventaMl: 0, ventaVa: 0, venta: 0, costoMl: 0, cogs: 0, uds: 0, ingNetos: 0, margen: 0,
};
const EMPTY_INPUTS: Inputs = { va: [], mapItem: {}, mapSku: {}, override: {}, ingresos: [] };

async function readDemoWorkbooks(cfg: BusinessConfig) {
  const { base, prev } = await workbooks.readBase(resolve(env.BASE_PNL_PATH!), cfg);
  const inputs = await workbooks.readInputs(
    env.VENTAS_DIRECTAS_PATH ? resolve(env.VENTAS_DIRECTAS_PATH) : undefined,
  );
  return { base, prev, inputs };
}

export interface RunSyncOptions {
  /** Overrides the data source (tests); defaults to `getDataSource`. */
  dataSource?: DataSource;
  /** Recompute this month ("YYYY-MM") instead of the current / configured one. */
  month?: string;
  /** Stored as the snapshot's `computedAt` (defaults to `now`). */
  computedAt?: Date;
}

/** Port of `run_sync` (legacy 1215–1334): fetch → enrich → compute → store snapshot. */
export async function runSync(
  ownerId: string,
  now: Date = new Date(),
  opts: RunSyncOptions = {},
): Promise<DashboardData> {
  const cfg = loadBusinessConfig();
  const t = nowArg(now);
  let [y, m] = [t.y, t.m];
  const forced = opts.month ?? cfg.mes;
  if (forced) {
    const [yy, mm] = forced.split("-").map(Number);
    if (!yy || !mm) throw new Error(`mes inválido: ${forced}`);
    [y, m] = [yy, mm];
  }
  const [py, pm] = prevYm(y, m);

  // Live syncs start from an empty SKU base and no previous close, plus whatever Excel files the
  // user uploaded (P&L close -> SKU base and previous totals; inputs -> direct sales, mapping...).
  // The demo source reads the bundled workbooks instead.
  const uploaded = await loadUploaded(ownerId);
  const demo =
    env.DATA_SOURCE === "demo" && env.BASE_PNL_PATH ? await readDemoWorkbooks(cfg) : null;
  const base = uploaded.base ?? demo?.base ?? {};
  const prevCierre = uploaded.prev ?? demo?.prev ?? ZERO_TOTALS;
  const decisions = await loadDecisions(ownerId);
  const inputs = withConfirmed(uploaded.inputs ?? demo?.inputs ?? EMPTY_INPUTS, decisions);
  const fuzzy = createMatcher(base, decisions.rejected);
  const ds = opts.dataSource ?? getDataSource(ownerId, base, now);

  log(`Descargando órdenes de ${monthLabel(y, m)}…`);
  const orders = await fetchMonth(ownerId, ds, y, m, false, t.d);
  log(`${orders.length} órdenes (${orders.filter((o) => o.status === "paid").length} pagas)`);
  const prevOrders = await fetchMonth(ownerId, ds, py, pm, true, t.d);
  log(`${monthLabel(py, pm)}: ${prevOrders.length} órdenes (para comparar a igual día)`);

  const { shipCosts, gtins, taxes } = await enrich(ownerId, ds, [...orders, ...prevOrders], now, log);

  const data = computeDashboard({
    orders, prevOrders, shipCosts, gtins, taxes, base, prevCierre, inputs, cfg,
    y, m, now, stockFn: computeStock, fuzzy,
  });

  // Control lines (legacy 1280–1290); never log order contents.
  const calCfg = { ...cfg, impuestosMlPctEstimado: data.taxPct };
  const lines = buildLines(orders, shipCosts, gtins, base, inputs, calCfg, y, m, taxes, fuzzy);
  const ml = lines.filter((l) => l.channel === "ML");
  if (ml.length) {
    const con = ml.filter((l) => l.taxSource === "Mercado Pago").length;
    log(`Impuestos: ${con}/${ml.length} líneas ML con detalle real de Mercado Pago; el resto, estimado`);
  }
  const pml = buildLines(prevOrders, shipCosts, gtins, base, inputs, calCfg, py, pm, taxes, fuzzy).filter(
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
  const computedAt = opts.computedAt ?? now;
  await db.snapshot.upsert({
    where: { ownerId_month: { ownerId, month } },
    create: { ownerId, month, payload: parsed, computedAt },
    update: { payload: parsed, computedAt },
  });
  return parsed;
}
