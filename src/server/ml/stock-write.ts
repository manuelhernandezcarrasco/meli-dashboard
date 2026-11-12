/**
 * The only code that writes to Mercado Libre: sets `available_quantity` of an item or of one variation.
 * Everything else stays read-only (see http.ts). Called only by the push engine (src/server/stock/push.ts).
 */
import { mlPutStock, type TokenAuth } from "./http";
import { tokenAuthFor } from "./tokens";

const API = "https://api.mercadolibre.com";

export interface SetAvailableQuantityArgs {
  /** Tenant whose Mercado Libre tokens are used (ignored when `auth` is given). */
  accountId: string;
  itemId: string;
  /** Set for a variation of the item; omit for a listing without variations. */
  variationId?: number | null;
  /** Integer >= 0. */
  quantity: number;
  /** Injectable for tests. */
  auth?: TokenAuth;
}

/** `PUT /items/{id}` with `available_quantity` only (or `variations: [{id, available_quantity}]`). One attempt; throws MlWriteError. */
export async function setAvailableQuantity(a: SetAvailableQuantityArgs): Promise<void> {
  if (!Number.isInteger(a.quantity) || a.quantity < 0) {
    throw new RangeError(`available_quantity must be an integer >= 0, got ${a.quantity}`);
  }
  const itemId = a.itemId.trim().toUpperCase();
  const body =
    a.variationId == null
      ? { available_quantity: a.quantity }
      : { variations: [{ id: a.variationId, available_quantity: a.quantity }] };
  await mlPutStock(`${API}/items/${itemId}`, body, a.auth ?? tokenAuthFor(a.accountId));
}
