import { afterEach, describe, expect, it, vi } from "vitest";
import { mlFetch, ReadOnlyViolationError, type TokenAuth } from "./http";

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
