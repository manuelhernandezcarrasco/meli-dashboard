/**
 * Push engine (S3): sends our available quantity to Mercado Libre, dry-run by default, with a full log.
 * The only writer to ML is `setAvailableQuantity` (src/server/ml/stock-write.ts).
 */
import { Prisma } from "../../../generated/prisma";
import type { GoLiveInput, GoLivePreview, PushLogRow, PushTrigger, SyncMode, SyncStatusRow } from "~/lib/stock-contracts";
import { MlWriteError } from "~/server/ml/http";
import { getItemsStock, type ItemStock } from "~/server/ml/items-stock";
import { setAvailableQuantity } from "~/server/ml/stock-write";
import {
  hasOpenAlert, readAllLinks, readLinkedProductIds, readPushLog, readLinksForProducts, readProducts, saveSyncState,
  setProductSyncMode, writePushLog, type LinkRow,
} from "~/server/store/stockPush";
import {
  StockError,
  type AlertService, type AppendMovementInput, type AvailableQuantity, type LedgerService, type PushTriggerInfo,
} from "./contracts";
import { raiseAlert, resolveAlert } from "./alerts";
import { appendMovement, availableQuantity } from "./ledger";

const MAX_ATTEMPTS = 3;
const driftKey = (linkId: number) => `drift:${linkId}`;

export interface MlGateway {
  getItemsStock(accountId: string, itemIds: string[]): Promise<Map<string, ItemStock>>;
  setAvailableQuantity(a: { accountId: string; itemId: string; variationId: number | null; quantity: number }): Promise<void>;
}

export interface PushDeps {
  ml: MlGateway;
  availableQuantity: AvailableQuantity;
  raiseAlert: AlertService["raiseAlert"];
  resolveAlert: AlertService["resolveAlert"];
  appendMovement: LedgerService["appendMovement"];
  sleep: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const defaultDeps: PushDeps = {
  ml: {
    getItemsStock: (accountId, ids) => getItemsStock(accountId, ids),
    setAvailableQuantity: (a) => setAvailableQuantity(a),
  },
  availableQuantity,
  raiseAlert,
  resolveAlert,
  appendMovement,
  sleep: realSleep,
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const transient = (e: unknown) => e instanceof MlWriteError && (e.status === 0 || e.status === 429 || e.status >= 500);

function mlQtyOf(item: ItemStock, variationId: number | null): number | null {
  if (variationId === null) return item.variations.length > 0 ? null : item.available_quantity;
  return item.variations.find((v) => v.id === variationId)?.available_quantity ?? null;
}

export function createPushEngine(over: Partial<PushDeps> = {}) {
  const d: PushDeps = { ...defaultDeps, ...over };

  const desiredQty = (link: LinkRow) =>
    Math.max(0, d.availableQuantity(link.components.map((c) => ({ onHand: c.onHand, quantity: c.quantity }))));

  /** Reads ML for the given items; on failure returns the error text instead (dry-run still logs). */
  async function readMl(accountId: string, itemIds: string[]): Promise<{ items: Map<string, ItemStock>; error: string | null }> {
    try {
      return { items: await d.ml.getItemsStock(accountId, [...new Set(itemIds)]), error: null };
    } catch (e) {
      return { items: new Map(), error: errMsg(e) };
    }
  }

  async function pushLinks(accountId: string, links: LinkRow[], trigger: PushTriggerInfo): Promise<void> {
    if (links.length === 0) return;
    const { items, error: readError } = await readMl(accountId, links.map((l) => l.itemId));
    const base = { accountId, triggerType: trigger.type as PushTrigger, triggerRef: trigger.ref ?? null };

    for (const link of links) {
      const requestedQty = desiredQty(link);
      const live = link.components.length > 0 && link.components.every((c) => c.syncMode === "live");
      const mode: SyncMode = live ? "live" : "dry_run";
      const entry = { ...base, itemId: link.itemId, variationId: link.variationId, requestedQty, mode };
      const item = items.get(link.itemId.toUpperCase());
      const previousMlQty = item ? mlQtyOf(item, link.variationId) : null;

      const skip = async (reason: string) =>
        writePushLog({ ...entry, previousMlQty, result: "skipped", error: reason });

      if (link.components.length === 0) { await skip("El vínculo no tiene componentes"); continue; }
      if (link.components.some((c) => c.archived)) { await skip("Un producto del vínculo falta o está archivado"); continue; }
      if (item) {
        if (item.logistic_type === "fulfillment") { await skip("Publicación en Mercado Libre Full"); continue; }
        if (item.status !== "active" && item.status !== "paused") { await skip(`Estado de la publicación: ${item.status}`); continue; }
        if (link.variationId === null && item.variations.length > 0) { await skip("La publicación tiene variaciones: hay que vincular por variación"); continue; }
        if (link.variationId !== null && previousMlQty === null) { await skip("La variación no existe en la publicación"); continue; }
      } else if (!readError) {
        await skip("Publicación no encontrada en Mercado Libre");
        continue;
      }

      if (!live) {
        await writePushLog({ ...entry, previousMlQty, result: "dry_run", error: readError });
        if (previousMlQty !== null) await saveSyncState(accountId, link.linkId, { lastObservedMlQty: previousMlQty, lastObservedAt: new Date() });
        continue;
      }
      if (readError) {
        await fail(link, entry, null, 0, readError);
        continue;
      }

      let lastErr: unknown = null;
      let ok = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          await d.ml.setAvailableQuantity({ accountId, itemId: link.itemId, variationId: link.variationId, quantity: requestedQty });
          ok = true;
          break;
        } catch (e) {
          lastErr = e;
          if (!transient(e)) break;
          if (attempt < MAX_ATTEMPTS - 1) await d.sleep(2 ** attempt * 1000);
        }
      }
      if (ok) {
        const now = new Date();
        await writePushLog({ ...entry, previousMlQty, result: "ok", httpStatus: 200 });
        await saveSyncState(accountId, link.linkId, {
          lastPushedQty: requestedQty, lastPushedAt: now, lastObservedMlQty: requestedQty, lastObservedAt: now,
          status: "in_sync", lastError: null,
        });
        await d.resolveAlert(accountId, link.itemId, "auto");
        await d.resolveAlert(accountId, driftKey(link.linkId), "auto");
      } else {
        await fail(link, entry, previousMlQty, lastErr instanceof MlWriteError ? lastErr.status : null, errMsg(lastErr));
      }
    }

    async function fail(
      link: LinkRow,
      entry: { itemId: string; variationId: number | null; requestedQty: number; mode: SyncMode; accountId: string; triggerType: PushTrigger; triggerRef: string | null },
      previousMlQty: number | null,
      httpStatus: number | null,
      message: string,
    ) {
      await writePushLog({ ...entry, previousMlQty, result: "failed", httpStatus, error: message });
      await saveSyncState(accountId, link.linkId, { status: "failed", lastError: message });
      await d.raiseAlert({
        accountId, type: "push_failed", dedupeKey: link.itemId, itemId: link.itemId, marketplace: "mercadolibre",
        title: `No se pudo actualizar el stock en Mercado Libre (${link.itemId})`,
        detail: message, quantity: entry.requestedQty,
      });
    }
  }

