// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
let rows: unknown[] = [];
vi.mock("~/trpc/react", () => ({
  api: {
    stockReturns: {
      list: { useQuery: () => ({ data: rows, isLoading: false, error: null, refetch: vi.fn() }) },
      resolve: { useMutation: () => ({ mutate, isPending: false, error: null }) },
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
    },
    stockProducts: { list: { useQuery: () => ({ data: [{ id: 1, name: "Cámara" }] }) } },
  },
}));

import { ReturnsPage } from "./ReturnsPage";

const mk = (id: number, outcome: string, quantity = 2) => ({
  id, marketplace: "mercadolibre", orderId: 1000 + id, lineNo: 0, productId: 1, productName: `Prod ${id}`,
  quantity, outcome, reason: "Defecto", openedAt: "2026-11-01T10:00:00Z", resolvedAt: null, note: null,
});

beforeEach(() => {
  mutate.mockClear();
  rows = [mk(1, "pending", 2), mk(2, "in_repair", 3), mk(3, "lost"), mk(4, "restocked")];
});
afterEach(cleanup);

const rowOf = (name: string) => screen.getByText(name).closest("tr")!;

describe("<ReturnsPage />", () => {
  it("defaults to pending + in repair and shows counters", () => {
    render(<ReturnsPage />);
    expect(screen.queryByText("Prod 3")).toBeNull();
    expect(screen.queryByText("Prod 4")).toBeNull();
    expect(screen.getByTestId("pending-count").textContent).toBe("2 u.");
    expect(screen.getByTestId("repair-count").textContent).toBe("3 u.");
  });

  it("renders only legal actions per state", () => {
    render(<ReturnsPage />);
    const names = (n: string) => within(rowOf(n)).getAllByRole("button").map((b) => b.textContent);
    expect(names("Prod 1")).toEqual(["Perdido", "A reparación", "Reingresar al stock"]);
    expect(names("Prod 2")).toEqual(["Reingresar al stock", "Perdido"]);
  });

  it("final states are read-only", () => {
    render(<ReturnsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Perdido" , pressed: false }));
    fireEvent.click(screen.getByRole("button", { name: "Reingresado", pressed: false }));
    expect(within(rowOf("Prod 3")).queryAllByRole("button")).toHaveLength(0);
    expect(within(rowOf("Prod 4")).queryAllByRole("button")).toHaveLength(0);
  });

  it("restock needs an explicit confirmation stating +N", () => {
    render(<ReturnsPage />);
    fireEvent.click(within(rowOf("Prod 1")).getByRole("button", { name: "Reingresar al stock" }));
    expect(mutate).not.toHaveBeenCalled();
    const dlg = screen.getByRole("dialog");
    expect(dlg.textContent).toContain("Se suma +2 al stock disponible");
    fireEvent.click(within(dlg).getByRole("button", { name: "Confirmar" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ returnId: 1, outcome: "restocked", confirmRestock: true }));
  });

  it("lost asks for confirmation too and never sends confirmRestock", () => {
    render(<ReturnsPage />);
    fireEvent.click(within(rowOf("Prod 1")).getByRole("button", { name: "Perdido" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirmar" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0].confirmRestock).toBeUndefined();
  });
});
