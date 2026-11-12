# S9 — Invoice service: review → apply

## Goal
From an uploaded PDF to a reviewed draft to applied stock and cost, with nothing written to stock until the person confirms.

## Files you own
`src/server/stock/invoices.ts`, `src/server/store/stockInvoices.ts`, `src/app/api/invoices/upload/route.ts`, `src/server/api/routers/stock-invoices.ts`, tests.

## Behaviour
1. **Upload** `POST /api/invoices/upload` (Clerk-protected, PDF only, ≤ 10 MB, magic bytes `%PDF`): parse with S2 `parseInvoicePdf`; reject duplicates by `(supplierTaxId, number)` with a link to the existing invoice; create a `PurchaseInvoice` `draft` plus lines. Keep no raw file (like the Excel flow); keep `sourceFileName`.
2. **Auto-resolve** each line: `ean` exact match against `InventoryProduct.ean` → `auto_ean`; else `unresolved`.
3. **Review model** `getDraft(id)` returns everything the preview must show:
   - header, taxes (IVA, perceptions, other), subtotal, total, **`feeFactor = total/subtotal`** and an explicit sentence-ready breakdown ("impuestos y percepciones: +27,00 %, no se descuenta IVA");
   - per line: quantity, unit price, **landed unit cost = unitPrice × feeFactor**, line landed total, resolved product (name, current stock, current cost) and the **projected new weighted cost and new stock** (S1 pure function), plus the diff vs now;
   - unresolved lines with suggested products (same name tokens) and the fields that a manual match would fill (S5 `previewLink`-style plan);
   - parser warnings (S2) and a blocking state when lines are unresolved.
4. **Edit draft**: `setFeeFactor` (marks `feeFactorOverridden`), `matchLine(lineNo, productId)` (fill-missing-only plan applied on confirm), `createProductFromLine(lineNo, {...})`, `skipLine(lineNo)` (excluded from apply; must be explicit).
5. **Apply** `confirmInvoice(id)`: all-or-nothing transaction; refuses while any non-skipped line is unresolved; for each line `appendMovement` type `purchase_in`, qty, `landedUnitCost`, `idempotencyKey = invoice:<id>:<lineNo>`; status → `applied`; then `requestPush` (S3), alert evaluation (S7), and `margin_drop` checks. Voiding an applied invoice is **not** supported in v1 (corrections are manual adjustments with a reason).
6. **Router** `stock-invoices.ts`: `list`, `getDraft`, `setFeeFactor`, `matchLine`, `createProductFromLine`, `skipLine`, `confirm`, `discard` (drafts only).

## Tests
The Sony sample from S2 end to end: factor ≈ 1,27001; line 1 landed unit cost ≈ 69.971,74; preview projected cost equals the cost after apply; duplicate invoice rejected; unresolved line blocks confirm; skip works; idempotent confirm (double click); rollback on a failing line; manual match enriches only empty fields.

## Done when
Tests green; applying the sample leaves ledger and cost history consistent (`recomputeOnHand` equal to cache).
