import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s9";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }) }));

import { createCallerFactory } from "~/server/api/trpc";
import { stockInvoicesRouter } from "~/server/api/routers/stock-invoices";
import { db } from "~/server/db";
import { appendMovement, recomputeOnHand } from "./ledger";
import { createInvoiceService, DuplicateInvoiceError } from "./invoices";

const A = "inv_acct_a";
const B = "inv_acct_b";
const sample = readFileSync(path.join(__dirname, "../invoices/__fixtures__/sony-0225-00085935.pdf"));
// EANs of the six sample lines, in order.
const EANS = ["0027242925489", "0027242932425", "0027242928688", "0027242923638", "0027242931770", "0027242931817"];

const pushes: { ids: number[]; ref?: string }[] = [];
let evaluated = 0;
const svc = createInvoiceService({
  push: async (_a, ids, t) => { pushes.push({ ids, ref: t.ref }); },
  evaluateAlerts: async () => { evaluated++; },
});

async function product(acc: string, over: { ean?: string | null; name?: string; onHand?: number; unitCost?: number; sku?: string } = {}) {
  const p = await db.inventoryProduct.create({
    data: { accountId: acc, name: over.name ?? "Prod", ean: over.ean ?? null, sku: over.sku, onHand: over.onHand ?? 0, unitCost: over.unitCost ?? 0 },
  });
  return Number(p.id);
}
const clean = () => db.account.deleteMany({ where: { id: { in: [A, B] } } });
beforeEach(async () => {
  await clean();
  await db.account.createMany({ data: [{ id: A }, { id: B }] });
  pushes.length = 0; evaluated = 0;
});
afterAll(async () => { await clean(); await db.$disconnect(); });

/** All six EANs known; first product already has stock to exercise the weighted average. */
async function seedAll() {
  const ids: number[] = [];
  for (const [i, ean] of EANS.entries()) ids.push(await product(A, { ean, name: `Sony ${i + 1}` }));
  // Opening stock goes through the ledger so that the ledger sum equals the cache.
  await appendMovement({ accountId: A, productId: ids[0]!, type: "initial_count", quantity: 10, unitCost: 50000, occurredAt: new Date(Date.now() - 1000), idempotencyKey: "seed", actor: "system" });
  return ids;
}
const upload = (acc = A) => svc.createDraft(acc, { name: "01-0225-00085935.pdf", buffer: sample });

