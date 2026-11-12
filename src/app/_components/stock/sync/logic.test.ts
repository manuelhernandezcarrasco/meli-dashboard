import { describe, expect, it } from "vitest";

import type { AlertRow, ProductRow, PushLogRow, SyncStatusRow } from "~/lib/stock-contracts";
import { adjustPayloads, classifyProducts, dryRunRows, editsValid, filterLog, goLivePayload, NO_FILTERS } from "./logic";

const prod = (o: Partial<ProductRow>): ProductRow => ({
  id: 1, ean: null, sku: null, name: "Auricular", model: "", category: "", onHand: 5, inRepair: 0, unitCost: 1,
  minUnits: null, syncMode: "dry_run", dailyRate: null, coverageDays: null, linkedListings: 1, openAlerts: 0, archived: false, ...o,
});
const alert = (o: Partial<AlertRow>): AlertRow => ({
  id: 1, type: "low_stock", status: "open", productId: 1, productName: null, marketplace: null, itemId: null, dedupeKey: "k",
  title: "t", detail: "d", quantity: null, amount: null, createdAt: "", acknowledgedAt: null, resolvedAt: null, resolution: null, ...o,
});
const st = (o: Partial<SyncStatusRow>): SyncStatusRow => ({
  linkId: 1, marketplace: "mercadolibre", itemId: "MLA1", variationId: null, productNames: ["Auricular"], desiredQty: 5,
  status: "in_sync", lastObservedMlQty: 5, lastObservedAt: null, lastPushedQty: null, lastPushedAt: null, lastError: null, mode: "dry_run", ...o,
});
const log = (o: Partial<PushLogRow>): PushLogRow => ({
  id: 1, marketplace: "mercadolibre", itemId: "MLA1", variationId: null, requestedQty: 1, previousMlQty: null, mode: "dry_run",
  result: "dry_run", httpStatus: null, error: null, triggerType: "sale", triggerRef: null, createdAt: "", ...o,
});

describe("classifyProducts", () => {
  it("blocks negative stock", () => {
    const r = classifyProducts([prod({ onHand: -2 })], [], []);
    expect(r.ready).toHaveLength(0);
    expect(r.blocked[0]!.blocked).toContain("negative");
  });
  it("blocks drift (by sync status or alert)", () => {
    expect(classifyProducts([prod({})], [], [st({ status: "drift" })]).blocked[0]!.blocked).toContain("drift");
    expect(classifyProducts([prod({})], [alert({ type: "stock_drift" })], []).blocked[0]!.blocked).toContain("drift");
  });
  it("blocks unresolved alerts but not resolved ones", () => {
    expect(classifyProducts([prod({ openAlerts: 1 })], [alert({})], []).blocked[0]!.blocked).toContain("alerts");
    expect(classifyProducts([prod({})], [alert({ status: "resolved" })], []).ready).toHaveLength(1);
  });
  it("skips unlinked and archived, splits live", () => {
    const r = classifyProducts([prod({ id: 1, linkedListings: 0 }), prod({ id: 2, archived: true }), prod({ id: 3, syncMode: "live" })], [], []);
    expect(r.ready).toHaveLength(0);
    expect(r.live.map((p) => p.id)).toEqual([3]);
  });
});

describe("wizard payloads", () => {
  const edits = [
    { productId: 1, ours: 5, opening: 5, reason: "" },
    { productId: 2, ours: 5, opening: 8, reason: " conteo físico " },
  ];
  it("requires a reason only for edited stock", () => {
    expect(editsValid(edits)).toBe(true);
    expect(editsValid([{ productId: 2, ours: 5, opening: 8, reason: "  " }])).toBe(false);
  });
  it("adjust payload carries delta and reason; unchanged products have none", () => {
    expect(adjustPayloads(edits, "run")).toEqual([
      { productId: 2, delta: 3, reason: "conteo físico", idempotencyKey: "golive-adjust:run:2" },
    ]);
  });
  it("goLive payload confirms every product", () => {
    expect(goLivePayload(edits, "run").confirmations.map((c) => [c.productId, c.openingStock])).toEqual([[1, 5], [2, 8]]);
  });
});

describe("log + dry-run", () => {
  const rows = [log({ id: 1 }), log({ id: 2, result: "failed", mode: "live", itemId: "MLA2" })];
  it("filters by result, mode and listing", () => {
    expect(filterLog(rows, NO_FILTERS)).toHaveLength(2);
    expect(filterLog(rows, { ...NO_FILTERS, result: "failed" }).map((r) => r.id)).toEqual([2]);
    expect(filterLog(rows, { ...NO_FILTERS, mode: "dry_run" }).map((r) => r.id)).toEqual([1]);
    expect(filterLog(rows, { ...NO_FILTERS, listing: "mla2" }).map((r) => r.id)).toEqual([2]);
  });
  it("dry-run rows only simulated, flag differences", () => {
    const r = dryRunRows([st({}), st({ linkId: 2, desiredQty: 3 }), st({ linkId: 3, mode: "live" })]);
    expect(r.map((x) => x.differs)).toEqual([false, true]);
  });
});
