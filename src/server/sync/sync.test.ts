import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_t6";
});
vi.mock("~/env", () => ({
  env: {
    NODE_ENV: "test",
    DATA_SOURCE: "demo",
    BASE_PNL_PATH: "demo/PnL_MercadoLibre_Septiembre2026_DEMO.xlsx",
    VENTAS_DIRECTAS_PATH: "demo/Ventas_Directas_DEMO.xlsx",
  },
}));

import { DashboardDataSchema, type DashboardData } from "~/lib/contracts";
import { loadBusinessConfig } from "~/server/config";
import { db } from "~/server/db";
import { DemoDataSource } from "~/server/datasource/demo";
import { workbooks } from "~/server/workbooks";
import { enrich, fetchMonth } from "./enrich";
import { rebuildAll } from "./rebuild";
import { runSync } from "./run";
import { createSyncService } from "./service";

const OWNER = "user_a";
const OTHER = "user_b";
const NOW = new Date("2026-10-20T15:30:00-03:00");

async function demoSource() {
  const { base } = await workbooks.readBase(
    path.resolve("demo/PnL_MercadoLibre_Septiembre2026_DEMO.xlsx"),
    loadBusinessConfig(),
  );
  return new DemoDataSource({ base, now: NOW });
}

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: { in: [OWNER, OTHER] } } }); // cascades to every table the sync writes
});
afterAll(() => db.$disconnect());

describe("runSync (demo)", () => {
  it("stores a valid snapshot", async () => {
    const data = await runSync(OWNER, NOW);
    DashboardDataSchema.parse(data);
    expect(data.monthLabel).toBe("Octubre 2026");
    expect(data.rows.length).toBeGreaterThan(100);
    const snap = await db.snapshot.findUnique({ where: { accountId_month: { accountId: OWNER, month: "2026-10" } } });
    expect(snap?.computedAt.toISOString()).toBe(NOW.toISOString());
    expect(DashboardDataSchema.parse(snap?.payload)).toEqual(data);
  });
});

describe("enrich caching", () => {
  it("second run makes no shipment/GTIN/tax calls for old orders", async () => {
    const ds = await demoSource();
    // run far enough in the future that every order is "old" (> 3 days)
    const later = new Date("2026-12-20T12:00:00-03:00");
    const orders = (await ds.getOrdersMonth(2026, 9)).filter((o) => o.status === "paid");
    const ship = vi.spyOn(ds, "getShipmentCosts");
    const gtin = vi.spyOn(ds, "getGtins");
    const tax = vi.spyOn(ds, "getPaymentTaxes");

    const first = await enrich(OWNER, ds, orders, later);
    expect(ship).toHaveBeenCalledTimes(1);
    expect(gtin).toHaveBeenCalledTimes(1);
    expect(tax.mock.calls.length).toBeGreaterThan(0);
    expect(Object.keys(first.taxes).length).toBeGreaterThan(0);

    ship.mockClear(); gtin.mockClear(); tax.mockClear();
    const second = await enrich(OWNER, ds, orders, later);
    expect(ship).not.toHaveBeenCalled();
    expect(gtin).not.toHaveBeenCalled();
    // payments without MP detail (null) are retried; everything with detail is not
    const retried = tax.mock.calls.flatMap((c) => c[0]);
    expect(retried.every((id) => !(id in first.taxes))).toBe(true);
    expect(second.taxes).toEqual(first.taxes);
    expect(second.shipCosts).toEqual(first.shipCosts);
    expect(second.gtins).toEqual(first.gtins);
  });

  it("caches catalog ids per item and retries items without one", async () => {
    const ds = await demoSource();
    const orders = (await ds.getOrdersMonth(2026, 10)).filter((o) => o.status === "paid");
    const ids = [...new Set(orders.flatMap((o) => o.items.map((i) => i.itemId.toUpperCase())))];
    const cat = vi.spyOn(ds, "getCatalogIds").mockResolvedValue({ [ids[0]!]: "MLA999" });
    const first = await enrich(OWNER, ds, orders, NOW);
    expect(first.catalogIds[ids[0]!]).toBe("MLA999");
    expect(cat).toHaveBeenCalledTimes(1);
    cat.mockClear();
    const second = await enrich(OWNER, ds, orders, NOW);
    expect(second.catalogIds[ids[0]!]).toBe("MLA999");
    expect(cat.mock.calls[0]![0]).not.toContain(ids[0]!); // found ones are not asked again
    cat.mockRejectedValue(new Error("boom"));
    await expect(enrich(OWNER, ds, orders, NOW)).resolves.toBeDefined(); // never breaks the sync
  });

  it("re-fetches shipments of recent orders", async () => {
    const ds = await demoSource();
    const orders = (await ds.getOrdersMonth(2026, 10)).filter((o) => o.status === "paid");
    await enrich(OWNER, ds, orders, NOW);
    const ship = vi.spyOn(ds, "getShipmentCosts");
    await enrich(OWNER, ds, orders, NOW);
    const asked = new Set(ship.mock.calls.flatMap((c) => c[0]));
    expect(asked.size).toBeGreaterThan(0);
    expect(asked.size).toBeLessThan(orders.length); // old ones stay cached
  });

  it("stops querying taxes after 5 failures and keeps null", async () => {
    const ds = await demoSource();
    const orders = (await ds.getOrdersMonth(2026, 9)).filter((o) => o.status === "paid");
    const later = new Date("2026-12-20T12:00:00-03:00");
    const tax = vi.spyOn(ds, "getPaymentTaxes").mockRejectedValue(new Error("boom"));
    const warn: string[] = [];
    const out = await enrich(OWNER, ds, orders, later, (m) => warn.push(m));
    expect(tax).toHaveBeenCalledTimes(5);
    expect(out.taxes).toEqual({});
    expect(warn.some((m) => m.startsWith("Aviso"))).toBe(true);
  });
});

