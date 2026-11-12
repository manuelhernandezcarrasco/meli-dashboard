import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { StockError } from "~/server/stock/contracts";
import { DuplicateInvoiceError, getInvoiceService } from "~/server/stock/invoices";
import { InvoiceParseError, ScannedPdfError } from "~/server/invoices/parse";

export const runtime = "nodejs";

export const MAX_INVOICE_BYTES = 10 * 1024 * 1024;

const err = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: message, ...extra }, { status });

/** `%PDF` */
const looksLikePdf = (b: Buffer) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

/** multipart/form-data: `file` (.pdf, ≤ 10 MB). Creates a draft; nothing touches stock. The file is not kept. */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return err("No autenticado", 401);

  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_INVOICE_BYTES + 64 * 1024) return err("El archivo supera 10 MB", 413);

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return err("Falta el archivo", 400);
  if (file.size > MAX_INVOICE_BYTES) return err("El archivo supera 10 MB", 413);
  if (!file.name.toLowerCase().endsWith(".pdf")) return err("Solo se aceptan archivos .pdf", 400);

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!looksLikePdf(buffer)) return err("El archivo no es un PDF válido", 400);

  try {
    const { invoiceId, warnings } = await getInvoiceService().createDraft(userId, { name: file.name, buffer });
    return NextResponse.json({ invoiceId, warnings });
  } catch (e) {
    if (e instanceof DuplicateInvoiceError) {
      return err(e.message, 409, { existingInvoiceId: e.existingInvoiceId, link: `/stock?tab=invoices&invoice=${e.existingInvoiceId}` });
    }
    if (e instanceof InvoiceParseError || e instanceof ScannedPdfError) return err(e.message, 422);
    if (e instanceof StockError) return err(e.message, 422);
    throw e;
  }
}
