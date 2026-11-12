import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s3";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("~/server/ml/tokens", () => ({
  tokenAuthFor: () => ({ getAccessToken: () => Promise.resolve("tok"), refresh: () => Promise.resolve() }),
}));

import { db } from "~/server/db";
import { ensureAccount } from "~/server/store/bulk";
import { readPushLog } from "~/server/store/stockPush";
import { StockError, type RaiseAlertInput } from "./contracts";
import { createPushEngine } from "./push";

const A = "s3_push_a";
const B = "s3_push_b";
const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

/* ---------- fake Mercado Libre behind a mocked fetch ---------- */
interface FakeItem { id: string; available_quantity?: number; status?: string; logistic?: string; variations?: { id: number; available_quantity: number }[] }
let items: Record<string, FakeItem>;
let puts: { url: string; body: unknown }[];
let putResponses: number[]; // statuses returned by successive PUTs (default 200)
let gets: number;

function installFetch() {
  puts = [];
  gets = 0;
  putResponses = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    if (init.method === "PUT") {
      puts.push({ url, body: JSON.parse(init.body as string) });
      const status = putResponses.shift() ?? 200;
      return Promise.resolve(new Response(status === 200 ? "{}" : "err", { status }));
    }
    gets++;
    const ids = new URL(url).searchParams.get("ids")!.split(",");
    return Promise.resolve(new Response(JSON.stringify(ids.map((id) => {
      const it = items[id];
      if (!it) return { code: 404, body: { id } };
      return {
        code: 200,
        body: {
          id, available_quantity: it.available_quantity ?? 0, status: it.status ?? "active", listing_type_id: "gold_special",
          shipping: { logistic_type: it.logistic ?? "cross_docking" }, variations: it.variations ?? [],
        },
      };
    }))));
  }));
}

/* ---------- fixtures ---------- */
let alerts: RaiseAlertInput[];
let resolved: string[];
const movements: unknown[] = [];
const engine = () =>
  createPushEngine({
    sleep,
    raiseAlert: (i) => { alerts.push(i); return Promise.resolve({ alertId: 1, created: true }); },
    resolveAlert: (_a, key) => { resolved.push(key); return Promise.resolve(); },
    appendMovement: (m) => { movements.push(m); return Promise.resolve({ movementId: 1, created: true, onHandAfter: null as never, unitCostAfter: null as never }); },
  });

async function product(accountId: string, name: string, onHand: number, syncMode: "dry_run" | "live" = "live") {
  const p = await db.inventoryProduct.create({ data: { accountId, name, onHand, syncMode } });
  return Number(p.id);
}
async function link(accountId: string, itemId: string, comps: [number, number][], variationId: number | null = null) {
  const l = await db.listingLink.create({ data: { accountId, marketplace: "mercadolibre", itemId, variationId } });
  await db.listingLinkComponent.createMany({
    data: comps.map(([productId, quantity]) => ({ accountId, linkId: l.id, productId: BigInt(productId), quantity })),
  });
  await db.listingSyncState.create({ data: { accountId, linkId: l.id } });
  return Number(l.id);
}
const state = (accountId: string, linkId: number) =>
  db.listingSyncState.findUniqueOrThrow({ where: { accountId_linkId: { accountId, linkId: BigInt(linkId) } } });
const logOf = async (accountId: string) => (await readPushLog(accountId, 50)).reverse();

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await ensureAccount(A);
  await ensureAccount(B);
  alerts = [];
  resolved = [];
  movements.length = 0;
  sleep.mockClear();
  items = {};
  installFetch();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await db.$disconnect();
});

