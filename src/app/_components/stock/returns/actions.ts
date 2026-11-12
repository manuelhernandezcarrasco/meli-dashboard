import type { ReturnOutcome } from "~/lib/stock-contracts";

export type ReturnAction = "lost" | "in_repair" | "restocked";

export const OUTCOME_LABEL: Record<ReturnOutcome, string> = {
  pending: "Pendiente",
  lost: "Perdido",
  in_repair: "En reparación",
  restocked: "Reingresado",
};

export const OUTCOME_ORDER: ReturnOutcome[] = ["pending", "in_repair", "lost", "restocked"];
export const DEFAULT_FILTER: ReturnOutcome[] = ["pending", "in_repair"];

export const ACTION_LABEL: Record<ReturnAction, string> = {
  lost: "Perdido",
  in_repair: "A reparación",
  restocked: "Reingresar al stock",
};

/** Mirrors the server state machine; final states (lost, restocked) offer nothing. */
export function allowedActions(outcome: ReturnOutcome): ReturnAction[] {
  if (outcome === "pending") return ["lost", "in_repair", "restocked"];
  if (outcome === "in_repair") return ["restocked", "lost"];
  return [];
}

export function confirmText(action: ReturnAction, quantity: number): string {
  if (action === "restocked") return `Se suma +${quantity} al stock disponible.`;
  if (action === "in_repair") return "La unidad no se puede vender y queda en «en reparación».";
  return "La unidad se da por perdida. No cambia el stock disponible.";
}
