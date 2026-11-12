# X1 — End-to-end verification (after all wave-2 tickets are merged)

## Goal
Prove the whole loop works on a throwaway database, in dry-run, before the owner switches anything live.

## Files you own
`e2e/stock/*` (or `src/server/stock/e2e.test.ts` if there is no e2e runner), `docs/tickets/stock/X1-report.md` (your findings).

## Scenario (automate what you can; do the rest by hand in the dev server and report)
1. Seed: the demo P&L workbook → run cutover → products + initial movements + costs; exact-GTIN listings auto-link.
2. Upload the Sony sample invoice → review shows factor ≈ 1,27001, line 1 landed cost ≈ 69.971,74 → match an unmatched line manually → confirm. Check ledger balance, cost history and that a dry-run push log row exists for each affected linked listing.
3. Simulate a webhook for a paid order of a linked listing → one `sale` movement, cost frozen at that time; send the same webhook twice → still one.
4. Order of an unlinked listing → `unmatched_sale` alert, no movement. Link it from the Alerts tab → cost review alert → accept → pending sales applied.
5. Cancel an unshipped order → stock restored. Cancel a shipped one → return appears as Pendiente; resolve as in repair, then restock.
6. Push stock negative → alert, ML payload clamped at 0 in the dry-run log.
7. Upload a new P&L Excel → `excel_reset` movements and cost entries with the log text; old sales keep their COGS; "Recalcular histórico" twice gives identical COGS.
8. Go-live wizard on one product against a mocked ML: shows ML qty vs ours, requires confirmation; verify the only ML write is the single quantity PUT.
9. Dashboard shows no stock table/alerts card, the badge links to `/stock/alerts`; sidebar collapsed by default; market-research index works.

## Done when
Everything above passes or each failure is written up with steps to reproduce; the report lists what remains manual for the owner (ML app write permission, webhook URL registration, Render cron, switching the first product live).
