import { beforeEach, describe, expect, it, vi } from "vitest";

const row: { v: Record<string, unknown> | null } = { v: null };
vi.mock("~/env", () => ({
  env: { ML_CLIENT_ID: "cid", ML_CLIENT_SECRET: "sec", ML_REDIRECT_URI: "http://localhost/cb" },
}));
vi.mock("~/server/db", () => ({
  db: {
    mlToken: {
      findUnique: vi.fn(() => Promise.resolve(row.v)),
      upsert: vi.fn(({ update }: { update: Record<string, unknown> }) => {
        row.v = { id: 1, ...update };
        return Promise.resolve();
      }),
    },
  },
}));

import { ensureToken } from "./tokens";

beforeEach(() => {
  vi.unstubAllGlobals();
  row.v = {
    id: 1,
    accessToken: "old-access",
    refreshToken: "old-refresh",
    userId: 123n,
    expiresAt: new Date(Date.now() - 1000),
  };
});

describe("ensureToken", () => {
  it("5 parallel calls with an expired token do exactly one refresh and store the new refresh token", async () => {
    const f = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", user_id: 123, expires_in: 21600 }),
      );
    });
    vi.stubGlobal("fetch", f);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => ensureToken()));
    expect(f).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(Array(5).fill("new-access"));
    expect(row.v?.refreshToken).toBe("new-refresh");
    const body = ((f.mock.calls[0] as unknown[])[1] as RequestInit).body as string;
    expect(body).toContain("refresh_token=old-refresh");
  });

  it("does not refresh a token that is still valid", async () => {
    row.v!.expiresAt = new Date(Date.now() + 3600_000);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(ensureToken()).resolves.toBe("old-access");
    expect(f).not.toHaveBeenCalled();
  });
});
