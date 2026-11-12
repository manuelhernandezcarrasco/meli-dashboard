import { Prisma } from "../../../generated/prisma";
import { db } from "~/server/db";

/** Prisma client or the one handed to an interactive transaction. */
export type Db = Prisma.TransactionClient;

/** Rows per bulk statement. Arrays travel as ONE bind parameter, so this is not a bind-limit issue. */
export const BATCH = 2000;

export const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

type Scalar = string | number | bigint | boolean | Date | null | undefined;

/**
 * Values as the text array a bulk statement unnests (`unnest($1::text[])::bigint`...). Everything
 * goes through text so Postgres does the typing and large Mercado Libre ids never touch a JS float.
 */
export const txt = (xs: readonly Scalar[]): (string | null)[] =>
  xs.map((x) => (x === null || x === undefined ? null : x instanceof Date ? x.toISOString() : String(x)));

/**
 * Makes sure the tenant row exists before anything references it. One idempotent statement; call
 * it at the entry points that create data for a user (sync, upload, token save, decision...).
 */
export async function ensureAccount(ownerId: string, client: Db = db): Promise<void> {
  await client.account.createMany({ data: [{ id: ownerId }], skipDuplicates: true });
}

/** Postgres LIKE pattern matching `text` anywhere (escapes % _ \). */
export const likeContains = (text: string): string => `%${text.replace(/[\\%_]/g, "\\$&")}%`;
