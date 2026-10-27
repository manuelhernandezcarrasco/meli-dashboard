import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import type { Base, BusinessConfig, Inputs, PrevCierre } from "~/lib/contracts";
import {
  CATEGORIAS,
  normCat,
  normEan,
  normHdr,
  toNum,
  toPct,
} from "~/lib/normalize";

type Cell = unknown;

/** Reduces an exceljs cell value to a plain value (formula results, no errors). */
function plain(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("error" in o) return null;
    if ("result" in o) return plain(o.result);
    if ("formula" in o || "sharedFormula" in o) return null;
    if ("richText" in o)
      return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("text" in o) return plain(o.text);
    return null;
  }
  return v;
}

/** Python-style `str(x or "")`. */
const str = (v: unknown): string => (v ? String(v) : "");

async function loadRows(file: string): Promise<{
  names: string[];
  rows: (name: string) => Cell[][];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return {
    names: wb.worksheets.map((w) => w.name),
    rows: (name) => {
      const ws = wb.getWorksheet(name)!;
      const out: Cell[][] = [];
      for (let i = 1; i <= ws.rowCount; i++) {
        const vals = ws.getRow(i).values as unknown[];
        const arr: Cell[] = [];
        for (let j = 1; j < vals.length; j++) arr.push(plain(vals[j]));
        out.push(arr);
      }
      return out;
    },
  };
}

export async function readBase(
  file: string,
  cfg: BusinessConfig,
): Promise<{ base: Base; prev: PrevCierre }> {
  if (!file || !fs.existsSync(file)) {
    throw new Error(`No encuentro el P&L del cierre anterior: ${file}`);
  }
  const wb = await loadRows(file);
  const sheetName = wb.names.find((n) =>
    ["pldetalle", "pyldetalle"].includes(normHdr(n)),
  );
  if (sheetName === undefined) {
    throw new Error(
      `El archivo ${path.basename(file)} no tiene la hoja 'P&L Detalle'`,
    );
  }
  const rows = wb.rows(sheetName);
  let hdrI = -1;
  const cols = new Map<string, number>();
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const n = rows[i]!.map(normHdr);
    if (n.includes("ean") && n.some((x) => x.startsWith("cupond"))) {
      hdrI = i;
      n.forEach((h, j) => {
        if (!cols.has(h)) cols.set(h, j);
      });
      break;
    }
  }
  if (hdrI < 0) {
    throw new Error(
      "No encontré la fila de encabezados (EAN / CU Pond.) en 'P&L Detalle'",
    );
  }
  const col = (...names: string[]): number | undefined => {
    for (const nm of names)
      for (const [k, j] of cols) if (k === nm || k.startsWith(nm)) return j;
    return undefined;
  };
  const cCat = col("cat"),
    cEan = col("ean"),
    cDesc = col("descripcion"),
    cMod = col("modelo");
  const cCu = col("cupond"),
    cStk = col("stockfinal"),
    cMg = col("mgasum");
  const cVt = col("ventatotal"),
    cCml = col("costoml");
  const cVml = col("ventaml"),
    cVva = col("ventava"),
    cCogs = col("cogs");
  const cUml = col("ml"),
    cUva = col("va");

  const tot = { ventaMl: 0, ventaVa: 0, venta: 0, costoMl: 0, cogs: 0, uds: 0 };
  const base: Base = {};
  let curCat = "OTRAS";
  const mgDefault: Record<string, number> = {};
  for (const [k, v] of Object.entries(cfg.margenAsumido))
    mgDefault[k.toUpperCase()] = v;

  for (const row of rows.slice(hdrI + 1)) {
    const g = (c: number | undefined): Cell =>
      c !== undefined && c < row.length ? row[c] : null;
    const ean = normEan(g(cEan));
    const desc = str(g(cDesc)).trim();
    const catCell = str(g(cCat)).trim();
    if (!ean) {
      const label = (catCell || desc).toUpperCase();
      for (const c of CATEGORIAS) {
        if (
          label.replace(/PLAYSTATION/g, "PLAY STATION").includes(c) &&
          !label.includes("TOTAL")
        )
          curCat = c;
      }
      continue;
    }
    const cat = catCell ? normCat(catCell) : curCat;
    const cu = toNum(g(cCu), 0);
    const mg = cMg !== undefined ? toPct(g(cMg)) : null;
    const vt = toNum(g(cVt));
    const cml = toNum(g(cCml));
    tot.ventaMl += toNum(g(cVml));
    tot.ventaVa += toNum(g(cVva));
    tot.venta += vt;
    tot.costoMl += cml;
    tot.cogs += toNum(g(cCogs));
    const uds = toNum(g(cUml)) + toNum(g(cUva));
    tot.uds += uds;
    base[ean] = {
      ean,
      desc,
      modelo: str(g(cMod)),
      cat,
      cu: cu > 0 ? cu : 0,
      stock: toNum(g(cStk), 0),
      mg: mg ?? mgDefault[cat] ?? 0.3,
      costoMlPctPrev: vt ? cml / vt : null,
      udsPrev: uds,
    };
  }
  const ingNetos = tot.venta - tot.costoMl;
  const prev: PrevCierre = { ...tot, ingNetos, margen: ingNetos - tot.cogs };
  return { base, prev };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Excel date or dd/mm/yyyy string -> "YYYY-MM-DD" (null if neither). */
