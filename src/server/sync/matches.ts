import type { Inputs } from "~/lib/contracts";
import { db } from "~/server/db";

export interface MatchDecisions {
  /** itemId -> EAN a person confirmed */
  confirmed: Record<string, string>;
  /** itemId -> EANs a person rejected */
  rejected: Record<string, string[]>;
}

export async function loadDecisions(ownerId: string): Promise<MatchDecisions> {
  const rows = await db.matchDecision.findMany({ where: { ownerId }, orderBy: { decidedAt: "asc" } });
  const out: MatchDecisions = { confirmed: {}, rejected: {} };
  for (const r of rows) {
    const id = r.itemId.toUpperCase();
    if (r.decision === "confirmed") out.confirmed[id] = r.ean;
    else (out.rejected[id] ??= []).push(r.ean);
  }
  return out;
}

/** Confirmed matches act like “Mapeo ML” rows (the Excel mapping still wins when both exist). */
export function withConfirmed(inputs: Inputs, d: MatchDecisions): Inputs {
  return { ...inputs, mapItem: { ...d.confirmed, ...inputs.mapItem } };
}

export async function saveDecision(
  ownerId: string,
  itemId: string,
  ean: string,
  decision: "confirmed" | "rejected",
): Promise<void> {
  const id = itemId.toUpperCase();
  await db.$transaction([
    // one confirmed EAN per listing; a new confirmation replaces the old one
    ...(decision === "confirmed"
      ? [db.matchDecision.deleteMany({ where: { ownerId, itemId: id, decision: "confirmed" } })]
      : []),
    db.matchDecision.upsert({
      where: { ownerId_itemId_ean: { ownerId, itemId: id, ean } },
      create: { ownerId, itemId: id, ean, decision },
      update: { decision, decidedAt: new Date() },
    }),
  ]);
}
