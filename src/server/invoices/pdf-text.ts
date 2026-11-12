import { getDocumentProxy } from "unpdf";

/** The PDF has no text layer (scanned image). OCR is out of scope in v1. */
export class ScannedPdfError extends Error {
  constructor() {
    super(
      "El PDF no tiene capa de texto (parece escaneado). Subí el PDF original de la factura, no una foto o escaneo.",
    );
    this.name = "ScannedPdfError";
  }
}

/** A run of text that sits together on a row (items closer than CELL_GAP). */
export interface Cell {
  x: number;
  text: string;
}

/** One visual row of a page, top to bottom. */
export interface Row {
  y: number;
  cells: Cell[];
  /** Cells joined with single spaces. */
  text: string;
}

export interface PdfPage {
  number: number;
  rows: Row[];
}

const ROW_TOLERANCE = 3;
const CELL_GAP = 12;

interface RawItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

function buildRows(items: RawItem[]): Row[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: RawItem[][] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0]!.y - it.y) <= ROW_TOLERANCE) g.push(it);
    else groups.push([it]);
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    let prevEnd = -Infinity;
    for (const it of g) {
      const last = cells[cells.length - 1];
      if (last && it.x - prevEnd < CELL_GAP) {
        last.text += (it.x - prevEnd > 1 ? " " : "") + it.str.trim();
      } else {
        cells.push({ x: it.x, text: it.str.trim() });
      }
      prevEnd = it.x + it.width;
    }
    return { y: g[0]!.y, cells, text: cells.map((c) => c.text).join(" ") };
  });
}

/** Extracts positioned text rows per page. Throws `ScannedPdfError` when no page has any text. */
export async function extractPdfPages(buffer: Buffer): Promise<PdfPage[]> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch {
    throw new Error("No se pudo leer el archivo: no es un PDF válido.");
  }
  const pages: PdfPage[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items: RawItem[] = [];
    for (const it of content.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      items.push({ str: it.str, x: it.transform[4]!, y: it.transform[5]!, width: it.width });
    }
    pages.push({ number: n, rows: buildRows(items) });
  }
  if (pages.every((p) => p.rows.length === 0)) throw new ScannedPdfError();
  return pages;
}
