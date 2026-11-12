import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenAuth } from "./http";
import { setAvailableQuantity } from "./stock-write";

vi.mock("./tokens", () => ({ tokenAuthFor: () => { throw new Error("tokens must not be used in tests"); } }));

const auth: TokenAuth = { getAccessToken: () => Promise.resolve("t"), refresh: () => Promise.resolve() };
afterEach(() => vi.unstubAllGlobals());
const stub = () => {
  const f = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", f);
  return f;
};

describe("setAvailableQuantity", () => {
  it("listing: PUT /items/{id} with available_quantity only", async () => {
    const f = stub();
    await setAvailableQuantity({ accountId: "a", itemId: "mla123", quantity: 7, auth });
    const [url, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.mercadolibre.com/items/MLA123");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ available_quantity: 7 });
  });
  it("variation: variations payload only", async () => {
    const f = stub();
    await setAvailableQuantity({ accountId: "a", itemId: "MLA123", variationId: 99, quantity: 2, auth });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ variations: [{ id: 99, available_quantity: 2 }] });
  });
  it.each([-1, 1.2, NaN, Infinity])("rejects quantity %s without sending", async (q) => {
    const f = stub();
    await expect(setAvailableQuantity({ accountId: "a", itemId: "MLA1", quantity: q, auth })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it("0 is allowed", async () => {
    const f = stub();
    await setAvailableQuantity({ accountId: "a", itemId: "MLA1", quantity: 0, auth });
    expect(f).toHaveBeenCalledOnce();
  });
});
