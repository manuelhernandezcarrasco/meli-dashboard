import type { Base } from "~/lib/contracts";
import { normCat } from "~/lib/normalize";

/**
 * Fuzzy match between a Mercado Libre listing title and the products of the P&L base, for the
 * listings that have no usable SKU / EAN / GTIN. Pure and deterministic.
 *
 *  - "auto":    confident enough to use the cost without asking anyone.
 *  - "suggest": plausible, but a human should confirm before the cost is used.
 *  - null:      nothing close enough (or it conflicts on colour / model number / brand family).
 */
export interface MatchResult {
  ean: string;
  score: number;
  status: "auto" | "suggest";
}

export interface Matcher {
  match(title: string, itemId: string): MatchResult | null;
}

export const AUTO_SCORE = 0.88;
export const SUGGEST_SCORE = 0.6;
/** If the runner-up is this close to the winner the pick is ambiguous: ask instead of guessing. */
const AMBIGUITY_GAP = 0.08;

const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "para", "con", "y", "en", "un", "una", "por", "o",
  "original", "originales", "nuevo", "nueva", "oficial", "inalambrico", "inalambrica", "wireless",
  "bluetooth", "serie", "series", "pack", "envio", "gratis", "garantia", "microsoft", "generacion",
  "x1", "version",
]);

/** Spanish/English variants collapsed to one canonical token. */
const SYNONYMS: Record<string, string> = {
  controlador: "control", joystick: "control", mando: "control", gamepad: "control",
  consola: "consola", console: "consola",
  azul: "blue", negro: "black", negra: "black", blanco: "white", blanca: "white",
  rojo: "red", roja: "red", verde: "green", gris: "gray", grey: "gray", rosa: "pink",
  violeta: "purple", morado: "purple", purpura: "purple", amarillo: "yellow",
  naranja: "orange", celeste: "cyan", dorado: "gold", plateado: "silver",
  auricular: "headset", auriculares: "headset", headphones: "headset", headset: "headset",
  teclado: "keyboard", camara: "camera", cargador: "charger",
};

const COLORS = new Set([
  "blue", "black", "white", "red", "green", "gray", "pink", "purple", "yellow", "orange",
  "cyan", "gold", "silver",
]);

type Family = "xbox" | "sony" | "bosch" | "vino";

const FAMILY_OF_CAT: Record<string, Family> = {
  XBOX: "xbox", SONY: "sony", "PLAY STATION": "sony", BOSCH: "bosch", VINOS: "vino",
};

function familyOfTokens(tokens: Set<string>): Family | null {
  if (tokens.has("xbox")) return "xbox";
  for (const t of tokens) if (/^ps\d?$/.test(t) || t === "dualsense" || t === "dualshock") return "sony";
  if (tokens.has("playstation") || tokens.has("sony")) return "sony";
  if (tokens.has("bosch")) return "bosch";
  for (const t of ["malbec", "cabernet", "vino", "tinto", "blend", "syrah"]) if (tokens.has(t)) return "vino";
  return null;
}

export function tokenize(text: string): Set<string> {
  let s = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  s = s
    .replace(/\bx\s*[|/]\s*s\b/g, " xs ") // "X|S", "X/S"
    .replace(/\bplay\s*station\s*(\d)/g, " ps$1 ")
    .replace(/\bps\s+(\d)\b/g, " ps$1 ")
    .replace(/(\d+)\s*(gb|tb|mb|ml|cl|lt|l)\b/g, " $1$2 ");
  const out = new Set<string>();
  for (let t of s.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    t = SYNONYMS[t] ?? t;
    if (t.length > 3 && t.endsWith("s") && !/\d/.test(t)) t = t.slice(0, -1); // crude plural
    t = SYNONYMS[t] ?? t;
    if (STOPWORDS.has(t) || t.length < 2 && !/\d/.test(t)) continue;
    out.add(t);
  }
  return out;
}

const hasDigit = (t: string) => /\d/.test(t);

interface Candidate {
  ean: string;
  family: Family | null;
  forms: Set<string>[]; // alternative token sets (description, description + model)
}

function candidatesOf(base: Base): Candidate[] {
  const out: Candidate[] = [];
  for (const b of Object.values(base)) {
    const desc = tokenize(b.desc);
    const forms: Set<string>[] = [];
    if (desc.size) forms.push(desc);
    const withModel = tokenize(`${b.desc} ${b.modelo}`);
    if (withModel.size > desc.size) forms.push(withModel);
    const model = tokenize(b.modelo);
    if (model.size >= 2) forms.push(model);
    if (!forms.length) continue;
    out.push({
      ean: b.ean,
      family: FAMILY_OF_CAT[normCat(b.cat)] ?? familyOfTokens(desc),
      forms,
    });
  }
  return out;
}

/** Score of one candidate form against the listing tokens, or null when they conflict. */
function scoreForm(form: Set<string>, title: Set<string>): { score: number; shared: number } | null {
  let shared = 0;
  for (const t of form) if (title.has(t)) shared++;
  if (!shared) return null;

  const formColors = [...form].filter((t) => COLORS.has(t));
  const titleColors = [...title].filter((t) => COLORS.has(t));
  if (formColors.length && titleColors.length && !formColors.some((c) => title.has(c))) return null;

  const formNums = [...form].filter(hasDigit);
  const titleNums = [...title].filter(hasDigit);
  if (formNums.length && titleNums.length && !formNums.some((n) => title.has(n))) return null; // ps4 vs ps5, 825gb vs 1tb

  const containment = shared / form.size; // how much of the P&L product the title mentions
  const coverage = shared / title.size; // how much of the title the product explains
  let score = 0.75 * containment + 0.25 * Math.sqrt(coverage);
  if (formNums.some((n) => !title.has(n))) score *= 0.6; // the model number is missing from the listing
  return { score, shared };
}

/**
 * @param rejected itemId -> EANs a person already said are NOT the same product.
 */
export function createMatcher(base: Base, rejected: Record<string, string[]> = {}): Matcher {
  const cands = candidatesOf(base);
  const cache = new Map<string, MatchResult | null>();

  return {
    match(title, itemId) {
      const key = `${itemId}\u0000${title}`;
      if (cache.has(key)) return cache.get(key)!;
      const t = tokenize(title);
      const banned = new Set(rejected[itemId] ?? []);
      const fam = familyOfTokens(t);

      const scored: { ean: string; score: number; shared: number; size: number }[] = [];
      for (const c of cands) {
        if (banned.has(c.ean)) continue;
        if (fam && c.family && fam !== c.family) continue;
        let best: { score: number; shared: number; size: number } | null = null;
        for (const f of c.forms) {
          const r = scoreForm(f, t);
          if (r && (!best || r.score > best.score)) best = { ...r, size: f.size };
        }
        if (best) scored.push({ ean: c.ean, ...best });
      }
      scored.sort((a, b) => b.score - a.score);

      let res: MatchResult | null = null;
      const top = scored[0];
      if (top && top.score >= SUGGEST_SCORE) {
        const gap = top.score - (scored[1]?.score ?? 0);
        const confident = top.score >= AUTO_SCORE && top.shared >= 2 && top.size >= 2 && gap >= AMBIGUITY_GAP;
        res = {
          ean: top.ean,
          score: Math.round(top.score * 100) / 100,
          status: confident ? "auto" : "suggest",
        };
      }
      cache.set(key, res);
      return res;
    },
  };
}
