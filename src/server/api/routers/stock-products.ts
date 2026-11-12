import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  CreateProductInputSchema, LinkListingInputSchema, ManualAdjustInputSchema, ProductListInputSchema,
  type LinkedListing, type MovementRow, type CostEntryRow, type ProductDetail, type ProductRow,
} from "~/lib/stock-contracts";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { isLinked } from "~/server/ml";
import { StockError } from "~/server/stock/contracts";
import { setManualCost } from "~/server/stock/ledger";
import { applyPendingForListing } from "~/server/stock/sales";
import { createProductWithStock, getStockServices, linking, type LinkPlan, type UnlinkedListing } from "~/server/stock/linking";
import {
  costHistory, DuplicateEanError, getProductBase, listProductBases, recentMovements, updateProduct, type ProductBase,
} from "~/server/store/inventoryProducts";
import { linkedListingsOfProduct } from "~/server/store/stockLinks";

/** Stock is meaningless without a linked Mercado Libre account. */
const linkedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!(await isLinked(ctx.userId))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ML_NOT_CONNECTED" });
  }
  return next();
});

/**
 * v1 links simple listings only. The ONLY place that enforces it: F1 (combo builder) deletes this check;
 * the service and the data model already accept several components.
 */
export const V1_MAX_COMPONENTS = 1;
function assertV1Components(components: unknown[]): void {
  if (components.length > V1_MAX_COMPONENTS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Combos: próximamente" });
  }
}

function toTrpc(e: unknown): never {
  if (e instanceof TRPCError) throw e;
  if (e instanceof DuplicateEanError) throw new TRPCError({ code: "CONFLICT", message: e.message, cause: e });
  if (e instanceof StockError) {
    const code =
      e.code === "PRODUCT_NOT_FOUND" || e.code === "LINK_NOT_FOUND" ? "NOT_FOUND"
      : e.code === "LINK_EXISTS" || e.code === "IDEMPOTENCY_CONFLICT" ? "CONFLICT"
      : "BAD_REQUEST";
    throw new TRPCError({ code, message: e.message, cause: e });
  }
  throw e;
}
async function guard<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) { return toTrpc(e); }
}

export const ProductStatusSchema = z.enum(["all", "in_stock", "out_of_stock", "negative", "in_repair", "unlinked"]);
export const ProductSortSchema = z.object({
  by: z.enum(["name", "onHand", "coverageDays", "unitCost", "openAlerts", "linkedListings"]).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});
export const ProductListQuerySchema = ProductListInputSchema.extend({
  status: ProductStatusSchema.default("all"),
  hasAlerts: z.boolean().optional(),
  sort: ProductSortSchema.default({ by: "name", dir: "asc" }),
});
export type ProductListQuery = z.input<typeof ProductListQuerySchema>;

export const CreateProductWithStockSchema = CreateProductInputSchema.extend({
  initialStock: z.number().nonnegative().optional(),
  initialCost: z.number().nonnegative().optional(),
});

const toRow = (b: ProductBase, rates: Map<number, number | null>): ProductRow => {
  const rest: Omit<ProductBase, "createdAt"> & { createdAt?: Date } = { ...b };
  delete rest.createdAt;
  const dailyRate = rates.get(b.id) ?? null;
  return { ...rest, dailyRate, coverageDays: dailyRate && dailyRate > 0 ? Math.max(0, b.onHand) / dailyRate : null };
};

async function rowsOf(accountId: string, bases: ProductBase[]): Promise<ProductRow[]> {
  const rates = await getStockServices().dailyRates(accountId, bases.map((b) => b.id));
  return bases.map((b) => toRow(b, rates));
}

const matchesStatus = (r: ProductRow, s: z.infer<typeof ProductStatusSchema>): boolean =>
  s === "all" ? true
  : s === "in_stock" ? r.onHand > 0
  : s === "out_of_stock" ? r.onHand === 0
  : s === "negative" ? r.onHand < 0
  : s === "in_repair" ? r.inRepair > 0
  : r.linkedListings === 0;