describe("requestPush", () => {
  it("dry-run: logs, sends nothing", async () => {
    const p = await product(A, "Cámara", 5, "dry_run");
    const l = await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1", available_quantity: 9 };
    await engine().requestPush(A, [p], { type: "sale", ref: "123" });
    expect(puts).toEqual([]);
    const [row] = await logOf(A);
    expect(row).toMatchObject({ itemId: "MLA1", requestedQty: 5, previousMlQty: 9, mode: "dry_run", result: "dry_run", triggerType: "sale", triggerRef: "123" });
    expect((await state(A, l)).lastObservedMlQty).toBe(9);
    expect((await state(A, l)).lastPushedQty).toBeNull();
  });

  it("live: PUTs available_quantity and updates the sync state", async () => {
    const p = await product(A, "Cámara", 5);
    const l = await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1", available_quantity: 9 };
    await engine().requestPush(A, [p], { type: "adjust" });
    expect(puts).toEqual([{ url: "https://api.mercadolibre.com/items/MLA1", body: { available_quantity: 5 } }]);
    const [row] = await logOf(A);
    expect(row).toMatchObject({ mode: "live", result: "ok", requestedQty: 5, previousMlQty: 9, httpStatus: 200 });
    expect(await state(A, l)).toMatchObject({ status: "in_sync", lastPushedQty: 5, lastError: null });
    expect(resolved).toContain("MLA1");
  });

  it("clamps negative stock to 0", async () => {
    const p = await product(A, "X", -3);
    await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1", available_quantity: 2 };
    await engine().requestPush(A, [p], { type: "sale" });
    expect(puts[0]!.body).toEqual({ available_quantity: 0 });
  });

  it("combo: min over components of floor(onHand / qty)", async () => {
    const a = await product(A, "A", 10);
    const b = await product(A, "B", 7);
    await link(A, "MLA1", [[a, 2], [b, 3]]);
    items.MLA1 = { id: "MLA1" };
    await engine().requestPush(A, [b], { type: "sale" }); // triggered by B only, but A is a component too
    expect(puts[0]!.body).toEqual({ available_quantity: 2 });
  });

  it("combo with one dry-run component stays dry-run", async () => {
    const a = await product(A, "A", 10, "live");
    const b = await product(A, "B", 7, "dry_run");
    await link(A, "MLA1", [[a, 1], [b, 1]]);
    items.MLA1 = { id: "MLA1" };
    await engine().requestPush(A, [a], { type: "sale" });
    expect(puts).toEqual([]);
    expect((await logOf(A))[0]!.result).toBe("dry_run");
  });

  it("variation payload", async () => {
    const p = await product(A, "Var", 4);
    await link(A, "MLA1", [[p, 1]], 777);
    items.MLA1 = { id: "MLA1", variations: [{ id: 777, available_quantity: 1 }] };
    await engine().requestPush(A, [p], { type: "sale" });
    expect(puts[0]!.body).toEqual({ variations: [{ id: 777, available_quantity: 4 }] });
    expect((await logOf(A))[0]).toMatchObject({ variationId: 777, previousMlQty: 1, result: "ok" });
  });

  it("skips ML Full, inactive items, item with variations linked whole, missing items and archived products", async () => {
    const p = await product(A, "P", 5);
    const archived = await product(A, "Old", 5);
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: BigInt(archived) } }, data: { archivedAt: new Date() } });
    await link(A, "MLA1", [[p, 1]]);
    await link(A, "MLA2", [[p, 1]]);
    await link(A, "MLA3", [[p, 1]]);
    await link(A, "MLA4", [[p, 1]]);
    await link(A, "MLA5", [[p, 1], [archived, 1]]);
    items.MLA1 = { id: "MLA1", logistic: "fulfillment" };
    items.MLA2 = { id: "MLA2", status: "closed" };
    items.MLA3 = { id: "MLA3", variations: [{ id: 1, available_quantity: 0 }] };
    items.MLA5 = { id: "MLA5" };
    await engine().requestPush(A, [p], { type: "sale" });
    expect(puts).toEqual([]);
    const log = await logOf(A);
    expect(log).toHaveLength(5);
    expect(log.every((r) => r.result === "skipped")).toBe(true);
    expect(log.find((r) => r.itemId === "MLA1")!.error).toMatch(/Full/);
    expect(log.find((r) => r.itemId === "MLA4")!.error).toMatch(/no encontrada/);
  });

  it("paused items are pushed", async () => {
    const p = await product(A, "P", 3);
    await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1", status: "paused" };
    await engine().requestPush(A, [p], { type: "sale" });
    expect(puts).toHaveLength(1);
  });

  it("never touches a product with no link (unknown products are never pushed as 0)", async () => {
    const p = await product(A, "Unlinked", 0);
    items.MLA1 = { id: "MLA1", available_quantity: 8 };
    await engine().requestPush(A, [p], { type: "sale" });
    expect(puts).toEqual([]);
    expect(gets).toBe(0);
    expect(await logOf(A)).toEqual([]);
  });

  it("does not leak across accounts", async () => {
    const pb = await product(B, "B", 1);
    await link(B, "MLA9", [[pb, 1]]);
    const pa = await product(A, "A", 1);
    items.MLA9 = { id: "MLA9" };
    await engine().requestPush(A, [pa, pb], { type: "sale" });
    expect(puts).toEqual([]);
  });

  it("retries 429/5xx with backoff, then succeeds", async () => {
    const p = await product(A, "P", 2);
    await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1" };
    putResponses = [429, 503];
    await engine().requestPush(A, [p], { type: "sale" });
    expect(puts).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect((await logOf(A))[0]!.result).toBe("ok");
    expect(alerts).toEqual([]);
  });

  it("gives up after 3 attempts: failed log, failed state, push_failed alert", async () => {
    const p = await product(A, "P", 2);
    const l = await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1" };
    putResponses = [500, 500, 500, 500];
    await engine().requestPush(A, [p], { type: "sale" });
    expect(puts).toHaveLength(3);
    expect((await logOf(A))[0]).toMatchObject({ result: "failed", httpStatus: 500 });
    expect(await state(A, l)).toMatchObject({ status: "failed" });
    expect((await state(A, l)).lastError).toMatch(/500/);
    expect(alerts).toMatchObject([{ type: "push_failed", dedupeKey: "MLA1" }]);
  });

  it("4xx other than 429 fails immediately", async () => {
    const p = await product(A, "P", 2);
    await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1" };
    putResponses = [400];
    await engine().requestPush(A, [p], { type: "sale" });
    expect(puts).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect((await logOf(A))[0]).toMatchObject({ result: "failed", httpStatus: 400 });
    expect(alerts).toHaveLength(1);
  });

  it("a failed ML read in live mode sends nothing and fails", async () => {
    const p = await product(A, "P", 2);
    await link(A, "MLA1", [[p, 1]]);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("x", { status: 400 }))));
    await engine().requestPush(A, [p], { type: "sale" });
    expect((await logOf(A))[0]!.result).toBe("failed");
  });
});

