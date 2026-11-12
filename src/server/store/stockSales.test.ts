import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s4";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import { db } from "~/server/db";
import { ensureAccount } from "./bulk";
import { accountByExternalUser, readPendingLines, readSalesSettings, reconcilableAccounts, setLastReconcileAt, withAccountLock } from "./stockSales";
import { markProcessed, readEvent, recordEvent } from "./webhookEvents";

const A = "s4_store_a";
const B = "s4_store_b";
const conn = (accountId: string, externalUserId: string) =>
  db.marketplaceConnection.create({ data: { accountId, marketplace: "mercadolibre", externalUserId, accessToken: "x", refreshToken: "y", expiresAt: new Date() } });

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await ensureAccount(A);
  await ensureAccount(B);
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await db.$disconnect();
});

describe("stockSales store", () => {
  it("maps a marketplace user to its account, settings and reconcile stamp round-trip", async () => {
    await conn(A, "u-s4-a");
    await conn(B, "u-s4-b");
    expect(await accountByExternalUser("u-s4-a")).toBe(A);
    expect(await accountByExternalUser("nobody")).toBeNull();

    expect(await readSalesSettings(A)).toBeNull();
    expect(await reconcilableAccounts()).toEqual(expect.not.arrayContaining([expect.objectContaining({ accountId: A })]));
    const cutoverAt = new Date("2026-10-01T03:00:00Z");
    await db.inventorySettings.create({ data: { accountId: A, cutoverAt } });
    await db.inventorySettings.create({ data: { accountId: B } }); // no cutover
    expect(await reconcilableAccounts()).toEqual(expect.arrayContaining([{ accountId: A, externalUserId: "u-s4-a" }]));
    expect((await reconcilableAccounts()).some((r) => r.accountId === B)).toBe(false);

    const at = new Date("2026-10-02T00:00:00Z");
    await setLastReconcileAt(A, at);
    expect(await readSalesSettings(A)).toEqual({ cutoverAt, lastReconcileAt: at });
  });

  it("pending lines are scoped per account and ordered by creation time", async () => {
    const mk = async (acc: string, id: number, created: string) => {
      await db.listing.createMany({ data: [{ accountId: acc, marketplace: "mercadolibre", itemId: "MLA9" }], skipDuplicates: true });
      await db.order.create({ data: { accountId: acc, marketplace: "mercadolibre", orderId: id, status: "paid", createdAt: new Date(created) } });
      await db.orderItem.create({ data: { accountId: acc, marketplace: "mercadolibre", orderId: id, lineNo: 0, itemId: "MLA9", title: "t", quantity: 1, unitPrice: 1, saleFee: 0 } });
    };
    await mk(A, 2, "2026-10-03T00:00:00Z");
    await mk(A, 1, "2026-10-04T00:00:00Z");
    await mk(B, 3, "2026-10-03T00:00:00Z");
    const lines = await readPendingLines(A, new Date("2026-10-01T00:00:00Z"), { itemId: "mla9" });
    expect(lines.map((l) => l.orderId)).toEqual([2, 1]);
    expect(await readPendingLines(A, new Date("2026-10-03T12:00:00Z"))).toHaveLength(1);
  });

  it("the advisory lock serializes work on one account but not across accounts", async () => {
    const log: string[] = [];
    const slow = (name: string, acc: string, ms: number) => withAccountLock(acc, async () => {
      log.push(`${name}:in`); await new Promise((r) => setTimeout(r, ms)); log.push(`${name}:out`);
    });
    const first = slow("a1", A, 150);
    while (!log.includes("a1:in")) await new Promise((r) => setTimeout(r, 5));
    const second = slow("a2", A, 0);
    const other = slow("b1", B, 0); // another account is not blocked
    await other;
    expect(log).toEqual(["a1:in", "b1:in", "b1:out"]);
    await Promise.all([first, second]);
    expect(log.slice(3)).toEqual(["a1:out", "a2:in", "a2:out"]);
  });
});

describe("webhookEvents store", () => {
  it("dedupes on the marketplace event id and records the processing result", async () => {
    const first = await recordEvent({ accountId: A, topic: "orders_v2", resource: "/orders/1", externalEventId: "e1" });
    expect(first).toMatchObject({ created: true });
    expect(await recordEvent({ accountId: A, topic: "orders_v2", resource: "/orders/1", externalEventId: "e1" })).toBeNull();
    await markProcessed(first!.id, "boom");
    expect(await readEvent(first!.id)).toMatchObject({ accountId: A, resource: "/orders/1", error: "boom" });
    expect((await readEvent(first!.id))!.processedAt).not.toBeNull();
  });

  it("without an id, repeats are dropped only while the first is unprocessed and recent", async () => {
    const t = new Date("2026-10-01T10:00:00Z");
    const e = { accountId: A, topic: "orders_v2", resource: "/orders/2" };
    const first = await recordEvent(e, t);
    expect(await recordEvent(e, new Date(t.getTime() + 10_000))).toBeNull();
    expect(await recordEvent(e, new Date(t.getTime() + 120_000))).not.toBeNull(); // old enough: a new event
    await markProcessed(first!.id, null);
    expect(await recordEvent({ ...e, resource: "/orders/3" }, t)).not.toBeNull();
  });
});
