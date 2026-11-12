import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s8";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import { db } from "~/server/db";
import { listReturns, returnsStore } from "./stockReturns";

const A = "ret_acct_a";
const B = "ret_acct_b";
let productId = 0;

async function seed(acc: string) {
  await db.account.createMany({ data: [{ id: acc }], skipDuplicates: true });
  await db.listing.createMany({
    data: [{ accountId: acc, marketplace: "mercadolibre", itemId: "MLA1", title: "Cámara" }], skipDuplicates: true,
  });
  await db.order.create({
    data: {
      accountId: acc, marketplace: "mercadolibre", orderId: 500n, status: "paid", createdAt: new Date(),
      items: { create: [{ lineNo: 0, itemId: "MLA1", title: "Cámara", quantity: 2, unitPrice: 10, saleFee: 1 }] },
    },
  });
  return (await db.inventoryProduct.create({ data: { accountId: acc, name: "Cámara Sony" } })).id;
}

const clean = async () => { await db.account.deleteMany({ where: { id: { in: [A, B] } } }); };
beforeEach(async () => { await clean(); productId = Number(await seed(A)); await seed(B); });
afterAll(async () => { await clean(); await db.$disconnect(); });

const open = (acc = A, lineNo = 0) =>
  returnsStore.insert({ accountId: acc, orderId: 500, lineNo, productId, quantity: 2, reason: "defective" });

describe("returnsStore", () => {
  it("insert is idempotent per order line", async () => {
    const a = await open();
    const b = await open();
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.record.id).toBe(a.record.id);
    expect(a.record).toMatchObject({ outcome: "pending", quantity: 2, orderId: 500, reason: "defective" });
  });

  it("transition is compare-and-set", async () => {
    const { record } = await open();
    const at = new Date("2026-11-12T10:00:00Z");
    const moved = await returnsStore.transition(A, record.id, "pending", "lost", "gone", at);
    expect(moved).toMatchObject({ outcome: "lost", note: "gone", resolvedAt: at });
    expect(await returnsStore.transition(A, record.id, "pending", "restocked", undefined, at)).toBeNull();
    expect((await returnsStore.get(A, record.id))!.outcome).toBe("lost");
  });

  it("is tenant-scoped", async () => {
    const { record } = await open();
    expect(await returnsStore.get(B, record.id)).toBeNull();
    expect(await returnsStore.transition(B, record.id, "pending", "lost", undefined, new Date())).toBeNull();
    expect(await listReturns(B)).toEqual([]);
  });

  it("list filters by outcome and carries the product name", async () => {
    const { record } = await open();
    await returnsStore.transition(A, record.id, "pending", "in_repair", undefined, null);
    expect(await listReturns(A, "pending")).toEqual([]);
    const rows = await listReturns(A, "in_repair");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productName: "Cámara Sony", orderId: 500, outcome: "in_repair", resolvedAt: null });
    expect(await listReturns(A)).toHaveLength(1);
  });
});