describe("compareWithMl", () => {
  it("records ML quantities, marks drift and alerts; heals live products without a prior alert", async () => {
    const live = await product(A, "Live", 5);
    const dry = await product(A, "Dry", 5, "dry_run");
    const same = await product(A, "Same", 3);
    const lLive = await link(A, "MLA1", [[live, 1]]);
    const lDry = await link(A, "MLA2", [[dry, 1]]);
    const lSame = await link(A, "MLA3", [[same, 1]]);
    items.MLA1 = { id: "MLA1", available_quantity: 9 };
    items.MLA2 = { id: "MLA2", available_quantity: 9 };
    items.MLA3 = { id: "MLA3", available_quantity: 3 };
    const r = await engine().compareWithMl(A);
    expect(r).toEqual({ checked: 3, drift: 2, pushed: 1 });
    expect(alerts.filter((a) => a.type === "stock_drift").map((a) => a.dedupeKey).sort()).toEqual([`drift:${lLive}`, `drift:${lDry}`].sort());
    // dry-run product is never overwritten
    expect(puts).toEqual([{ url: "https://api.mercadolibre.com/items/MLA1", body: { available_quantity: 5 } }]);
    expect((await state(A, lDry))).toMatchObject({ status: "drift", lastObservedMlQty: 9, lastPushedQty: null });
    expect((await state(A, lSame))).toMatchObject({ status: "in_sync", lastObservedMlQty: 3 });
    expect((await state(A, lLive)).status).toBe("in_sync"); // healed
    expect(await logOf(A)).toHaveLength(1);
  });

  it("does not push for a live product that already has an open drift alert", async () => {
    const p = await product(A, "Live", 5);
    const l = await link(A, "MLA1", [[p, 1]]);
    await db.stockAlert.create({ data: { accountId: A, type: "stock_drift", dedupeKey: `drift:${l}`, title: "x" } });
    items.MLA1 = { id: "MLA1", available_quantity: 9 };
    const r = await engine().compareWithMl(A);
    expect(r).toMatchObject({ drift: 1, pushed: 0 });
    expect(puts).toEqual([]);
    expect((await state(A, l)).status).toBe("drift");
  });

  it("skips Full listings and variations that no longer exist", async () => {
    const p = await product(A, "P", 1);
    await link(A, "MLA1", [[p, 1]]);
    await link(A, "MLA2", [[p, 1]], 5);
    items.MLA1 = { id: "MLA1", logistic: "fulfillment", available_quantity: 99 };
    items.MLA2 = { id: "MLA2", variations: [{ id: 6, available_quantity: 1 }] };
    expect(await engine().compareWithMl(A)).toEqual({ checked: 0, drift: 0, pushed: 0 });
    expect(alerts).toEqual([]);
  });

  it("auto-resolves the drift alert when ML matches again", async () => {
    const p = await product(A, "P", 4, "dry_run");
    const l = await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1", available_quantity: 4 };
    await engine().compareWithMl(A);
    expect(resolved).toContain(`drift:${l}`);
  });
});

