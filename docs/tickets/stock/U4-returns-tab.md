# U4 — Returns tab

## Goal
`/stock/returns`: decide what happens to each returned unit.

## Files you own
`src/app/stock/returns/page.tsx`, `src/app/_components/stock/returns/*`, tests.

## Behaviour
1. Table from `stockReturns.list`: product, listing title, order id, quantity, reason, opened date, outcome chip (Pendiente / Perdido / En reparación / Reingresado). Filter by outcome (default: Pendiente + En reparación).
2. Row actions by state: Pendiente → **Perdido** (no stock change), **A reparación** (not sellable, shown in "en reparación"), **Reingresar al stock** (explicit confirmation dialog: "se suma +N al stock disponible"). En reparación → Reingresar / Perdido. Final states are read-only. Optional note field.
3. **Registrar devolución** manual button (order id, product, quantity, reason).
4. Header counters: pending, in repair units.
5. Spanish copy; confirmation on every state-changing action; double-click protection.

## Tests
Mocked tRPC: allowed actions per state, confirm dialog for restock, illegal action not rendered.

## Done when
Checks green; screenshots of the table and the restock confirmation.
