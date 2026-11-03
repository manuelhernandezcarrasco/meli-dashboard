export const UPLOAD_KINDS = ["pnl", "inputs"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** .xlsx files are zip archives. */
export function looksLikeXlsx(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}
