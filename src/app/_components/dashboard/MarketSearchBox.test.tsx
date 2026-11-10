// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { MarketSearchBox, type MarketSearchHit } from "./MarketSearchBox";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); push.mockReset(); });

const hits: MarketSearchHit[] = [
  { itemId: "MLA1", title: "Cámara Sony", catalogProductId: "MLA-C1" },
  { itemId: "MLA2", title: "Cámara vieja", catalogProductId: null },
];

async function typeAndWait(search: (q: string) => Promise<MarketSearchHit[]>) {
  render(<MarketSearchBox search={search} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "cam" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
}

describe("<MarketSearchBox />", () => {
  it("debounces, shows the dropdown and navigates on a hit with catalog id", async () => {
    const search = vi.fn(() => Promise.resolve(hits));
    render(<MarketSearchBox search={search} />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "c" } });
    fireEvent.change(input, { target: { value: "cam" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(search).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith("cam");
    fireEvent.click(screen.getByRole("button", { name: "Cámara Sony" }));
    expect(push).toHaveBeenCalledWith("/market-research/MLA-C1");
  });

  it("shows a disabled row for items without catalog", async () => {
    await typeAndWait(() => Promise.resolve(hits));
    expect(screen.getByText("Sin catálogo — no soportado todavía")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /vieja/ })).toBeNull();
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-disabled")).toBe("true");
  });
});
