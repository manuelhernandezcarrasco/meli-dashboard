import { z } from "zod";
import {
  BaseSchema,
  InputsSchema,
  PrevCierreSchema,
  type Base,
  type Inputs,
  type PrevCierre,
} from "~/lib/contracts";
import { loadBusinessConfig } from "~/server/config";
import { db } from "~/server/db";
import { readBase, readInputs } from "./read";
import type { UploadKind } from "./upload";

const PnlPayloadSchema = z.object({ base: BaseSchema, prev: PrevCierreSchema });

export interface UploadSummary {
  kind: UploadKind;
  fileName: string;
  uploadedAt: string;
  /** SKUs in the P&L, or direct-sale rows in the inputs file */
  rows: number;
}

/**
 * Parses an uploaded workbook, stores the normalized data for `ownerId` and drops the cached
 * snapshots so the next dashboard load recomputes with it. Throws the reader's Spanish error
 * message when the file does not have the expected sheets/headers.
 */
export async function saveUpload(
  ownerId: string,
  kind: UploadKind,
  fileName: string,
  buf: Buffer,
): Promise<UploadSummary> {
  let payload: unknown;
  let rows: number;
  if (kind === "pnl") {
    const r = await readBase(buf, loadBusinessConfig());
    payload = r;
    rows = Object.keys(r.base).length;
  } else {
    const r = await readInputs(buf);
    payload = r;
    rows = r.va.length;
  }
  const row = await db.userWorkbook.upsert({
    where: { ownerId_kind: { ownerId, kind } },
    create: { ownerId, kind, fileName, payload: payload as object },
    update: { fileName, payload: payload as object, uploadedAt: new Date() },
  });
  await db.snapshot.deleteMany({ where: { ownerId } });
  return { kind, fileName, uploadedAt: row.uploadedAt.toISOString(), rows };
}

export async function listUploads(ownerId: string): Promise<UploadSummary[]> {
  const rows = await db.userWorkbook.findMany({ where: { ownerId } });
  return rows.map((r) => ({
    kind: r.kind as UploadKind,
    fileName: r.fileName,
    uploadedAt: r.uploadedAt.toISOString(),
    rows:
      r.kind === "pnl"
        ? Object.keys(PnlPayloadSchema.parse(r.payload).base).length
        : InputsSchema.parse(r.payload).va.length,
  }));
}

export async function deleteUpload(ownerId: string, kind: UploadKind): Promise<void> {
  await db.userWorkbook.deleteMany({ where: { ownerId, kind } });
  await db.snapshot.deleteMany({ where: { ownerId } });
}

/** The user's uploaded data, or undefined for whatever they have not uploaded yet. */
export async function loadUploaded(
  ownerId: string,
): Promise<{ base?: Base; prev?: PrevCierre; inputs?: Inputs }> {
  const rows = await db.userWorkbook.findMany({ where: { ownerId } });
  const out: { base?: Base; prev?: PrevCierre; inputs?: Inputs } = {};
  for (const r of rows) {
    if (r.kind === "pnl") Object.assign(out, PnlPayloadSchema.parse(r.payload));
    else if (r.kind === "inputs") out.inputs = InputsSchema.parse(r.payload);
  }
  return out;
}
