import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s4";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("~/server/ml/tokens", () => ({
  tokenAuthFor: () => ({ getAccessToken: () => Promise.resolve("tok"), refresh: () => Promise.resolve() }),
}));

import { db } from "~/server/db";
import { ensureAccount } from "~/server/store/bulk";
import { createSales } from "./sales";

const A = "s4_ml_a";
let calls: { method: string; url: string }[];

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: A } });
  await ensureAccount(A);
  await db.marketplaceConnection.create({ data: { accountId: A, marketplace: "mercadolibre", externalUserId: "555", accessToken: "x", refreshToken: "y", expiresAt: new Date() } });
  await db.inventorySettings.create({ data: { accountId: A, cutoverAt: new Date("2026-10-01T00:00:00Z") } });
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(url) });
    const u = new URL(String(url));
    const body = u.pathname === "/orders/search"
      ? { results: [{ id: 9, status: "paid", date_created: "2026-10-05T10:00:00.000-03:00", order_items: [], payments: [] }], paging: { total: 1 } }
      : u.pathname.startsWith("/shipments/") ? { status: "shipped" } : { id: 9, status: "paid", date_created: "2026-10-05T10:00:00.000-03:00", order_items: [], payments: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.account.deleteMany({ where: { id: A } });
});

describe("default Mercado Libre reads", () => {
  it("only GET, orders by last update for the seller, compacted to the contract shape", async () => {
    const s = createSales({ compareWithMl: async () => undefined });
    const r = await s.reconcileAccount(A);
    expect(r).toMatchObject({ orders: 1, errors: 0 });
    await s.applyOrder(A, 9);
    expect(calls.every((c) => c.method === "GET" && new URL(c.url).hostname === "api.mercadolibre.com")).toBe(true);
    const search = new URL(calls[0]!.url);
    expect(search.pathname).toBe("/orders/search");
    expect(search.searchParams.get("seller")).toBe("555");
    expect(search.searchParams.get("order.date_last_updated.from")).toMatch(/-03:00$/);
    expect(calls.some((c) => c.url.endsWith("/orders/9"))).toBe(true);
  });
});
