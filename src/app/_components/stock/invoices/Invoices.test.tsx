// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Review } from "./types";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const m = vi.hoisted(() => {
  const m = {
    list: vi.fn(),
    getDraft: vi.fn(),
    search: vi.fn(),
    calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  };
  const mutation = (name: string) => {
    const fn = vi.fn();
    m.calls[name] = fn;
    return {
      useMutation: (o?: { onSuccess?: () => void }) => ({
        mutate: (i: unknown, opts?: { onSuccess?: () => void; onSettled?: () => void }) => {
          fn(i);
          o?.onSuccess?.();
          opts?.onSuccess?.();
          opts?.onSettled?.();
        },
        isPending: false,
        error: null,
        reset: vi.fn(),
      }),
    };
  };
  return { ...m, mutation };
});
vi.mock("~/trpc/react", () => ({
  api: {
    stockInvoices: {
      list: { useQuery: () => m.list() },
      getDraft: { useQuery: () => m.getDraft() },
      setFeeFactor: m.mutation("setFeeFactor"),
      matchLine: m.mutation("matchLine"),
      createProductFromLine: m.mutation("createProductFromLine"),
      skipLine: m.mutation("skipLine"),
      confirm: m.mutation("confirm"),
      discard: m.mutation("discard"),
    },
    stockProducts: { list: { useQuery: (i: unknown, o: unknown) => m.search(i, o) } },
  },
}));

import { InvoiceReviewPage } from "./InvoiceReviewPage";
import { InvoicesList } from "./InvoicesList";
import { uploadInvoice, validatePdf } from "./upload";

const base: Review = {
  invoiceId: 7, status: "draft", supplierName: "Sony Argentina S.A.", supplierTaxId: "30679928879", number: "0225-00085935",
  issueDate: "2026-08-28", currency: "ARS", subtotal: 100, ivaAmount: 21, perceptionsAmount: 6, otherTaxesAmount: 0, total: 127,
  feeFactor: 1.27, feeFactorOverridden: false, warnings: [], canConfirm: true,
  lines: [
    { lineNo: 1, supplierCode: "A1", ean: "4548736000000", description: "Cámara", quantity: 2, unitPrice: 100, discount: 0, lineSubtotal: 200,
      landedUnitCost: 127, resolution: "auto_ean", productId: 1, productName: "Cámara ZV", willFill: {}, stockNow: 2, costNow: 100 },
    { lineNo: 2, supplierCode: "B2", ean: null, description: "Cable raro", quantity: 3, unitPrice: 10, discount: 0, lineSubtotal: 30,
      landedUnitCost: 12.7, resolution: "unresolved", productId: null, productName: null, willFill: {} },
  ],
};
const withLine2Resolved = (): Review => ({
  ...base,
  lines: [base.lines[0]!, { ...base.lines[1]!, resolution: "manual_match", productId: 2, productName: "Cable", stockNow: 0, costNow: 0 }],
});

beforeEach(() => {
  push.mockReset();
  Object.values(m.calls).forEach((f) => f.mockReset());
  m.getDraft.mockReturnValue({ data: base, isLoading: false, error: null, refetch: vi.fn() });
  m.search.mockReturnValue({ data: undefined, isLoading: false, error: null });
});
afterEach(cleanup);

describe("upload helpers", () => {
  it("rejects non PDFs and oversized files in Spanish", () => {
    expect(validatePdf({ name: "a.xlsx", type: "application/vnd.ms-excel", size: 10 })).toMatch(/PDF/);
    expect(validatePdf({ name: "a.pdf", type: "application/pdf", size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
    expect(validatePdf({ name: "a.pdf", type: "application/pdf", size: 5 })).toBeNull();
  });
  it("maps a 409 to the duplicate message with the existing id", async () => {
    const f = new File(["%PDF"], "f.pdf", { type: "application/pdf" });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ existingInvoiceId: 4 }), { status: 409 }));
    const r = await uploadInvoice(f, fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, existingInvoiceId: 4 });
    expect(!r.ok && r.message).toMatch(/ya fue cargada/);
  });
  it("explains a PDF without text and network failures", async () => {
    const f = new File(["%PDF"], "f.pdf", { type: "application/pdf" });
    const scanned = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "El PDF no tiene texto" }), { status: 422 }));
    expect(await uploadInvoice(f, scanned as unknown as typeof fetch)).toMatchObject({ message: expect.stringMatching(/no tiene texto/) });
    const down = vi.fn().mockRejectedValue(new Error("x"));
    expect(await uploadInvoice(f, down as unknown as typeof fetch)).toMatchObject({ message: expect.stringMatching(/conexión/) });
  });
});