describe("go live", () => {
  it("prepareGoLive shows ours vs ML", async () => {
    const p = await product(A, "Cámara", 5, "dry_run");
    const l = await link(A, "MLA1", [[p, 1]]);
    await link(A, "MLA2", [[p, 1]]);
    items.MLA1 = { id: "MLA1", available_quantity: 7 };
    const r = await engine().prepareGoLive(A, p);
    expect(r).toMatchObject({ productId: p, productName: "Cámara", ourOnHand: 5 });
    expect(r.listings).toEqual([
      { linkId: l, itemId: "MLA1", variationId: null, mlQty: 7 },
      expect.objectContaining({ itemId: "MLA2", mlQty: null }),
    ]);
    await expect(engine().prepareGoLive(A, 999999)).rejects.toBeInstanceOf(StockError);
  });

  it("setSyncMode live needs the confirmation; nothing changes without it", async () => {
    const p = await product(A, "P", 5, "dry_run");
    await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1" };
    await expect(engine().setSyncMode(A, [p], "live")).rejects.toMatchObject({ code: "ML_WRITE_BLOCKED" });
    expect((await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: BigInt(p) } } })).syncMode).toBe("dry_run");
    expect(puts).toEqual([]);
  });

  it("confirmed as-is: flips to live, no adjustment, pushes", async () => {
    const p = await product(A, "P", 5, "dry_run");
    await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1", available_quantity: 7 };
    await engine().setSyncMode(A, [p], "live", [{ productId: p, openingStock: 5, idempotencyKey: "k1" }]);
    expect(movements).toEqual([]);
    expect(puts[0]!.body).toEqual({ available_quantity: 5 });
  });

  it("edited opening stock writes a manual_adjust of the delta through the ledger", async () => {
    const p = await product(A, "P", 5, "dry_run");
    await link(A, "MLA1", [[p, 1]]);
    items.MLA1 = { id: "MLA1" };
    await engine().setSyncMode(A, [p], "live", [{ productId: p, openingStock: 8, idempotencyKey: "k2" }]);
    expect(movements).toMatchObject([{ accountId: A, productId: p, type: "manual_adjust", idempotencyKey: "k2", actor: "user" }]);
    expect(String((movements[0] as { quantity: unknown }).quantity)).toBe("3");
  });

  it("'all' = linked products only; dry_run needs no confirmation", async () => {
    const linked = await product(A, "L", 1, "live");
    await product(A, "NotLinked", 1, "live");
    await link(A, "MLA1", [[linked, 1]]);
    await engine().setSyncMode(A, "all", "dry_run");
    const rows = await db.inventoryProduct.findMany({ where: { accountId: A }, orderBy: { id: "asc" } });
    expect(rows.map((r) => r.syncMode)).toEqual(["dry_run", "live"]);
  });
});

describe("syncStatus / pushLog", () => {
  it("lists links with the desired quantity", async () => {
    const p = await product(A, "P", 6, "dry_run");
    await link(A, "MLA1", [[p, 2]]);
    const s = await engine().syncStatus(A);
    expect(s).toMatchObject([{ itemId: "MLA1", desiredQty: 3, status: "never", mode: "dry_run", productNames: ["P"] }]);
    items.MLA1 = { id: "MLA1" };
    await engine().requestPush(A, [p], { type: "manual" });
    const log = await engine().pushLog(A, 10);
    expect(log[0]).toMatchObject({ itemId: "MLA1", marketplace: "mercadolibre" });
    expect(typeof log[0]!.createdAt).toBe("string");
  });
});
