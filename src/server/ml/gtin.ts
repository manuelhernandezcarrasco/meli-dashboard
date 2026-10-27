import { normEan } from "~/lib/normalize";

/** Port of `gtin_from_attrs`: first GTIN/EAN/UPC value (before any comma), normalized. */
export function gtinFromAttrs(
  attrs: { id?: string; value_name?: string | null }[] | null | undefined,
): string {
  for (const a of attrs ?? []) {
    if (a.id === "GTIN" || a.id === "EAN" || a.id === "UPC") {
      const v = (a.value_name ?? "").split(",")[0]!.trim();
      if (v) return normEan(v);
    }
  }
  return "";
}
