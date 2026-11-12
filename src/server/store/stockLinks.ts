import type { Prisma } from "../../../generated/prisma";
import type { LinkedListing } from "~/lib/stock-contracts";
import { normEan } from "~/lib/normalize";
import { db } from "~/server/db";
import type { Db } from "./bulk";
import type { Marketplace } from "./marketplace";

/** One thing that can be linked: a listing without variations, or one variation of a listing that has them. */
export interface ListingTarget {
  itemId: string;
  variationId: number | null;
  title: string | null;
  /** Normalized GTIN: the variation's first, then the item's. Empty when none. */
  gtin: string;
  /** Item-level GTIN as normalized (may differ from `gtin` for variations). */
  itemGtin: string;
  /** SKUs the seller set, seen on past order lines. */
  skus: string[];
  /** All variations of the listing (for the unmatched form); empty for a simple listing. */
  variations: { variationId: number; gtin: string }[];
}

const key = (itemId: string, variationId: number | null) => `${itemId}|${variationId ?? 0}`;

async function skusByItem(accountId: string, mp: Marketplace, itemIds?: string[]): Promise<Map<string, Map<number, string[]>>> {
  const rows = await db.orderItem.findMany({
    where: { accountId, marketplace: mp, ...(itemIds ? { itemId: { in: itemIds } } : {}), OR: [{ sellerSku: { not: null } }, { sellerCustomField: { not: null } }] },
    select: { itemId: true, variationId: true, sellerSku: true, sellerCustomField: true, order: { select: { createdAt: true } } },
    orderBy: { order: { createdAt: "desc" } },
  });
  const out = new Map<string, Map<number, string[]>>();
  for (const r of rows) {
    const v = r.variationId === null ? 0 : Number(r.variationId);
    const perItem = out.get(r.itemId) ?? new Map<number, string[]>();
    const list = perItem.get(v) ?? [];
    for (const s of [r.sellerSku, r.sellerCustomField]) {
      const t = s?.trim();
      if (t && !list.includes(t)) list.push(t);
    }
    perItem.set(v, list);
    out.set(r.itemId, perItem);
  }
  return out;
}

function targetsOf(
  listings: { itemId: string; title: string | null; gtin: string | null; variations: { variationId: bigint; gtin: string }[] }[],
  skus: Map<string, Map<number, string[]>>,
): ListingTarget[] {
  const out: ListingTarget[] = [];
  for (const l of listings) {
    const itemGtin = normEan(l.gtin);
    const vars = l.variations.map((v) => ({ variationId: Number(v.variationId), gtin: normEan(v.gtin) }));
    const per = skus.get(l.itemId);
    const base = { itemId: l.itemId, title: l.title, itemGtin, variations: vars };
    if (vars.length === 0) {
      out.push({ ...base, variationId: null, gtin: itemGtin, skus: per?.get(0) ?? [] });
    } else {
      for (const v of vars) {
        out.push({ ...base, variationId: v.variationId, gtin: v.gtin || itemGtin, skus: per?.get(v.variationId) ?? [] });
      }
    }
  }
  return out;
}

const listingSelect = { itemId: true, title: true, gtin: true, variations: { select: { variationId: true, gtin: true }, orderBy: { variationId: "asc" } } } as const;

/** Targets (see `ListingTarget`) that have no ListingLink yet. */
export async function listUnlinkedTargets(accountId: string, mp: Marketplace): Promise<ListingTarget[]> {
  const [listings, links, skus] = await Promise.all([
    db.listing.findMany({ where: { accountId, marketplace: mp }, select: listingSelect, orderBy: { itemId: "asc" } }),
    db.listingLink.findMany({ where: { accountId, marketplace: mp }, select: { itemId: true, variationId: true } }),
    skusByItem(accountId, mp),
  ]);
  const linked = new Set(links.map((l) => key(l.itemId, l.variationId === null ? null : Number(l.variationId))));
  return targetsOf(listings, skus).filter((t) => !linked.has(key(t.itemId, t.variationId)));
}

