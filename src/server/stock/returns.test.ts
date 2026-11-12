import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s8";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));

import type { AppendMovementInput } from "./contracts";
import {
  createReturnsService, ReturnNotFoundError, type ReturnRecord, type ReturnsDeps, type ReturnsStore,
} from "./returns";

const ACC = "acc";

/** In-memory store with the same conditional-transition semantics as the SQL one. */
function fakeStore(): ReturnsStore & { rows: Map<number, ReturnRecord> } {
  const rows = new Map<number, ReturnRecord>();
  let seq = 0;
  return {
    rows,
    async insert(i) {
      const dup = [...rows.values()].find(
        (r) => r.accountId === i.accountId && r.orderId === i.orderId && r.lineNo === i.lineNo,
      );
      if (dup) return { record: dup, created: false };
      const record: ReturnRecord = {
        id: ++seq, accountId: i.accountId, marketplace: "mercadolibre", orderId: i.orderId, lineNo: i.lineNo,
        productId: i.productId, quantity: i.quantity, outcome: "pending", reason: i.reason ?? null,
        openedAt: new Date(), resolvedAt: null, note: null,
      };
      rows.set(record.id, record);
      return { record, created: true };
    },
    async get(_a, id) { return rows.get(id) ?? null; },
    async transition(_a, id, from, to, note, resolvedAt) {
      const r = rows.get(id);
      if (!r || r.outcome !== from) return null;
      const next = { ...r, outcome: to, note: note ?? r.note, resolvedAt };
      rows.set(id, next);
      return next;
    },
  };
}

function setup() {
  const store = fakeStore();
  const movements = new Map<string, AppendMovementInput>();
  const bucket = { onHand: 10, inRepair: 0 };
  const pushes: { productIds: number[]; ref?: string }[] = [];
  const evaluated: number[][] = [];
  const deps: ReturnsDeps = {
    store,
    ledger: {
      async appendMovement(m) {
        const q = Number(m.quantity);
        const created = !movements.has(m.idempotencyKey);
        if (created) {
          movements.set(m.idempotencyKey, m);
          if (m.type === "return_restock") bucket.onHand += q;
          if (m.type === "repair_in" || m.type === "repair_out") bucket.inRepair += q;
        }
        return { movementId: movements.size, created, onHandAfter: bucket.onHand as never, unitCostAfter: 0 as never };
      },
    },
    push: {
      async requestPush(_a, productIds, t) { pushes.push({ productIds, ref: t.ref }); },
    },
    alerts: { async evaluateProducts(_a, ids) { evaluated.push(ids); } },
    now: () => new Date("2026-11-12T12:00:00Z"),
  };
  const svc = createReturnsService(deps);
  const open = async (lineNo = 0, quantity = 2) =>
    (await svc.openReturn({ accountId: ACC, orderId: 100, lineNo, productId: 7, quantity })).record;
  return { svc, store, movements, bucket, pushes, evaluated, open };
}

const types = (m: Map<string, AppendMovementInput>) => [...m.values()].map((x) => x.type);

describe("openReturn", () => {
  it("creates a pending case and is idempotent per order line", async () => {
    const { svc } = setup();
    const a = await svc.openReturn({ accountId: ACC, orderId: 1, lineNo: 0, productId: 7, quantity: 1, reason: "x" });
    const b = await svc.openReturn({ accountId: ACC, orderId: 1, lineNo: 0, productId: 7, quantity: 1 });
    expect(a.created).toBe(true);
    expect(a.record.outcome).toBe("pending");
    expect(b.created).toBe(false);
    expect(b.record.id).toBe(a.record.id);
  });
  it("rejects non-positive quantity", async () => {
    const { svc } = setup();
    await expect(svc.openReturn({ accountId: ACC, orderId: 1, lineNo: 0, productId: 7, quantity: 0 }))
      .rejects.toMatchObject({ code: "INVALID_QUANTITY" });
  });
});

