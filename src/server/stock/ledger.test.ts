import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_t6";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import { db } from "~/server/db";
import { StockError } from "./contracts";
import { appendMovement, costAt, getProductBalance, listMovements, recomputeOnHand } from "./ledger";

const A = "ledger_user_a";
const B = "ledger_user_b";
let seq = 0;
const key = () => `k${Date.now()}-${++seq}`;
const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min));

async function newProduct(accountId = A, over: { archivedAt?: Date } = {}): Promise<number> {
  const p = await db.inventoryProduct.create({ data: { accountId, name: `p${++seq}`, ...over } });
  return Number(p.id);
}
const move = (productId: number, type: Parameters<typeof appendMovement>[0]["type"], quantity: number | string, extra: Partial<Parameters<typeof appendMovement>[0]> = {}) =>
  appendMovement({ accountId: A, productId, type, quantity, occurredAt: at(0), idempotencyKey: key(), actor: "system", ...extra });

beforeAll(async () => {
  await db.account.createMany({ data: [{ id: A }, { id: B }], skipDuplicates: true });
});
afterAll(async () => {
  const where = { accountId: { in: [A, B] } };
  await db.stockMovement.deleteMany({ where });
  await db.productCostEntry.deleteMany({ where });
  await db.inventoryProduct.deleteMany({ where });
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await db.$disconnect();
});

