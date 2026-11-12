/** DB access of the ML stock push engine (S3): links with their components, sync state and the push log. */
import type { Prisma } from "../../../generated/prisma";
import { db } from "~/server/db";
import type { PushResult, PushTrigger, SyncMode, SyncStatus } from "~/lib/stock-contracts";
import { MERCADOLIBRE } from "./marketplace";

export interface LinkComponentRow {
  productId: number;
  name: string;
  /** Units of the product per unit of listing. */
  quantity: Prisma.Decimal;
  onHand: Prisma.Decimal;
  syncMode: SyncMode;
  archived: boolean;
}

export interface SyncStateRow {
  lastObservedMlQty: number | null;
  lastObservedAt: Date | null;
  lastPushedQty: number | null;
  lastPushedAt: Date | null;
  status: SyncStatus;
  lastError: string | null;
}

export interface LinkRow {
  linkId: number;
  itemId: string;
  variationId: number | null;
  components: LinkComponentRow[];
  state: SyncStateRow | null;
}

const include = {
  components: { include: { product: true }, orderBy: { productId: "asc" } },
  syncState: true,
} satisfies Prisma.ListingLinkInclude;

type LinkWithParts = Prisma.ListingLinkGetPayload<{ include: typeof include }>;

const toRow = (l: LinkWithParts): LinkRow => ({
  linkId: Number(l.id),
  itemId: l.itemId,
  variationId: l.variationId === null ? null : Number(l.variationId),
  components: l.components.map((c) => ({
    productId: Number(c.productId),
    name: c.product.name,
    quantity: c.quantity,
    onHand: c.product.onHand,
    syncMode: c.product.syncMode,
    archived: c.product.archivedAt !== null,
  })),
  state: l.syncState && {
    lastObservedMlQty: l.syncState.lastObservedMlQty,
    lastObservedAt: l.syncState.lastObservedAt,
    lastPushedQty: l.syncState.lastPushedQty,
    lastPushedAt: l.syncState.lastPushedAt,
    status: l.syncState.status,
    lastError: l.syncState.lastError,
  },
});

/** Links (with ALL their components) that use at least one of the products. */
export async function readLinksForProducts(accountId: string, productIds: number[]): Promise<LinkRow[]> {
  if (productIds.length === 0) return [];
  const rows = await db.listingLink.findMany({
    where: {
      accountId,
      marketplace: MERCADOLIBRE,
      components: { some: { productId: { in: productIds.map(BigInt) } } },
    },
    include,
    orderBy: { id: "asc" },
  });
  return rows.map(toRow);
}

export async function readAllLinks(accountId: string): Promise<LinkRow[]> {
  const rows = await db.listingLink.findMany({ where: { accountId, marketplace: MERCADOLIBRE }, include, orderBy: { id: "asc" } });
  return rows.map(toRow);
}

export async function readLink(accountId: string, linkId: number): Promise<LinkRow | null> {
  const l = await db.listingLink.findUnique({ where: { accountId_id: { accountId, id: BigInt(linkId) } }, include });
  return l ? toRow(l) : null;
}

export interface PushLogEntry {
  accountId: string;
  itemId: string;
  variationId: number | null;
  requestedQty: number;
  previousMlQty: number | null;
  mode: SyncMode;
  result: PushResult;
  httpStatus?: number | null;
  error?: string | null;
  triggerType: PushTrigger;
  triggerRef?: string | null;
}

export async function writePushLog(e: PushLogEntry): Promise<void> {
  await db.mlPushLog.create({
    data: {
      accountId: e.accountId,
      marketplace: MERCADOLIBRE,
      itemId: e.itemId,
      variationId: e.variationId === null ? null : BigInt(e.variationId),
      requestedQty: e.requestedQty,
      previousMlQty: e.previousMlQty,
      mode: e.mode,
      result: e.result,
      httpStatus: e.httpStatus ?? null,
      error: e.error ?? null,
      triggerType: e.triggerType,
      triggerRef: e.triggerRef ?? null,
    },
  });
}

export interface PushLogRead {
  id: number;
  itemId: string;
  variationId: number | null;
  requestedQty: number;
  previousMlQty: number | null;
  mode: SyncMode;
  result: PushResult;
  httpStatus: number | null;
  error: string | null;
  triggerType: PushTrigger;
  triggerRef: string | null;
  createdAt: Date;
}

export async function readPushLog(accountId: string, limit: number, itemId?: string): Promise<PushLogRead[]> {
  const rows = await db.mlPushLog.findMany({
    where: { accountId, marketplace: MERCADOLIBRE, ...(itemId ? { itemId: itemId.toUpperCase() } : {}) },
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: Number(r.id),
    itemId: r.itemId,
    variationId: r.variationId === null ? null : Number(r.variationId),
    requestedQty: r.requestedQty,
    previousMlQty: r.previousMlQty,
    mode: r.mode,
    result: r.result,
    httpStatus: r.httpStatus,
    error: r.error,
    triggerType: r.triggerType,
    triggerRef: r.triggerRef,
    createdAt: r.createdAt,
  }));
}

export type SyncStatePatch = Partial<SyncStateRow>;

/** Creates the state row when the link has none (S5 seeds it, but be safe), otherwise patches it. */
export async function saveSyncState(accountId: string, linkId: number, patch: SyncStatePatch): Promise<void> {
  const id = BigInt(linkId);
  await db.listingSyncState.upsert({
    where: { accountId_linkId: { accountId, linkId: id } },
    create: { accountId, linkId: id, ...patch },
    update: patch,
  });
}

export interface ProductSyncRow {
  productId: number;
  name: string;
  onHand: Prisma.Decimal;
  syncMode: SyncMode;
  archived: boolean;
}

export async function readProducts(accountId: string, productIds: number[]): Promise<ProductSyncRow[]> {
  const rows = await db.inventoryProduct.findMany({ where: { accountId, id: { in: productIds.map(BigInt) } }, orderBy: { id: "asc" } });
  return rows.map((p) => ({ productId: Number(p.id), name: p.name, onHand: p.onHand, syncMode: p.syncMode, archived: p.archivedAt !== null }));
}

/** Ids of the non-archived products that have at least one link. */
export async function readLinkedProductIds(accountId: string): Promise<number[]> {
  const rows = await db.listingLinkComponent.findMany({
    where: { accountId, product: { archivedAt: null } },
    select: { productId: true },
    distinct: ["productId"],
    orderBy: { productId: "asc" },
  });
  return rows.map((r) => Number(r.productId));
}

export async function setProductSyncMode(accountId: string, productIds: number[], mode: SyncMode): Promise<void> {
  if (productIds.length === 0) return;
  await db.inventoryProduct.updateMany({ where: { accountId, id: { in: productIds.map(BigInt) } }, data: { syncMode: mode } });
}

/** Whether a non-resolved alert exists for the key (S7 owns writing alerts; this is a read for the reconcile rule). */
export async function hasOpenAlert(accountId: string, dedupeKey: string): Promise<boolean> {
  const n = await db.stockAlert.count({ where: { accountId, dedupeKey, status: { not: "resolved" } } });
  return n > 0;
}
