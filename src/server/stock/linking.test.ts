import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s5";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import { db } from "~/server/db";
import { createProduct } from "~/server/store/inventoryProducts";
import { ensureAccount } from "~/server/store/bulk";
import { createLinking } from "./linking";
import { StockError, type RaiseAlertInput } from "./contracts";

const A = "s5_user_a";
const B = "s5_user_b";
const ML = "mercadolibre" as const;
const EAN1 = "7790000000011";
const EAN2 = "7790000000028";

function setup(pending = 0) {
  const alerts: RaiseAlertInput[] = [];
  const resolved: string[] = [];
  const svc = createLinking({
    alerts: {
      raiseAlert: async (i) => { alerts.push(i); return { alertId: alerts.length, created: true }; },
      resolveAlert: async (_a, key) => { resolved.push(key); },
    },
    pendingSales: async () => pending,
  });
  return { svc, alerts, resolved };
}

const listing = (itemId: string, over: { title?: string; gtin?: string; variations?: [number, string][] } = {}) =>
  db.listing.create({
    data: {
      accountId: A, marketplace: ML, itemId, title: over.title ?? `Título ${itemId}`, gtin: over.gtin ?? null,
      variations: { create: (over.variations ?? []).map(([v, g]) => ({ variationId: v, gtin: g })) },
    },
  });

const linksOf = (itemId: string) =>
  db.listingLink.findMany({ where: { accountId: A, itemId }, include: { components: true, syncState: true } });

beforeEach(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await ensureAccount(A);
  await ensureAccount(B);
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
});

describe("autoLink", () => {
  it("links a listing whose GTIN equals a product EAN exactly, with one component of qty 1", async () => {
    const { svc } = setup();
    const p = await createProduct(A, { name: "Cámara", ean: EAN1 });
    await listing("MLA1", { gtin: EAN1 });
    const { linkIds } = await svc.autoLink(A);
    expect(linkIds).toHaveLength(1);
    const [l] = await linksOf("MLA1");
    expect(l!.variationId).toBeNull();
    expect(l!.components.map((c) => [Number(c.productId), Number(c.quantity)])).toEqual([[p.id, 1]]);
    expect(l!.syncState?.status).toBe("never");
  });

  it("normalizes the GTIN (spreadsheet float / padding) before comparing", async () => {
    const { svc } = setup();
    await createProduct(A, { name: "Cámara", ean: EAN1 });
    await listing("MLA1", { gtin: ` ${EAN1}.0 ` });
    expect((await svc.autoLink(A)).linkIds).toHaveLength(1);
  });

  it("links per variation and never at listing level when the listing has variations", async () => {
    const { svc } = setup();
    const p1 = await createProduct(A, { name: "Rojo", ean: EAN1 });
    const p2 = await createProduct(A, { name: "Azul", ean: EAN2 });
    await listing("MLA2", { gtin: EAN1, variations: [[11, EAN1], [22, EAN2]] });
    const { linkIds } = await svc.autoLink(A);
    expect(linkIds).toHaveLength(2);
    const links = await linksOf("MLA2");
    expect(links.every((l) => l.variationId !== null)).toBe(true);
    const byVar = Object.fromEntries(links.map((l) => [Number(l.variationId), Number(l.components[0]!.productId)]));
    expect(byVar).toEqual({ 11: p1.id, 22: p2.id });
  });

  it("does not link on a mismatch, nor by title, and is idempotent", async () => {
    const { svc } = setup();
    await createProduct(A, { name: "Título MLA3", ean: EAN1 });
    await listing("MLA3", { title: "Título MLA3", gtin: "7790000000999" });
    await listing("MLA4"); // no gtin at all
    expect((await svc.autoLink(A)).linkIds).toEqual([]);
    expect(await db.listingLink.count({ where: { accountId: A } })).toBe(0);

    await listing("MLA5", { gtin: EAN1 });
    expect((await svc.autoLink(A)).linkIds).toHaveLength(1);
    expect((await svc.autoLink(A)).linkIds).toHaveLength(0);
  });

  it("only touches its own account and skips archived products", async () => {
    const { svc } = setup();
    await db.inventoryProduct.create({ data: { accountId: B, ean: EAN1, name: "De B" } });
    const arch = await createProduct(A, { name: "Viejo", ean: EAN2 });
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: arch.id } }, data: { archivedAt: new Date() } });
    await listing("MLA6", { gtin: EAN1 });
    await listing("MLA7", { gtin: EAN2 });
    expect((await svc.autoLink(A)).linkIds).toEqual([]);
  });

  it("raises unmatched_listing for what stays unlinked and resolves it once linked", async () => {
    const { svc, alerts, resolved } = setup();
    await listing("MLA8", { title: "Sin match", gtin: "7790000000777", variations: [[1, "7790000000777"]] });
    await svc.autoLink(A);
    const al = alerts.find((x) => x.type === "unmatched_listing");
    expect(al).toMatchObject({ itemId: "MLA8", dedupeKey: "unmatched_listing:mercadolibre:MLA8", title: expect.stringContaining("Sin match") });
    const detail = JSON.parse(al!.detail!) as { itemId: string; variations: { variationId: number; gtin: string }[]; gtin: string | null };
    expect(detail.itemId).toBe("MLA8");
    expect(detail.variations).toEqual([{ variationId: 1, gtin: "7790000000777" }]);

    const p = await createProduct(A, { name: "P", ean: null });
    await svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA8", variationId: 1, components: [{ productId: p.id, quantity: 1 }] });
    expect(resolved).toContain("unmatched_listing:mercadolibre:MLA8");
  });
});

