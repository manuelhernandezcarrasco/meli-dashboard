import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSyncService } from "~/server/sync";
import { deleteUpload, listUploads, saveUpload } from "~/server/workbooks/store";
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_KINDS,
  looksLikeXlsx,
  type UploadKind,
} from "~/server/workbooks/upload";

export const runtime = "nodejs";

const asKind = (v: unknown): UploadKind | null =>
  UPLOAD_KINDS.find((k) => k === v) ?? null;

const err = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

export async function GET() {
  const { userId } = await auth();
  if (!userId) return err("No autenticado", 401);
  return NextResponse.json({ uploads: await listUploads(userId) });
}

/** multipart/form-data: `kind` ("pnl" | "inputs") + `file` (.xlsx) */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return err("No autenticado", 401);

  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) return err("El archivo supera 5 MB", 413);

  const form = await req.formData().catch(() => null);
  const kind = asKind(form?.get("kind"));
  const file = form?.get("file");
  if (!kind) return err("Tipo de archivo inválido", 400);
  if (!(file instanceof File)) return err("Falta el archivo", 400);
  if (file.size > MAX_UPLOAD_BYTES) return err("El archivo supera 5 MB", 413);
  if (!file.name.toLowerCase().endsWith(".xlsx")) return err("Solo se aceptan archivos .xlsx", 400);

  const buf = Buffer.from(await file.arrayBuffer());
  if (!looksLikeXlsx(buf)) return err("El archivo no es un .xlsx válido", 400);

  try {
    const summary = await saveUpload(userId, kind, file.name.slice(0, 200), buf);
    // Snapshots were dropped, so this starts a fresh sync (or joins one in flight) in the background.
    void getSyncService(userId).getDashboard().catch(() => undefined);
    return NextResponse.json({ upload: summary });
  } catch (e) {
    return err(e instanceof Error ? e.message : "No pude leer el archivo", 422);
  }
}

export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) return err("No autenticado", 401);
  const kind = asKind(new URL(req.url).searchParams.get("kind"));
  if (!kind) return err("Tipo de archivo inválido", 400);
  await deleteUpload(userId, kind);
  return NextResponse.json({ ok: true });
}