describe("what is asked again, and when", () => {
  const DAY = 86_400_000;

  it("a listing with no catalog product is asked again only after 24 h", async () => {
    const ds = await demoSource();
    const orders = (await ds.getOrdersMonth(2026, 10)).filter((o) => o.status === "paid");
    const ids = [...new Set(orders.flatMap((o) => o.items.map((i) => i.itemId.toUpperCase())))];
    const cat = vi.spyOn(ds, "getCatalogIds").mockImplementation((asked) => Promise.resolve(Object.fromEntries(asked.map((i) => [i, null]))));
    await enrich(OWNER, ds, orders, new Date());
    expect(cat.mock.calls[0]![0]).toHaveLength(ids.length);
    cat.mockClear();
    await enrich(OWNER, ds, orders, new Date()); // same day: everything was just answered
    expect(cat).not.toHaveBeenCalled();
    await enrich(OWNER, ds, orders, new Date(Date.now() + DAY + 60_000)); // a day later
    expect(cat.mock.calls[0]![0]).toHaveLength(ids.length);
  });

  it("a payment Mercado Pago has no tax detail for is asked again after 6 h, not on every sync", async () => {
    const ds = await demoSource();
    const orders = (await ds.getOrdersMonth(2026, 9)).filter((o) => o.status === "paid");
    const later = new Date(Date.now() + 40 * DAY); // every order is old, so only the "no detail" rule applies
    const first = await enrich(OWNER, ds, orders, later);
    const approved = orders.flatMap((o) => o.payments.filter((p) => p.status === "approved").map((p) => String(p.id)));
    const noDetail = approved.filter((id) => !(id in first.taxes));
    expect(noDetail.length).toBeGreaterThan(0);
    const tax = vi.spyOn(ds, "getPaymentTaxes");
    await enrich(OWNER, ds, orders, new Date(later.getTime() + 3_600_000)); // 1 h later
    expect(tax).not.toHaveBeenCalled();
    await enrich(OWNER, ds, orders, new Date(later.getTime() + 7 * 3_600_000)); // 7 h later
    expect(new Set(tax.mock.calls.flatMap((c) => c[0]))).toEqual(new Set(noDetail));
  });

  it("a sync persists the month's orders and the economics lines it computed", async () => {
    const data = await runSync(OWNER, NOW);
    const lines = await db.saleLine.findMany({ where: { accountId: OWNER, period: "2026-10" } });
    expect(lines.length).toBe(data.rows.length);
    const revenue = lines.reduce((s, l) => s + l.revenue.toNumber(), 0);
    expect(revenue).toBeCloseTo(data.rows.reduce((s, r) => s + r.sale, 0), 0);
    expect(await db.order.count({ where: { accountId: OWNER } })).toBeGreaterThan(0);
    expect(await db.orderPeriod.findMany({ where: { accountId: OWNER }, select: { month: true, isFinal: true } })).toEqual(
      expect.arrayContaining([{ month: "2026-10", isFinal: false }, { month: "2026-09", isFinal: true }]),
    );
  });

  it("rebuildAll with refetch marks everything stale but keeps the old values until new ones arrive", async () => {
    await runSync(OWNER, NOW);
    const orders = await db.order.count({ where: { accountId: OWNER } });
    const ds = await demoSource();
    const ship = vi.spyOn(ds, "getShipmentCosts");
    await rebuildAll(OWNER, { now: NOW, refetch: true });
    expect(await db.order.count({ where: { accountId: OWNER } })).toBeGreaterThanOrEqual(orders); // nothing wiped
    expect(await db.shipment.count({ where: { accountId: OWNER, costFetchedAt: null, sellerCost: { not: null } } })).toBe(0);
    ship.mockRestore();
  });

  it("a closed month that is final is read from the database, not downloaded again", async () => {
    const ds = await demoSource();
    const spy = vi.spyOn(ds, "getOrdersMonth");
    const first = await fetchMonth(OWNER, ds, 2026, 9, true, 20);
    spy.mockClear();
    const again = await fetchMonth(OWNER, ds, 2026, 9, true, 21);
    expect(spy).not.toHaveBeenCalled();
    // same orders; orders created in the same instant come back ordered by id, not by API order
    const byTime = (a: { dateCreated: string; id: number }, b: { dateCreated: string; id: number }) =>
      a.dateCreated < b.dateCreated ? -1 : a.dateCreated > b.dateCreated ? 1 : a.id - b.id;
    expect(again).toEqual([...first].sort(byTime));
  });
});

