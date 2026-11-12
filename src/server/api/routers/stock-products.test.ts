import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s5";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }) }));
vi.mock("~/server/ml", () => ({ isLinked: async () => true }));

import { createCallerFactory } from "~/server/api/trpc";
import { db } from "~/server/db";
import { configureStock } from "~/server/stock/linking";
import { stockProductsRouter } from "./stock-products";

vi.setConfig({ testTimeout: 60_000 }); // tRPC adds a random 100-500ms dev delay per call

const A = "s5_router_a";
const B = "s5_router_b";
const ML = "mercadolibre" as const;
const caller = (userId: string | null = A) =>
  createCallerFactory(stockProductsRouter)({ db, userId, headers: new Headers() });

const movements: Record<string, unknown>[] = [];
configureStock({
  services: {
    ledger: {
      appendMovement: async (i) => {
        movements.push(i as unknown as Record<string, unknown>);
        const onHand = Number(i.quantity);
        await db.inventoryProduct.update({ where: { accountId_id: { accountId: i.accountId, id: i.productId } }, data: { onHand } });
        return { movementId: movements.length, created: true, onHandAfter: onHand as never, unitCostAfter: 0 as never };
      },
    },
    dailyRates: async (_a, ids) => new Map(ids.map((i) => [i, i % 2 === 0 ? 2 : null])),
  },
});

beforeEach(async () => {
  movements.length = 0;
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
});

const mk = (name: string, over: { ean?: string | null } = {}) =>
  caller().create({ name, ean: over.ean ?? null, sku: null, model: "", category: "", minUnits: null });

