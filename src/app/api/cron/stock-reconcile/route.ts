import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { reconcileAll } from "~/server/stock/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const handlers = { reconcileAll };

function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Scheduled safety net (Render cron, every 15 min): `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: Request) {
  if (!authorized(req.headers.get("authorization"))) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const results = await handlers.reconcileAll();
  return NextResponse.json({ ok: results.every((r) => r.errors === 0), accounts: results.length, results });
}
