import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("~/server/stock/sales", () => ({ reconcileAll: vi.fn() }));

import { GET, handlers } from "./route";

const call = (auth?: string) => GET(new Request("http://x/api/cron/stock-reconcile", { headers: auth ? { authorization: auth } : {} }));
const run = vi.fn();

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  run.mockReset().mockResolvedValue([{ accountId: "a", orders: 2, applied: 1, errors: 0 }]);
  handlers.reconcileAll = run;
});

describe("GET /api/cron/stock-reconcile", () => {
  it("rejects a missing or wrong secret with 401 and runs nothing", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await call("s3cret")).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects everything when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    expect((await call("Bearer ")).status).toBe(401);
    expect((await call("Bearer undefined")).status).toBe(401);
  });

  it("runs the reconcile with the right secret", async () => {
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accounts: 1 });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports failures without throwing", async () => {
    run.mockResolvedValue([{ accountId: "a", orders: 1, applied: 0, errors: 1 }]);
    expect(await (await call("Bearer s3cret")).json()).toMatchObject({ ok: false });
  });
});