describe("stockProducts router", () => {
  it("requires a signed-in user", async () => {
    await expect(caller(null).list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a duplicate EAN with CONFLICT and keeps the first product", async () => {
    await mk("Uno", { ean: "7790000000011" });
    await expect(mk("Dos", { ean: "7790000000011" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.inventoryProduct.count({ where: { accountId: A } })).toBe(1);
  });

  it("create with initial stock goes through the ledger as initial_count with a reason", async () => {
    const { productId } = await caller().create({ name: "Con stock", ean: null, sku: null, model: "", category: "Cámaras", minUnits: null, initialStock: 5, initialCost: 100 });
    expect(movements).toEqual([expect.objectContaining({ productId, type: "initial_count", quantity: 5, unitCost: 100, reason: expect.any(String) })]);
    await expect(caller().create({ name: "Sin costo", ean: null, sku: null, model: "", category: "", minUnits: null, initialStock: 5 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("adjustStock needs a reason and goes through the ledger", async () => {
    const { productId } = await mk("Uno");
    await expect(caller().adjustStock({ productId, delta: 3, reason: "", idempotencyKey: "k1" })).rejects.toBeTruthy();
    await caller().adjustStock({ productId, delta: 3, reason: "Conteo", idempotencyKey: "k1" });
    expect(movements[0]).toMatchObject({ type: "manual_adjust", quantity: 3, reason: "Conteo", idempotencyKey: "adjust:k1", actor: "user" });
  });

  it("update changes only name/category/minUnits and rejects other fields", async () => {
    const { productId } = await mk("Uno", { ean: "7790000000011" });
    await caller().update({ productId, name: "Nuevo", category: "Lentes", minUnits: 4 });
    const p = await db.inventoryProduct.findFirstOrThrow({ where: { accountId: A, id: productId } });
    expect(p).toMatchObject({ name: "Nuevo", category: "Lentes", ean: "7790000000011" });
    expect(Number(p.minUnits)).toBe(4);
    // @ts-expect-error ean is not editable
    await expect(caller().update({ productId, ean: "7790000000028" })).rejects.toBeTruthy();
  });

  it("list filters by status, category, search (EAN/SKU/name), hasAlerts, and sorts; rows carry forecast fields", async () => {
    const a = await caller().create({ name: "Cámara Sony", ean: "7790000000011", sku: "SNY-1", model: "", category: "Cámaras", minUnits: null });
    const b = await caller().create({ name: "Lente Canon", ean: "7790000000028", sku: null, model: "", category: "Lentes", minUnits: null });
    const c = await caller().create({ name: "Trípode", ean: null, sku: "TRI-9", model: "", category: "Lentes", minUnits: null });
    const set = (id: number, data: Record<string, unknown>) => db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id } }, data });
    await set(a.productId, { onHand: 10 });
    await set(b.productId, { onHand: -2 });
    await set(c.productId, { onHand: 0, inRepair: 1 });
    await db.stockAlert.create({ data: { accountId: A, type: "low_stock", dedupeKey: "k", title: "t", productId: b.productId } });
    await db.stockAlert.create({ data: { accountId: A, type: "low_stock", dedupeKey: "k2", title: "t", productId: c.productId, status: "resolved" } });
    await db.listing.create({ data: { accountId: A, marketplace: ML, itemId: "MLA1" } });
    const link = await caller().link({ marketplace: ML, itemId: "MLA1", variationId: null, components: [{ productId: a.productId, quantity: 1 }], fillMissing: true });

    const names = async (q: Parameters<ReturnType<typeof caller>["list"]>[0]) => (await caller().list(q)).map((r) => r.name);
    expect(await names({})).toEqual(["Cámara Sony", "Lente Canon", "Trípode"]);
    expect(await names({ status: "in_stock" })).toEqual(["Cámara Sony"]);
    expect(await names({ status: "negative" })).toEqual(["Lente Canon"]);
    expect(await names({ status: "out_of_stock" })).toEqual(["Trípode"]);
    expect(await names({ status: "in_repair" })).toEqual(["Trípode"]);
    expect(await names({ status: "unlinked" })).toEqual(["Lente Canon", "Trípode"]);
    expect(await names({ category: "Lentes" })).toEqual(["Lente Canon", "Trípode"]);
    expect(await names({ query: "7790000000028" })).toEqual(["Lente Canon"]);
    expect(await names({ query: "tri-9" })).toEqual(["Trípode"]);
    expect(await names({ query: "sony" })).toEqual(["Cámara Sony"]);
    expect(await names({ hasAlerts: true })).toEqual(["Lente Canon"]);
    expect(await names({ hasAlerts: false })).toEqual(["Cámara Sony", "Trípode"]);
    expect(await names({ sort: { by: "onHand", dir: "desc" } })).toEqual(["Cámara Sony", "Trípode", "Lente Canon"]);

    const rows = await caller().list({});
    const row = rows.find((r) => r.id === a.productId)!;
    expect(row).toMatchObject({ onHand: 10, linkedListings: 1, openAlerts: 0, syncMode: "dry_run", archived: false });
    // fake forecast: even ids sell 2/day, odd ids unknown
    const rate = a.productId % 2 === 0 ? 2 : null;
    expect(row.dailyRate).toBe(rate);
    expect(row.coverageDays).toBe(rate ? 5 : null);
    expect(link.linkId).toBeGreaterThan(0);

    const archived = await set(c.productId, { archivedAt: new Date() });
    expect(archived).toBeTruthy();
    expect(await names({})).toEqual(["Cámara Sony", "Lente Canon"]);
    expect(await names({ includeArchived: true })).toHaveLength(3);
  });

  it("get returns product, links, movements and cost history", async () => {
    const { productId } = await mk("Uno");
    await db.listing.create({ data: { accountId: A, marketplace: ML, itemId: "MLA2", title: "Pub 2" } });
    await caller().link({ marketplace: ML, itemId: "MLA2", variationId: null, components: [{ productId, quantity: 1 }], fillMissing: true });
    const d = await caller().get({ productId });
    expect(d.product.id).toBe(productId);
    expect(d.listings).toEqual([expect.objectContaining({ itemId: "MLA2", title: "Pub 2", syncStatus: "never", componentCount: 1, componentQuantity: 1 })]);
    expect(d.recentMovements).toEqual([]);
    expect(d.costHistory).toEqual([]);
    await expect(caller().get({ productId: 99_999_999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("previewLink equals what link applies, and link/unlink round-trip", async () => {
    const { productId } = await caller().create({ name: "x", ean: null, sku: null, model: "", category: "", minUnits: null });
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: productId } }, data: { name: "" } });
    await db.listing.create({ data: { accountId: A, marketplace: ML, itemId: "MLA3", title: "Título", gtin: "7790000000011" } });
    const input = { marketplace: ML, itemId: "MLA3", variationId: null, components: [{ productId, quantity: 1 }] };
    const preview = await caller().previewLink(input);
    const { plan, linkId } = await caller().link({ ...input, fillMissing: true });
    expect(plan).toEqual(preview);
    expect(plan[0]!.fills).toEqual({ ean: "7790000000011", name: "Título" });
    await caller().unlink({ linkId });
    expect(await db.listingLink.count({ where: { accountId: A } })).toBe(0);
    await expect(caller().unlink({ linkId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects combos at router level ('Combos: próximamente') while the service accepts them", async () => {
    const p1 = await mk("Uno");
    const p2 = await mk("Dos");
    const input = { marketplace: ML, itemId: "MLA4", variationId: null, components: [{ productId: p1.productId, quantity: 1 }, { productId: p2.productId, quantity: 2 }] };
    await expect(caller().link({ ...input, fillMissing: true })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Combos: próximamente" });
    await expect(caller().previewLink(input)).rejects.toMatchObject({ message: "Combos: próximamente" });
    expect(await db.listingLink.count({ where: { accountId: A } })).toBe(0);
  });

  it("autoLink and unlinkedListings work through the router, scoped to the caller", async () => {
    await mk("Cámara", { ean: "7790000000011" });
    await db.listing.create({ data: { accountId: A, marketplace: ML, itemId: "MLA5", gtin: "7790000000011" } });
    await db.listing.create({ data: { accountId: A, marketplace: ML, itemId: "MLA6", title: "Sin match" } });
    expect((await caller().autoLink()).linkIds).toHaveLength(1);
    expect((await caller().unlinkedListings()).map((l) => l.itemId)).toEqual(["MLA6"]);
    expect(await caller(B).unlinkedListings()).toEqual([]);
  });
});

describe("stockProducts.setCost", () => {
  it("writes a manual cost entry through the ledger cost path and leaves onHand alone", async () => {
    const { productId } = await mk("Con costo");
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: productId } }, data: { onHand: 4 } });
    const r = await caller().setCost({ productId, unitCost: 1234.5, note: "carga manual" });
    expect(r).toMatchObject({ unitCost: 1234.5, changed: true, salesApplied: 0 });
    const p = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: productId } } });
    expect(Number(p.unitCost)).toBe(1234.5);
    expect(Number(p.onHand)).toBe(4);
    const entries = await db.productCostEntry.findMany({ where: { accountId: A, productId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reason: "manual", note: "carga manual" });
    expect((await caller().setCost({ productId, unitCost: 1234.5 })).changed).toBe(false);
  });

  it("rejects negative costs and other accounts' products", async () => {
    const { productId } = await mk("Mío");
    await expect(caller().setCost({ productId, unitCost: -1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().setCost({ productId: 99999999, unitCost: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