describe("appendMovement", () => {
  it("purchase blends the weighted average and writes cost history", async () => {
    const p = await newProduct();
    const r1 = await move(p, "purchase_in", 58, { unitCost: "69971.7449", occurredAt: at(1) });
    expect(r1.created).toBe(true);
    expect(r1.onHandAfter.toString()).toBe("58");
    expect(r1.unitCostAfter.toString()).toBe("69971.7449");
    const r2 = await move(p, "purchase_in", 42, { unitCost: "80000", occurredAt: at(2) });
    // (58*69971.7449 + 42*80000)/100
    expect(r2.unitCostAfter.toString()).toBe("74183.612");
    const bal = await getProductBalance(A, p);
    expect(bal?.onHand.toString()).toBe("100");
    expect(bal?.unitCost.toString()).toBe("74183.612");
    expect(await db.productCostEntry.count({ where: { accountId: A, productId: p } })).toBe(2);
  });

  it("purchase while stock is 0 and while negative takes the landed cost", async () => {
    const p = await newProduct();
    await move(p, "initial_count", 2, { unitCost: 10 });
    await move(p, "sale", -2);
    const zero = await move(p, "purchase_in", 5, { unitCost: 50 });
    expect(zero.unitCostAfter.toString()).toBe("50");
    await move(p, "sale", -7);
    const neg = await move(p, "purchase_in", 4, { unitCost: 70 });
    expect(neg.onHandAfter.toString()).toBe("2");
    expect(neg.unitCostAfter.toString()).toBe("70");
  });

  it("sale keeps the cost and reports wentNegative", async () => {
    const p = await newProduct();
    await move(p, "initial_count", 1, { unitCost: 40 });
    const ok = await move(p, "sale", -1);
    expect(ok.wentNegative).toBe(false);
    expect(ok.unitCostAfter.toString()).toBe("40");
    const neg = await move(p, "sale", -1);
    expect(neg.wentNegative).toBe(true);
    expect(neg.onHandAfter.toString()).toBe("-1");
  });

  it("replaying an idempotencyKey changes nothing and returns the original", async () => {
    const p = await newProduct();
    const k = key();
    const first = await move(p, "initial_count", 5, { unitCost: 10, idempotencyKey: k });
    const again = await move(p, "initial_count", 5, { unitCost: 10, idempotencyKey: k });
    expect(again.created).toBe(false);
    expect(again.movementId).toBe(first.movementId);
    expect((await getProductBalance(A, p))?.onHand.toString()).toBe("5");
    expect(await db.stockMovement.count({ where: { accountId: A, productId: p } })).toBe(1);
    await expect(move(p, "initial_count", 6, { unitCost: 10, idempotencyKey: k })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("concurrent appends on the same product both land", async () => {
    const p = await newProduct();
    await move(p, "initial_count", 0.001, { unitCost: 1 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => move(p, i % 2 ? "purchase_in" : "manual_adjust", 3, { unitCost: 5, reason: "x" })));
    expect((await getProductBalance(A, p))?.onHand.toString()).toBe("30.001");
    expect((await recomputeOnHand(A, p)).toString()).toBe("30.001");
  });

  it("concurrent replays of one key write a single movement", async () => {
    const p = await newProduct();
    const k = key();
    const rs = await Promise.all([1, 2, 3].map(() => move(p, "initial_count", 4, { unitCost: 9, idempotencyKey: k })));
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect((await getProductBalance(A, p))?.onHand.toString()).toBe("4");
  });

  it("excel_reset writes the stock correction and the cost entry", async () => {
    const p = await newProduct();
    await move(p, "initial_count", 10, { unitCost: 100 });
    const r = await move(p, "excel_reset", -4, { unitCost: 120 });
    expect(r.onHandAfter.toString()).toBe("6");
    expect(r.unitCostAfter.toString()).toBe("120");
    const last = await listMovements(A, p, { limit: 1 });
    expect(last[0]?.type).toBe("excel_reset");
    expect(last[0]?.reason).toMatch(/Excel/);
    const entries = await db.productCostEntry.findMany({ where: { accountId: A, productId: p }, orderBy: { id: "asc" } });
    expect(entries.map((e) => [e.reason, e.unitCost.toString()])).toEqual([["initial", "100"], ["excel", "120"]]);
  });

  it("repair moves units between the buckets", async () => {
    const p = await newProduct();
    await move(p, "initial_count", 5, { unitCost: 1 });
    await move(p, "repair_out", -2);
    let bal = await getProductBalance(A, p);
    expect([bal?.onHand.toString(), bal?.inRepair.toString()]).toEqual(["3", "2"]);
    await move(p, "repair_in", 1);
    bal = await getProductBalance(A, p);
    expect([bal?.onHand.toString(), bal?.inRepair.toString()]).toEqual(["4", "1"]);
    await expect(move(p, "repair_in", 5)).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
  });

  it("validates signs, reasons, cost and the product", async () => {
    const p = await newProduct();
    await expect(move(p, "sale", 1)).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    await expect(move(p, "purchase_in", -1, { unitCost: 1 })).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    await expect(move(p, "purchase_in", 0, { unitCost: 1 })).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    await expect(move(p, "purchase_in", Number.NaN, { unitCost: 1 })).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    await expect(move(p, "purchase_in", 1)).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    await expect(move(p, "manual_adjust", 1)).rejects.toThrow(/reason/);
    await expect(move(p, "manual_adjust", 1, { reason: "  " })).rejects.toThrow(/reason/);
    await expect(move(p, "loss", -1)).rejects.toThrow(/reason/);
    await move(p, "loss", -1, { reason: "roto" });
    await expect(move(999_999_999, "sale", -1)).rejects.toBeInstanceOf(StockError);
    await expect(move(999_999_999, "sale", -1)).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
    const arch = await newProduct(A, { archivedAt: new Date() });
    await expect(move(arch, "sale", -1)).rejects.toMatchObject({ code: "PRODUCT_ARCHIVED" });
  });

  it("is tenant-scoped", async () => {
    const p = await newProduct(A);
    await expect(appendMovement({ accountId: B, productId: p, type: "sale", quantity: -1, occurredAt: at(0), idempotencyKey: key(), actor: "system" }))
      .rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });
});

describe("costAt", () => {
  it("returns the latest entry at or before the instant, null before any", async () => {
    const p = await newProduct();
    expect(await costAt(A, p, at(100))).toBeNull();
    await move(p, "initial_count", 10, { unitCost: 100, occurredAt: at(10) });
    await move(p, "purchase_in", 10, { unitCost: 200, occurredAt: at(20) });
    expect(await costAt(A, p, at(5))).toBeNull();
    expect((await costAt(A, p, at(10)))?.toString()).toBe("100");
    expect((await costAt(A, p, at(19)))?.toString()).toBe("100");
    expect((await costAt(A, p, at(20)))?.toString()).toBe("150");
    expect((await costAt(A, p, at(999)))?.toString()).toBe("150");
    await expect(costAt(A, 999_999_999, at(0))).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });
});

describe("reads", () => {
  it("listMovements pages newest first", async () => {
    const p = await newProduct();
    for (let i = 1; i <= 5; i++) await move(p, "manual_adjust", 1, { reason: "r", occurredAt: at(i) });
    const page1 = await listMovements(A, p, { limit: 2 });
    expect(page1.map((m) => m.occurredAt.getTime())).toEqual([at(5).getTime(), at(4).getTime()]);
    const page2 = await listMovements(A, p, { limit: 10, before: page1[1]!.occurredAt });
    expect(page2).toHaveLength(3);
    expect(page2[0]?.occurredAt.getTime()).toBe(at(3).getTime());
  });

  it("recomputeOnHand equals the cache after 200 random movements", async () => {
    const p = await newProduct();
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    await move(p, "initial_count", 50, { unitCost: 10 });
    for (let i = 0; i < 199; i++) {
      const r = rnd();
      const qty = Math.floor(rnd() * 9) + 1;
      if (r < 0.3) await move(p, "purchase_in", qty, { unitCost: 10 + Math.floor(rnd() * 90) });
      else if (r < 0.7) await move(p, "sale", -qty);
      else if (r < 0.8) await move(p, "sale_cancel", qty);
      else if (r < 0.9) await move(p, "manual_adjust", rnd() < 0.5 ? qty : -qty, { reason: "t" });
      else await move(p, "loss", -qty, { reason: "t" });
    }
    expect(await db.stockMovement.count({ where: { accountId: A, productId: p } })).toBe(200);
    const bal = await getProductBalance(A, p);
    expect((await recomputeOnHand(A, p)).toString()).toBe(bal?.onHand.toString());
    const last = (await listMovements(A, p, { limit: 1 }))[0];
    expect(last?.onHandAfter.toString()).toBe(bal?.onHand.toString());
  }, 60_000);
});
