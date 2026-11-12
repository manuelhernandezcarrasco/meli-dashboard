export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type UploadResult =
  | { ok: true; invoiceId: number }
  | { ok: false; message: string; existingInvoiceId?: number };

/** Client-side checks that mirror the server (PDF only, ≤ 10 MB). Returns a Spanish message or null. */
export function validatePdf(file: { name: string; type: string; size: number }): string | null {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return "El archivo tiene que ser un PDF.";
  if (file.size === 0) return "El archivo está vacío.";
  if (file.size > MAX_PDF_BYTES) return "El PDF supera el máximo de 10 MB.";
  return null;
}

interface UploadBody {
  invoiceId?: number;
  error?: string;
  code?: string;
  existingInvoiceId?: number;
}

/** POST /api/invoices/upload (S9). 409 carries `existingInvoiceId` for the duplicate link. */
export async function uploadInvoice(file: File, fetchImpl: typeof fetch = fetch): Promise<UploadResult> {
  const invalid = validatePdf(file);
  if (invalid) return { ok: false, message: invalid };
  try {
    const body = new FormData();
    body.set("file", file);
    const r = await fetchImpl("/api/invoices/upload", { method: "POST", body });
    const j = (await r.json().catch(() => ({}))) as UploadBody;
    if (r.ok && typeof j.invoiceId === "number") return { ok: true, invoiceId: j.invoiceId };
    if (r.status === 409 || j.existingInvoiceId != null) {
      return {
        ok: false,
        existingInvoiceId: j.existingInvoiceId,
        message: "Esta factura ya fue cargada (mismo CUIT y número).",
      };
    }
    if (r.status === 413) return { ok: false, message: "El PDF supera el máximo de 10 MB." };
    if (r.status === 422 && /texto|text/i.test(j.error ?? "")) {
      return { ok: false, message: "Este PDF no tiene texto (parece un escaneo). Subí el PDF original del proveedor." };
    }
    return { ok: false, message: j.error ?? "No se pudo leer la factura. Revisá que sea un PDF del proveedor." };
  } catch {
    return { ok: false, message: "No se pudo subir el archivo. Revisá tu conexión e intentá de nuevo." };
  }
}
