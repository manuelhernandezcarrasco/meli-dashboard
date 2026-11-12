# S2 — Invoice PDF parser (pure, no database)

## Goal
`parseInvoicePdf(buffer: Buffer): ParsedInvoice` for Argentine supplier invoices, validated against the Sony sample. Pure code + tests; no DB, no network.

## Files you own
`src/server/invoices/parse.ts`, `src/server/invoices/pdf-text.ts`, `src/server/invoices/numbers.ts`, `src/server/invoices/*.test.ts`, `src/server/invoices/__fixtures__/*`, `package.json` (only to add the PDF text library; pick a maintained one such as `pdfjs-dist` or `unpdf`, pinned).

## Sample (fixture to commit: a copy or a text dump of `01-0225-00085935.pdf`; do not commit real tax IDs beyond what is in the expected JSON)
Two-page text PDF. Page 1: header (supplier Sony Argentina S.A., CUIT `30679928879`, `Nº 0225-00085935`, `FECHA: 28/08/2026`, buyer CUIT `30715331671`), table `CANTIDAD | CODIGO / Origen | Den. estándar | DESCRIPCION | Precio Unitario | Importe | Descuentos | Subtotal`, then `Subtotale 10.843.892,71`. Page 2: `Perc. IB CF 6.000 % 650.633,56`, `IVA 21 % 2.277.217,47`, `TOTAL PESOS 13.771.743,74`.

Expected `lines` (qty, supplierCode, ean as printed in "Den. estándar" → normalized, description, unitPrice, subtotal):

| qty | code | EAN printed | normalized | desc | unit | subtotal |
|---|---|---|---|---|---|---|
| 58 | 92484938 | 027242925489 | 0027242925489 | WH-CH520/CZ UC | 55.095,86 | 3.195.559,88 |
| 27 | 92484939 | 027242932425 | 0027242932425 | WH-CH520/PZ UC | 55.095,86 | 1.487.588,22 |
| 20 | 18061335 | 027242928688 | 0027242928688 | WHULT900N/BZUC | 200.349,91 | 4.006.998,20 |
| 30 | 92484535 | 027242923638 | 0027242923638 | WI-C100/BZ UC | 35.060,82 | 1.051.824,60 |
| 5 | 18063335 | 027242931770 | 0027242931770 | WF-C710N/BZ UC | 100.174,71 | 500.873,55 |
| 6 | 18063337 | 027242931817 | 0027242931817 | WF-C710N/LZ UC | 100.174,71 | 601.048,26 |

Totals: `subtotal 10.843.892,71`, `perceptionsAmount 650.633,56`, `ivaAmount 2.277.217,47`, `total 13.771.743,74`, `feeFactor = total/subtotal ≈ 1,27001`.

## Behaviour
1. Extract text per page; **first check the PDF has a text layer** — if not, throw `ScannedPdfError` (no OCR in v1).
2. Parse Argentine numbers (`1.234,56` → `1234.56`) in `numbers.ts`, with tests.
3. EAN normalization: strip spaces, left-pad 12-digit UPC to 13 digits with `0` (reuse/extend `normEan` in `src/lib/normalize.ts` only by calling it; do not edit it).
4. Output `ParsedInvoice` (type from S0 contracts): header (supplier name/taxId, number, issueDate ISO, buyer taxId), `lines[]`, `taxes` (`iva`, `perceptions`, `other`), `subtotal`, `total`, `warnings[]`.
5. **Validation (as warnings or errors):** `sum(line.subtotal) ≈ subtotal` (±0,05) and `subtotal + iva + perceptions + other ≈ total` (±0,05). If a check fails, return the parse with a `warnings` entry, not a throw (the review screen shows it). Missing total or no lines → throw `InvoiceParseError` with a readable Spanish message.
6. Do not compute landed cost here (S9 does it). Do not look at the database.
7. Layout drift: parse by column order/regex anchored on the table header, not on absolute positions, and keep the code readable enough to add other suppliers later (one parser module per supplier layout behind `parseInvoicePdf` detection by header text).

## Tests
The sample above end to end; number parser table; UPC→GTIN-13; two bad fixtures (totals mismatch → warning, empty PDF → error).

## Done when
Sample yields exactly the table above; checks pass; no DB or network imports (a lint test asserts it).