export const stockProductsRouter = createTRPCRouter({
  list: linkedProcedure.input(ProductListQuerySchema.default({})).query(async ({ ctx, input }): Promise<ProductRow[]> => {
    const rows = (await rowsOf(ctx.userId, await listProductBases(ctx.userId, input)))
      .filter((r) => matchesStatus(r, input.status) && (input.hasAlerts === undefined || (r.openAlerts > 0) === input.hasAlerts));
    const { by, dir } = input.sort;
    const sign = dir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      if (by === "name") return sign * a.name.localeCompare(b.name, "es");
      const x = a[by], y = b[by];
      if (x === null && y === null) return 0;
      if (x === null) return 1; // unknown coverage always last
      if (y === null) return -1;
      return sign * (x - y);
    });
  }),

  get: linkedProcedure.input(z.object({ productId: z.number().int().positive() })).query(async ({ ctx, input }): Promise<ProductDetail> => {
    const base = await getProductBase(ctx.userId, input.productId);
    if (!base) throw new TRPCError({ code: "NOT_FOUND", message: "PRODUCT_NOT_FOUND" });
    const [[product], listings, recentMovs, costs]: [ProductRow[], LinkedListing[], MovementRow[], CostEntryRow[]] = await Promise.all([
      rowsOf(ctx.userId, [base]), linkedListingsOfProduct(ctx.userId, input.productId),
      recentMovements(ctx.userId, input.productId, 50), costHistory(ctx.userId, input.productId),
    ]);
    return { product: product!, listings, recentMovements: recentMovs, costHistory: costs };
  }),

  create: linkedProcedure.input(CreateProductWithStockSchema).mutation(({ ctx, input }): Promise<{ productId: number }> =>
    guard(async () => ({ productId: (await createProductWithStock(ctx.userId, input)).id }))),

  /** Only name, category and minUnits are editable by hand. */
  update: linkedProcedure
    .input(z.object({
      productId: z.number().int().positive(),
      name: z.string().min(1).max(300).optional(),
      category: z.string().max(100).optional(),
      minUnits: z.number().nonnegative().nullable().optional(),
    }).strict())
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      const { productId, ...patch } = input;
      if (!(await updateProduct(ctx.userId, productId, patch))) throw new TRPCError({ code: "NOT_FOUND", message: "PRODUCT_NOT_FOUND" });
      return { ok: true };
    }),

  adjustStock: linkedProcedure.input(ManualAdjustInputSchema).mutation(({ ctx, input }): Promise<{ onHand: number }> =>
    guard(async () => {
      const r = await getStockServices().ledger.appendMovement({
        accountId: ctx.userId, productId: input.productId, type: "manual_adjust", quantity: input.delta,
        occurredAt: new Date(), idempotencyKey: `adjust:${input.idempotencyKey}`, reason: input.reason, actor: "user",
      });
      return { onHand: Number(r.onHandAfter) };
    })),

  /**
   * Manual cost (alerts `missing_cost` / "Editar costo"). Goes through the ledger's cost-entry path
   * (`setManualCost`, reason "manual"); stock is never touched. Then applies the sales parked for lack of a cost.
   */
  setCost: linkedProcedure
    .input(z.object({ productId: z.number().int().positive(), unitCost: z.number().nonnegative(), note: z.string().max(300).optional() }).strict())
    .mutation(({ ctx, input }): Promise<{ unitCost: number; changed: boolean; salesApplied: number }> =>
      guard(async () => {
        const r = await setManualCost({
          accountId: ctx.userId, productId: input.productId, unitCost: input.unitCost, occurredAt: new Date(), note: input.note,
        });
        let salesApplied = 0;
        for (const l of await linkedListingsOfProduct(ctx.userId, input.productId)) {
          // the cost is saved either way; a failure here is picked up by the next reconcile
          salesApplied += await applyPendingForListing(ctx.userId, l.itemId, l.variationId).catch((e) => {
            console.error("[stock] applying pending sales after setCost failed", e);
            return 0;
          });
        }
        return { unitCost: Number(r.unitCost), changed: r.changed, salesApplied };
      })),

  previewLink: linkedProcedure.input(LinkListingInputSchema).query(({ ctx, input }): Promise<LinkPlan> =>
    guard(async () => {
      assertV1Components(input.components);
      return linking.previewLink({ accountId: ctx.userId, ...input });
    })),

  link: linkedProcedure
    .input(LinkListingInputSchema.extend({ fillMissing: z.boolean().default(true) }))
    .mutation(({ ctx, input }): Promise<{ linkId: number; plan: LinkPlan }> =>
      guard(async () => {
        assertV1Components(input.components);
        const { fillMissing, ...args } = input;
        return linking.linkListing({ accountId: ctx.userId, ...args }, { fillMissing });
      })),

  unlink: linkedProcedure.input(z.object({ linkId: z.number().int().positive() })).mutation(({ ctx, input }): Promise<{ ok: true }> =>
    guard(async () => { await linking.unlinkListing(ctx.userId, input.linkId); return { ok: true as const }; })),

  autoLink: linkedProcedure.mutation(({ ctx }): Promise<{ linkIds: number[] }> => guard(() => linking.autoLink(ctx.userId))),

  unlinkedListings: linkedProcedure.query(({ ctx }): Promise<UnlinkedListing[]> => linking.unlinkedListings(ctx.userId)),
});
