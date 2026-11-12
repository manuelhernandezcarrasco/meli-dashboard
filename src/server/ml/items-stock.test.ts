import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenAuth } from "./http";
import { getItemsStock, getItemStock } from "./items-stock";

vi.mock("./tokens", () => ({ tokenAuthFor: () => { throw new Error("no tokens in tests"); } }));
const auth: TokenAuth = { getAccessToken: () => Promise.resolve("t"), refresh: () => Promise.resolve() };
afterEach(() => vi.unstubAllGlobals());

const entry = (id: string, extra: object = {}) => ({
  code: 200,
  body: { id, available_quantity: 4, status: "active", listing_type_id: "gold_special", shipping: { logistic_type: "cross_docking" }, variations: [], ...extra },
});

describe("items stock reads", () => {
  it("maps the multiget response", async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([entry("MLA1", { variations: [{ id: 5, available_quantity: 2 }], shipping: { logistic_type: "fulfillment" } })])),
    );
    vi.stubGlobal("fetch", f);
    const s = await getItemStock("a", "mla1", { auth });
    expect(s).toEqual({
      itemId: "MLA1", available_quantity: 4, status: "active", listing_type_id: "gold_special",
      variations: [{ id: 5, available_quantity: 2 }], logistic_type: "fulfillment",
    });
    expect((f.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });
  it("20 ids per call; missing/error entries are absent", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `MLA${i + 1}`);
    const f = vi.fn().mockImplementation((url: string) => {
      const asked = new URL(url).searchParams.get("ids")!.split(",");
      return Promise.resolve(new Response(JSON.stringify(asked.map((id) => (id === "MLA3" ? { code: 404, body: { id } } : entry(id))))));
    });
    vi.stubGlobal("fetch", f);
    const m = await getItemsStock("a", ids, { auth });
    expect(f).toHaveBeenCalledTimes(3);
    expect(m.size).toBe(44);
    expect(m.has("MLA3")).toBe(false);
  });
});
