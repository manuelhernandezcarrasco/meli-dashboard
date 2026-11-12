import { afterEach, describe, expect, it, vi } from "vitest";
import { MlWriteError, mlFetch, mlPutStock, ReadOnlyViolationError, type TokenAuth } from "./http";

const sleep = () => Promise.resolve();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function stubFetch(...responses: Response[]) {
  const f = vi.fn();
  for (const r of responses) f.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe("read-only guard", () => {
  it.each(["PUT", "POST", "DELETE", "PATCH"])("blocks %s to ML", async (m) => {
    const f = stubFetch(json({}));
    await expect(
      mlFetch(m, "https://api.mercadolibre.com/items/MLA1"),
    ).rejects.toBeInstanceOf(ReadOnlyViolationError);
    expect(f).not.toHaveBeenCalled();
  });
  it("blocks GET to other hosts", async () => {
    const f = stubFetch(json({}));
    await expect(mlFetch("GET", "https://evil.com/x")).rejects.toBeInstanceOf(
      ReadOnlyViolationError,
    );
    expect(f).not.toHaveBeenCalled();
  });
  it("blocks POST to /orders/search", async () => {
    stubFetch(json({}));
    await expect(
      mlFetch("POST", "https://api.mercadolibre.com/orders/search"),
    ).rejects.toBeInstanceOf(ReadOnlyViolationError);
  });
  it("allows the oauth token POST", async () => {
    const f = stubFetch(json({ access_token: "a" }));
    const r = await mlFetch("POST", "https://api.mercadolibre.com/oauth/token", {
      form: { grant_type: "refresh_token" },
    });
    expect(r).toEqual({ access_token: "a" });
    expect(f).toHaveBeenCalledOnce();
  });
  it("allows GET to Mercado Pago", async () => {
    stubFetch(json({ id: 1 }));
    await expect(mlFetch("GET", "https://api.mercadopago.com/v1/payments/1")).resolves.toEqual({ id: 1 });
  });
});

describe("retry behaviour", () => {
  const url = "https://api.mercadolibre.com/users/me";
  const makeAuth = () => {
    let token = "old";
    const auth: TokenAuth = {
      getAccessToken: () => Promise.resolve(token),
      refresh: vi.fn(() => {
        token = "new";
        return Promise.resolve();
      }),
    };
    return auth;
  };

  it("401 → refresh once → retry succeeds", async () => {
    const f = stubFetch(json({}, 401), json({ ok: 1 }));
    const auth = makeAuth();
    await expect(mlFetch("GET", url, { auth, sleep })).resolves.toEqual({ ok: 1 });
    expect(auth.refresh).toHaveBeenCalledOnce();
    const h = (f.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer new");
  });
  it("second 401 throws", async () => {
    stubFetch(json({}, 401), json({}, 401));
    const auth = makeAuth();
    await expect(mlFetch("GET", url, { auth, sleep })).rejects.toThrow(/HTTP 401/);
    expect(auth.refresh).toHaveBeenCalledOnce();
  });
  it("429 then 200 returns the body", async () => {
    stubFetch(json({}, 429), json({ ok: 2 }));
    await expect(mlFetch("GET", url, { sleep })).resolves.toEqual({ ok: 2 });
  });
  it("404 returns null", async () => {
    stubFetch(json({}, 404));
    await expect(mlFetch("GET", url, { sleep })).resolves.toBeNull();
  });
  it("other errors include status and truncated body", async () => {
    stubFetch(new Response("x".repeat(500), { status: 400 }));
    const err = await mlFetch("GET", url, { sleep }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^HTTP 400 en /);
    expect((err as Error).message.length).toBeLessThan(400);
  });
  it("gives up after 4 retryable failures", async () => {
    const f = stubFetch(json({}, 503), json({}, 503), json({}, 503), json({}, 503));
    await expect(mlFetch("GET", url, { sleep })).rejects.toThrow(/No pude conectar/);
    expect(f).toHaveBeenCalledTimes(4);
  });
});

describe("stock write exception", () => {
  const auth: TokenAuth = { getAccessToken: () => Promise.resolve("tok"), refresh: vi.fn(() => Promise.resolve()) };
  const ML = "https://api.mercadolibre.com";

  it("mlFetch still blocks PUT /items/{id}, even with a stock body", async () => {
    const f = stubFetch(json({}));
    await expect(mlFetch("PUT", `${ML}/items/MLA1`, { auth })).rejects.toBeInstanceOf(ReadOnlyViolationError);
    expect(f).not.toHaveBeenCalled();
  });

  it("mlPutStock sends exactly one PUT with the stock body and bearer token", async () => {
    const f = stubFetch(json({ id: "MLA1" }));
    await mlPutStock(`${ML}/items/MLA1`, { available_quantity: 3 }, auth);
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${ML}/items/MLA1`);
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"available_quantity":3}');
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("variation body is allowed", async () => {
    const f = stubFetch(json({}));
    await mlPutStock(`${ML}/items/MLA1`, { variations: [{ id: 55, available_quantity: 0 }] }, auth);
    expect(f).toHaveBeenCalledOnce();
  });

  it.each([
    ["other path", `${ML}/items/MLA1/description`, { available_quantity: 1 }],
    ["other resource", `${ML}/orders/1`, { available_quantity: 1 }],
    ["other host", "https://evil.com/items/MLA1", { available_quantity: 1 }],
    ["mercado pago", "https://api.mercadopago.com/items/MLA1", { available_quantity: 1 }],
    ["http", "http://api.mercadolibre.com/items/MLA1", { available_quantity: 1 }],
    ["query string", `${ML}/items/MLA1?x=1`, { available_quantity: 1 }],
    ["bad item id", `${ML}/items/abc`, { available_quantity: 1 }],
    ["negative", `${ML}/items/MLA1`, { available_quantity: -1 }],
    ["fraction", `${ML}/items/MLA1`, { available_quantity: 1.5 }],
    ["extra key", `${ML}/items/MLA1`, { available_quantity: 1, price: 5 }],
    ["variation extra key", `${ML}/items/MLA1`, { variations: [{ id: 1, available_quantity: 1, price: 5 }] }],
    ["empty variations", `${ML}/items/MLA1`, { variations: [] }],
  ])("blocks %s", async (_n, url, body) => {
    const f = stubFetch(json({}));
    await expect(mlPutStock(url, body as never, auth)).rejects.toBeInstanceOf(ReadOnlyViolationError);
    expect(f).not.toHaveBeenCalled();
  });

  it("maps HTTP errors to MlWriteError with the status and does not retry", async () => {
    const f = stubFetch(new Response("bad", { status: 400 }));
    const e = await mlPutStock(`${ML}/items/MLA1`, { available_quantity: 1 }, auth).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MlWriteError);
    expect((e as MlWriteError).status).toBe(400);
    expect(f).toHaveBeenCalledOnce();
  });

  it("network failure is MlWriteError status 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const e = await mlPutStock(`${ML}/items/MLA1`, { available_quantity: 1 }, auth).catch((x: unknown) => x);
    expect((e as MlWriteError).status).toBe(0);
  });

  it("401 refreshes the token once and resends", async () => {
    const f = stubFetch(json({}, 401), json({}));
    await mlPutStock(`${ML}/items/MLA1`, { available_quantity: 1 }, auth);
    expect(auth.refresh).toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
