import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s4";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
const afters: (() => Promise<void>)[] = [];
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => Promise<void>) => { afters.push(fn); },
}));

import { db } from "~/server/db";
import { ensureAccount } from "~/server/store/bulk";
import { handlers, POST } from "./route";

const A = "s4_hook_a";
const applied: [string, number, string | undefined][] = [];

const post = (body: unknown) =>
  POST(new Request("http://x/api/webhooks/ml", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const note = (over: Record<string, unknown> = {}) => ({ _id: "n-1", topic: "orders_v2", resource: "/orders/123", user_id: 777, ...over });
const drain = async () => { while (afters.length) await afters.shift()!(); };

beforeEach(async () => {
  await db.webhookEvent.deleteMany({ where: { accountId: A } });
  await db.account.deleteMany({ where: { id: A } });
  await ensureAccount(A);
  await db.marketplaceConnection.create({ data: { accountId: A, marketplace: "mercadolibre", externalUserId: "777", accessToken: "x", refreshToken: "y", expiresAt: new Date() } });
  applied.length = 0; afters.length = 0;
  handlers.applyOrder = (async (a: string, id: number, actor?: string) => { applied.push([a, id, actor]); return { status: "applied" }; }) as never;
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: A } });
  await db.$disconnect();
});

describe("POST /api/webhooks/ml", () => {
  it("answers 200 fast, stores the event and processes it after the response", async () => {
    const t = Date.now();
    const res = await post(note());
    expect(res.status).toBe(200);
    expect(Date.now() - t).toBeLessThan(500);
    expect(applied).toEqual([]); // not before responding
    await drain();
    expect(applied).toEqual([[A, 123, "webhook"]]);
    const ev = await db.webhookEvent.findFirstOrThrow({ where: { accountId: A } });
    expect(ev).toMatchObject({ topic: "orders_v2", resource: "/orders/123", externalEventId: "n-1", error: null });
    expect(ev.processedAt).not.toBeNull();
  });

  it("drops a duplicate notification", async () => {
    await post(note());
    const second = await post(note());
    expect(second.status).toBe(200);
    await drain();
    expect(applied).toHaveLength(1);
    expect(await db.webhookEvent.count({ where: { accountId: A } })).toBe(1);
  });

  it("dedupes notifications that carry no id while the first is still waiting", async () => {
    await post(note({ _id: undefined }));
    await post(note({ _id: undefined }));
    await drain();
    expect(applied).toHaveLength(1);
  });

  it("acknowledges and ignores unknown sellers, other topics and garbage", async () => {
    for (const b of [note({ user_id: 1 }), note({ topic: "items" }), note({ resource: "/orders/abc" }), "not json", { }]) {
      expect((await post(b)).status).toBe(200);
    }
    await drain();
    expect(applied).toEqual([]);
    expect(await db.webhookEvent.count({ where: { accountId: A } })).toBe(0);
  });

  it("records the error when processing fails and still answered 200", async () => {
    handlers.applyOrder = (async () => { throw new Error("ML down"); }) as never;
    expect((await post(note())).status).toBe(200);
    await drain();
    const ev = await db.webhookEvent.findFirstOrThrow({ where: { accountId: A } });
    expect(ev.error).toBe("ML down");
    expect(ev.processedAt).not.toBeNull();
  });
});