describe("fetchMonth", () => {
  it("never caches the current month; caches a closed one", async () => {
    const ds = await demoSource();
    const spy = vi.spyOn(ds, "getOrdersMonth");
    await fetchMonth(OWNER, ds, 2026, 10, false, 20);
    await fetchMonth(OWNER, ds, 2026, 10, false, 20);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    await fetchMonth(OWNER, ds, 2026, 9, true, 20);
    await fetchMonth(OWNER, ds, 2026, 9, true, 21);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("re-downloads a closed month during days 1–5 of the next one", async () => {
    const ds = await demoSource();
    const spy = vi.spyOn(ds, "getOrdersMonth");
    await fetchMonth(OWNER, ds, 2026, 9, true, 3);
    await fetchMonth(OWNER, ds, 2026, 9, true, 4);
    expect(spy).toHaveBeenCalledTimes(2);
    await fetchMonth(OWNER, ds, 2026, 9, true, 6); // still not final -> fetch and mark final
    await fetchMonth(OWNER, ds, 2026, 9, true, 7);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("sync service", () => {
  const sample = async (): Promise<DashboardData> => runSync(OWNER, NOW);

  function make(startMs = NOW.getTime()) {
    const clock = { t: startMs };
    const sync = vi.fn(async (now: Date) => {
      const d = await runSync(OWNER, now);
      return d;
    });
    const svc = createSyncService({
      ownerId: OWNER,
      clock: () => new Date(clock.t),
      sync,
      refreshMinutes: () => 15,
      source: "demo",
    });
    return { clock, sync, svc };
  }

  it("no snapshot: syncs and waits", async () => {
    const { svc, sync } = make();
    const d = await svc.getDashboard();
    DashboardDataSchema.parse(d);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("fresh snapshot: no sync", async () => {
    await sample();
    const { svc, sync, clock } = make();
    clock.t += 14 * 60_000;
    await svc.getDashboard();
    expect(sync).not.toHaveBeenCalled();
  });

  it("stale snapshot: returns it immediately, one background sync for 10 concurrent gets", async () => {
    const old = await sample();
    const { svc, sync, clock } = make();
    clock.t += 16 * 60_000;
    const res = await Promise.all(Array.from({ length: 10 }, () => svc.getDashboard()));
    for (const r of res) expect(r).toEqual(old);
    expect(sync).toHaveBeenCalledTimes(1);
    expect((await svc.status()).syncing).toBe(true);
    await vi.waitFor(async () => expect((await svc.status()).syncing).toBe(false));
    const snap = await db.snapshot.findFirst({ where: { accountId: OWNER } });
    expect(snap?.computedAt.getTime()).toBe(clock.t);
  });

  it("forceRefresh twice within 60 s: the second is TOO_MANY_REQUESTS", async () => {
    const { svc, clock } = make();
    await svc.forceRefresh();
    clock.t += 20_000;
    await expect(svc.forceRefresh()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Espere 40 s",
    });
    expect((await svc.status()).cooldownSeconds).toBe(40);
    clock.t += 40_000;
    await expect(svc.forceRefresh()).resolves.toBeDefined();
  });

  it("failed background sync: serves the snapshot and exposes lastError", async () => {
    await sample();
    const clock = { t: NOW.getTime() + 20 * 60_000 };
    const svc = createSyncService({
      ownerId: OWNER,
      clock: () => new Date(clock.t),
      sync: () => Promise.reject(new Error("ML caído")),
      refreshMinutes: () => 15,
      source: "demo",
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(svc.getDashboard()).resolves.toBeDefined();
    await vi.waitFor(async () => expect((await svc.status()).lastError).toBe("ML caído"));
    quiet.mockRestore();
  });

  it("no snapshot and sync fails: throws", async () => {
    const svc = createSyncService({
      ownerId: OWNER,
      clock: () => NOW,
      sync: () => Promise.reject(new Error("sin datos")),
      refreshMinutes: () => 15,
      source: "demo",
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(svc.getDashboard()).rejects.toThrow("sin datos");
    quiet.mockRestore();
  });
});

describe("per-user isolation", () => {
  it("snapshots and caches of one user are invisible to another", async () => {
    await runSync(OWNER, NOW);
    expect(await db.snapshot.count({ where: { accountId: OTHER } })).toBe(0);
    expect(await db.order.count({ where: { accountId: OTHER } })).toBe(0);
    expect(await db.saleLine.count({ where: { accountId: OTHER } })).toBe(0);
    expect(await db.order.count({ where: { accountId: OWNER } })).toBeGreaterThan(0);
    expect(await db.saleLine.count({ where: { accountId: OWNER } })).toBeGreaterThan(0);

    const svc = createSyncService({
      ownerId: OTHER,
      clock: () => NOW,
      sync: (now) => runSync(OTHER, now),
      refreshMinutes: () => 15,
      source: "demo",
    });
    expect((await svc.status()).updatedAt).toBe(""); // no snapshot of its own yet
  });
});

describe("rebuildAll without snapshots of earlier months", () => {
  it("still recomputes the previous month, so history is never skipped", async () => {
    await runSync(OWNER, NOW);
    await db.snapshot.deleteMany({ where: { accountId: OWNER, month: { not: "2026-10" } } });
    const r = await rebuildAll(OWNER, { now: NOW });
    expect(r.months.at(-1)).toBe("2026-10");
    expect(r.months).toContain("2026-09");
    expect(r.failed).toEqual([]);
  });
});

describe("rebuildAll", () => {
  it("recomputes every stored month and keeps the current one as latest", async () => {
    await runSync(OWNER, new Date("2026-09-20T12:00:00-03:00"));
    await runSync(OWNER, NOW);
    await db.snapshot.updateMany({ where: { accountId: OWNER }, data: { payload: {} } }); // simulate stale snapshots
    const r = await rebuildAll(OWNER, { now: NOW });
    expect(r.failed).toEqual([]);
    expect(r.months).toEqual(["2026-08", "2026-09", "2026-10"]); // + the month Sept was compared with
    const latest = await db.snapshot.findFirst({ where: { accountId: OWNER }, orderBy: { computedAt: "desc" } });
    expect(latest?.month).toBe("2026-10");
    for (const s of await db.snapshot.findMany({ where: { accountId: OWNER } })) DashboardDataSchema.parse(s.payload);
  });
});
