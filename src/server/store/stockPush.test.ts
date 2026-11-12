import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s3";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import { db } from "~/server/db";
import { ensureAccount } from "./bulk";
import {
  hasOpenAlert, readLinkedProductIds, readLinksForProducts, readProducts, readPushLog, saveSyncState, setProductSyncMode, writePushLog,
} from "./stockPush";

const A = "s3_store_a";
const B = "s3_store_b";
beforeEach(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await ensureAccount(A);
  await ensureAccount(B);
});
afterAll(async () => {
  await db.account.deleteMany({ where: { id: { in: [A, B] } } });
  await db.$disconnect();
});

describe("stockPush store", () => {
  it("links, sync state, mode and push log round-trip, scoped per account", async () => {
    const p = await db.inventoryProduct.create({ data: { accountId: A, name: "P", onHand: 4 } });
    const l = await db.listingLink.create({ data: { accountId: A, marketplace: "mercadolibre", itemId: "MLA1", variationId: 12n } });
    await db.listingLinkComponent.createMany({ data: [{ accountId: A, linkId: l.id, productId: p.id, quantity: 2 }] });
    const id = Number(p.id);

    const [row] = await readLinksForProducts(A, [id]);
    expect(row).toMatchObject({ linkId: Number(l.id), itemId: "MLA1", variationId: 12, state: null });
    expect(row!.components[0]).toMatchObject({ productId: id, name: "P", syncMode: "dry_run", archived: false });
    expect(row!.components[0]!.onHand.toNumber()).toBe(4);
    expect(await readLinksForProducts(B, [id])).toEqual([]);
    expect(await readLinkedProductIds(A)).toEqual([id]);

    await saveSyncState(A, Number(l.id), { status: "failed", lastError: "boom" }); // creates
    await saveSyncState(A, Number(l.id), { lastPushedQty: 3 }); // patches
    expect((await readLinksForProducts(A, [id]))[0]!.state).toMatchObject({ status: "failed", lastError: "boom", lastPushedQty: 3 });

    await setProductSyncMode(A, [id], "live");
    expect((await readProducts(A, [id]))[0]!.syncMode).toBe("live");

    await writePushLog({ accountId: A, itemId: "MLA1", variationId: 12, requestedQty: 2, previousMlQty: null, mode: "dry_run", result: "dry_run", triggerType: "manual" });
    await writePushLog({ accountId: A, itemId: "MLA2", variationId: null, requestedQty: 0, previousMlQty: 1, mode: "live", result: "failed", httpStatus: 500, error: "x", triggerType: "sale", triggerRef: "9" });
    const log = await readPushLog(A, 10);
    expect(log.map((r) => r.itemId)).toEqual(["MLA2", "MLA1"]); // newest first
    expect(log[1]).toMatchObject({ variationId: 12, previousMlQty: null });
    expect((await readPushLog(A, 10, "mla2")).length).toBe(1);
    expect(await readPushLog(B, 10)).toEqual([]);
  });

  it("hasOpenAlert ignores resolved alerts", async () => {
    await db.stockAlert.create({ data: { accountId: A, type: "stock_drift", dedupeKey: "k", title: "t", status: "resolved", resolvedAt: new Date() } });
    expect(await hasOpenAlert(A, "k")).toBe(false);
    await db.stockAlert.create({ data: { accountId: A, type: "stock_drift", dedupeKey: "k", title: "t" } });
    expect(await hasOpenAlert(A, "k")).toBe(true);
    expect(await hasOpenAlert(B, "k")).toBe(false);
  });
});
