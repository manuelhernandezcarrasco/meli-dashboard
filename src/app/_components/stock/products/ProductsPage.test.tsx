// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detail, row } from "./fixtures";

const listQuery = vi.fn();
const getQuery = vi.fn();
const unlinked = vi.fn();
const preview = vi.fn();
const adjust = vi.fn();
const link = vi.fn();
const idle = { mutate: vi.fn(), isPending: false, error: null };

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ stockProducts: { invalidate: vi.fn() } }),
    stockProducts: {
      list: { useQuery: (i: unknown) => listQuery(i) },
      get: { useQuery: (i: unknown, o: unknown) => getQuery(i, o) },
      unlinkedListings: { useQuery: () => unlinked() },
      previewLink: { useQuery: (i: unknown, o: unknown) => preview(i, o) },
      adjustStock: { useMutation: () => ({ ...idle, mutate: adjust }) },
      link: { useMutation: () => ({ ...idle, mutate: link }) },
      unlink: { useMutation: () => idle },
      update: { useMutation: () => idle },
      create: { useMutation: () => idle },
    },
  },
}));

import { ProductsPage } from "./ProductsPage";

const ok = (data: unknown) => ({ data, isLoading: false, error: null, refetch: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
  listQuery.mockReturnValue(ok([
    row(),
    row({ id: 2, name: "Router", ean: "7790000000028", sku: "RT-2", category: "Redes", onHand: 0, coverageDays: null, syncMode: "live" }),
    row({ id: 3, name: "Cable", ean: null, sku: "CB-3", category: "Redes", onHand: -2, coverageDays: null, openAlerts: 2 }),
  ]));
  getQuery.mockReturnValue(ok(detail()));
  unlinked.mockReturnValue(ok([{ marketplace: "mercadolibre", itemId: "MLA999", variationId: null, title: "Cámara nueva", gtin: null, skus: [], variations: [] }]));
  preview.mockReturnValue(ok(undefined));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const names = () => screen.getAllByTestId("product-row").map((r) => within(r).getByTestId("name").textContent);

describe("<ProductsPage />", () => {
  it("lists products with state chips and the dry-run banner", () => {
    render(<ProductsPage />);
    expect(names()).toEqual(["Cámara IP", "Router", "Cable"]);
    expect(screen.getByText("Sin stock", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Negativo", { selector: "span" })).toBeTruthy();
    expect(screen.getAllByText("Simulación", { selector: "span" }).length).toBe(2);
    expect(screen.getByText("En vivo", { selector: "span" })).toBeTruthy();
  });

  it("shows the simulation banner only when nothing is live", () => {
    const { unmount } = render(<ProductsPage />);
    expect(screen.queryByText(/Modo simulación: no se envía stock a Mercado Libre/)).toBeNull();
    unmount();
    listQuery.mockReturnValue(ok([row()]));
    render(<ProductsPage />);
    expect(screen.getByText(/Modo simulación: no se envía stock a Mercado Libre/)).toBeTruthy();
  });

  it("filters by state, category and sync mode", () => {
    render(<ProductsPage />);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "negative" } });
    expect(names()).toEqual(["Cable"]);
    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Categoría"), { target: { value: "Redes" } });
    expect(names()).toEqual(["Router", "Cable"]);
    fireEvent.change(screen.getByLabelText("Sincronización"), { target: { value: "live" } });
    expect(names()).toEqual(["Router"]);
  });

  it("sends the debounced search to the server", async () => {
    render(<ProductsPage />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: " rout " } });
    expect(listQuery).not.toHaveBeenLastCalledWith(expect.objectContaining({ query: "rout" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(listQuery).toHaveBeenLastCalledWith(expect.objectContaining({ query: "rout" }));
  });

  it("sorts by a column header", () => {
    render(<ProductsPage />);
    fireEvent.click(screen.getByRole("button", { name: /^En stock/ }));
    expect(names()).toEqual(["Cámara IP", "Router", "Cable"]);
    fireEvent.click(screen.getByRole("button", { name: /^En stock/ }));
    expect(names()).toEqual(["Cable", "Router", "Cámara IP"]);
  });

  it("has loading, empty and error states", () => {
    listQuery.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: vi.fn() });
    const a = render(<ProductsPage />);
    expect(screen.getByTestId("skeleton")).toBeTruthy();
    a.unmount();
    listQuery.mockReturnValue(ok([]));
    const b = render(<ProductsPage />);
    expect(screen.getByText(/Todavía no hay productos/)).toBeTruthy();
    b.unmount();
    const refetch = vi.fn();
    listQuery.mockReturnValue({ data: undefined, isLoading: false, error: { message: "boom" }, refetch });
    render(<ProductsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe("product drawer", () => {
  const open = () => {
    render(<ProductsPage />);
    fireEvent.click(screen.getAllByTestId("product-row")[0]!);
  };

  it("switches between listings, ledger and cost history", () => {
    open();
    expect(screen.getByText("MLA123")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Movimientos" }));
    expect(screen.getByText("Venta")).toBeTruthy();
    expect(screen.getByText("2000123", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Historial de costo" }));
    expect(screen.getByText("Factura")).toBeTruthy();
  });

  it("requires a reason to adjust stock", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "Ajuste" }));
    fireEvent.change(screen.getByLabelText("Cantidad (+/−)"), { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar ajuste" }));
    expect(adjust).not.toHaveBeenCalled();
    expect(screen.getByText("Ingresá el motivo del ajuste.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Rotura" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar ajuste" }));
    expect(adjust).toHaveBeenCalledWith(expect.objectContaining({ productId: 1, delta: -3, reason: "Rotura", idempotencyKey: expect.any(String) }));
  });

  it("converts a target stock into a delta", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "Ajuste" }));
    fireEvent.click(screen.getByLabelText("Dejar en"));
    fireEvent.change(screen.getByLabelText("Cantidad"), { target: { value: "35" } });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Conteo" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar ajuste" }));
    expect(adjust).toHaveBeenCalledWith(expect.objectContaining({ delta: -5 }));
  });

  it("previews what linking will fill before confirming", () => {
    preview.mockImplementation((_i: unknown, o: { enabled?: boolean }) =>
      o.enabled ? ok([{ productId: 1, fills: { ean: "7790000000099", category: "Cámaras" } }]) : ok(undefined));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Vincular publicación" }));
    fireEvent.change(screen.getByLabelText("Publicación"), { target: { value: "MLA999|" } });
    expect(screen.getByText("EAN", { selector: "dt" })).toBeTruthy();
    expect(screen.getByText("7790000000099", { selector: "dd" })).toBeTruthy();
    expect(link).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar vínculo" }));
    expect(link).toHaveBeenCalledWith(expect.objectContaining({
      itemId: "MLA999", variationId: null, components: [{ productId: 1, quantity: 1 }], fillMissing: true,
    }));
  });
});
