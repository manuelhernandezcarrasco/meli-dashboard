import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://pnl:pnl@localhost:5432/pnl_t6";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import { db } from "~/server/db";
import { deleteUpload, listUploads, loadUploaded, saveUpload } from "./store";

const demo = path.resolve(import.meta.dirname, "../../../demo");
const pnl = fs.readFileSync(path.join(demo, "PnL_MercadoLibre_Septiembre2026_DEMO.xlsx"));
const va = fs.readFileSync(path.join(demo, "Ventas_Directas_DEMO.xlsx"));
const A = "upload_user_a";
const B = "upload_user_b";

beforeEach(async () => {
  await db.userWorkbook.deleteMany({ where: { ownerId: { in: [A, B] } } });
});
afterAll(async () => {
  await db.userWorkbook.deleteMany({ where: { ownerId: { in: [A, B] } } });
  await db.$disconnect();
});

describe("uploaded workbook store", () => {
  it("saves, lists and loads both kinds, scoped per user", async () => {
    const p = await saveUpload(A, "pnl", "cierre.xlsx", pnl);
    expect(p.rows).toBeGreaterThan(0);
    await saveUpload(A, "inputs", "va.xlsx", va);

    const loaded = await loadUploaded(A);
    expect(Object.keys(loaded.base ?? {})).toHaveLength(p.rows);
    expect(loaded.prev?.venta).toBeGreaterThan(0);
    expect(loaded.inputs?.va.length).toBeGreaterThan(0);
    expect((await listUploads(A)).map((u) => u.kind).sort()).toEqual(["inputs", "pnl"]);

    expect(await loadUploaded(B)).toEqual({});
  });

  it("re-uploading replaces, delete removes and snapshots are dropped", async () => {
    await db.snapshot.upsert({
      where: { ownerId_month: { ownerId: A, month: "2026-10" } },
      create: { ownerId: A, month: "2026-10", payload: {}, computedAt: new Date() },
      update: {},
    });
    await saveUpload(A, "pnl", "uno.xlsx", pnl);
    await saveUpload(A, "pnl", "dos.xlsx", pnl);
    const list = await listUploads(A);
    expect(list).toHaveLength(1);
    expect(list[0]!.fileName).toBe("dos.xlsx");
    expect(await db.snapshot.count({ where: { ownerId: A } })).toBe(0);

    await deleteUpload(A, "pnl");
    expect(await loadUploaded(A)).toEqual({});
  });

  it("rejects a wrong workbook without storing anything", async () => {
    await expect(saveUpload(A, "pnl", "mal.xlsx", va)).rejects.toThrow(/P&L Detalle/);
    expect(await listUploads(A)).toEqual([]);
  });
});