/** The target for one (itemId, variationId), or null when the listing is unknown. A variation the listing lacks is unknown too. */
export async function getTarget(accountId: string, mp: Marketplace, itemId: string, variationId: number | null): Promise<ListingTarget | null> {
  const [l, skus] = await Promise.all([
    db.listing.findUnique({ where: { accountId_marketplace_itemId: { accountId, marketplace: mp, itemId } }, select: listingSelect }),
    skusByItem(accountId, mp, [itemId]),
  ]);
  if (!l) return null;
  return targetsOf([l], skus).find((t) => t.variationId === variationId) ?? null;
}

export interface StoredLink {
  id: number;
  components: { productId: number; quantity: number }[];
}

export async function findLink(accountId: string, mp: Marketplace, itemId: string, variationId: number | null, client: Db = db): Promise<StoredLink | null> {
  const l = await client.listingLink.findFirst({
    where: { accountId, marketplace: mp, itemId, variationId: variationId === null ? null : variationId },
    include: { components: true },
  });
  return l ? { id: Number(l.id), components: l.components.map((c) => ({ productId: Number(c.productId), quantity: Number(c.quantity) })) } : null;
}

/**
 * Creates the link for (listing, variation) with its components and a `never` sync state, removing any
 * previous link of the same target first. Call inside a transaction.
 */
export async function replaceLink(
  tx: Db, accountId: string, mp: Marketplace, itemId: string, variationId: number | null,
  components: { productId: number; quantity: Prisma.Decimal.Value }[],
): Promise<number> {
  await tx.listingLink.deleteMany({ where: { accountId, marketplace: mp, itemId, variationId: variationId === null ? null : variationId } });
  const link = await tx.listingLink.create({
    data: {
      accountId, marketplace: mp, itemId, variationId,
      components: { create: components.map((c) => ({ productId: c.productId, quantity: c.quantity })) },
      syncState: { create: { status: "never" } },
    },
  });
  return Number(link.id);
}

export async function deleteLink(accountId: string, linkId: number): Promise<boolean> {
  const r = await db.listingLink.deleteMany({ where: { accountId, id: linkId } });
  return r.count > 0;
}

/** True while some target of the listing still has no link. */
export async function hasUnlinkedTarget(accountId: string, mp: Marketplace, itemId: string): Promise<boolean> {
  const l = await db.listing.findUnique({ where: { accountId_marketplace_itemId: { accountId, marketplace: mp, itemId } }, select: listingSelect });
  if (!l) return false;
  const links = await db.listingLink.findMany({ where: { accountId, marketplace: mp, itemId }, select: { variationId: true } });
  const linked = new Set(links.map((x) => key(itemId, x.variationId === null ? null : Number(x.variationId))));
  return targetsOf([l], new Map()).some((t) => !linked.has(key(t.itemId, t.variationId)));
}

/** Listings (and variations) a product feeds, with their sync state, for the table and drawer. */
export async function linkedListingsOfProduct(accountId: string, productId: number): Promise<LinkedListing[]> {
  const comps = await db.listingLinkComponent.findMany({
    where: { accountId, productId },
    include: { link: { include: { syncState: true, _count: { select: { components: true } } } } },
    orderBy: { linkId: "asc" },
  });
  if (comps.length === 0) return [];
  const ids = [...new Set(comps.map((c) => c.link.itemId))];
  const listings = await db.listing.findMany({ where: { accountId, itemId: { in: ids } }, select: { itemId: true, marketplace: true, title: true } });
  const titles = new Map(listings.map((l) => [`${l.marketplace}|${l.itemId}`, l.title]));
  return comps.map((c) => ({
    linkId: Number(c.linkId),
    marketplace: c.link.marketplace,
    itemId: c.link.itemId,
    variationId: c.link.variationId === null ? null : Number(c.link.variationId),
    title: titles.get(`${c.link.marketplace}|${c.link.itemId}`) ?? null,
    componentQuantity: Number(c.quantity),
    componentCount: c.link._count.components,
    syncStatus: c.link.syncState?.status ?? "never",
    lastPushedQty: c.link.syncState?.lastPushedQty ?? null,
    lastObservedMlQty: c.link.syncState?.lastObservedMlQty ?? null,
  }));
}
