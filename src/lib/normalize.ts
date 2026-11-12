export const CATEGORIAS = [
  "SONY",
  "PLAY STATION",
  "XBOX",
  "BOSCH",
  "VINOS",
  "ONFAN",
  "OTRAS",
] as const;

export function normEan(x: unknown): string {
  if (x === null || x === undefined) return "";
  const s = String(x).trim();
  if (!s) return "";
  if (/^\d+(\.0+)?$/.test(s) || /^\d+(\.\d+)?[eE]\+?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return BigInt(Math.trunc(n)).toString();
  }
  return s;
}

export function normHdr(x: unknown): string {
  let s = String(x ?? "")
    .trim()
    .toLowerCase();
  for (const [a, b] of [
    ["á", "a"],
    ["é", "e"],
    ["í", "i"],
    ["ó", "o"],
    ["ú", "u"],
  ] as const) {
    s = s.split(a).join(b);
  }
  return s.replace(/[^a-z0-9%]/g, "");
}

export function toNum(x: unknown, dflt = 0): number {
  if (x === null || x === undefined || x === "") return dflt;
  if (typeof x === "number") return x;
  let s = String(x).replace(/\$/g, "").replace(/ /g, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return s !== "" && Number.isFinite(n) ? n : dflt;
}

/** Accepts 0.15, 15, "15%". Returns null if empty/unparseable. */
export function toPct(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const v =
    typeof x === "number"
      ? x
      : (() => {
          const n = toNum(String(x).replace(/%/g, ""), Number.NaN);
          return Number.isNaN(n) ? null : n;
        })();
  if (v === null) return null;
  return v > 1 ? v / 100 : v;
}

export function normCat(x: unknown): string {
  let s = String(x ?? "")
    .trim()
    .toUpperCase();
  s = s.replace(/PLAYSTATION/g, "PLAY STATION");
  if ((CATEGORIAS as readonly string[]).includes(s)) return s;
  for (const c of CATEGORIAS) if (s.includes(c)) return c;
  return s || "OTRAS";
}

/** Lowercase + strip accents, so "Cámara" matches "camara". Mirrors `norm_text` in the 20261112000000 migration. */
export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().trim();
}
