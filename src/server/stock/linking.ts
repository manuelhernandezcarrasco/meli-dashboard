/**
 * S5 — which listing / variation feeds which product(s).
 *
 * Auto-link happens only on an exact EAN/GTIN; everything else is a manual link that fills the product's
 * EMPTY fields from the listing (never overwrites). Writes to ListingLink / ListingLinkComponent and to the
 * identity fields of InventoryProduct go through ../store/stockLinks.ts and ../store/inventoryProducts.ts only.
 */
import { db } from "~/server/db";
import {
  createProduct, eanIndex, fillProductFields, getProductIdentities, type ProductFills, type ProductIdentity,
} from "~/server/store/inventoryProducts";
import {
  deleteLink, getTarget, hasUnlinkedTarget, listUnlinkedTargets, replaceLink, type ListingTarget,
} from "~/server/store/stockLinks";
import { MERCADOLIBRE } from "~/server/store/marketplace";
import { raiseAlert, resolveAlert } from "./alerts";
import { dailyRates } from "./forecast";
import { appendMovement } from "./ledger";
import { pendingSalesCount } from "./sales";
import {
  StockError, type AlertService, type DecimalInput, type LedgerService, type LinkListingArgs,
} from "./contracts";

/** What a link would write into a product: only fields that are empty today. */
export interface FillPlanItem { productId: number; fills: ProductFills }
export type LinkPlan = FillPlanItem[];

export interface LinkResult { linkId: number; plan: LinkPlan }
export interface UnlinkedListing {
  marketplace: typeof MERCADOLIBRE;
  itemId: string;
  variationId: number | null;
  title: string | null;
  gtin: string | null;
  skus: string[];
  variations: { variationId: number; gtin: string }[];
}

/** Collaborators owned by other tickets (defaults are the real services); injectable for tests. */
export interface LinkingDeps {
  /** S7. */
  alerts: Pick<AlertService, "raiseAlert" | "resolveAlert">;
  /** S4: number of paid sales of this listing parked for lack of a link. */
  pendingSales: (accountId: string, itemId: string, variationId: number | null) => Promise<number>;
}

/** S1 ledger and S7 forecast, used by the router (not by the linking service itself). */
export interface StockServices {
  ledger: Pick<LedgerService, "appendMovement">;
  /** S7 forecast: units sold per day (null = unknown) for each product. */
  dailyRates: (accountId: string, productIds: number[]) => Promise<Map<number, number | null>>;
}

const defaultDeps: LinkingDeps = {
  alerts: { raiseAlert, resolveAlert },
  pendingSales: pendingSalesCount,
};

const defaultServices: StockServices = {
  ledger: { appendMovement },
  dailyRates,
};

let deps: LinkingDeps = defaultDeps;
let services: StockServices = defaultServices;
/** Test seam: production uses the real ledger, alerts, sales and forecast by default. */
export function configureStock(next: { linking?: Partial<LinkingDeps>; services?: Partial<StockServices> }): void {
  deps = { ...deps, ...next.linking };
  services = { ...services, ...next.services };
}
export const getStockServices = (): StockServices => services;

const toNum = (q: DecimalInput): number => Number(q);

const unmatchedKey = (mp: string, itemId: string) => `unmatched_listing:${mp}:${itemId}`;
const costReviewKey = (mp: string, itemId: string, variationId: number | null) => `link_cost_review:${mp}:${itemId}:${variationId ?? 0}`;

/** Business rule of the data path; the v1 router additionally caps components at 1 (see stock-products.ts). */
function validateComponents(components: LinkListingArgs["components"]): void {
  if (components.length === 0) throw new StockError("INVALID_QUANTITY", "Un vínculo necesita al menos un componente");
  const seen = new Set<number>();
  for (const c of components) {
    const q = toNum(c.quantity);
    if (!Number.isFinite(q) || q <= 0) throw new StockError("INVALID_QUANTITY", "La cantidad de cada componente debe ser mayor a 0");
    if (seen.has(c.productId)) throw new StockError("INVALID_QUANTITY", "Un producto no puede repetirse en el mismo vínculo");
    seen.add(c.productId);
  }
}

async function loadProducts(accountId: string, components: LinkListingArgs["components"]): Promise<Map<number, ProductIdentity>> {
  const products = await getProductIdentities(accountId, components.map((c) => c.productId));
  for (const c of components) {
    const p = products.get(c.productId);
    if (!p) throw new StockError("PRODUCT_NOT_FOUND", `Producto ${c.productId} no existe`);
    if (p.archived) throw new StockError("PRODUCT_ARCHIVED", `Producto ${p.name} está archivado`);
  }
  return products;
}

