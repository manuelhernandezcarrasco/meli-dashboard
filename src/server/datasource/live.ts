import type { Gtins, Order, PaymentTaxes, ShipCosts } from "~/lib/contracts";
import { MlClient } from "~/server/ml/client";
import { compactOrder } from "~/server/ml/compact";
import { MERCADOLIBRE } from "~/server/store/marketplace";
import type { DataSource } from "./types";

const CONCURRENCY = 5;

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

export class LiveDataSource implements DataSource {
  readonly marketplace = MERCADOLIBRE;

  constructor(private readonly client: MlClient) {}

  async getOrdersMonth(y: number, m: number): Promise<Order[]> {
    const sellerId = await this.client.getSellerId();
    const raw = await this.client.ordersMonth(sellerId, y, m);
    return raw.map(compactOrder);
  }

  async getShipmentCosts(shippingIds: string[]): Promise<ShipCosts> {
    const costs = await mapLimit(shippingIds, CONCURRENCY, (id) =>
      this.client.shipmentSellerCost(id),
    );
    return Object.fromEntries(shippingIds.map((id, i) => [id, costs[i]!]));
  }

  async getGtins(itemIds: string[]): Promise<Gtins> {
    const chunks: string[][] = [];
    for (let i = 0; i < itemIds.length; i += 20) chunks.push(itemIds.slice(i, i + 20));
    const parts = await mapLimit(chunks, CONCURRENCY, (c) => this.client.itemsGtin(c));
    return Object.assign({}, ...parts) as Gtins;
  }

  async getCatalogIds(itemIds: string[]): Promise<Record<string, string | null>> {
    const chunks: string[][] = [];
    for (let i = 0; i < itemIds.length; i += 20) chunks.push(itemIds.slice(i, i + 20));
    const parts = await mapLimit(chunks, CONCURRENCY, (c) => this.client.itemsCatalogId(c));
    return Object.assign({}, ...parts) as Record<string, string | null>;
  }

  async getPaymentTaxes(
    paymentIds: string[],
  ): Promise<Record<string, PaymentTaxes | null>> {
    const taxes = await mapLimit(paymentIds, CONCURRENCY, (id) =>
      this.client.paymentTaxes(id),
    );
    return Object.fromEntries(paymentIds.map((id, i) => [id, taxes[i]!]));
  }
}