describe("resolveReturn transitions", () => {
  it("pending → lost writes no movement and stores note", async () => {
    const { svc, open, movements, pushes } = setup();
    const r = await open();
    const out = await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "lost", note: "never came back" });
    expect(out.outcome).toBe("lost");
    expect(out.note).toBe("never came back");
    expect(out.resolvedAt).not.toBeNull();
    expect(movements.size).toBe(0);
    expect(pushes).toEqual([]);
  });

  it("pending → in_repair: repair_in only, inRepair += qty, onHand unchanged, not resolved", async () => {
    const { svc, open, movements, bucket, pushes } = setup();
    const r = await open(0, 3);
    const out = await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "in_repair" });
    expect(out.outcome).toBe("in_repair");
    expect(out.resolvedAt).toBeNull();
    expect(types(movements)).toEqual(["repair_in"]);
    expect(movements.get(`return:${r.id}:in_repair`)).toMatchObject({ productId: 7, quantity: 3, refType: "return" });
    expect(bucket).toEqual({ onHand: 10, inRepair: 3 });
    expect(pushes).toEqual([]);
  });

  it("pending → restocked: return_restock, onHand += qty, push + alert evaluation", async () => {
    const { svc, open, movements, bucket, pushes, evaluated } = setup();
    const r = await open(0, 2);
    const out = await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "restocked", confirmRestock: true });
    expect(out.outcome).toBe("restocked");
    expect(types(movements)).toEqual(["return_restock"]);
    expect(bucket).toEqual({ onHand: 12, inRepair: 0 });
    expect(pushes).toEqual([{ productIds: [7], ref: `return:${r.id}` }]);
    expect(evaluated).toEqual([[7]]);
  });

  it("restock without confirmation is rejected and changes nothing", async () => {
    const { svc, open, movements, store } = setup();
    const r = await open();
    await expect(svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "restocked" }))
      .rejects.toMatchObject({ code: "RETURN_TRANSITION", message: expect.stringContaining("confirm") });
    expect(movements.size).toBe(0);
    expect(store.rows.get(r.id)!.outcome).toBe("pending");
  });

  it("in_repair → restocked: repair_out then return_restock, inRepair back to 0, onHand += qty", async () => {
    const { svc, open, movements, bucket, pushes } = setup();
    const r = await open(0, 3);
    await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "in_repair" });
    const out = await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "restocked", confirmRestock: true });
    expect(out.outcome).toBe("restocked");
    expect(types(movements)).toEqual(["repair_in", "repair_out", "return_restock"]);
    expect(movements.get(`return:${r.id}:restocked:repair_out`)!.quantity).toBe(-3);
    expect(bucket).toEqual({ onHand: 13, inRepair: 0 });
    expect(pushes).toHaveLength(1);
  });

  it("in_repair → lost: repair_out, no restock, no push", async () => {
    const { svc, open, movements, bucket, pushes } = setup();
    const r = await open(0, 3);
    await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "in_repair" });
    const out = await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "lost", note: "dead" });
    expect(out.outcome).toBe("lost");
    expect(types(movements)).toEqual(["repair_in", "repair_out"]);
    expect(bucket).toEqual({ onHand: 10, inRepair: 0 });
    expect(pushes).toEqual([]);
  });

  const terminal = ["lost", "restocked"] as const;
  const targets = ["lost", "in_repair", "restocked"] as const;
  for (const from of terminal) {
    for (const to of targets) {
      if (to === from) continue;
      it(`${from} → ${to} is rejected`, async () => {
        const { svc, open } = setup();
        const r = await open();
        await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: from, confirmRestock: true });
        await expect(svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: to, confirmRestock: true }))
          .rejects.toMatchObject({ code: "RETURN_TRANSITION" });
      });
    }
  }

  it("in_repair → in_repair is a no-op replay (no second movement)", async () => {
    const { svc, open, movements } = setup();
    const r = await open();
    await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "in_repair" });
    await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "in_repair" });
    expect(movements.size).toBe(1);
  });

  it("replaying restocked returns the case, writes no new movement, re-requests the push", async () => {
    const { svc, open, movements, bucket, pushes } = setup();
    const r = await open(0, 2);
    const args = { accountId: ACC, returnId: r.id, outcome: "restocked" as const, confirmRestock: true };
    await svc.resolveReturn(args);
    await svc.resolveReturn(args);
    expect(movements.size).toBe(1);
    expect(bucket.onHand).toBe(12);
    expect(pushes).toHaveLength(2);
  });

  it("crash after the movement but before the state change: retry finishes without double-counting", async () => {
    const { svc, open, store, movements, bucket } = setup();
    const r = await open(0, 2);
    const real = store.transition;
    let fail = true;
    store.transition = async (...a) => { if (fail) { fail = false; throw new Error("db down"); } return real(...a); };
    await expect(svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "in_repair" })).rejects.toThrow("db down");
    const out = await svc.resolveReturn({ accountId: ACC, returnId: r.id, outcome: "in_repair" });
    expect(out.outcome).toBe("in_repair");
    expect(movements.size).toBe(1);
    expect(bucket.inRepair).toBe(2);
  });

  it("unknown case → ReturnNotFoundError", async () => {
    const { svc } = setup();
    await expect(svc.resolveReturn({ accountId: ACC, returnId: 999, outcome: "lost" }))
      .rejects.toBeInstanceOf(ReturnNotFoundError);
  });
});