/**
 * Fields to fill from the listing. Only a simple (single-component) link enriches: a combo's GTIN/title
 * describe the pack, not any one component.
 */
async function computePlan(
  accountId: string, args: LinkListingArgs, products: Map<number, ProductIdentity>, target: ListingTarget | null,
): Promise<LinkPlan> {
  if (args.components.length !== 1) return [];
  const productId = args.components[0]!.productId;
  if (!target) return [{ productId, fills: {} }];
  const p = products.get(productId)!;
  const fills: ProductFills = {};
  if (!p.ean && /^\d{8,14}$/.test(target.gtin)) {
    const owner = await db.inventoryProduct.findUnique({ where: { accountId_ean: { accountId, ean: target.gtin } }, select: { id: true } });
    if (!owner) fills.ean = target.gtin;
  }
  if (!p.sku && target.skus[0]) fills.sku = target.skus[0];
  if (!p.name.trim() && target.title?.trim()) fills.name = target.title.trim();
  return [{ productId, fills }];
}

export function createLinking(d: LinkingDeps = defaultDeps) {
  async function plan(args: LinkListingArgs): Promise<{ plan: LinkPlan; products: Map<number, ProductIdentity> }> {
    validateComponents(args.components);
    const products = await loadProducts(args.accountId, args.components);
    const target = await getTarget(args.accountId, args.marketplace, args.itemId, args.variationId);
    return { plan: await computePlan(args.accountId, args, products, target), products };
  }

  /** What `linkListing(args, {fillMissing: true})` would fill, without writing anything. */
  async function previewLink(args: LinkListingArgs): Promise<LinkPlan> {
    return (await plan(args)).plan;
  }

  async function linkListing(args: LinkListingArgs, opts: { fillMissing?: boolean } = {}): Promise<LinkResult> {
    const fillMissing = opts.fillMissing ?? true;
    const { plan: fillPlan } = await plan(args);
    const applied: LinkPlan = fillMissing ? fillPlan : [];
    const linkId = await db.$transaction(async (tx) => {
      const id = await replaceLink(tx, args.accountId, args.marketplace, args.itemId, args.variationId, args.components);
      for (const item of applied) await fillProductFields(args.accountId, item.productId, item.fills, tx);
      return id;
    });

    const pending = await d.pendingSales(args.accountId, args.itemId, args.variationId);
    if (pending > 0) {
      const after = await getProductIdentities(args.accountId, args.components.map((c) => c.productId));
      for (const c of args.components) {
        const p = after.get(c.productId)!;
        await d.alerts.raiseAlert({
          accountId: args.accountId, type: "link_cost_review", marketplace: args.marketplace, itemId: args.itemId,
          productId: c.productId, quantity: pending, amount: p.unitCost,
          dedupeKey: args.components.length === 1 ? costReviewKey(args.marketplace, args.itemId, args.variationId) : `${costReviewKey(args.marketplace, args.itemId, args.variationId)}:${c.productId}`,
          title: `Confirmar costo de ${p.name}`,
          detail: `${pending} venta(s) pendientes de «${args.itemId}» se aplicarán con el costo actual (${p.unitCost}) cuando lo confirmes o edites.`,
        });
      }
    }
    if (!(await hasUnlinkedTarget(args.accountId, args.marketplace, args.itemId))) {
      await d.alerts.resolveAlert(args.accountId, unmatchedKey(args.marketplace, args.itemId), "auto");
    }
    return { linkId, plan: applied };
  }

  async function unlinkListing(accountId: string, linkId: number): Promise<void> {
    if (!(await deleteLink(accountId, linkId))) throw new StockError("LINK_NOT_FOUND", `Vínculo ${linkId} no existe`);
  }

  async function raiseUnmatchedAlerts(accountId: string, unlinked: ListingTarget[]): Promise<void> {
    const byItem = new Map<string, ListingTarget[]>();
    for (const t of unlinked) byItem.set(t.itemId, [...(byItem.get(t.itemId) ?? []), t]);
    for (const [itemId, ts] of byItem) {
      const first = ts[0]!;
      await d.alerts.raiseAlert({
        accountId, type: "unmatched_listing", marketplace: MERCADOLIBRE, itemId,
        dedupeKey: unmatchedKey(MERCADOLIBRE, itemId),
        title: `Publicación sin producto: ${first.title ?? itemId}`,
        detail: JSON.stringify({
          title: first.title, itemId, gtin: first.itemGtin || null, variations: first.variations,
          skus: [...new Set(ts.flatMap((t) => t.skus))],
          unlinkedVariationIds: ts.flatMap((t) => (t.variationId === null ? [] : [t.variationId])),
        }),
      });
    }
  }

  /** Links every unlinked listing/variation whose GTIN equals a product EAN; alerts for the rest. */
  async function autoLink(accountId: string): Promise<{ linkIds: number[] }> {
    const [targets, byEan] = await Promise.all([listUnlinkedTargets(accountId, MERCADOLIBRE), eanIndex(accountId)]);
    const linkIds: number[] = [];
    const left: ListingTarget[] = [];
    for (const t of targets) {
      const productId = t.gtin ? byEan.get(t.gtin) : undefined;
      if (productId === undefined) { left.push(t); continue; }
      const linkId = await db.$transaction((tx) =>
        replaceLink(tx, accountId, MERCADOLIBRE, t.itemId, t.variationId, [{ productId, quantity: 1 }]));
      linkIds.push(linkId);
      const pending = await d.pendingSales(accountId, t.itemId, t.variationId);
      if (pending > 0) {
        const p = (await getProductIdentities(accountId, [productId])).get(productId)!;
        await d.alerts.raiseAlert({
          accountId, type: "link_cost_review", marketplace: MERCADOLIBRE, itemId: t.itemId, productId, quantity: pending, amount: p.unitCost,
          dedupeKey: costReviewKey(MERCADOLIBRE, t.itemId, t.variationId), title: `Confirmar costo de ${p.name}`,
          detail: `${pending} venta(s) pendientes de «${t.itemId}» se aplicarán con el costo actual (${p.unitCost}) cuando lo confirmes o edites.`,
        });
      }
    }
    const stillOpen = new Set(left.map((t) => t.itemId));
    for (const id of new Set(targets.map((t) => t.itemId))) {
      if (!stillOpen.has(id)) await d.alerts.resolveAlert(accountId, unmatchedKey(MERCADOLIBRE, id), "auto");
    }
    await raiseUnmatchedAlerts(accountId, left);
    return { linkIds };
  }

  /** Unlinked listings (per variation when the listing has them) with the data the link form needs. */
  async function unlinkedListings(accountId: string): Promise<UnlinkedListing[]> {
    return (await listUnlinkedTargets(accountId, MERCADOLIBRE)).map((t) => ({
      marketplace: MERCADOLIBRE, itemId: t.itemId, variationId: t.variationId, title: t.title,
      gtin: t.gtin || null, skus: t.skus, variations: t.variations,
    }));
  }

  return {
    autoLink, autoLinkByEan: autoLink, previewLink, linkListing, unlinkListing, unlinkedListings,
  };
}

