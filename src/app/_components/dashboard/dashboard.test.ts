// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DashboardDataSchema } from "~/lib/contracts";
import sample from "~/lib/sample-dashboard.json";
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
afterEach(cleanup);

describe("<Dashboard />", () => {
  it("renders every section title", () => {
    render(createElement(Dashboard, { data, demo: true }));
    for (const t of [
      "Venta diaria y margen bruto",
      "Del precio al margen",
      "Por categoría",
      "Últimas ventas",
      "Top productos del mes",
      "Alertas de datos",
      "Stock crítico",
    ]) {
      expect(screen.getAllByRole("heading", { name: new RegExp(t) }).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("heading", { name: /Venta acumulada vs Septiembre 2026/ })).toBeTruthy();
    expect(screen.getByText(/Mes acumulado/)).toBeTruthy();
    expect(screen.getByText("DEMO")).toBeTruthy();
    expect(screen.getByText("Todos")).toBeTruthy();
  });
});
