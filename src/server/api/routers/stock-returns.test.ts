import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s8";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }) }));

import { createCallerFactory } from "~/server/api/trpc";
import { db } from "~/server/db";
import { configureReturnsService } from "~/server/stock/returns";
import { returnsStore } from "~/server/store/stockReturns";
import { stockReturnsRouter } from "./stock-returns";

const U = "ret_router_user";
const caller = createCallerFactory(stockReturnsRouter)({ db, userId: U, headers: new Headers() });
const moves: { type: string; quantity: unknown; key: string }[] = [];
const pushes: number[][] = [];
let productId = 0;

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: U } });
  await db.account.create({ data: { id: U } });
  await db.listing.create({ data: { accountId: U, marketplace: "mercadolibre", itemId: "MLA9", title: "T" } });
  await db.order.create({
    data: {
      accountId: U, marketplace: "mercadolibre", orderId: 77n, status: "cancelled", createdAt: new Date(),
      items: { create: [{ lineNo: 0, itemId: "MLA9", title: "T", quantity: 1, unitPrice: 1, saleFee: 0 }] },
    },
  });
  productId = Number((await db.inventoryProduct.create({ data: { accountId: U, name: "Prod" } })).id);
  moves.length = 0; pushes.length = 0;
  configureReturnsService({
    store: returnsStore,
    ledger: {
      async appendMovement(m) {
        moves.push({ type: m.type, quantity: m.quantity, key: m.idempotencyKey });
        return { movementId: 1, created: true, onHandAfter: 0 as never, unitCostAfter: 0 as never };
      },
    },
    push: { async requestPush(_a, ids) { pushes.push(ids); } },
    alerts: { async evaluateProducts() {} },
  });
});
afterAll(async () => { await db.account.deleteMany({ where: { id: U } }); await db.$disconnect(); });

describe("stockReturns router", () => {
  it("create → list → resolve flow", async () => {
    const { returnId } = await caller.create({ orderId: 77, lineNo: 0, productId, quantity: 1, reason: "broken" });
    expect((await caller.create({ orderId: 77, lineNo: 0, productId, quantity: 1 })).created).toBe(false);
    expect(await caller.list({ outcome: "pending" })).toHaveLength(1);

    await expect(caller.resolve({ returnId, outcome: "restocked", idempotencyKey: "k" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(moves).toEqual([]);

    await caller.resolve({ returnId, outcome: "restocked", confirmRestock: true, idempotencyKey: "k" });
    expect(moves.map((m) => m.type)).toEqual(["return_restock"]);
    expect(pushes).toEqual([[productId]]);
    expect(await caller.list({ outcome: "restocked" })).toHaveLength(1);

    await expect(caller.resolve({ returnId, outcome: "lost", idempotencyKey: "k2" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("unknown return → NOT_FOUND", async () => {
    await expect(caller.resolve({ returnId: 424242, outcome: "lost", idempotencyKey: "k" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
