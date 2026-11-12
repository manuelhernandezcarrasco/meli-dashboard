import { db } from "~/server/db";
import { MERCADOLIBRE } from "./marketplace";

/**
 * WebhookEvent persistence (S4 is the only writer). A notification is stored first, answered 200, and
 * processed afterwards; `processedAt` null = still to do (the reconcile also covers anything lost).
 */

export interface WebhookInput {
  accountId: string;
  topic: string;
  resource: string;
  /** The marketplace's own notification id, when it sends one: the dedupe key. */
  externalEventId?: string | null;
}

/** A repeat of a notification still waiting to be processed is the same notification. */
const PENDING_WINDOW_MS = 60_000;

export async function recordEvent(i: WebhookInput, now = new Date()): Promise<{ id: number; created: boolean } | null> {
  const externalEventId = i.externalEventId ?? null;
  if (externalEventId) {
    const { count } = await db.webhookEvent.createMany({
      data: [{ accountId: i.accountId, marketplace: MERCADOLIBRE, topic: i.topic, resource: i.resource, externalEventId, receivedAt: now }],
      skipDuplicates: true,
    });
    if (count === 0) return null;
    const row = await db.webhookEvent.findFirstOrThrow({ where: { marketplace: MERCADOLIBRE, externalEventId } });
    return { id: Number(row.id), created: true };
  }
  const dup = await db.webhookEvent.findFirst({
    where: { accountId: i.accountId, marketplace: MERCADOLIBRE, topic: i.topic, resource: i.resource, processedAt: null,
      receivedAt: { gte: new Date(now.getTime() - PENDING_WINDOW_MS) } },
  });
  if (dup) return null;
  const row = await db.webhookEvent.create({
    data: { accountId: i.accountId, marketplace: MERCADOLIBRE, topic: i.topic, resource: i.resource, receivedAt: now },
  });
  return { id: Number(row.id), created: true };
}

export async function markProcessed(id: number, error: string | null, now = new Date()): Promise<void> {
  await db.webhookEvent.update({ where: { id: BigInt(id) }, data: { processedAt: now, error: error?.slice(0, 500) ?? null } });
}

export interface StoredWebhookEvent { id: number; accountId: string | null; topic: string; resource: string; processedAt: Date | null; error: string | null }

export async function readEvent(id: number): Promise<StoredWebhookEvent | null> {
  const r = await db.webhookEvent.findUnique({ where: { id: BigInt(id) } });
  return r ? { id: Number(r.id), accountId: r.accountId, topic: r.topic, resource: r.resource, processedAt: r.processedAt, error: r.error } : null;
}