describe("linkListing / previewLink", () => {
  it("fills only EMPTY product fields from the listing and previewLink returns exactly that plan", async () => {
    const { svc } = setup();
    const p = await createProduct(A, { name: "", ean: null, sku: "MI-SKU", category: "Cámaras" });
    await listing("MLA10", { title: "Sony Alpha 7", gtin: EAN1 });
    const args = { accountId: A, marketplace: ML, itemId: "MLA10", variationId: null, components: [{ productId: p.id, quantity: 1 }] };

    const preview = await svc.previewLink(args);
    expect(await db.inventoryProduct.count({ where: { accountId: A, ean: EAN1 } })).toBe(0); // nothing written
    expect(await db.listingLink.count({ where: { accountId: A } })).toBe(0);

    const { plan, linkId } = await svc.linkListing(args, { fillMissing: true });
    expect(plan).toEqual(preview);
    expect(plan).toEqual([{ productId: p.id, fills: { ean: EAN1, name: "Sony Alpha 7" } }]);
    expect(linkId).toBeGreaterThan(0);
    const after = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: p.id } } });
    expect(after).toMatchObject({ ean: EAN1, name: "Sony Alpha 7", sku: "MI-SKU", category: "Cámaras" });
  });

  it("never overwrites a filled field", async () => {
    const { svc } = setup();
    const p = await createProduct(A, { name: "Mi nombre", ean: EAN2, sku: "X" });
    await listing("MLA11", { title: "Otro título", gtin: EAN1 });
    const { plan } = await svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA11", variationId: null, components: [{ productId: p.id, quantity: 1 }] }, { fillMissing: true });
    expect(plan).toEqual([{ productId: p.id, fills: {} }]);
    const after = await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: p.id } } });
    expect(after).toMatchObject({ ean: EAN2, name: "Mi nombre", sku: "X" });
  });

  it("does not fill an EAN another product already owns", async () => {
    const { svc } = setup();
    await createProduct(A, { name: "Dueño", ean: EAN1 });
    const p = await createProduct(A, { name: "Otro", ean: null });
    await listing("MLA12", { gtin: EAN1 });
    const { plan } = await svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA12", variationId: null, components: [{ productId: p.id, quantity: 1 }] }, { fillMissing: true });
    expect(plan[0]!.fills.ean).toBeUndefined();
  });

  it("fills the sku from the seller sku of past sales and uses the variation GTIN first", async () => {
    const { svc } = setup();
    const p = await createProduct(A, { name: "Azul", ean: null });
    await listing("MLA13", { gtin: EAN1, variations: [[5, EAN2]] });
    await db.order.create({
      data: {
        accountId: A, marketplace: ML, orderId: 1, status: "paid", createdAt: new Date(),
        items: { create: [{ lineNo: 0, itemId: "MLA13", variationId: 5, title: "t", sellerSku: "SKU-9", quantity: 1, unitPrice: 1, saleFee: 0 }] },
      },
    });
    const { plan } = await svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA13", variationId: 5, components: [{ productId: p.id, quantity: 1 }] }, { fillMissing: true });
    expect(plan[0]!.fills).toMatchObject({ ean: EAN2, sku: "SKU-9" });
  });

  it("fillMissing=false links without touching the product", async () => {
    const { svc } = setup();
    const p = await createProduct(A, { name: "", ean: null });
    await listing("MLA14", { gtin: EAN1 });
    const { plan } = await svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA14", variationId: null, components: [{ productId: p.id, quantity: 1 }] }, { fillMissing: false });
    expect(plan).toEqual([]);
    expect((await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: p.id } } })).ean).toBeNull();
  });

  it("replaces an existing link atomically (components swapped, one link row)", async () => {
    const { svc } = setup();
    const p1 = await createProduct(A, { name: "Uno", ean: null });
    const p2 = await createProduct(A, { name: "Dos", ean: null });
    await listing("MLA15");
    const base = { accountId: A, marketplace: ML, itemId: "MLA15", variationId: null };
    const first = await svc.linkListing({ ...base, components: [{ productId: p1.id, quantity: 1 }] });
    const second = await svc.linkListing({ ...base, components: [{ productId: p2.id, quantity: 2 }] });
    const links = await linksOf("MLA15");
    expect(links).toHaveLength(1);
    expect(Number(links[0]!.id)).toBe(second.linkId);
    expect(first.linkId).not.toBe(second.linkId);
    expect(links[0]!.components.map((c) => [Number(c.productId), Number(c.quantity)])).toEqual([[p2.id, 2]]);
  });

  it("supports combos at service level (several components)", async () => {
    const { svc } = setup();
    const p1 = await createProduct(A, { name: "Uno", ean: null });
    const p2 = await createProduct(A, { name: "Dos", ean: null });
    await listing("MLA16", { gtin: EAN1 });
    await svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA16", variationId: null, components: [{ productId: p1.id, quantity: 1 }, { productId: p2.id, quantity: 3 }] }, { fillMissing: true });
    const [l] = await linksOf("MLA16");
    expect(l!.components).toHaveLength(2);
    // combos never enrich: the listing GTIN is the pack's, not a component's
    expect((await db.inventoryProduct.findUniqueOrThrow({ where: { accountId_id: { accountId: A, id: p1.id } } })).ean).toBeNull();
  });

  it("validates products and quantities", async () => {
    const { svc } = setup();
    const p = await createProduct(A, { name: "Uno", ean: null });
    const other = await db.inventoryProduct.create({ data: { accountId: B, name: "De B" } });
    const base = { accountId: A, marketplace: ML, itemId: "MLA17", variationId: null };
    await expect(svc.linkListing({ ...base, components: [{ productId: 999_999, quantity: 1 }] })).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
    await expect(svc.linkListing({ ...base, components: [{ productId: Number(other.id), quantity: 1 }] })).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
    await expect(svc.linkListing({ ...base, components: [{ productId: p.id, quantity: 0 }] })).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    await expect(svc.linkListing({ ...base, components: [] })).rejects.toBeInstanceOf(StockError);
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: p.id } }, data: { archivedAt: new Date() } });
    await expect(svc.linkListing({ ...base, components: [{ productId: p.id, quantity: 1 }] })).rejects.toMatchObject({ code: "PRODUCT_ARCHIVED" });
    expect(await db.listingLink.count({ where: { accountId: A } })).toBe(0);
  });

  it("raises link_cost_review with the current cost when sales are pending, otherwise not", async () => {
    const withPending = setup(3);
    const p = await createProduct(A, { name: "Uno", ean: null });
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: p.id } }, data: { unitCost: "1234.5" } });
    await listing("MLA18");
    await withPending.svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA18", variationId: null, components: [{ productId: p.id, quantity: 1 }] });
    expect(withPending.alerts.filter((a) => a.type === "link_cost_review")).toEqual([
      expect.objectContaining({ productId: p.id, itemId: "MLA18", quantity: 3, amount: 1234.5, dedupeKey: "link_cost_review:mercadolibre:MLA18:0" }),
    ]);

    const none = setup(0);
    await listing("MLA19");
    await none.svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA19", variationId: null, components: [{ productId: p.id, quantity: 1 }] });
    expect(none.alerts.filter((a) => a.type === "link_cost_review")).toEqual([]);
  });
});

