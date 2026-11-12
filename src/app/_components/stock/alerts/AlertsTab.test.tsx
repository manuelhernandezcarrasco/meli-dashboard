// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AlertRow } from "~/lib/stock-contracts";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));

const mocks = vi.hoisted(() => {
  const m = (v: unknown = {}) => vi.fn(() => Promise.resolve(v));
  return {
    rows: { current: [] as unknown[] },
    ack: m(), resolve: m(), decide: m(), setCost: m(), adjust: m({ onHand: 0 }), link: m({ linkId: 1 }), create: m({ productId: 9 }),
    invalidate: m(),
  };
});

vi.mock("~/trpc/react", () => {
  const q = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
  const mut = (fn: unknown) => ({ useMutation: () => ({ mutateAsync: fn }) });
  const inv = { invalidate: mocks.invalidate };
  return {
    api: {
      useUtils: () => ({ stockAlerts: { list: inv, counts: inv }, stockProducts: inv, stockSync: inv }),
      stockAlerts: {
        list: { useQuery: () => q(mocks.rows.current) },
        counts: { useQuery: () => q({ open: 2, total: 3, byType: {} }) },
        acknowledge: mut(mocks.ack), resolve: mut(mocks.resolve), decideMatch: mut(mocks.decide),
      },
      stockProducts: {
        unlinkedListings: { useQuery: () => q([{ itemId: "MLA1", variationId: null, title: "Parlante X", gtin: "7791234567890", skus: ["SK-1"], variations: [] }]) },
        list: { useQuery: () => q([{ id: 5, name: "Parlante existente", ean: null, sku: null }]) },
        previewLink: { useQuery: () => q([{ productId: 5, fills: { ean: "7791234567890", sku: null } }]) },
        get: { useQuery: () => q({ product: { onHand: -3 } }) },
        link: mut(mocks.link), create: mut(mocks.create), adjustStock: mut(mocks.adjust), setCost: mut(mocks.setCost),
      },
      stockSync: {
        status: { useQuery: () => q([{ itemId: "MLA1", lastObservedMlQty: 4, lastError: null }]) },
        compare: mut(vi.fn(() => Promise.resolve({}))),
      },
    },
  };
});

import { AlertsTab } from "./AlertsTab";

const row = (o: Partial<AlertRow>): AlertRow => ({
  id: 1, type: "low_stock", status: "open", productId: 7, productName: "Prod", marketplace: "mercadolibre", itemId: "MLA1",
  dedupeKey: "k", title: "Título", detail: "Detalle", quantity: null, amount: null,
  createdAt: new Date().toISOString(), acknowledgedAt: null, resolvedAt: null, resolution: null, ...o,
});

beforeEach(() => { vi.clearAllMocks(); mocks.rows.current = []; });
afterEach(cleanup);

const openPanel = () => fireEvent.click(screen.getByRole("button", { name: "Resolver" }));
const type = (label: string | RegExp, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } });

