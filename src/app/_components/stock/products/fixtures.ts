import type { ProductDetail, ProductRow } from "~/lib/stock-contracts";

export const row = (o: Partial<ProductRow> = {}): ProductRow => ({
  id: 1, ean: "7790000000011", sku: "SKU-1", name: "Cámara IP", model: "X1", category: "Cámaras",
  onHand: 40, inRepair: 0, unitCost: 1500, minUnits: 5, syncMode: "dry_run", dailyRate: 2, coverageDays: 20,
  linkedListings: 1, openAlerts: 0, archived: false, ...o,
});

export const detail = (o: Partial<ProductDetail> = {}): ProductDetail => ({
  product: row(),
  listings: [{
    linkId: 9, marketplace: "mercadolibre", itemId: "MLA123", variationId: null, title: "Cámara IP wifi",
    componentQuantity: 1, componentCount: 1, syncStatus: "in_sync", lastPushedQty: 40, lastObservedMlQty: 40,
  }],
  recentMovements: [{
    id: 1, productId: 1, type: "sale", quantity: -2, occurredAt: "2026-11-10T15:00:00.000Z", recordedAt: "2026-11-10T15:00:00.000Z",
    onHandAfter: 38, unitCostAfter: 1500, refType: "order", refId: "2000123", reason: null, actor: "webhook",
  }],
  costHistory: [{
    id: 1, effectiveFrom: "2026-10-01T00:00:00.000Z", unitCost: 1500, onHandAtChange: 40, reason: "invoice",
    refType: "invoice", refId: "7", note: null,
  }],
  ...o,
});
