import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://pnl:pnl@localhost:5432/pnl_s9";
});
vi.mock("~/env", () => ({ env: { NODE_ENV: "test" } }));
const user = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: user.id }) }));

import { db } from "~/server/db";
import { POST } from "./route";

const U = "inv_route_user";
const sample = readFileSync(path.join(__dirname, "../../../../server/invoices/__fixtures__/sony-0225-00085935.pdf"));
const req = (file?: File) => {
  const form = new FormData();
  if (file) form.set("file", file);
  return new Request("http://x/api/invoices/upload", { method: "POST", body: form });
};
const pdf = (name = "f.pdf", bytes: BlobPart = sample as unknown as BlobPart) => new File([bytes], name, { type: "application/pdf" });

beforeEach(async () => { user.id = U; await db.account.deleteMany({ where: { id: U } }); });
afterAll(async () => { await db.account.deleteMany({ where: { id: U } }); await db.$disconnect(); });

describe("POST /api/invoices/upload", () => {
  it("requires a session", async () => {
    user.id = null;
    expect((await POST(req(pdf()))).status).toBe(401);
  });
  it("rejects missing, non-pdf and fake-pdf files", async () => {
    expect((await POST(req())).status).toBe(400);
    expect((await POST(req(pdf("a.xlsx")))).status).toBe(400);
    expect((await POST(req(pdf("a.pdf", "not a pdf at all")))).status).toBe(400);
  });
  it("creates a draft, then answers 409 with the existing invoice for a duplicate", async () => {
    const ok = await POST(req(pdf()));
    expect(ok.status).toBe(200);
    const { invoiceId } = (await ok.json()) as { invoiceId: number };
    const dup = await POST(req(pdf()));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ existingInvoiceId: invoiceId });
  });
});
