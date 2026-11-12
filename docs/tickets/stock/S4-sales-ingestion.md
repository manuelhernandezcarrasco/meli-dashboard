# S4 — Sales ingestion: webhook, reconcile, cancellations

## Goal
Sales (and cancellations) change stock even when nobody has the dashboard open.

## Files you own
`src/app/api/webhooks/ml/route.ts`, `src/app/api/cron/stock-reconcile/route.ts`, `src/server/stock/sales.ts`, `src/server/store/stockSales.ts`, `src/server/store/webhookEvents.ts`, `render.yaml` (add the cron job only), `.env.example` (add `CRON_SECRET`, `ML_WEBHOOK_SECRET` if used), tests.

## Behaviour

1. **Webhook** `POST /api/webhooks/ml` (public, no Clerk): accept ML `orders_v2` notifications `{resource: "/orders/123", user_id, topic, ...}`. Respond **200 within 500 ms** and process asynchronously (queue in `WebhookEvent`, then process in-request after responding or via the reconcile). Map `user_id` → account via `MarketplaceConnection.externalUserId`; unknown user → 200, ignore. Drop duplicates through the `WebhookEvent` unique key. Add the route to the Clerk middleware public matcher (edit `src/middleware.ts` minimal, list that in your report).
2. **Process an order** (`applyOrder(accountId, orderId)`): fetch the order with the existing read client, write it through the existing `saveOrders` store (no new order storage), then for each item line of a `paid` order: resolve `ListingLink` by `(itemId, variationId?)`. If linked → `appendMovement` (S1) type `sale`, quantity `−qty × component.quantity` per component, `idempotencyKey = sale:<orderId>:<lineNo>:<productId>`, `occurredAt` = order createdAt. If **not** linked → no movement, `raiseAlert({type:'unmatched_sale', dedupeKey: itemId})`, and remember it as pending (query, not a table: paid `OrderItem`s since `cutoverAt` without a `sale` movement).
3. Never apply orders created before `InventorySettings.cutoverAt`.
4. **Cancellation before shipping**: when an order turns `cancelled` (webhook or reconcile) and a `sale` movement exists and the shipment is not shipped → `sale_cancel` movement (+qty, idempotent). Shipped/delivered → do nothing automatic; open a `ReturnCase` (S8 service interface) as `pending`.
5. After movements: `requestPush(accountId, productIds, 'sale')` (S3).
6. **Retroactive apply** `applyPendingForListing(accountId, itemId, variationId?)` — called by S5 after a link is created **and its cost review alert is resolved** (PLAN: user confirms/edits cost first). Applies all pending sales since `cutoverAt` in chronological order.
7. **Reconcile** (`GET /api/cron/stock-reconcile`, requires `Authorization: Bearer $CRON_SECRET`): for each account with a connection and a `cutoverAt`: list orders from `max(cutoverAt, lastReconcileAt − 1 day)`, run `applyOrder` for any without movements (idempotency makes this safe), then `compareWithMl` (S3). Update `InventorySettings.lastReconcileAt`. Runs every 15 min via a Render cron job in `render.yaml`.
8. Serialize processing per account (advisory lock) so webhook and reconcile do not interleave.

## Tests
Duplicate webhook = one movement; unlinked sale → alert + no movement; later link → retroactive movements in order; cancellation before/after shipping; pre-cutover order ignored; pack with several lines; reconcile catches a missed webhook; bad CRON_SECRET → 401.

## Done when
Tests green; with the dev server running, a simulated webhook for a linked paid order produces one `sale` movement and one dry-run push log row.
