// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MARKET_TTL_MS, type MarketResearch, type MarketState } from "~/lib/market";

const h = vi.hoisted(() => ({
  get: vi.fn<(i: { catalogProductId: string }) => unknown>(),
  touch: vi.fn<(i: { catalogProductId: string }) => unknown>(),
  linked: true,
}));

vi.mock("@clerk/nextjs", () => ({ UserButton: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => createElement("a", { href }, children),
}));
vi.mock("./MarketChart", () => ({
  MarketChart: ({ data }: { data: MarketResearch }) => createElement("div", { "data-testid": "chart" }, data.catalogTitle),
}));
vi.mock("~/trpc/react", async () => {
  const rq = await import("@tanstack/react-query");
  return {
    api: {
      useUtils: () => {
        const qc = rq.useQueryClient();
        return { market: { get: { setData: (i: unknown, d: unknown) => qc.setQueryData(["market.get", i], d) } } };
      },
      dashboard: { connection: { useQuery: () => ({ data: { linked: h.linked } }) } },
      market: {
        get: {
          useQuery: (input: { catalogProductId: string }, opts: Record<string, unknown>) =>
            rq.useQuery({ queryKey: ["market.get", input], queryFn: async () => h.get(input), ...opts, retry: false }),
        },
        touch: {
          useMutation: (opts: Record<string, unknown>) =>
            rq.useMutation({ mutationFn: async (i: { catalogProductId: string }) => h.touch(i), ...opts }),
        },
      },
    },
  };
});

import { MarketPage } from "./MarketPage";

const research = (over: Partial<MarketResearch> = {}): MarketResearch => ({
  catalogProductId: "MLA1",
  catalogTitle: "Auriculares X",
  points: [],
  excluded: [],
  regression: { log: null, linear: null },
  fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});
const ready = (d = research()): MarketState => ({ status: "ready", data: d });
const running = (d: MarketResearch | null): MarketState => ({ status: "running", data: d, startedAt: new Date().toISOString() });

function mountPage() {
  const qc = new QueryClient();
  return render(createElement(QueryClientProvider, { client: qc }, createElement(MarketPage, { catalogProductId: "MLA1" })));
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  h.linked = true;
  h.get.mockReset().mockResolvedValue(ready());
  h.touch.mockReset().mockResolvedValue(ready());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<MarketPage />", () => {
  it("touches exactly once on mount, then every 15 min, and stops on unmount", async () => {
    const { unmount } = mountPage();
    await flush();
    expect(h.touch).toHaveBeenCalledTimes(1);
    await advance(MARKET_TTL_MS);
    expect(h.touch).toHaveBeenCalledTimes(2);
    unmount();
    await advance(30 * 60_000);
    expect(h.touch).toHaveBeenCalledTimes(2);
  });

  it("polls get every 2s only while running", async () => {
    h.get.mockResolvedValue(running(null));
    h.touch.mockResolvedValue(running(null));
    mountPage();
    await flush();
    const before = h.get.mock.calls.length;
    await advance(6000);
    expect(h.get.mock.calls.length).toBeGreaterThanOrEqual(before + 3);

    h.get.mockResolvedValue(ready());
    await advance(2000);
    await advance(2000);
    const settled = h.get.mock.calls.length;
    await advance(20_000);
    expect(h.get.mock.calls.length).toBe(settled);
  });

  it("shows a skeleton when running with no data", async () => {
    h.get.mockResolvedValue(running(null));
    h.touch.mockResolvedValue(running(null));
    mountPage();
    await flush();
    expect(screen.getByLabelText("Cargando")).toBeTruthy();
    expect(screen.queryByTestId("chart")).toBeNull();
  });

  it("keeps the chart and shows a spinner when running with previous data", async () => {
    h.get.mockResolvedValue(running(research()));
    h.touch.mockResolvedValue(running(research()));
    mountPage();
    await flush();
    expect(screen.getByTestId("chart").textContent).toBe("Auriculares X");
    expect(screen.getByText("Actualizando…")).toBeTruthy();
    expect(screen.getByText("Actualizado hace 5 min")).toBeTruthy();
  });

  it("failed shows the error, last data and a working retry", async () => {
    const failed: MarketState = { status: "failed", data: research(), error: "ML caído" };
    h.get.mockResolvedValue(failed);
    h.touch.mockResolvedValue(failed);
    mountPage();
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("ML caído");
    expect(screen.getByTestId("chart")).toBeTruthy();
    const calls = h.touch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await flush();
    expect(h.touch.mock.calls.length).toBe(calls + 1);
  });

  it("shows the link screen when ML is not connected", async () => {
    h.linked = false;
    mountPage();
    await flush();
    expect(screen.getByText("Vincular Mercado Libre")).toBeTruthy();
    expect(h.touch).not.toHaveBeenCalled();
  });

  it("shows an empty state for an unknown catalog id", async () => {
    h.get.mockResolvedValue(ready(research({ catalogTitle: "" })));
    h.touch.mockResolvedValue(ready(research({ catalogTitle: "" })));
    mountPage();
    await flush();
    expect(screen.getByText(/No encontramos este producto/)).toBeTruthy();
  });
});