describe("createDraft + getDraft (Sony sample)", () => {
  it("resolves by exact EAN, computes the fee factor and landed costs, writes no stock", async () => {
    const ids = await seedAll();
    const { invoiceId } = await upload();
    const d = await svc.getDraft(A, invoiceId);
    expect(d.status).toBe("draft");
    expect(d.feeFactor).toBeCloseTo(1.27, 4);
    expect(d.feeSentence).toBe("impuestos y percepciones: +27,00 %, no se descuenta IVA");
    expect(d.lines).toHaveLength(6);
    expect(d.lines.every((l) => l.resolution === "auto_ean")).toBe(true);
    expect(d.lines[0]!.productId).toBe(ids[0]);
    expect(d.lines[0]!.landedUnitCost).toBeCloseTo(69971.74, 1);
    expect(d.lines[0]!.landedTotal).toBeCloseTo(69971.74 * 58, -1);
    expect(d.canConfirm).toBe(true);
    expect(d.blockedReason).toBeNull();
    // Nothing moved.
    expect(await db.stockMovement.count({ where: { accountId: A, type: "purchase_in" } })).toBe(0);
  });

  it("projects the new weighted cost and stock, and the diff vs now", async () => {
    await seedAll();
    const d = await svc.getDraft(A, (await upload()).invoiceId);
    const l1 = d.lines[0]!;
    // (10×50000 + 58×69971.74) / 68
    expect(l1.projected!.onHand).toBe(68);
    expect(l1.projected!.unitCost).toBeCloseTo((10 * 50000 + 58 * l1.landedUnitCost) / 68, 2);
    expect(l1.current).toEqual({ onHand: 10, unitCost: 50000 });
    expect(l1.diff!.stock).toBe(58);
    expect(l1.diff!.cost).toBeCloseTo(l1.projected!.unitCost - 50000, 4);
  });

  it("lists unresolved lines with suggestions and blocks confirm", async () => {
    await product(A, { ean: EANS[0]!, name: "Auricular Sony WH-CH520 negro" });
    await product(A, { name: "Auricular WH-CH520 azul", sku: "92484939" });
    await product(A, { name: "Parlante JBL" });
    const d = await svc.getDraft(A, (await upload()).invoiceId);
    expect(d.unresolvedCount).toBe(5);
    expect(d.canConfirm).toBe(false);
    expect(d.blockedReason).toMatch(/5 línea/);
    const l2 = d.lines[1]!;
    expect(l2.resolution).toBe("unresolved");
    expect(l2.suggestions[0]!.name).toBe("Auricular WH-CH520 azul");
    expect(l2.suggestions[0]!.willFill).toEqual({ ean: EANS[1] }); // sku already equal? sku set, so only ean is empty
    expect(l2.suggestions.map((s) => s.name)).not.toContain("Parlante JBL");
  });

  it("rejects the same invoice twice with a pointer to the existing one, per account", async () => {
    const { invoiceId } = await upload();
    const e = await upload().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DuplicateInvoiceError);
    expect((e as DuplicateInvoiceError).existingInvoiceId).toBe(invoiceId);
    await expect(upload(B)).resolves.toBeDefined(); // another account may have the same invoice
  });
});

describe("editing the draft", () => {
  it("setFeeFactor overrides and recomputes landed costs; null restores total/subtotal", async () => {
    await seedAll();
    const { invoiceId } = await upload();
    await svc.setFeeFactor(A, invoiceId, 1.3);
    let d = await svc.getDraft(A, invoiceId);
    expect(d.feeFactorOverridden).toBe(true);
    expect(d.feeFactor).toBe(1.3);
    expect(d.lines[0]!.landedUnitCost).toBeCloseTo(55095.86 * 1.3, 3);
    expect(d.feeSentence).toContain("+30,00 %");
    await svc.setFeeFactor(A, invoiceId, null);
    d = await svc.getDraft(A, invoiceId);
    expect(d.feeFactorOverridden).toBe(false);
    expect(d.lines[0]!.landedUnitCost).toBeCloseTo(69971.74, 1);
  });

  it("matchLine fills only the empty fields of the product, on confirm", async () => {
    const ids = await seedAll();
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: ids[1]! } }, data: { ean: null } });
    const target = await product(A, { name: "Manual", sku: "MIO-1" }); // has sku, lacks ean
    const { invoiceId } = await upload();
    await svc.matchLine(A, invoiceId, 2, target);
    const d = await svc.getDraft(A, invoiceId);
    expect(d.lines[1]).toMatchObject({ productId: target, resolution: "manual_match", willFill: { ean: EANS[1] } });
    // nothing written yet
    expect((await db.inventoryProduct.findFirstOrThrow({ where: { id: target } })).ean).toBeNull();
    await svc.confirm(A, invoiceId);
    const p = await db.inventoryProduct.findFirstOrThrow({ where: { id: target } });
    expect(p).toMatchObject({ ean: EANS[1], sku: "MIO-1", name: "Manual" }); // sku not overwritten
  });

  it("createProductFromLine creates and links atomically", async () => {
    await seedAll();
    const { invoiceId } = await upload();
    const other = await db.inventoryProduct.findFirstOrThrow({ where: { accountId: A, ean: EANS[2] } });
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: other.id } }, data: { ean: null } });
    await svc.discard(A, invoiceId);
    const again = (await upload()).invoiceId;
    const { productId } = await svc.createProductFromLine(A, again, 3, { ean: EANS[2]!, sku: null, name: "Nuevo", model: "", category: "", minUnits: null });
    const d = await svc.getDraft(A, again);
    expect(d.lines[2]).toMatchObject({ productId, resolution: "created_product", productName: "Nuevo" });
    // EAN already taken → error, line stays unresolved
    await expect(svc.createProductFromLine(A, again, 1, { ean: EANS[0]!, sku: null, name: "Dup", model: "", category: "", minUnits: null })).rejects.toThrow();
    expect((await svc.getDraft(A, again)).lines[0]!.productId).not.toBeNull(); // line 1 was auto-resolved, untouched
  });

  it("skipLine is explicit and lets confirm go through without that line", async () => {
    const ids = await seedAll();
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: BigInt(ids[5]!) } }, data: { ean: null } });
    const { invoiceId } = await upload();
    expect((await svc.getDraft(A, invoiceId)).canConfirm).toBe(false);
    await svc.skipLine(A, invoiceId, 6);
    const d = await svc.getDraft(A, invoiceId);
    expect(d.lines).toHaveLength(5);
    expect(d.canConfirm).toBe(true);
    await svc.confirm(A, invoiceId);
    expect(await db.stockMovement.count({ where: { accountId: A, type: "purchase_in" } })).toBe(5);
  });

  it("only drafts can be edited or discarded", async () => {
    await seedAll();
    const { invoiceId } = await upload();
    await svc.confirm(A, invoiceId);
    await expect(svc.setFeeFactor(A, invoiceId, 2)).rejects.toMatchObject({ code: "INVOICE_NOT_DRAFT" });
    await expect(svc.discard(A, invoiceId)).rejects.toMatchObject({ code: "INVOICE_NOT_DRAFT" });
    await expect(svc.skipLine(A, invoiceId, 1)).rejects.toMatchObject({ code: "INVOICE_NOT_DRAFT" });
  });
});

