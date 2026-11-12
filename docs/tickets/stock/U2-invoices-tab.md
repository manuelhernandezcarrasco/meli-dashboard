# U2 — Invoices tab (upload, review, confirm)

## Goal
`/stock/invoices`: upload a purchase invoice PDF, review exactly what will change, confirm.

## Files you own
`src/app/stock/invoices/page.tsx`, `src/app/stock/invoices/[id]/page.tsx`, `src/app/_components/stock/invoices/*`, tests.

## Behaviour
1. **List**: invoices with supplier, number, date, total, lines, status (Borrador / Aplicada), applied date. "Subir factura" button (PDF, drag and drop, size/type errors in Spanish, duplicate-invoice message with a link to the existing one).
2. **Review screen** (`getDraft`) — nothing is applied here:
   - Header block: supplier, number, date, subtotal, IVA, percepciones, total.
   - **Fee factor card**: "Total ÷ subtotal = ×1,27001 (+27,00 %): incluye IVA, percepciones e impuestos; el costo es bruto, no se descuenta nada." Editable field (shows "editado" badge) — this must be visible before Confirm.
   - Lines table: qty, code, EAN, description, unit price, **costo unitario con impuestos**, product match (name or "Sin match"), stock now → after, cost now → after (highlight changes).
   - Unmatched lines: inline resolver — "Vincular con producto existente" (search; shows the fields that will be filled, never overwritten) or "Crear producto" (prefilled from the invoice line), or "Omitir línea" (explicit).
   - Parser warnings in a visible callout (totals mismatch).
   - Sticky footer: "Confirmar y aplicar" disabled while unresolved lines exist, with a summary ("6 productos, 146 unidades, +$13,77 M"). A confirmation dialog repeats the totals. After success: toast + link to products.
3. Draft can be discarded. Applied invoices are read-only (show applied movements).
4. States: parsing spinner, parse failure (Spanish message, "este PDF no tiene texto" for scanned files), network errors with retry, double-click protection on confirm.

## Tests
Mocked tRPC: upload errors, fee-factor edit updates projections, confirm disabled until resolved, skip flow, duplicate message. Manual run with the Sony sample (once S2/S9 are merged) with screenshots.

## Done when
Checks green; screenshots of list, review (factor card visible), resolver, confirmation.
