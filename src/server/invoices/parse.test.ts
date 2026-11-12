import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InvoiceParseError, ScannedPdfError, normalizeGtin, parseInvoicePdf } from "./parse";
import { buildPdf, sonyLikePdf } from "./__fixtures__/build-pdf";

const sample = readFileSync(path.join(__dirname, "__fixtures__/sony-0225-00085935.pdf"));

describe("parseInvoicePdf — Sony sample", () => {
  it("yields exactly the expected header, lines and totals", async () => {
    const inv = await parseInvoicePdf(sample);
    expect(inv).toMatchObject({
      supplierName: "Sony Argentina S.A.",
      supplierTaxId: "30679928879",
      number: "0225-00085935",
      issueDate: "2026-08-28",
      currency: "ARS",
      subtotal: 10843892.71,
      ivaAmount: 2277217.47,
      perceptionsAmount: 650633.56,
      otherTaxesAmount: 0,
      total: 13771743.74,
      warnings: [],
    });
    expect(inv.lines.map((l) => [l.quantity, l.supplierCode, l.ean, l.description, l.unitPrice, l.discount, l.lineSubtotal])).toEqual([
      [58, "92484938", "0027242925489", "WH-CH520/CZ UC", 55095.86, 0, 3195559.88],
      [27, "92484939", "0027242932425", "WH-CH520/PZ UC", 55095.86, 0, 1487588.22],
      [20, "18061335", "0027242928688", "WHULT900N/BZUC", 200349.91, 0, 4006998.2],
      [30, "92484535", "0027242923638", "WI-C100/BZ UC", 35060.82, 0, 1051824.6],
      [5, "18063335", "0027242931770", "WF-C710N/BZ UC", 100174.71, 0, 500873.55],
      [6, "18063337", "0027242931817", "WF-C710N/LZ UC", 100174.71, 0, 601048.26],
    ]);
    expect(inv.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(inv.total / inv.subtotal).toBeCloseTo(1.27, 4);
  });
});

describe("normalizeGtin", () => {
  it("left-pads a 12-digit UPC to GTIN-13", () => {
    expect(normalizeGtin("027242925489")).toBe("0027242925489");
    expect(normalizeGtin("0 27242 92548 9")).toBe("0027242925489");
  });
  it("keeps a valid GTIN-13", () => {
    expect(normalizeGtin("7790895000782")).toBe("7790895000782");
  });
  it("returns null for bad check digit, garbage or empty", () => {
    expect(normalizeGtin("027242925488")).toBeNull();
    expect(normalizeGtin("abc")).toBeNull();
    expect(normalizeGtin("")).toBeNull();
    expect(normalizeGtin(null)).toBeNull();
  });
});

describe("parseInvoicePdf — synthetic fixtures", () => {
  it("parses a consistent synthetic invoice without warnings", async () => {
    const inv = await parseInvoicePdf(sonyLikePdf());
    expect(inv.total).toBe(254);
    expect(inv.perceptionsAmount).toBe(12);
    expect(inv.ivaAmount).toBe(42);
    expect(inv.warnings).toEqual([]);
  });

  it("returns a warning (does not throw) when totals do not add up", async () => {
    const inv = await parseInvoicePdf(sonyLikePdf({ total: "999,00" }));
    expect(inv.total).toBe(999);
    expect(inv.warnings.join(" ")).toMatch(/no coincide con el total/);
  });

  it("warns when the lines do not add up to the subtotal", async () => {
    const inv = await parseInvoicePdf(sonyLikePdf({ subtotal: "300,00", total: "354,00" }));
    expect(inv.warnings.join(" ")).toMatch(/suma de las líneas/);
  });

  it("throws InvoiceParseError (Spanish) when there are no lines", async () => {
    const err = await parseInvoicePdf(sonyLikePdf({ noLines: true })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceParseError);
    expect((err as Error).message).toMatch(/líneas/);
  });

  it("throws ScannedPdfError for a PDF without text layer", async () => {
    await expect(parseInvoicePdf(buildPdf([[]]))).rejects.toBeInstanceOf(ScannedPdfError);
  });

  it("throws InvoiceParseError for an unknown layout", async () => {
    const pdf = buildPdf([[{ x: 30, y: 700, text: "Otro Proveedor SA" }]]);
    await expect(parseInvoicePdf(pdf)).rejects.toBeInstanceOf(InvoiceParseError);
  });

  it("rejects non-PDF bytes with a readable error", async () => {
    await expect(parseInvoicePdf(Buffer.from("not a pdf"))).rejects.toThrow(/PDF/);
  });
});

describe("invoice parser purity", () => {
  it("imports no database or network modules", () => {
    const dir = __dirname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    const forbidden = /from\s+["'](?:@prisma\/|~\/server\/(?:db|store|ml)|node:(?:http|https|net|dns)|undici|axios)|\bfetch\(|PrismaClient/;
    for (const f of files) {
      expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(forbidden);
    }
  });
});
