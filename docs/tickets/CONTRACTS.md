# Shared contracts (T0 copies these into code, verbatim)

T0 creates `src/lib/contracts.ts` (Zod schemas + inferred types) from this document and `src/server/datasource/types.ts` for the interfaces. Nobody else edits those files.

## Naming map (Python → TS)
Python keys are Spanish snake_case; TS contracts are English camelCase **except** the P&L business terms, which keep the Spanish names the dashboard already uses (`venta`, `costoMl`, `cogs`, `ingNetos`, `margen`, `uds`).

## Source data

```ts
export const OrderSchema = z.object({
  id: z.number(),
  packId: z.number().nullable(),
  status: z.string(),                       // only "paid" counts
  dateCreated: z.string(),                  // ISO 8601 as returned by ML
  shippingId: z.number().nullable(),
  items: z.array(z.object({
    itemId: z.string(),                     // "MLA123…" upper-case
    title: z.string(),
    sellerSku: z.string().nullable(),
    sellerCustomField: z.string().nullable(),
    variationId: z.number().nullable(),
    quantity: z.number(),
    unitPrice: z.number(),
    saleFee: z.number(),                    // per unit, like ML's sale_fee
  })),
  payments: z.array(z.object({ id: z.number(), status: z.string() })),
});

export const PaymentTaxesSchema = z.object({ total: z.number(), det: z.record(z.number()) }); // null = payment without detail
export type ShipCosts = Record<string, number>;                         // shippingId -> seller cost
export type Gtins = Record<string, Record<string, string>>;            // itemId -> {"_item": ean, "<variationId>": ean}
export type TaxMap = Record<string, PaymentTaxes>;                      // paymentId -> taxes (only non-null entries)

export const BaseSkuSchema = z.object({
  ean: z.string(), desc: z.string(), modelo: z.string(), cat: z.string(),
  cu: z.number(),                 // 0 when unknown
  stock: z.number(),              // "Stock final" of the closing P&L
  mg: z.number(),                 // assumed margin (0..1)
  costoMlPctPrev: z.number().nullable(),
  udsPrev: z.number(),
});
export type Base = Record<string, BaseSku>;                              // ean -> sku

export const PrevCierreSchema = z.object({
  ventaMl: z.number(), ventaVa: z.number(), venta: z.number(), costoMl: z.number(),
  cogs: z.number(), uds: z.number(), ingNetos: z.number(), margen: z.number(),
});                                                                      // same shape as Totals

export const InputsSchema = z.object({
  va: z.array(z.object({ date: z.string(), cliente: z.string(), ean: z.string(), desc: z.string(), qty: z.number(), pu: z.number() })),
  mapItem: z.record(z.string()),     // itemId -> ean
  mapSku: z.record(z.string()),      // sku -> ean
  override: z.record(z.object({ cu: z.number(), desc: z.string(), cat: z.string().nullable() })),
  ingresos: z.array(z.object({ date: z.string(), ean: z.string(), qty: z.number() })),
});
```

## Calculation

```ts
export const LineSchema = z.object({
  date: z.string(), time: z.string(),              // "YYYY-MM-DD", "HH:MM" ("" for direct sales)
  channel: z.enum(["ML", "VA"]),
  order: z.string(), itemId: z.string(), sku: z.string(), ean: z.string(),
  matchVia: z.string(),                            // "Mapeo item" | "Mapeo SKU" | "SKU=EAN" | "GTIN publicación" | "Sin match" | "Carga manual"
  desc: z.string(), titleMl: z.string(), cat: z.string(),
  qty: z.number(), pu: z.number(),
  venta: z.number(), cargoVenta: z.number(), envio: z.number(), impEst: z.number(), costoMl: z.number(),
  cu: z.number(), costSource: z.string(),          // "Override" | "Real (CU Pond. cierre)" | "Asumido 8%" | "Sin match – asumido 30%"
  taxSource: z.string(),                           // "Mercado Pago" | "Estimado 3.1%" | ""
  taxDetail: z.string(),
});

export const TotalsSchema = z.object({
  ventaMl: z.number(), ventaVa: z.number(), venta: z.number(), costoMl: z.number(),
  cogs: z.number(), uds: z.number(), ingNetos: z.number(), margen: z.number(),
});                                                // also used for one day ("DailyPoint")
```

