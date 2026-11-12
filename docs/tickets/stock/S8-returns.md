# S8 — Returns domain

## Goal
Returns never touch stock automatically. A person decides each one.

## Files you own
`src/server/stock/returns.ts`, `src/server/store/stockReturns.ts`, `src/server/api/routers/stock-returns.ts`, tests.

## Behaviour
1. **`openReturn({orderId, lineNo, productId, quantity, reason?})`**: creates a `ReturnCase` as `pending` (unique per order line; idempotent). Called by S4 on shipped cancellations; also creatable manually from the UI (`create`).
2. **Outcomes** (`resolveReturn(id, outcome, note?)`), all via S1 `appendMovement`, idempotent with `return:<id>:<outcome>`:
   - `lost`: no stock change (stock already left at the sale). Write no movement; store the outcome and `note` on the `ReturnCase`, which is the audit record.
   - `in_repair`: `repair_in` movement: `inRepair += qty`, `onHand` unchanged. Not sellable.
   - `restocked`: `return_restock` movement: `onHand += qty`. Requires explicit confirmation flag from the caller.
   - From `in_repair` the person may later resolve to `restocked` (`repair_out` then `return_restock`: `inRepair −= qty`, `onHand += qty`) or `lost` (`repair_out`, no restock).
3. State machine: `pending → lost | in_repair | restocked`; `in_repair → restocked | lost`; terminal states are final (reject other transitions).
4. After a restock: `requestPush` (S3) and alert evaluation (S7) via their interfaces.
5. **Router** `stock-returns.ts`: `list` (by outcome), `create`, `resolve`. Row shape from S0 contracts (include order id, listing title, buyer-free: no personal data of the buyer is stored).

## Tests
Every transition and every illegal transition; idempotent replay; in_repair bucket math; restock needs confirm; push requested after restock.

## Done when
Tests green; nothing else writes `ReturnCase`.
