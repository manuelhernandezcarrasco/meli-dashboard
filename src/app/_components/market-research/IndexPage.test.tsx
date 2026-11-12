// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchQuery = vi.fn();
const recentQuery = vi.fn();
vi.mock("@clerk/nextjs", () => ({ UserButton: () => null }));
vi.mock("~/trpc/react", () => ({
  api: { market: { recent: { useQuery: () => recentQuery() }, searchOwnProducts: { useQuery: (i: unknown, o: unknown) => searchQuery(i, o) } } },
}));

import { MarketIndex } from "./IndexPage";

beforeEach(() => {
  vi.useFakeTimers();
  recentQuery.mockReturnValue({
    data: [{ catalogProductId: "MLA-R", title: "Reciente", ean: "999", lastScanAt: "2026-11-12T15:00:00Z" }],
    isLoading: false, error: null, refetch: vi.fn(),
  });
  searchQuery.mockImplementation((_i: unknown, o: { enabled?: boolean }) =>
    o.enabled
      ? { data: [{ itemId: "MLA1", title: "Cámara", catalogProductId: "MLA-R" }], isLoading: false, error: null, refetch: vi.fn() }
      : { data: undefined, isLoading: false, error: null, refetch: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("<MarketIndex />", () => {
  it("lists recent scans without a query", () => {
    render(<MarketIndex />);
    expect(screen.getByRole("link", { name: /Reciente/ }).getAttribute("href")).toBe("/market-research/MLA-R");
  });

  it("searches after the debounce and links the result", async () => {
    render(<MarketIndex />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: " cam " } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(searchQuery).toHaveBeenLastCalledWith({ query: "cam" }, { enabled: true });
    expect(screen.getByRole("link", { name: /Cámara/ }).getAttribute("href")).toBe("/market-research/MLA-R");
    expect(screen.getByText(/EAN: 999/)).toBeTruthy();
  });
});
