import type {
  Base,
  BusinessConfig,
  Gtins,
  Inputs,
  Order,
  PaymentTaxes,
  PrevCierre,
  ShipCosts,
} from "~/lib/contracts";

export interface DataSource {
  /** Orders created in month (y, m), Argentina time. */
  getOrdersMonth(y: number, m: number): Promise<Order[]>;
  /** shippingId -> seller shipping cost. */
  getShipmentCosts(shippingIds: string[]): Promise<ShipCosts>;
  /** itemId -> gtins. */
  getGtins(itemIds: string[]): Promise<Gtins>;
  /** paymentId -> taxes or null (no detail). */
  getPaymentTaxes(
    paymentIds: string[],
  ): Promise<Record<string, PaymentTaxes | null>>;
}

export interface Workbooks {
  readBase(
    path: string,
    cfg: BusinessConfig,
  ): Promise<{ base: Base; prev: PrevCierre }>;
  readInputs(path: string | undefined): Promise<Inputs>;
}
