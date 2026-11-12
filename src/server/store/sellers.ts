import { db } from "~/server/db";
import { BATCH, chunks, txt } from "./bulk";
import type { Marketplace } from "./marketplace";

/** Public seller nicknames we already know. */
export async function readSellerNicknames(mp: Marketplace, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const part of chunks(ids, 20_000)) {
    const rows = await db.seller.findMany({ where: { marketplace: mp, sellerId: { in: part.map(BigInt) } } });
    for (const r of rows) out.set(Number(r.sellerId), r.nickname);
  }
  return out;
}

export async function saveSellerNicknames(mp: Marketplace, entries: [number, string][]): Promise<void> {
  const sorted = [...entries].sort(([a], [b]) => a - b);
  for (const part of chunks(sorted, BATCH)) {
    await db.$executeRaw`
      INSERT INTO "Seller" ("marketplace", "sellerId", "nickname", "fetchedAt")
      SELECT ${mp}::"Marketplace", t.id::bigint, t.nick, now()
      FROM unnest(${txt(part.map(([id]) => id))}::text[], ${part.map(([, n]) => n)}::text[]) AS t(id, nick)
      ON CONFLICT ("marketplace", "sellerId") DO UPDATE SET "nickname" = EXCLUDED."nickname", "fetchedAt" = EXCLUDED."fetchedAt"`;
  }
}