function toDate(f: unknown): string | null {
  if (f instanceof Date)
    return `${f.getUTCFullYear()}-${p2(f.getUTCMonth() + 1)}-${p2(f.getUTCDate())}`;
  if (typeof f === "string") {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(f.trim());
    if (!m) return null;
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${p2(mo)}-${p2(d)}`;
  }
  return null;
}

export async function readInputs(file: string | undefined): Promise<Inputs> {
  const out: Inputs = {
    va: [],
    mapItem: {},
    mapSku: {},
    override: {},
    ingresos: [],
  };
  if (!file || !fs.existsSync(file)) {
    console.warn(
      "Aviso: no encontré el archivo de Ventas Directas / Mapeo; sigo sin él",
    );
    return out;
  }
  const wb = await loadRows(file);

  const table = (name: string): Record<string, Cell>[] => {
    if (!wb.names.includes(name)) return [];
    const rows = wb.rows(name);
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const hdr = rows[i]!.map(normHdr);
      if (!hdr.includes("ean")) continue;
      const data: Record<string, Cell>[] = [];
      for (const rr of rows.slice(i + 1)) {
        if (!rr.some((v) => v !== null && v !== "")) continue;
        const rec: Record<string, Cell> = {};
        for (let j = 0; j < Math.min(hdr.length, rr.length); j++)
          rec[hdr[j]!] = rr[j];
        data.push(rec);
      }
      return data;
    }
    return [];
  };
  const find = (r: Record<string, Cell>, pred: (k: string) => boolean) =>
    Object.entries(r).find(([k]) => pred(k))?.[1];

  for (const r of table("Ventas Directas")) {
    const f = toDate(r.fecha);
    const ean = normEan(r.ean);
    const qty = toNum(r.cantidad);
    const pu = toNum(find(r, (k) => k.startsWith("preciounit") || k === "precio"));
    if (!f || !ean || !qty) continue;
    if (!pu) {
      console.warn(
        `Aviso: venta directa del ${f.slice(8)}/${f.slice(5, 7)} (EAN ${ean}) sin precio; se ignora`,
      );
      continue;
    }
    if (str(r.cliente).trim().toUpperCase().startsWith("EJEMPLO")) continue;
    out.va.push({
      date: f,
      cliente: str(r.cliente),
      ean,
      desc: str(r.descripcion),
      qty,
      pu,
    });
  }
  for (const r of table("Mapeo ML")) {
    const ean = normEan(r.ean);
    if (!ean) continue;
    const iid = str(r.mlitemid).trim().toUpperCase();
    const sku = (str(r.skuml) || str(r.sellersku)).trim();
    if (iid) out.mapItem[iid] = ean;
    if (sku) out.mapSku[sku] = ean;
  }
  for (const r of table("Costos Override")) {
    const ean = normEan(r.ean);
    const cu = toNum(find(r, (k) => k.startsWith("costounit")));
    if (ean && cu > 0)
      out.override[ean] = {
        cu,
        desc: str(r.descripcion),
        cat: r.cat ? normCat(r.cat) : null,
      };
  }
  for (const r of table("Ingresos Stock")) {
    const f = toDate(r.fecha);
    const ean = normEan(r.ean);
    const qty = toNum(r.cantidad);
    if (f && ean && qty && !str(r.proveedor).toUpperCase().startsWith("EJEMPLO"))
      out.ingresos.push({ date: f, ean, qty });
  }
  return out;
}
