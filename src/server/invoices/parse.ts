import { normEan } from "~/lib/normalize";
import type { ParsedInvoice, ParsedInvoiceLine } from "~/lib/stock-contracts";
import { round2, tryParseArNumber } from "./numbers";
import { extractPdfPages, ScannedPdfError, type PdfPage, type Row } from "./pdf-text";

export { ScannedPdfError };

/** The PDF has text but we could not read a usable invoice from it. Message is user-facing (es-AR). */
export class InvoiceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceParseError";
  }
}

const TOLERANCE = 0.05;

// ---------------------------------------------------------------------------
// EAN helpers
// ---------------------------------------------------------------------------

function gtin13CheckOk(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/** "027242925489" (UPC-12) -> "0027242925489". Returns null when it is not a valid GTIN-13 after padding. */
export function normalizeGtin(printed: string | null | undefined): string | null {
  if (!printed) return null;
  const digits = normEan(printed.replace(/\s+/g, ""));
  if (!/^\d+$/.test(digits) || digits.length > 13) return null;
  const padded = digits.padStart(13, "0");
  return gtin13CheckOk(padded) ? padded : null;
}

// ---------------------------------------------------------------------------
// Supplier layouts. Add a new one by implementing SupplierLayout and listing it in LAYOUTS.
// ---------------------------------------------------------------------------

interface SupplierLayout {
  name: string;
  /** Cheap detection on the header text of the first page. */
  detect(pages: PdfPage[]): boolean;
  parse(pages: PdfPage[]): ParsedInvoice;
}

const MONEY = String.raw`-?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}`;
const MONEY_RE = new RegExp(`^${MONEY}$`);

function allRows(pages: PdfPage[]): Row[] {
  return pages.flatMap((p) => p.rows);
}

function moneyIn(text: string): number[] {
  return (text.match(new RegExp(MONEY, "g")) ?? []).map((m) => tryParseArNumber(m)!);
}

function fail(what: string): never {
  throw new InvoiceParseError(`No se pudo leer la factura: falta ${what}.`);
}

const sonyLayout: SupplierLayout = {
  name: "Sony Argentina",
  detect: (pages) => /sony argentina/i.test(pages[0]?.rows.map((r) => r.text).join("\n") ?? ""),

  parse(pages) {
    const rows = allRows(pages);
    const first = pages[0]!.rows;
    const warnings: string[] = [];
    const text = first.map((r) => r.text).join("\n");

    // Header -----------------------------------------------------------
    const number = /(\d{4}-\d{8})/.exec(text)?.[1] ?? fail("el número de comprobante");
    const date = /FECHA:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
    if (!date) fail("la fecha");
    const issueDate = `${date[3]}-${date[2]}-${date[1]}`;
    const supplierTaxId = /CUIT\s*N[º°o]?:?\s*(\d{11})/i.exec(text)?.[1] ?? fail("el CUIT del proveedor");
    const supplierName =
      first.flatMap((r) => r.cells).find((c) => c.x < 150 && /[a-z]{3}/i.test(c.text))?.text ?? fail("el proveedor");
    // Buyer: the CUIT column of the "CODIGO DE CUENTA ... CUIT" strip (first 11-digit id that is not the supplier's).
    const buyerHeader = first.findIndex((r) => /CODIGO DE CUENTA/i.test(r.text));
    const buyerTaxId = first
      .slice(buyerHeader + 1, buyerHeader + 3)
      .flatMap((r) => r.text.match(/\b\d{11}\b/g) ?? [])
      .find((id) => id !== supplierTaxId);
    if (!buyerTaxId) warnings.push("No se encontró el CUIT del comprador.");

    // Lines ------------------------------------------------------------
    const lines: ParsedInvoiceLine[] = [];
    for (const page of pages) {
      const start = page.rows.findIndex((r) => /CANTIDAD/.test(r.text));
      if (start < 0) continue;
      const body = page.rows.slice(start + 1);
      const end = body.findIndex((r) => /^(Subtotal|SON PESOS|TOTAL)/i.test(r.text));
      const table = end < 0 ? body : body.slice(0, end);
      for (let i = 0; i < table.length; i++) {
        const row = table[i]!;
        const head = /^(\d+)\s+(\d{4,})\s+(.+)$/.exec(row.text);
        if (!head) {
          if (!/^(Origen|Den\.|DESCRIPCION|CODIGO)/i.test(row.text)) {
            warnings.push(`Fila de detalle sin interpretar: "${row.text}"`);
          }
          continue;
        }
        const next = table[i + 1];
        const priced = next
          ? new RegExp(`^(?:(\\d[\\d ]{6,})\\s+)?(${MONEY})\\s+(${MONEY})\\s+(${MONEY})\\s+(${MONEY})$`).exec(next.text)
          : null;
        if (!priced) {
          warnings.push(`Línea ${lines.length + 1} (${head[2]}): no se encontraron los importes.`);
          continue;
        }
        i++;
        const lineNo = lines.length + 1;
        const printedEan = priced[1]?.trim() ?? null;
        const ean = normalizeGtin(printedEan);
        if (printedEan && !ean) warnings.push(`Línea ${lineNo}: el EAN "${printedEan}" no es un GTIN válido.`);
        const quantity = Number(head[1]);
        const unitPrice = tryParseArNumber(priced[2]!)!;
        const discount = tryParseArNumber(priced[4]!)!;
        const lineSubtotal = tryParseArNumber(priced[5]!)!;
        if (Math.abs(quantity * unitPrice - discount - lineSubtotal) > TOLERANCE) {
          warnings.push(`Línea ${lineNo}: cantidad × precio − descuento no coincide con el subtotal de la línea.`);
        }
        lines.push({
          lineNo,
          supplierCode: head[2]!,
          ean,
          description: head[3]!.trim(),
          quantity,
          unitPrice,
          discount,
          lineSubtotal,
        });
      }
    }
    if (lines.length === 0) throw new InvoiceParseError("No se encontraron líneas de producto en la factura.");

    // Totals -----------------------------------------------------------
    const subtotalRow = rows.find((r) => /^Subtotal/i.test(r.text) && moneyIn(r.text).length > 0);
    const subtotal = subtotalRow ? moneyIn(subtotalRow.text).at(-1)! : fail("el subtotal");

    const totalIdx = rows.findIndex((r) => /TOTAL PESOS/.test(r.text));
    const totalRows = totalIdx < 0 ? [] : [rows[totalIdx]!, rows[totalIdx + 1]];
    const total = totalRows.map((r) => (r ? moneyIn(r.text).at(-1) : undefined)).find((v) => v !== undefined);
    if (total === undefined) throw new InvoiceParseError("No se pudo leer el total de la factura.");

    // Tax block: a row of labels containing "%" with the amounts on the row right below, in the same order.
    let ivaAmount = 0;
    let perceptionsAmount = 0;
    let otherTaxesAmount = 0;
    for (const page of pages) {
      const idx = page.rows.findIndex((r) => r.cells.some((c) => /%/.test(c.text) && /^(Perc|IVA|Imp|IIBB)/i.test(c.text)));
      if (idx < 0) continue;
      const labels = page.rows[idx]!.cells.map((c) => c.text);
      const amounts = (page.rows[idx + 1]?.cells ?? []).map((c) => c.text).filter((t) => MONEY_RE.test(t));
      if (labels.length !== amounts.length) {
        warnings.push("No se pudieron asociar los impuestos con sus importes.");
        continue;
      }
      labels.forEach((label, k) => {
        const amount = tryParseArNumber(amounts[k]!)!;
        if (/^IVA/i.test(label)) ivaAmount += amount;
        else if (/^Perc/i.test(label)) perceptionsAmount += amount;
        else otherTaxesAmount += amount;
      });
      break;
    }

    // Validation -------------------------------------------------------
    const linesSum = round2(lines.reduce((s, l) => s + l.lineSubtotal, 0));
    if (Math.abs(linesSum - subtotal) > TOLERANCE) {
      warnings.push(`La suma de las líneas (${linesSum}) no coincide con el subtotal (${subtotal}).`);
    }
    const expectedTotal = round2(subtotal + ivaAmount + perceptionsAmount + otherTaxesAmount);
    if (Math.abs(expectedTotal - total) > TOLERANCE) {
      warnings.push(`Subtotal + impuestos (${expectedTotal}) no coincide con el total (${total}).`);
    }

    return {
      supplierName,
      supplierTaxId,
      number,
      issueDate,
      currency: "ARS",
      subtotal,
      ivaAmount: round2(ivaAmount),
      perceptionsAmount: round2(perceptionsAmount),
      otherTaxesAmount: round2(otherTaxesAmount),
      total,
      lines,
      warnings,
    };
  },
};

const LAYOUTS: SupplierLayout[] = [sonyLayout];

/**
 * Parses a supplier invoice PDF (text layer required).
 * Throws `ScannedPdfError` (no text layer) or `InvoiceParseError` (unknown layout, no lines, no total).
 * Totals that do not add up are returned as `warnings`, not thrown.
 */
export async function parseInvoicePdf(buffer: Buffer): Promise<ParsedInvoice> {
  const pages = await extractPdfPages(buffer);
  const layout = LAYOUTS.find((l) => l.detect(pages));
  if (!layout) {
    throw new InvoiceParseError("No reconocemos el formato de esta factura. Por ahora solo se admiten facturas de Sony Argentina.");
  }
  return layout.parse(pages);
}
