/** Argentine number format helpers: `1.234,56` -> 1234.56. Pure. */

const AR_NUMBER = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;

/** True when `raw` is a well-formed Argentine decimal (dot thousands, comma decimals, optional minus). */
export function isArNumber(raw: string): boolean {
  return AR_NUMBER.test(raw.trim().replace(/^\$\s*/, ""));
}

/** Parses an Argentine-formatted number. Throws on anything malformed (never guesses). */
export function parseArNumber(raw: string): number {
  const s = raw.trim().replace(/^\$\s*/, "");
  if (!AR_NUMBER.test(s)) throw new Error(`Número inválido: "${raw}"`);
  return Number(s.replace(/\./g, "").replace(",", "."));
}

/** Like `parseArNumber` but returns null instead of throwing. */
export function tryParseArNumber(raw: string): number | null {
  return isArNumber(raw) ? parseArNumber(raw) : null;
}

/** Rounds to 2 decimals, avoiding float noise in sums. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
