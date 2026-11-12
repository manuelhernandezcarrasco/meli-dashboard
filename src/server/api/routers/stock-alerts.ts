import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  AlertListInputSchema, type AlertRow, type AlertSummary, type AlertType,
} from "~/lib/stock-contracts";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { getSyncService, saveDecision } from "~/server/sync";
import { acknowledgeAlert, resolutionForm, resolveAlert, resolveAlertById, type FormSpec } from "~/server/stock/alerts";
import { countAlerts, getAlert, listAlerts, type StoredAlert } from "~/server/store/stockAlerts";

const toRow = (a: StoredAlert): AlertRow => ({
  id: a.id, type: a.type, status: a.status, productId: a.productId, productName: a.productName,
  marketplace: a.marketplace, itemId: a.itemId, dedupeKey: a.dedupeKey, title: a.title, detail: a.detail,
  quantity: a.quantity, amount: a.amount, createdAt: a.createdAt.toISOString(),
  acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null, resolvedAt: a.resolvedAt?.toISOString() ?? null,
  resolution: a.resolution,
});

const alertId = z.object({ id: z.number().int().positive() });

/** Stock - alerts: list, counts for the dashboard badge, acknowledge / resolve and match decisions. */
export const stockAlertsRouter = createTRPCRouter({
  list: protectedProcedure
    .input(AlertListInputSchema.extend({ productId: z.number().int().positive().optional() }).default({ status: ["open", "acknowledged"] }))
    .query(async ({ ctx, input }): Promise<AlertRow[]> =>
      (await listAlerts(ctx.userId, input)).map(toRow)),

  /** Non-resolved alerts: by type, `open` (not yet acknowledged) and `total`. */
  counts: protectedProcedure.query(async ({ ctx }): Promise<AlertSummary & { byType: Partial<Record<AlertType, number>> }> => {
    const { byType, open, total } = await countAlerts(ctx.userId);
    return { open, total, byType };
  }),

  acknowledge: protectedProcedure.input(alertId).mutation(async ({ ctx, input }) => {
    if (!(await getAlert(ctx.userId, input.id))) throw new TRPCError({ code: "NOT_FOUND" });
    await acknowledgeAlert(ctx.userId, input.id);
  }),

  resolve: protectedProcedure
    .input(alertId.extend({ resolution: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      if (!(await getAlert(ctx.userId, input.id))) throw new TRPCError({ code: "NOT_FOUND" });
      await resolveAlertById(ctx.userId, input.id, input.resolution);
    }),

  /** The form to resolve an alert that needs data; null for alerts without one. */
  form: protectedProcedure.input(alertId).query(async ({ ctx, input }): Promise<FormSpec | null> => {
    const a = await getAlert(ctx.userId, input.id);
    if (!a) throw new TRPCError({ code: "NOT_FOUND" });
    return resolutionForm(a);
  }),

  /** confirm / reject a suggested match; confirm / undo an automatic one. Resolves the alert. */
  decideMatch: protectedProcedure
    .input(alertId.extend({ decision: z.enum(["confirm", "reject", "undo"]) }))
    .mutation(async ({ ctx, input }) => {
      const a = await getAlert(ctx.userId, input.id);
      if (!a) throw new TRPCError({ code: "NOT_FOUND" });
      if ((a.type !== "suggested_match" && a.type !== "auto_match") || !a.itemId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "NOT_A_MATCH_ALERT" });
      }
      const ean = a.dedupeKey.split(":")[2]; // suggested_match:<itemId>:<ean>
      if (!ean) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MATCH_EAN_UNKNOWN" });
      await saveDecision(ctx.userId, a.itemId, ean, input.decision === "confirm" ? "confirmed" : "rejected");
      await resolveAlert(ctx.userId, a.dedupeKey, input.decision === "confirm" ? "confirmed" : "rejected");
      await getSyncService(ctx.userId).recompute(); // same as the dashboard's own decideMatch
    }),
});