describe("<AlertsTab />", () => {
  it("shows the empty state and the open badge", () => {
    render(<AlertsTab />);
    expect(screen.getByText("Sin alertas")).toBeTruthy();
    expect(screen.getByText("2 abiertas")).toBeTruthy();
  });

  it("groups by type with counts", () => {
    mocks.rows.current = [row({ id: 1, type: "negative_stock" }), row({ id: 2, type: "negative_stock" }), row({ id: 3 })];
    render(<AlertsTab />);
    expect(screen.getByRole("region", { name: "Stock negativo" }).textContent).toContain("2");
    expect(screen.getByRole("region", { name: "Stock bajo" })).toBeTruthy();
  });

  it("acknowledge is optimistic and rolls back with a message on error", async () => {
    mocks.rows.current = [row({})];
    let reject: (e: Error) => void = () => undefined;
    mocks.ack.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    render(<AlertsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Reconocer" }));
    await waitFor(() => expect(screen.getByText("Reconocida")).toBeTruthy());
    expect(mocks.ack).toHaveBeenCalledWith({ id: 1 });
    reject(new Error("boom"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("boom"));
    expect(screen.queryByText("Reconocida")).toBeNull();
    expect(screen.getByRole("button", { name: "Reconocer" })).toBeTruthy();
  });

  it("resolving a simple alert hides it and sends the resolution", async () => {
    mocks.rows.current = [row({})];
    render(<AlertsTab />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Marcar como resuelta" }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith({ id: 1, resolution: "resuelta manualmente" }));
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it("missing_cost validates then sends productId + cost and resolves", async () => {
    mocks.rows.current = [row({ type: "missing_cost" })];
    render(<AlertsTab />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Guardar costo" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Ingresá un costo"));
    expect(mocks.setCost).not.toHaveBeenCalled();
    type(/Costo unitario/, "1500,5");
    fireEvent.click(screen.getByRole("button", { name: "Guardar costo" }));
    await waitFor(() => expect(mocks.setCost).toHaveBeenCalledWith({ productId: 7, unitCost: 1500.5 }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith({ id: 1, resolution: "costo cargado: 1500.5" }));
  });

  it("link_cost_review: Aceptar resolves; Editar costo requires a valid cost", async () => {
    mocks.rows.current = [row({ type: "link_cost_review", amount: 1000, quantity: 3 })];
    render(<AlertsTab />);
    openPanel();
    expect(screen.getByText(/3 venta\(s\) pendientes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith({ id: 1, resolution: "costo aceptado" }));
  });

  it("link_cost_review: Editar costo saves a new cost first", async () => {
    mocks.rows.current = [row({ type: "link_cost_review", amount: 1000, quantity: 3 })];
    render(<AlertsTab />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Editar costo" }));
    type(/Costo unitario/, "1200");
    fireEvent.click(screen.getByRole("button", { name: "Guardar costo y aplicar" }));
    await waitFor(() => expect(mocks.setCost).toHaveBeenCalledWith({ productId: 7, unitCost: 1200 }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalled());
  });

  it("negative_stock adjust needs a reason", async () => {
    mocks.rows.current = [row({ type: "negative_stock" })];
    render(<AlertsTab />);
    openPanel();
    type(/Ajuste/, "5");
    fireEvent.click(screen.getByRole("button", { name: "Ajustar stock" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("motivo"));
    expect(mocks.adjust).not.toHaveBeenCalled();
    type(/Motivo/, "conteo");
    fireEvent.click(screen.getByRole("button", { name: "Ajustar stock" }));
    await waitFor(() => expect(mocks.adjust).toHaveBeenCalledWith(expect.objectContaining({ productId: 7, delta: 5, reason: "conteo" })));
  });

  it("stock_drift: Aceptar valor de ML adjusts ours by the difference, with a reason", async () => {
    mocks.rows.current = [row({ type: "stock_drift" })];
    render(<AlertsTab />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Aceptar valor de ML" }));
    await waitFor(() => expect(mocks.adjust).toHaveBeenCalledWith(expect.objectContaining({ productId: 7, delta: 7, reason: expect.stringContaining("Mercado Libre") })));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalled());
  });

  it("suggested_match confirms / rejects through decideMatch", async () => {
    mocks.rows.current = [row({ type: "suggested_match" })];
    render(<AlertsTab />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith({ id: 1, decision: "reject" }));
  });

  it("unmatched_listing: links an existing product (preview shown) with the quantity", async () => {
    mocks.rows.current = [row({ type: "unmatched_listing", productId: null })];
    render(<AlertsTab />);
    openPanel();
    type("Buscar producto", "parl");
    fireEvent.click(screen.getByRole("button", { name: /Parlante existente/ }));
    expect(screen.getByText(/ean: 7791234567890/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Vincular" }));
    await waitFor(() => expect(mocks.link).toHaveBeenCalledWith({
      marketplace: "mercadolibre", itemId: "MLA1", variationId: null, components: [{ productId: 5, quantity: 1 }], fillMissing: true,
    }));
  });

  it("unmatched_listing: creates a product prefilled from the listing, validating the GTIN", async () => {
    mocks.rows.current = [row({ type: "unmatched_listing", productId: null })];
    render(<AlertsTab />);
    openPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Crear producto" }));
    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Parlante X");
    type(/GTIN/, "123");
    fireEvent.click(screen.getByRole("button", { name: "Crear y vincular" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("13 dígitos"));
    type(/GTIN/, "7791234567890");
    fireEvent.click(screen.getByRole("button", { name: "Crear y vincular" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ ean: "7791234567890", sku: "SK-1", name: "Parlante X", model: "", category: "", minUnits: null }));
    await waitFor(() => expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({ components: [{ productId: 9, quantity: 1 }] })));
  });

  it("unmatched_listing: Ignorar resolves", async () => {
    mocks.rows.current = [row({ type: "unmatched_sale", productId: null })];
    render(<AlertsTab />);
    openPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Ignorar" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Ignorar" })[0]!);
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith({ id: 1, resolution: "ignorada" }));
  });
});
