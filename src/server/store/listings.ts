import type { Gtins } from "~/lib/contracts";
import { normalizeText } from "~/lib/normalize";
import { db } from "~/server/db";
import { BATCH, chunks, ensureAccount, likeContains } from "./bulk";
import type { Marketplace } from "./marketplace";

/** How long "this listing has no catalog product" is trusted before Mercado Libre is asked again. */
export const CATALOG_RECHECK_MS = 24 * 3_600_000;

export interface ListingState {
  gtinCheckedAt: Date | null;
  /** `{ _item, [variationId] }` as the calculation expects; only meaningful when `gtinCheckedAt` is set. */
  gtins: Record<string, string>;
  catalogProductId: string | null;
  catalogCheckedAt: Date | null;
}

/**
 * GTIN and catalog state of the given listings in ONE query (ids the table does not know do not
 * appear). A listing whose GTIN was never asked has `gtinCheckedAt` null.
 */
export async function readListings(ownerId: string, mp: Marketplace, itemIds: string[]): Promise<Map<string, ListingState>> {
  const out = new Map<string, ListingState>();
  for (const part of chunks(itemIds, 20_000)) {
    const rows = await db.$queryRaw<
      { id: string; gtin: string | null; gc: Date | null; cat: string | null; cc: Date | null; vars: Record<string, string> }[]
    >`
      SELECT l."itemId" AS id, l."gtin", l."gtinCheckedAt" AS gc, l."catalogProductId" AS cat, l."catalogCheckedAt" AS cc,
             COALESCE(jsonb_object_agg(v."variationId"::text, v."gtin") FILTER (WHERE v."variationId" IS NOT NULL), '{}'::jsonb) AS vars
      FROM "Listing" l
      LEFT JOIN "ListingVariation" v ON v."accountId" = l."accountId" AND v."marketplace" = l."marketplace" AND v."itemId" = l."itemId"
      WHERE l."accountId" = ${ownerId} AND l."marketplace" = ${mp}::"Marketplace" AND l."itemId" = ANY(${part}::text[])
      GROUP BY l."accountId", l."marketplace", l."itemId"`;
    for (const r of rows) {
      out.set(r.id, {
        gtinCheckedAt: r.gc,
        gtins: { _item: r.gtin ?? "", ...r.vars },
        catalogProductId: r.cat,
        catalogCheckedAt: r.cc,
      });
    }
  }
  return out;
}