describe("<InvoicesList />", () => {
  it("lists invoices with status and shows the duplicate link after upload", async () => {
    m.list.mockReturnValue({
      data: [
        { invoiceId: 4, supplierName: "Sony", number: "0225-1", issueDate: "2026-08-28", total: 1000, status: "applied", lineCount: 3, unresolvedLines: 0, appliedAt: "2026-09-01" },
        { invoiceId: 5, supplierName: "Sony", number: "0225-2", issueDate: "2026-08-29", total: 2000, status: "draft", lineCount: 2, unresolvedLines: 1 },
      ],
      isLoading: false, error: null, refetch: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ existingInvoiceId: 4 }), { status: 409 })));
    render(<InvoicesList />);
    expect(screen.getByText("Aplicada", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/Borrador · 1 sin resolver/)).toBeTruthy();
    const file = new File(["%PDF-1.4"], "f.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("invoice-file"), { target: { files: [file] } });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/ya fue cargada/);
    expect(screen.getByRole("link", { name: "Ver la factura existente" }).getAttribute("href")).toBe("/stock/invoices/4");
    vi.unstubAllGlobals();
  });

  it("shows a Spanish error for a non-PDF without calling the server", async () => {
    m.list.mockReturnValue({ data: [], isLoading: false, error: null, refetch: vi.fn() });
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    render(<InvoicesList />);
    await act(async () => {
      fireEvent.change(screen.getByTestId("invoice-file"), { target: { files: [new File(["x"], "a.xlsx")] } });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/PDF/);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("<InvoiceReviewPage />", () => {
  it("shows the fee-factor card and landed costs before confirming", () => {
    render(<InvoiceReviewPage invoiceId={7} />);
    expect(screen.getByTestId("factor-sentence").textContent).toContain("×1,27000");
    expect(screen.getByTestId("factor-sentence").textContent).toContain("+27,00 %");
    expect(screen.getByTestId("factor-sentence").textContent).toContain("no se descuenta nada");
    expect(screen.queryByText("editado")).toBeNull();
  });

  it("editing the factor updates landed cost and projected cost, and saves it", () => {
    render(<InvoiceReviewPage invoiceId={7} />);
    expect(screen.getByTestId("landed-1").textContent).toMatch(/127/);
    // stock 2 @100 + 2 @127 -> 113,5
    expect(screen.getByTestId("cost-1").textContent).toMatch(/114/);
    fireEvent.change(screen.getByLabelText("Factor aplicado"), { target: { value: "1,5" } });
    expect(screen.getByTestId("landed-1").textContent).toMatch(/150/);
    expect(screen.getByTestId("cost-1").textContent).toMatch(/125/); // (200+300)/4
    fireEvent.click(screen.getByRole("button", { name: "Guardar factor" }));
    expect(m.calls.setFeeFactor).toHaveBeenCalledWith({ invoiceId: 7, feeFactor: 1.5 });
  });

  it("shows the editado badge when overridden", () => {
    m.getDraft.mockReturnValue({ data: { ...base, feeFactorOverridden: true }, isLoading: false, error: null, refetch: vi.fn() });
    render(<InvoiceReviewPage invoiceId={7} />);
    expect(screen.getByText("editado")).toBeTruthy();
  });

  it("disables confirm until every line is resolved, with the unresolved count", () => {
    render(<InvoiceReviewPage invoiceId={7} />);
    expect((screen.getByRole("button", { name: "Confirmar y aplicar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Faltan resolver 1 línea/)).toBeTruthy();
  });

  it("skip flow: omitting the line calls skipLine and, once skipped, enables confirm", () => {
    render(<InvoiceReviewPage invoiceId={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Omitir línea" }));
    expect(m.calls.skipLine).toHaveBeenCalledWith({ invoiceId: 7, lineNo: 2 });
    cleanup();
    const skipped: Review = { ...base, lines: [base.lines[0]!, { ...base.lines[1]!, skipped: true }] };
    m.getDraft.mockReturnValue({ data: skipped, isLoading: false, error: null, refetch: vi.fn() });
    render(<InvoiceReviewPage invoiceId={7} />);
    expect((screen.getByRole("button", { name: "Confirmar y aplicar" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Línea omitida")).toBeTruthy();
    expect(screen.getByText(/1 producto, 2 unidades/)).toBeTruthy();
  });

  it("match flow previews the fields to fill and calls matchLine", async () => {
    vi.useFakeTimers();
    m.search.mockImplementation((_i: unknown, o: { enabled?: boolean }) => ({
      data: o.enabled ? [{ id: 9, name: "Cable USB", ean: null, sku: null, onHand: 4 }] : undefined,
      isLoading: false, error: null,
    }));
    render(<InvoiceReviewPage invoiceId={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Vincular con producto existente" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "cable" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByText(/Se completará: SKU: B2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Vincular" }));
    expect(m.calls.matchLine).toHaveBeenCalledWith({ invoiceId: 7, lineNo: 2, productId: 9 });
    vi.useRealTimers();
  });

  it("create flow is prefilled from the invoice line", () => {
    render(<InvoiceReviewPage invoiceId={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Crear producto" }));
    expect((screen.getByDisplayValue("Cable raro") as HTMLInputElement).value).toBe("Cable raro");
    fireEvent.click(screen.getByRole("button", { name: "Crear y vincular" }));
    expect(m.calls.createProductFromLine).toHaveBeenCalledWith({
      invoiceId: 7, lineNo: 2, product: { ean: null, sku: "B2", name: "Cable raro", model: "", category: "" },
    });
  });

  it("confirm opens a dialog with totals and applies once", () => {
    m.getDraft.mockReturnValue({ data: withLine2Resolved(), isLoading: false, error: null, refetch: vi.fn() });
    render(<InvoiceReviewPage invoiceId={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar y aplicar" }));
    const dlg = within(screen.getByRole("dialog", { name: "Confirmar factura" }));
    expect(dlg.getByText(/2 productos, 5 unidades/)).toBeTruthy();
    fireEvent.click(dlg.getByRole("button", { name: "Aplicar" }));
    expect(m.calls.confirm).toHaveBeenCalledTimes(1);
    expect(m.calls.confirm).toHaveBeenCalledWith({ invoiceId: 7 });
    expect(screen.getByRole("status").textContent).toMatch(/Factura aplicada/);
    expect(screen.getByRole("link", { name: "Ver productos" }).getAttribute("href")).toBe("/stock/products");
  });

  it("renders parser warnings and a retry on load error", () => {
    m.getDraft.mockReturnValue({ data: { ...base, warnings: ["El total no coincide"] }, isLoading: false, error: null, refetch: vi.fn() });
    render(<InvoiceReviewPage invoiceId={7} />);
    expect(screen.getByRole("note").textContent).toContain("El total no coincide");
    cleanup();
    const refetch = vi.fn();
    m.getDraft.mockReturnValue({ data: undefined, isLoading: false, error: { message: "boom" }, refetch });
    render(<InvoiceReviewPage invoiceId={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("applied invoices are read-only", () => {
    m.getDraft.mockReturnValue({ data: { ...withLine2Resolved(), status: "applied", appliedAt: "2026-09-01T10:00:00Z" }, isLoading: false, error: null, refetch: vi.fn() });
    render(<InvoiceReviewPage invoiceId={7} />);
    expect(screen.queryByRole("button", { name: "Confirmar y aplicar" })).toBeNull();
    expect(screen.queryByLabelText("Factor aplicado")).toBeNull();
    expect(screen.getByText(/solo lectura/)).toBeTruthy();
  });
});
