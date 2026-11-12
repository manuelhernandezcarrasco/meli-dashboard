import type { ReturnCase } from "../../../generated/prisma";
import type { ReturnOutcome, ReturnRow } from "~/lib/stock-contracts";
import { db } from "~/server/db";
import { ensureAccount } from "./bulk";
import type { OpenReturnInput, ReturnRecord, ReturnsStore } from "~/server/stock/returns";

/**
 * ReturnCase persistence. The ONLY writer of the table (S8). No buyer data is stored: a case points at an
 * order line and a product, nothing else.
 */

const toRecord = (r: ReturnCase): ReturnRecord => ({
  id: Number(r.id),
  accountId: r.accountId,
  marketplace: r.marketplace,
  orderId: Number(r.orderId),
  lineNo: r.lineNo,
  productId: Number(r.productId),
  quantity: Number(r.quantity),
  outcome: r.outcome,
  reason: r.reason,
  openedAt: r.openedAt,
  resolvedAt: r.resolvedAt,
  note: r.note,
});

export const returnsStore: ReturnsStore = {
  async insert(input: OpenReturnInput) {
    await ensureAccount(input.accountId);
    const where = {
      accountId: input.accountId, marketplace: "mercadolibre" as const,
      orderId: BigInt(input.orderId), lineNo: input.lineNo,
    };
    // skipDuplicates makes concurrent opens of the same line collapse into one row.
    const { count } = await db.returnCase.createMany({
      data: [{ ...where, productId: BigInt(input.productId), quantity: input.quantity, reason: input.reason ?? null }],
      skipDuplicates: true,
    });
    const row = await db.returnCase.findFirstOrThrow({ where });
    return { record: toRecord(row), created: count === 1 };
  },

  async get(accountId, id) {
    const row = await db.returnCase.findUnique({ where: { accountId_id: { accountId, id: BigInt(id) } } });
    return row ? toRecord(row) : null;
  },

  async transition(accountId, id, from, to, note, resolvedAt) {
    const { count } = await db.returnCase.updateMany({
      where: { accountId, id: BigInt(id), outcome: from },
      data: { outcome: to, resolvedAt, ...(note !== undefined ? { note } : {}) },
    });
    if (count === 0) return null;
    return this.get(accountId, id);
  },
};

export async function listReturns(accountId: string, outcome?: ReturnOutcome): Promise<ReturnRow[]> {
  const rows = await db.returnCase.findMany({
    where: { accountId, ...(outcome ? { outcome } : {}) },
    include: { product: { select: { name: true } } },
    orderBy: [{ openedAt: "desc" }, { id: "desc" }],
  });
  return rows.map((r) => ({
    id: Number(r.id),
    marketplace: r.marketplace,
    orderId: Number(r.orderId),
    lineNo: r.lineNo,
    productId: Number(r.productId),
    productName: r.product.name,
    quantity: Number(r.quantity),
    outcome: r.outcome,
    reason: r.reason,
    openedAt: r.openedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    note: r.note,
  }));
}