describe("unlinkListing / unlinkedListings", () => {
  it("removes link, components and sync state; unknown link → LINK_NOT_FOUND; other accounts untouched", async () => {
    const { svc } = setup();
    const p = await createProduct(A, { name: "Uno", ean: null });
    await listing("MLA20");
    const { linkId } = await svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA20", variationId: null, components: [{ productId: p.id, quantity: 1 }] });
    await expect(svc.unlinkListing(B, linkId)).rejects.toMatchObject({ code: "LINK_NOT_FOUND" });
    await svc.unlinkListing(A, linkId);
    expect(await db.listingLink.count({ where: { accountId: A } })).toBe(0);
    expect(await db.listingLinkComponent.count({ where: { accountId: A } })).toBe(0);
    expect(await db.listingSyncState.count({ where: { accountId: A } })).toBe(0);
    await expect(svc.unlinkListing(A, linkId)).rejects.toMatchObject({ code: "LINK_NOT_FOUND" });
  });

  it("unlinkedListings lists per variation for listings with variations and per listing otherwise", async () => {
    const { svc } = setup();
    const p = await createProduct(A, { name: "Uno", ean: null });
    await listing("MLA21", { variations: [[1, EAN1], [2, EAN2]] });
    await listing("MLA22", { gtin: EAN1 });
    await listing("MLA23");
    await svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA21", variationId: 1, components: [{ productId: p.id, quantity: 1 }] });
    await svc.linkListing({ accountId: A, marketplace: ML, itemId: "MLA23", variationId: null, components: [{ productId: p.id, quantity: 1 }] });
    const rows = await svc.unlinkedListings(A);
    expect(rows.map((r) => [r.itemId, r.variationId]).sort()).toEqual([["MLA21", 2], ["MLA22", null]]);
    expect(rows.find((r) => r.itemId === "MLA22")).toMatchObject({ title: "Título MLA22", gtin: EAN1 });
  });
});
