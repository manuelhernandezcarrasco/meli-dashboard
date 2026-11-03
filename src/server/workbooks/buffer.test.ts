import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readBase, readInputs } from "./index";
import { looksLikeXlsx } from "./upload";
import { loadBusinessConfig } from "~/server/config";

const demo = path.resolve(import.meta.dirname, "../../../demo");
const pnl = path.join(demo, "PnL_MercadoLibre_Septiembre2026_DEMO.xlsx");
const va = path.join(demo, "Ventas_Directas_DEMO.xlsx");
const cfg = loadBusinessConfig();

describe("uploaded workbooks (Buffer input)", () => {
  it("readBase on bytes equals readBase on the path", async () => {
    const fromBuf = await readBase(fs.readFileSync(pnl), cfg);
    const fromPath = await readBase(pnl, cfg);
    expect(fromBuf).toEqual(fromPath);
    expect(Object.keys(fromBuf.base).length).toBeGreaterThan(0);
  });

  it("readInputs on bytes equals readInputs on the path", async () => {
    expect(await readInputs(fs.readFileSync(va))).toEqual(await readInputs(va));
  });

  it("rejects a workbook without the P&L Detalle sheet, naming the upload", async () => {
    await expect(readBase(fs.readFileSync(va), cfg)).rejects.toThrow(
      /el archivo subido no tiene la hoja 'P&L Detalle'/,
    );
  });

  it("looksLikeXlsx checks the zip signature", () => {
    expect(looksLikeXlsx(fs.readFileSync(pnl))).toBe(true);
    expect(looksLikeXlsx(Buffer.from("hola mundo"))).toBe(false);
  });
});
