import { z } from "zod";

/* ---------- Source data ---------- */
export const OrderSchema = z.object({
  id: z.number(),
  packId: z.number().nullable(),
  status: z.string(),
  dateCreated: z.string(),
  shippingId: z.number().nullable(),
  items: z.array(
    z.object({
      itemId: z.string(),
      title: z.string(),
      sellerSku: z.string().nullable(),
      sellerCustomField: z.string().nullable(),
      variationId: z.number().nullable(),
      quantity: z.number(),
      unitPrice: z.number(),
      saleFee: z.number(),
    }),
  ),
  payments: z.array(z.object({ id: z.number(), status: z.string() })),
});
export type Order = z.infer<typeof OrderSchema>;

export const PaymentTaxesSchema = z.object({
  total: z.number(),
  det: z.record(z.number()),
});
export type PaymentTaxes = z.infer<typeof PaymentTaxesSchema>;

export type ShipCosts = Record<string, number>;
export type Gtins = Record<string, Record<string, string>>;
export type TaxMap = Record<string, PaymentTaxes>;

export const BaseSkuSchema = z.object({
  ean: z.string(),
  desc: z.string(),
  modelo: z.string(),
  cat: z.string(),
  cu: z.number(),
  stock: z.number(),
  mg: z.number(),
  costoMlPctPrev: z.number().nullable(),
  udsPrev: z.number(),
});
export type BaseSku = z.infer<typeof BaseSkuSchema>;
export const BaseSchema = z.record(BaseSkuSchema);
export type Base = z.infer<typeof BaseSchema>;

export const TotalsSchema = z.object({
  ventaMl: z.number(),
  ventaVa: z.number(),
  venta: z.number(),
  costoMl: z.number(),
  cogs: z.number(),
  uds: z.number(),
  ingNetos: z.number(),
  margen: z.number(),
});
export type Totals = z.infer<typeof TotalsSchema>;
export const PrevCierreSchema = TotalsSchema;
export type PrevCierre = Totals;

export const InputsSchema = z.object({
  va: z.array(
    z.object({
      date: z.string(),
      cliente: z.string(),
      ean: z.string(),
      desc: z.string(),
      qty: z.number(),
      pu: z.number(),
    }),
  ),
  mapItem: z.record(z.string()),
  mapSku: z.record(z.string()),
  override: z.record(
    z.object({ cu: z.number(), desc: z.string(), cat: z.string().nullable() }),
  ),
  ingresos: z.array(
    z.object({ date: z.string(), ean: z.string(), qty: z.number() }),
  ),
});
export type Inputs = z.infer<typeof InputsSchema>;

/* ---------- Calculation ---------- */
export const LineSchema = z.object({
  date: z.string(),
  time: z.string(),
  channel: z.enum(["ML", "VA"]),
  order: z.string(),
  itemId: z.string(),
  sku: z.string(),
  ean: z.string(),
  matchVia: z.string(),
  desc: z.string(),
  titleMl: z.string(),
  cat: z.string(),
  qty: z.number(),
  pu: z.number(),
  venta: z.number(),
  cargoVenta: z.number(),
  envio: z.number(),
  impEst: z.number(),
  costoMl: z.number(),
  cu: z.number(),
  costSource: z.string(),
  taxSource: z.string(),
  taxDetail: z.string(),
});
export type Line = z.infer<typeof LineSchema>;

export const STOCK_STATES = [
  "Vendido sin stock",
  "Agotado",
  "Crítico",
  "Bajo",
  "OK",
] as const;
export type StockState = (typeof STOCK_STATES)[number];

export const StockItemSchema = z.object({
  ean: z.string(),
  desc: z.string(),
  cat: z.string(),
  initial: z.number(),
  inflow: z.number(),
  sold: z.number(),
  remaining: z.number(),
  rate: z.number(),
  rateSource: z.enum(["mes actual", "mes anterior"]),
  coverage: z.number().nullable(),
  breakDate: z.string().nullable(),
  reorder: z.number(),
  state: z.enum(STOCK_STATES),
  cu: z.number(),
});
export type StockItem = z.infer<typeof StockItemSchema>;

/* ---------- Wire format ---------- */
export const StockRowSchema = z.object({
  desc: z.string(),
  cat: z.string(),
  ean: z.string(),
  initial: z.number(),
  inflow: z.number(),
  sold: z.number(),
  remaining: z.number(),
  rate: z.number(),
  rateSource: z.enum(["mes actual", "mes anterior"]),
  coverage: z.number().nullable(),
  breakDate: z.string().nullable(),
  reorder: z.number(),
  state: z.enum(STOCK_STATES),
});
export type StockRow = z.infer<typeof StockRowSchema>;

export const DashboardDataSchema = z.object({
  rows: z.array(
    z.object({
      date: z.string(),
      time: z.string(),
      channel: z.enum(["ML", "VA"]),
      order: z.string(),
      ean: z.string(),
      desc: z.string(),
      cat: z.string(),
      qty: z.number(),
      sale: z.number(),
      costML: z.number(),
      cogs: z.number(),
      assumed: z.boolean(),
    }),
  ),
  stock: z.array(StockRowSchema),
  updatedAt: z.string(),
  monthLabel: z.string(),
  y: z.number(),
  m: z.number(),
  unmatched: z
    .array(
      z.object({
        itemId: z.string(),
        sku: z.string(),
        title: z.string(),
        qty: z.number(),
        venta: z.number(),
      }),
    )
    .max(30),
  refreshMinutes: z.number(),
  taxPct: z.number(),
  thresholds: z.object({ crit: z.number(), low: z.number(), repo: z.number() }),
  comp: z.object({
    prevLabel: z.string(),
    prevCierre: TotalsSchema,
    prevDaily: z.array(TotalsSchema),
    nDays: z.number(),
    prevToday: TotalsSchema.nullable(),
    cutTime: z.string().nullable(),
    prevAccumAtCut: TotalsSchema,
    cutDay: z.number(),
  }),
});
export type DashboardData = z.infer<typeof DashboardDataSchema>;

/* ---------- Business config ---------- */
export const BusinessConfigSchema = z.object({
  refreshMinutes: z.number(),
  horaCierre: z.string(),
  mes: z.string(),
  stockCriticoDias: z.number(),
  stockBajoDias: z.number(),
  reposicionDias: z.number(),
  impuestosMlPctEstimado: z.union([z.literal("auto"), z.number()]),
  margenAsumido: z.record(z.number()),
});
export type BusinessConfig = z.infer<typeof BusinessConfigSchema>;
