// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DashboardDataSchema } from "~/lib/contracts";
import sample from "~/lib/sample-dashboard.json";

let counts: { data?: { open: number; total: number }; isError?: boolean } = {};
vi.mock("~/trpc/react", () => ({
  api: { stockAlerts: { counts: { useQuery: () => counts } } },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { Dashboard } from "./Dashboard";

const data = DashboardDataSchema.parse(sample);

beforeAll(() => {
  // recharts' ResponsiveContainer needs ResizeObserver
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => { cleanup(); counts = {}; });

describe("<Dashboard />", () => {
  it("renders every section title", () => {
    render(createElement(Dashboard, { data, demo: true }));
    for (const t of [
      "Venta diaria y margen bruto",
      "Del precio al margen",
      "Por categoría",
      "Últimas ventas",
      "Top productos del mes",
    ]) {
      expect(screen.getAllByRole("heading", { name: new RegExp(t) }).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("heading", { name: /Venta acumulada vs Septiembre 2026/ })).toBeTruthy();
    expect(screen.getByText(/Mes acumulado/)).toBeTruthy();
    expect(screen.getByText("DEMO")).toBeTruthy();
    expect(screen.getByText("Todos")).toBeTruthy();
  });

  it("no longer renders the critical-stock table nor the data-alerts card", () => {
    render(createElement(Dashboard, { data }));
    expect(screen.queryByRole("heading", { name: /Stock crítico/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Alertas de datos/ })).toBeNull();
  });

  it("shows an 'N alertas' badge linking to the alerts tab", () => {
    counts = { data: { open: 2, total: 5 } };
    render(createElement(Dashboard, { data }));
    const link = screen.getByRole("link", { name: /5 alertas/ });
    expect(link.getAttribute("href")).toBe("/stock/alerts");
  });

  it("renders no badge when the query failed or has no data", () => {
    counts = { isError: true };
    render(createElement(Dashboard, { data }));
    expect(screen.queryByRole("link", { name: /alerta/ })).toBeNull();
  });
});