  async function requestPush(accountId: string, productIds: number[], trigger: PushTriggerInfo): Promise<void> {
    if (!accountId) throw new StockError("PRODUCT_NOT_FOUND", "accountId required");
    // Only listings with an explicit link are ever returned here: unknown products are never pushed.
    await pushLinks(accountId, await readLinksForProducts(accountId, productIds), trigger);
  }

  /** Reads ML for every link, records what it has, flags drift and heals live products that have no open drift alert. */
  async function compareWithMl(accountId: string): Promise<{ checked: number; drift: number; pushed: number }> {
    const links = await readAllLinks(accountId);
    const { items, error } = await readMl(accountId, links.map((l) => l.itemId));
    if (error) throw new Error(error);
    const now = new Date();
    const heal: LinkRow[] = [];
    let checked = 0;
    let drift = 0;
    for (const link of links) {
      const item = items.get(link.itemId.toUpperCase());
      if (!item || item.logistic_type === "fulfillment" || link.components.length === 0 || link.components.some((c) => c.archived)) continue;
      const ml = mlQtyOf(item, link.variationId);
      if (ml === null) continue;
      checked++;
      const ours = desiredQty(link);
      if (ml === ours) {
        await saveSyncState(accountId, link.linkId, {
          lastObservedMlQty: ml, lastObservedAt: now,
          ...(link.state?.status === "drift" || link.state?.status === "never" || link.state?.status === "failed"
            ? { status: "in_sync" as const, lastError: null } : {}),
        });
        await d.resolveAlert(accountId, driftKey(link.linkId), "auto");
        continue;
      }
      drift++;
      const alreadyAlerted = await hasOpenAlert(accountId, driftKey(link.linkId));
      await saveSyncState(accountId, link.linkId, { lastObservedMlQty: ml, lastObservedAt: now, status: "drift" });
      await d.raiseAlert({
        accountId, type: "stock_drift", dedupeKey: driftKey(link.linkId), itemId: link.itemId, marketplace: "mercadolibre",
        title: `El stock en Mercado Libre (${ml}) no coincide con el nuestro (${ours})`,
        detail: `Publicación ${link.itemId}${link.variationId !== null ? ` · variación ${link.variationId}` : ""}`,
        quantity: ours,
      });
      if (!alreadyAlerted && link.components.every((c) => c.syncMode === "live")) heal.push(link);
    }
    await pushLinks(accountId, heal, { type: "reconcile" });
    return { checked, drift, pushed: heal.length };
  }

