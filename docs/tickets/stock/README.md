# Stock module — ticket index

Read `PLAN.md` first. Generic rules are in `docs/tickets/README.md` and `docs/database/README.md`; the rules below add to them.

## Rules for EVERY stock agent

1. Follow the ticket literally; touch only "Files you own". If something is missing or contradictory, stop and report it.
2. **Schema, `src/lib/stock-contracts.ts` and `src/server/stock/contracts.ts` are owned by S0.** Do not edit them. Need a change? Report it. S0 also creates the empty routers and registers them in `root.ts`; after that each router file belongs to one ticket: `stock-products` → S5, `stock-sync` → S3, `stock-alerts` → S7, `stock-returns` → S8, `stock-invoices` → S9 (S6 adds its own `stock-cutover.ts`).
3. **ML write exception:** rule 3 of the base README ("read-only") is relaxed for exactly one call — setting `available_quantity` — and only inside `src/server/ml/stock-write.ts` (ticket S3). Nobody else may write to ML.
4. All DB access in `src/server/store/` with a round-trip test. No raw Prisma calls elsewhere for stock tables.
5. Stock changes only via `appendMovement` (S1). Never update `onHand` directly.
6. Every write path is idempotent (an `idempotencyKey` per event).
7. UI text in Spanish (AR), code in English; reuse the existing design tokens/components.
8. Finish with `pnpm typecheck && pnpm lint && pnpm test`, then report what you did, what you did not do, and anything surprising.

## Dependency graph

| Ticket | Title | Starts when | Blocked by |
|---|---|---|---|
| S0 | Schema, migration, contracts, router stubs | now | – (run alone) |
| S1 | Ledger and weighted-average costing | S0 merged | S0 |
| S2 | Invoice PDF parser | S0 merged | S0 |
| S3 | ML stock write + push engine | S0 merged | S0 |
| S5 | Listing links and matching | S0 merged | S0 |
| S7 | Alerts engine | S0 merged | S0 |
| S8 | Returns domain | S0 merged | S0 |
| U0 | App shell (sidebar) + dashboard cleanup | S0 merged | S0 |
| U6 | Market research index page | S0 merged | S0 |
| S4 | Sales ingestion (webhook + reconcile + cancellations) | S1, S3, S5 merged | S1 S3 S5 |
| S6 | Cutover import + Excel as events + ledger COGS | S1, S5 merged | S1 S5 |
| S9 | Invoice service (review → apply) | S1, S2, S5 merged | S1 S2 S5 |
| U1 | Products tab + product drawer | S1, S5, S3 merged | S1 S3 S5 U0 |
| U2 | Invoices tab (upload, review, confirm) | S9 merged | S9 U0 |
| U3 | Alerts tab | S7 merged | S7 U0 |
| U4 | Returns tab | S8 merged | S8 U0 |
| U5 | Sync log tab + go-live flow | S3 merged | S3 U0 |
| X1 | End-to-end verification | all wave 2 merged | all |
| F1 | Combo (pack) builder UI | future | X1 |

Wave 1 = S1 S2 S3 S5 S7 S8 U0 U6 (all in parallel after S0). Wave 2 = S4 S6 S9 U1–U5. Tickets with no cross-file overlap can run in parallel; the "Files you own" lists guarantee that.
