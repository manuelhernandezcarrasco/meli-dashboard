import type { PaymentTaxes } from "~/lib/contracts";
import { toNum } from "~/lib/normalize";

interface Charge {
  type?: unknown;
  name?: unknown;
  accounts?: { from?: unknown } | null;
  amounts?: { original?: unknown; refunded?: unknown } | null;
}

/** Port of `taxes_from_payment`: tax charges billed to the seller, null if no detail. */
export function taxesFromPayment(p: {
  charges_details?: Charge[] | null;
  fee_details?: { type?: unknown; amount?: unknown }[] | null;
}): PaymentTaxes | null {
  const det: Record<string, number> = {};
  const charges = p.charges_details;
  if (charges === null || charges === undefined) return null;
  for (const ch of charges) {
    if (String(ch.type ?? "").toLowerCase() !== "tax") continue;
    const from = String(ch.accounts?.from || "collector").toLowerCase();
    if (from !== "collector" && from !== "seller") continue;
    const v = toNum(ch.amounts?.original) - toNum(ch.amounts?.refunded);
    if (v) {
      const name = String(ch.name || "impuesto");
      det[name] = (det[name] ?? 0) + v;
    }
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let financing = 0;
  for (const f of p.fee_details ?? []) {
    if (String(f.type ?? "").toLowerCase() === "financing_fee") financing += toNum(f.amount);
  }
  if (!financing) {
    for (const ch of charges) {
      const n = String(ch.name ?? "").toLowerCase();
      if (n === "financing_fee" || n === "financing_add_on_fee") {
        financing += toNum(ch.amounts?.original) - toNum(ch.amounts?.refunded);
      }
    }
  }
  return {
    financing: round2(financing),
    total: round2(Object.values(det).reduce((a, b) => a + b, 0)),
    det: Object.fromEntries(Object.entries(det).map(([k, v]) => [k, round2(v)])),
  };
}
