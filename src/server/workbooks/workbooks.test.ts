import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { readBase, readInputs } from "./index";
import { loadBusinessConfig } from "~/server/config";

const demo = path.resolve(import.meta.dirname, "../../../demo");
const fx = path.resolve(import.meta.dirname, "../../../tests/fixtures/demo");
const json = (f: string) => JSON.parse(fs.readFileSync(path.join(fx, f), "utf8"));
const cfg = loadBusinessConfig();
const tmp = path.resolve(import.meta.dirname, "../../../node_modules/.tmp-t2");

function expectClose(a: unknown, b: unknown, p = "") {
  if (typeof b === "number") {
    expect(typeof a, p).toBe("number");
    expect(a as number, p).toBeCloseTo(b, 4);
  } else if (b && typeof b === "object") {
    expect(Object.keys(a as object).sort(), p).toEqual(Object.keys(b).sort());
    for (const k of Object.keys(b))
      expectClose((a as never)[k], (b as never)[k], `${p}.${k}`);
  } else expect(a, p).toEqual(b);
}

async function writeWb(name: string, sheets: Record<string, unknown[][]>) {
  fs.mkdirSync(tmp, { recursive: true });
  const wb = new ExcelJS.Workbook();
  for (const [n, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(n);
    rows.forEach((r) => ws.addRow(r));
  }
  const f = path.join(tmp, name);
  await wb.xlsx.writeFile(f);
  return f;
}

describe("readBase", () => {
  it("matches the Python oracle", async () => {
    const { base, prev } = await readBase(
      path.join(demo, "PnL_MercadoLibre_Septiembre2026_DEMO.xlsx"),
      cfg,
    );
    expectClose(base, json("base.json"));
    expectClose(prev, json("prev_cierre.json"));
  });
  it("errors: missing file, sheet and header", async () => {
    await expect(readBase("/nope.xlsx", cfg)).rejects.toThrow(
      "No encuentro el P&L del cierre anterior: /nope.xlsx",
    );
    const noSheet = await writeWb("nosheet.xlsx", { Otra: [["x"]] });
    await expect(readBase(noSheet, cfg)).rejects.toThrow(
      "no tiene la hoja 'P&L Detalle'",
    );
    const noHdr = await writeWb("nohdr.xlsx", { "P&L Detalle": [["x", "y"]] });
    await expect(readBase(noHdr, cfg)).rejects.toThrow(
      "No encontré la fila de encabezados",
    );
  });
});

describe("readInputs", () => {
  it("matches the Python oracle", async () => {
    const got = await readInputs(path.join(demo, "Ventas_Directas_DEMO.xlsx"));
    expectClose(got, json("inputs.json"));
  });
  it("missing file -> empty inputs + warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await readInputs(undefined)).toEqual({
      va: [],
      mapItem: {},
      mapSku: {},
      override: {},
      ingresos: [],
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("parses dd/mm/yyyy strings and ignores sales without price", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = await writeWb("in.xlsx", {
      "Ventas Directas": [
        ["Fecha", "Cliente", "EAN", "Descripción", "Cantidad", "Precio Unit"],
        ["05/09/2026", "A", "123", "d", 2, 10],
        ["06/09/2026", "B", "123", "d", 2, null],
      ],
    });
    const got = await readInputs(f);
    expect(got.va).toEqual([
      { date: "2026-09-05", cliente: "A", ean: "123", desc: "d", qty: 2, pu: 10 },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

const real = path.resolve(
  import.meta.dirname,
  "../../../data/PnL_MercadoLibre_Septiembre2026.xlsx",
);
describe("smoke with the real workbook", () => {
  it.skipIf(!fs.existsSync(real))("loads > 0 SKUs", async () => {
    const { base, prev } = await readBase(real, cfg);
    expect(Object.keys(base).length).toBeGreaterThan(0);
    if (process.env.T2_REPORT) console.log(Object.keys(base).length, prev);
  });
});
