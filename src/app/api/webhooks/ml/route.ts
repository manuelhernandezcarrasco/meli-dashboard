import { after, NextResponse } from "next/server";
import { applyOrder } from "~/server/stock/sales";
import { markProcessed, recordEvent } from "~/server/store/webhookEvents";
import { accountByExternalUser } from "~/server/store/stockSales";

export const runtime = "nodejs";

const ORDER_RE = /^\/orders\/(\d+)$/;

/** Hooks so tests can swap the heavy part; production uses the defaults. */
export const handlers = { applyOrder, accountByExternalUser, recordEvent, markProcessed };

/**
 * Mercado Libre `orders_v2` notifications. Public (no Clerk). Stores the event, answers 200 right away and
 * processes after the response; the 15-minute reconcile covers anything that fails or is lost.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ ok: true });

  const topic = typeof body.topic === "string" ? body.topic : "";
  const resource = typeof body.resource === "string" ? body.resource : "";
  const userId = body.user_id === undefined || body.user_id === null ? "" : String(body.user_id);
  const eventId = typeof body._id === "string" && body._id ? body._id : null;
  const m = ORDER_RE.exec(resource);
  if (topic !== "orders_v2" || !m || !userId) return NextResponse.json({ ok: true }); // not ours: acknowledge so ML stops retrying

  try {
    const accountId = await handlers.accountByExternalUser(userId);
    if (!accountId) return NextResponse.json({ ok: true });
    const ev = await handlers.recordEvent({ accountId, topic, resource, externalEventId: eventId });
    if (!ev) return NextResponse.json({ ok: true, duplicate: true });

    after(async () => {
      try {
        await handlers.applyOrder(accountId, Number(m[1]), "webhook");
        await handlers.markProcessed(ev.id, null);
      } catch (e) {
        await handlers.markProcessed(ev.id, e instanceof Error ? e.message : String(e)).catch(() => undefined);
      }
    });
  } catch (e) {
    console.error(`[webhook] ${e instanceof Error ? e.message : String(e)}`);
  }
  return NextResponse.json({ ok: true });
}