/** Stores what Mercado Libre answered for GTINs and marks those listings as checked at `at` (the sync's clock). */
export async function saveGtins(ownerId: string, mp: Marketplace, gtins: Gtins, at: Date = new Date()): Promise<void> {
  const entries = Object.entries(gtins).sort(([a], [b]) => (a < b ? -1 : 1));
  if (!entries.length) return;
  await ensureAccount(ownerId);
  for (const part of chunks(entries, BATCH)) {
    const ids = part.map(([id]) => id.toUpperCase());
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "Listing" ("accountId", "marketplace", "itemId", "gtin", "gtinCheckedAt")
        SELECT ${ownerId}, ${mp}::"Marketplace", t.id, NULLIF(t.gtin, ''), ${at.toISOString()}::timestamptz
        FROM unnest(${ids}::text[], ${part.map(([, g]) => g._item ?? "")}::text[]) AS t(id, gtin)
        ON CONFLICT ("accountId", "marketplace", "itemId") DO UPDATE
          SET "gtin" = EXCLUDED."gtin", "gtinCheckedAt" = EXCLUDED."gtinCheckedAt", "updatedAt" = now()`;
      await tx.$executeRaw`
        DELETE FROM "ListingVariation" WHERE "accountId" = ${ownerId} AND "marketplace" = ${mp}::"Marketplace" AND "itemId" = ANY(${ids}::text[])`;
      const vars = part.flatMap(([id, g]) =>
        Object.entries(g)
          .filter(([k, v]) => k !== "_item" && /^\d+$/.test(k) && v)
          .map(([k, v]) => ({ id: id.toUpperCase(), variation: k, gtin: v })),
      );
      for (const v of chunks(vars, BATCH)) {
        await tx.$executeRaw`
          INSERT INTO "ListingVariation" ("accountId", "marketplace", "itemId", "variationId", "gtin")
          SELECT ${ownerId}, ${mp}::"Marketplace", t.id, t.variation::bigint, t.gtin
          FROM unnest(${v.map((x) => x.id)}::text[], ${v.map((x) => x.variation)}::text[], ${v.map((x) => x.gtin)}::text[])
               AS t(id, variation, gtin)
          ON CONFLICT DO NOTHING`;
      }
    });
  }
}

/** Stores the catalog product (or "none") Mercado Libre reported per listing, checked at `at`. */
export async function saveCatalogIds(
  ownerId: string,
  mp: Marketplace,
  ids: Record<string, string | null>,
  at: Date = new Date(),
): Promise<void> {
  const entries = Object.entries(ids).sort(([a], [b]) => (a < b ? -1 : 1));
  if (!entries.length) return;
  await ensureAccount(ownerId);
  for (const part of chunks(entries, BATCH)) {
    await db.$executeRaw`
      INSERT INTO "Listing" ("accountId", "marketplace", "itemId", "catalogProductId", "catalogCheckedAt")
      SELECT ${ownerId}, ${mp}::"Marketplace", t.id, t.cat, ${at.toISOString()}::timestamptz
      FROM unnest(${part.map(([id]) => id.toUpperCase())}::text[], ${part.map(([, c]) => c)}::text[]) AS t(id, cat)
      ON CONFLICT ("accountId", "marketplace", "itemId") DO UPDATE
        SET "catalogProductId" = EXCLUDED."catalogProductId", "catalogCheckedAt" = EXCLUDED."catalogCheckedAt",
            "updatedAt" = now()`;
  }
}

export interface ListingMatch {
  itemId: string;
  title: string;
  /** EAN of the P&L product the listing was matched to ("" = unmatched). */
  ean: string;
  /** Excel description of that product. */
  desc: string;
}

/** Records the title and P&L product of each sold listing, and the text the own-product search reads. */
export async function saveListingMatches(ownerId: string, mp: Marketplace, matches: ListingMatch[]): Promise<void> {
  if (!matches.length) return;
  await ensureAccount(ownerId);
  const sorted = [...matches].sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  for (const part of chunks(sorted, BATCH)) {
    await db.$executeRaw`
      INSERT INTO "Listing" ("accountId", "marketplace", "itemId", "title", "matchedEan", "searchText")
      SELECT ${ownerId}, ${mp}::"Marketplace", t.id, t.title, NULLIF(t.ean, ''), t.search
      FROM unnest(${part.map((m) => m.itemId.toUpperCase())}::text[], ${part.map((m) => m.title)}::text[],
                  ${part.map((m) => m.ean)}::text[], ${part.map((m) => normalizeText(`${m.title} ${m.desc}`))}::text[])
           AS t(id, title, ean, search)
      ON CONFLICT ("accountId", "marketplace", "itemId") DO UPDATE
        SET "title" = EXCLUDED."title", "matchedEan" = EXCLUDED."matchedEan", "searchText" = EXCLUDED."searchText",
            "updatedAt" = now()
        WHERE ("Listing"."title", "Listing"."matchedEan", "Listing"."searchText")
              IS DISTINCT FROM (EXCLUDED."title", EXCLUDED."matchedEan", EXCLUDED."searchText")`;
  }
}

export interface StoredProduct {
  itemId: string;
  title: string;
  desc?: string;
}

/** Listings whose title or P&L description contains `query` (already normalised), newest first. */
export async function searchListings(ownerId: string, mp: Marketplace, query: string, limit: number): Promise<StoredProduct[]> {
  const rows = await db.$queryRaw<{ itemId: string; title: string; desc: string | null }[]>`
    SELECT l."itemId", l."title", p."description" AS "desc"
    FROM "Listing" l
    LEFT JOIN "Product" p ON p."accountId" = l."accountId" AND p."ean" = l."matchedEan"
    WHERE l."accountId" = ${ownerId} AND l."marketplace" = ${mp}::"Marketplace" AND l."title" IS NOT NULL AND l."searchText" LIKE ${likeContains(query)}
    ORDER BY l."updatedAt" DESC, l."itemId"
    LIMIT ${limit}`;
  return rows.map((r) => ({ itemId: r.itemId, title: r.title, ...(r.desc ? { desc: r.desc } : {}) }));
}

/** `catalog_product_id` of one listing: undefined = never asked, null = asked and it has none. */
export async function getCatalogId(ownerId: string, mp: Marketplace, itemId: string): Promise<string | null | undefined> {
  const row = await db.listing.findUnique({
    where: { accountId_marketplace_itemId: { accountId: ownerId, marketplace: mp, itemId } },
    select: { catalogProductId: true, catalogCheckedAt: true },
  });
  if (!row?.catalogCheckedAt) return undefined;
  return row.catalogProductId;
}

export async function setCatalogId(ownerId: string, mp: Marketplace, itemId: string, id: string | null): Promise<void> {
  await saveCatalogIds(ownerId, mp, { [itemId]: id });
}

