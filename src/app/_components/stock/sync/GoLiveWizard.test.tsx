// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProductRow } from "~/lib/stock-contracts";

const h = vi.hoisted(() => ({
  adjust: vi.fn<(i: unknown) => Promise<unknown>>(),
  goLive: vi.fn<(i: unknown) => Promise<unknown>>(),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      stockSync: { invalidate: () => Promise.resolve() },
      stockProducts: { invalidate: () => Promise.resolve() },
      stockAlerts: { invalidate: () => Promise.resolve() },
    }),
    stockSync: {
      goLivePreview: {
        useQuery: ({ productId }: { productId: number }) => ({
          isLoading: false,
          error: null,
          data: { productId, productName: "x", ourOnHand: 5, listings: [{ linkId: 1, itemId: "MLA1", variationId: null, mlQty: 9 }] },
        }),
      },
      goLive: { useMutation: () => ({ mutateAsync: h.goLive }) },
    },
    stockProducts: { adjustStock: { useMutation: () => ({ mutateAsync: h.adjust }) } },
  },
}));

import { GoLiveWizard } from "./GoLiveWizard";

const product: ProductRow = {
  id: 7, ean: null, sku: null, name: "Auricular", model: "", category: "", onHand: 5, inRepair: 0, unitCost: 1,
  minUnits: null, syncMode: "dry_run", dailyRate: null, coverageDays: null, linkedListings: 1, openAlerts: 0, archived: false,
};
const mount = () => render(<GoLiveWizard items={[{ product, blocked: [] }]} onClose={() => undefined} />);
const next = () => fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

beforeEach(() => { h.adjust.mockResolvedValue({}); h.goLive.mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("<GoLiveWizard />", () => {
  it("shows ML quantity next to ours in step 1", () => {
    mount();
    expect(screen.getByText("MLA1")).toBeTruthy();
    expect(screen.getByText("(difiere)")).toBeTruthy();
  });

  it("cannot advance past step 2 without explicit confirmation, and never sends before the final dialog", async () => {
    mount();
    next();
    expect((screen.getByRole("button", { name: "Siguiente" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    next();
    fireEvent.click(screen.getByRole("button", { name: "Activar en vivo" }));
    expect(h.goLive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sí, enviar a Mercado Libre" }));
    await waitFor(() => expect(h.goLive).toHaveBeenCalledTimes(1));
    expect(h.adjust).not.toHaveBeenCalled();
  });

  it("an edited opening stock needs a reason and is sent through the adjust path with it", async () => {
    mount();
    next();
    fireEvent.change(screen.getByLabelText(/Stock inicial/), { target: { value: "8" } });
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Motivo del ajuste/), { target: { value: "conteo físico" } });
    fireEvent.click(screen.getByRole("checkbox"));
    next();
    fireEvent.click(screen.getByRole("button", { name: "Activar en vivo" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, enviar a Mercado Libre" }));
    await waitFor(() => expect(h.goLive).toHaveBeenCalled());
    expect(h.adjust).toHaveBeenCalledWith(expect.objectContaining({ productId: 7, delta: 3, reason: "conteo físico" }));
    expect(h.goLive).toHaveBeenCalledWith({ confirmations: [expect.objectContaining({ productId: 7, openingStock: 8 })] });
  });
});