describe("confirm", () => {
  it("applies the sample: preview equals result, ledger equals cache, cost history written, push + alerts requested", async () => {
    const ids = await seedAll();
    const { invoiceId } = await upload();
    const before = await svc.getDraft(A, invoiceId);
    await svc.confirm(A, invoiceId);

    for (const [i, l] of before.lines.entries()) {
      const p = await db.inventoryProduct.findFirstOrThrow({ where: { accountId: A, id: ids[i]! } });
      expect(Number(p.onHand)).toBe(l.projected!.onHand);
      expect(Number(p.unitCost)).toBeCloseTo(l.projected!.unitCost, 4);
      expect(Number(await recomputeOnHand(A, ids[i]!))).toBe(Number(p.onHand));
      const m = await db.stockMovement.findFirstOrThrow({ where: { accountId: A, idempotencyKey: `invoice:${invoiceId}:${i + 1}` } });
      expect(m).toMatchObject({ type: "purchase_in", refType: "invoice", refId: String(invoiceId) });
      expect(Number(m.quantity)).toBe(l.quantity);
    }
    expect(await db.productCostEntry.count({ where: { accountId: A, reason: "invoice" } })).toBe(6);
    const inv = await db.purchaseInvoice.findFirstOrThrow({ where: { accountId: A } });
    expect(inv.status).toBe("applied");
    expect(inv.appliedAt).not.toBeNull();
    expect(pushes).toEqual([{ ids: [...ids].sort((a, b) => a - b), ref: String(invoiceId) }]);
    expect(evaluated).toBe(1);
  });

  it("is idempotent: a second confirm writes nothing and does not push again", async () => {
    await seedAll();
    const { invoiceId } = await upload();
    expect(await svc.confirm(A, invoiceId)).toEqual({ applied: true });
    expect(await svc.confirm(A, invoiceId)).toEqual({ applied: false });
    await Promise.all([svc.confirm(A, invoiceId), svc.confirm(A, invoiceId)]);
    expect(await db.stockMovement.count({ where: { accountId: A, type: "purchase_in" } })).toBe(6);
    expect(pushes).toHaveLength(1);
  });

  it("refuses while a non-skipped line is unresolved, writing nothing", async () => {
    await product(A, { ean: EANS[0]! });
    const { invoiceId } = await upload();
    await expect(svc.confirm(A, invoiceId)).rejects.toMatchObject({ code: "INVOICE_UNRESOLVED" });
    expect(await db.stockMovement.count({ where: { accountId: A, type: "purchase_in" } })).toBe(0);
    expect((await db.purchaseInvoice.findFirstOrThrow({ where: { accountId: A } })).status).toBe("draft");
  });

  it("rolls back everything when a later line fails", async () => {
    const ids = await seedAll();
    const { invoiceId } = await upload();
    await db.inventoryProduct.update({ where: { accountId_id: { accountId: A, id: ids[3]! } }, data: { archivedAt: new Date() } });
    await expect(svc.confirm(A, invoiceId)).rejects.toMatchObject({ code: "PRODUCT_ARCHIVED" });
    expect(await db.stockMovement.count({ where: { accountId: A, type: "purchase_in" } })).toBe(0);
    expect(await db.productCostEntry.count({ where: { accountId: A, reason: "invoice" } })).toBe(0);
    const p1 = await db.inventoryProduct.findFirstOrThrow({ where: { accountId: A, id: ids[0]! } });
    expect(Number(p1.onHand)).toBe(10);
    expect(Number(p1.unitCost)).toBe(50000);
    expect((await db.purchaseInvoice.findFirstOrThrow({ where: { accountId: A } })).status).toBe("draft");
    expect(pushes).toHaveLength(0);
  });

  it("a failing push or alert evaluation does not undo an applied invoice", async () => {
    await seedAll();
    const s = createInvoiceService({ push: async () => { throw new Error("boom"); }, evaluateAlerts: async () => { throw new Error("boom"); } });
    const { invoiceId } = await s.createDraft(A, { name: "x.pdf", buffer: sample });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(s.confirm(A, invoiceId)).resolves.toEqual({ applied: true });
    spy.mockRestore();
    expect((await db.purchaseInvoice.findFirstOrThrow({ where: { accountId: A } })).status).toBe("applied");
  });

  it("two lines on one product accumulate in the projection and in the result", async () => {
    const ids = await seedAll();
    const { invoiceId } = await upload();
    await db.purchaseInvoiceLine.updateMany({ where: { accountId: A, invoiceId, lineNo: 2 }, data: { productId: ids[0]!, resolution: "manual_match" } });
    const d = await svc.getDraft(A, invoiceId);
    await svc.confirm(A, invoiceId);
    const p = await db.inventoryProduct.findFirstOrThrow({ where: { accountId: A, id: ids[0]! } });
    expect(Number(p.onHand)).toBe(10 + 58 + 27);
    expect(Number(p.unitCost)).toBeCloseTo(d.lines[1]!.projected!.unitCost, 4);
  });
});

describe("router", () => {
  const caller = createCallerFactory(stockInvoicesRouter)({ db, userId: A, headers: new Headers() });
  it("list / getDraft / skipLine / discard, scoped to the caller's account", async () => {
    const { invoiceId } = await upload();
    const { invoiceId: other } = await upload(B);
    const rows = await caller.list();
    expect(rows.map((r) => r.invoiceId)).toEqual([invoiceId]);
    expect(rows[0]).toMatchObject({ status: "draft", lineCount: 6, unresolvedLines: 6 });
    await expect(caller.getDraft({ invoiceId: other })).rejects.toMatchObject({ code: "CONFLICT" });
    await caller.skipLine({ invoiceId, lineNo: 1 });
    expect((await caller.getDraft({ invoiceId })).lines).toHaveLength(5);
    await expect(caller.confirm({ invoiceId })).rejects.toMatchObject({ code: "CONFLICT" }); // unresolved
    await caller.discard({ invoiceId });
    expect(await caller.list()).toEqual([]);
  });
});