export type Linking = ReturnType<typeof createLinking>;
/** The linking service wired with the shared dependencies (see `configureStock`). */
export const linking: Linking = new Proxy({} as Linking, {
  get: (_t, prop: keyof Linking) => createLinking(deps)[prop],
});

export interface NewProductWithStock {
  name: string;
  ean?: string | null;
  sku?: string | null;
  model?: string;
  category?: string;
  minUnits?: number | null;
  initialStock?: number;
  initialCost?: number;
}

/**
 * Creates a product (EAN uniqueness enforced by the store) and, when `initialStock` > 0, enters it through the
 * ledger as `initial_count` with an explanatory reason. Errors: DuplicateEanError, INVALID_QUANTITY.
 */
export async function createProductWithStock(accountId: string, input: NewProductWithStock): Promise<ProductIdentity> {
  const { initialStock, initialCost, ...fields } = input;
  const stock = initialStock ?? 0;
  if (!Number.isFinite(stock) || stock < 0) throw new StockError("INVALID_QUANTITY", "El stock inicial no puede ser negativo");
  if (stock > 0 && (initialCost === undefined || !Number.isFinite(initialCost) || initialCost < 0)) {
    throw new StockError("INVALID_QUANTITY", "Con stock inicial hace falta el costo inicial");
  }
  const product = await createProduct(accountId, fields);
  if (stock > 0) {
    await services.ledger.appendMovement({
      accountId, productId: product.id, type: "initial_count", quantity: stock, unitCost: initialCost!,
      occurredAt: new Date(), idempotencyKey: `initial:${product.id}`, reason: "Stock inicial al crear el producto", actor: "user",
    });
  }
  return product;
}