  /** What the UI shows before a product goes live: our stock vs what ML has on each linked listing. */
  async function prepareGoLive(accountId: string, productId: number): Promise<GoLivePreview> {
    const [product] = await readProducts(accountId, [productId]);
    if (!product) throw new StockError("PRODUCT_NOT_FOUND");
    const links = await readLinksForProducts(accountId, [productId]);
    const { items } = await readMl(accountId, links.map((l) => l.itemId));
    return {
      productId,
      productName: product.name,
      ourOnHand: product.onHand.toNumber(),
      listings: links.map((l) => {
        const item = items.get(l.itemId.toUpperCase());
        return { linkId: l.linkId, itemId: l.itemId, variationId: l.variationId, mlQty: item ? mlQtyOf(item, l.variationId) : null };
      }),
    };
  }

  /**
   * Flips the sync mode. Going live needs one confirmation per product (`GoLiveInput`): if the confirmed opening
   * stock differs from ours the delta is written as a manual_adjust through the ledger, then a push syncs ML.
   * Going back to dry_run needs no confirmation. `'all'` = every non-archived product with a link.
   */
  async function setSyncMode(
    accountId: string,
    target: number[] | "all",
    mode: SyncMode,
    confirmed: GoLiveInput[] = [],
  ): Promise<void> {
    const ids = target === "all" ? await readLinkedProductIds(accountId) : [...new Set(target)];
    const products = await readProducts(accountId, ids);
    if (products.length !== ids.length) throw new StockError("PRODUCT_NOT_FOUND");
    if (mode === "dry_run") {
      await setProductSyncMode(accountId, ids, "dry_run");
      return;
    }
    const byId = new Map(confirmed.map((c) => [c.productId, c]));
    for (const p of products) {
      if (!byId.has(p.productId)) throw new StockError("ML_WRITE_BLOCKED", `Falta confirmar el stock inicial de ${p.name}`);
    }
    for (const p of products) {
      const c = byId.get(p.productId)!;
      const delta = new Prisma.Decimal(c.openingStock).minus(p.onHand);
      if (!delta.isZero()) {
        const adj: AppendMovementInput = {
          accountId, productId: p.productId, type: "manual_adjust", quantity: delta, occurredAt: new Date(),
          idempotencyKey: c.idempotencyKey, refType: "go_live", reason: "Stock inicial confirmado al activar la sincronización", actor: "user",
        };
        await d.appendMovement(adj);
      }
    }
    await setProductSyncMode(accountId, ids, "live");
    await requestPush(accountId, ids, { type: "manual" });
  }

  /** Rows for the sync tab: what we would send now and what we know of each link. */
  async function syncStatus(accountId: string): Promise<SyncStatusRow[]> {
    return (await readAllLinks(accountId)).map((l) => ({
      linkId: l.linkId,
      marketplace: "mercadolibre" as const,
      itemId: l.itemId,
      variationId: l.variationId,
      productNames: l.components.map((c) => c.name),
      desiredQty: desiredQty(l),
      status: l.state?.status ?? "never",
      lastObservedMlQty: l.state?.lastObservedMlQty ?? null,
      lastObservedAt: l.state?.lastObservedAt?.toISOString() ?? null,
      lastPushedQty: l.state?.lastPushedQty ?? null,
      lastPushedAt: l.state?.lastPushedAt?.toISOString() ?? null,
      lastError: l.state?.lastError ?? null,
      mode: l.components.length > 0 && l.components.every((c) => c.syncMode === "live") ? "live" as const : "dry_run" as const,
    }));
  }

  async function pushLog(accountId: string, limit: number): Promise<PushLogRow[]> {
    return (await readPushLog(accountId, limit)).map((r) => ({
      ...r, marketplace: "mercadolibre" as const, createdAt: r.createdAt.toISOString(),
    }));
  }

  return { requestPush, compareWithMl, prepareGoLive, setSyncMode, syncStatus, pushLog };
}

let engine: ReturnType<typeof createPushEngine> | undefined;
const get = () => (engine ??= createPushEngine());

export const requestPush = (accountId: string, productIds: number[], trigger: PushTriggerInfo) => get().requestPush(accountId, productIds, trigger);
export const compareWithMl = (accountId: string) => get().compareWithMl(accountId);
export const prepareGoLive = (accountId: string, productId: number) => get().prepareGoLive(accountId, productId);
export const setSyncMode = (accountId: string, target: number[] | "all", mode: SyncMode, confirmed?: GoLiveInput[]) =>
  get().setSyncMode(accountId, target, mode, confirmed);
export const syncStatus = (accountId: string) => get().syncStatus(accountId);
export const pushLog = (accountId: string, limit: number) => get().pushLog(accountId, limit);
