import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_g1";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }) }));

import { createCallerFactory } from "~/server/api/trpc";
import { db } from "~/server/db";
import { ensureAccount } from "~/server/store/bulk";
import { stockCutoverRouter } from "./stock-cutover";

vi.setConfig({ testTimeout: 60_000 });
const A = "g1_cutover_a";
const caller = () => createCallerFactory(stockCutoverRouter)({ db, userId: A, headers: new Headers() });

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: A } });
  await ensureAccount(A);
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: A } });
});

const snap = (ean: string, pos: number) => ({
  accountId: A, ean, description: `P ${ean}`, model: "M", category: "C", unitCost: 100, stockFinal: 2, assumedMargin: 0.08, prevMlCostPct: null, prevUnits: 0, position: pos,
});

describe("stockCutover router", () => {
  it("status counts what a run would create vs. what already exists, then run reports the result", async () => {
    await db.product.createMany({ data: [snap("7790000000011", 1), snap("7790000000028", 2)] });
    await db.inventoryProduct.create({ data: { accountId: A, name: "ya existe", ean: "7790000000011" } });
    expect(await caller().status()).toEqual({ cutoverAt: null, snapshotProducts: 2, productsToCreate: 1, productsExisting: 1 });

    const at = "2026-10-01T03:00:00.000Z";
    const r = await caller().run({ cutoverAt: at });
    expect(r).toMatchObject({ cutoverAt: at, alreadyDone: false, productsCreated: 1, productsExisting: 1, listingsLinked: 0, listingsUnlinked: 0 });
    expect((await caller().status()).cutoverAt).toBe(at);
    await expect(caller().run({ cutoverAt: "2026-11-01T03:00:00.000Z" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses to run with no P&L snapshot", async () => {
    await expect(caller().run({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