## Wire format sent to the dashboard (`DashboardData`)

```ts
export const DashboardDataSchema = z.object({
  rows: z.array(z.object({                          // compact version of Line
    date: z.string(), time: z.string(), channel: z.enum(["ML", "VA"]), order: z.string(), ean: z.string(),
    desc: z.string(),                               // truncated to 70 chars
    cat: z.string(), qty: z.number(),
    sale: z.number(),                               // Line.venta, 2 decimals
    costML: z.number(),                             // Line.costoMl, 2 decimals
    cogs: z.number(),                               // qty * cu, 2 decimals
    assumed: z.boolean(),                           // true unless costSource starts with "Real" or equals "Override"
  })),
  stock: z.array(StockRowSchema),
  updatedAt: z.string(),                            // "dd/MM/yyyy HH:mm" Argentina time
  monthLabel: z.string(),                           // "Octubre 2026"
  y: z.number(), m: z.number(),
  unmatched: z.array(z.object({ itemId: z.string(), sku: z.string(), title: z.string(), qty: z.number(), venta: z.number() })).max(30),
  refreshMinutes: z.number(),
  taxPct: z.number(),                               // calibrated estimated tax %
  thresholds: z.object({ crit: z.number(), low: z.number(), repo: z.number() }),
  comp: z.object({
    prevLabel: z.string(), prevCierre: TotalsSchema,
    prevDaily: z.array(TotalsSchema), nDays: z.number(),
    prevToday: TotalsSchema.nullable(), cutTime: z.string().nullable(),
    prevAccumAtCut: TotalsSchema, cutDay: z.number(),
  }),
});

export const StockRowSchema = z.object({            // compact StockItem
  desc: z.string(),                                 // truncated to 60 chars
  cat: z.string(), ean: z.string(),
  initial: z.number(), inflow: z.number(), sold: z.number(), remaining: z.number(),
  rate: z.number(), rateSource: z.enum(["mes actual", "mes anterior"]),
  coverage: z.number().nullable(), breakDate: z.string().nullable(), reorder: z.number(),
  state: z.enum(["Vendido sin stock", "Agotado", "Crítico", "Bajo", "OK"]),
});
```
`StockItem` (full, from `computeStock`) has the Python names translated: `ean, desc, cat, initial, inflow, sold, remaining, rate, rateSource, coverage, breakDate, reorder, state, cu`.

## Interfaces (`src/server/datasource/types.ts`)

```ts
export interface DataSource {
  /** Orders created in month (y, m), Argentina time. */
  getOrdersMonth(y: number, m: number): Promise<Order[]>;
  /** shippingId -> seller shipping cost. */
  getShipmentCosts(shippingIds: string[]): Promise<ShipCosts>;
  /** itemId -> gtins (see Gtins). */
  getGtins(itemIds: string[]): Promise<Gtins>;
  /** paymentId -> taxes or null (no detail). */
  getPaymentTaxes(paymentIds: string[]): Promise<Record<string, PaymentTaxes | null>>;
}
export interface Workbooks {
  readBase(path: string, cfg: BusinessConfig): Promise<{ base: Base; prev: PrevCierre }>;
  readInputs(path: string | undefined): Promise<Inputs>;
}
```
`BusinessConfig` (from `config/business.json`, validated by Zod in `src/server/config.ts`): `refreshMinutes, horaCierre, mes, stockCriticoDias, stockBajoDias, reposicionDias, impuestosMlPctEstimado: "auto" | number, margenAsumido: Record<string, number>`.

## Shared helpers T0 provides (ported + tested)
`src/lib/normalize.ts`: `normEan, normHdr, toNum, toPct, normCat` (Python lines 78–135).
`src/lib/dates.ts`: `ARG_OFFSET_HOURS = -3`, `toArgParts(iso) -> {date, time, y, m, d}`, `daysIn(y, m)`, `prevYm(y, m)`, `monthLabel(y, m)` (`Enero…Diciembre`), `nowArg()`.
