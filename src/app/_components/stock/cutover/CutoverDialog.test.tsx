// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const statusQ = vi.fn();
const runFn = vi.fn();
const runState = { data: undefined as unknown, error: null as { message: string } | null, isPending: false };
const inv = { invalidate: vi.fn() };

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => <a href={href}>{children as never}</a> }));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({ stockCutover: inv, stockProducts: inv }),
    stockCutover: {
      status: { useQuery: () => statusQ() },
      run: { useMutation: () => ({ ...runState, mutate: runFn, reset: vi.fn() }) },
    },
  },
}));

import { CutoverDialog } from "./CutoverDialog";

const ok = (data: unknown) => ({ data, isLoading: false, error: null, refetch: vi.fn() });
const open = { cutoverAt: null, snapshotProducts: 10, productsToCreate: 8, productsExisting: 2 };

beforeEach(() => { runState.data = undefined; runState.error = null; runState.isPending = false; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("CutoverDialog", () => {
  it("shows the counts, asks for the date and needs an explicit second confirmation before running", () => {
    statusQ.mockReturnValue(ok(open));
    render(<CutoverDialog onClose={vi.fn()} />);
    expect(screen.getByTestId("cutover-counts").textContent).toMatch(/Productos en el Excel: 10.*Se van a crear: 8.*Ya existen \(no se tocan\): 2/);
    fireEvent.change(screen.getByLabelText(/Fecha de corte/), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar migración" }));
    expect(runFn).not.toHaveBeenCalled();
    expect(screen.getByText(/01\/10\/2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sí, iniciar migración" }));
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(runFn).toHaveBeenCalledWith({ cutoverAt: "2026-10-01T03:00:00.000Z" });
  });

  it("explains how to upload the Excel when there is no snapshot", () => {
    statusQ.mockReturnValue(ok({ ...open, snapshotProducts: 0, productsToCreate: 0, productsExisting: 0 }));
    render(<CutoverDialog onClose={vi.fn()} />);
    expect(screen.getByText(/Subí primero el Excel/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Iniciar migración" })).toBeNull();
  });

  it("after the cutover the date is fixed and the action completes the missing products", () => {
    statusQ.mockReturnValue(ok({ ...open, cutoverAt: "2026-10-01T03:00:00.000Z" }));
    render(<CutoverDialog onClose={vi.fn()} />);
    expect(screen.queryByLabelText(/Fecha de corte/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Completar faltantes" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, iniciar migración" }));
    expect(runFn).toHaveBeenCalledWith({ cutoverAt: "2026-10-01T03:00:00.000Z" });
  });

  it("shows the result: created, linked and left unlinked", async () => {
    statusQ.mockReturnValue(ok(open));
    runState.data = { cutoverAt: "2026-10-01T03:00:00.000Z", alreadyDone: false, productsCreated: 8, productsExisting: 2, listingsLinked: 6, listingsUnlinked: 3 };
    const onClose = vi.fn();
    render(<CutoverDialog onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/la migración se hizo/)).toBeTruthy());
    expect(screen.getByText(/Productos creados:/).textContent).toContain("8");
    expect(screen.getByText(/Publicaciones vinculadas:/).textContent).toContain("6");
    expect(screen.getByText(/Publicaciones sin vincular:/).textContent).toContain("3");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the server error and stays on the confirmation step", () => {
    statusQ.mockReturnValue(ok(open));
    runState.error = { message: "El corte ya se hizo" };
    render(<CutoverDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Iniciar migración" }));
    expect(screen.getByRole("alert").textContent).toContain("El corte ya se hizo");
  });
});
