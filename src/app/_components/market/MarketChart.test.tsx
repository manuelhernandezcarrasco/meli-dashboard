// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarketChart } from "./MarketChart";
import { fixtureResearch } from "./fixtures";
import { MarketTooltip } from "./MarketTooltip";

const SIZE = { width: 800, height: 400 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const dots = (c: HTMLElement) => Array.from(c.querySelectorAll("circle"));

describe("<MarketChart />", () => {
  it("renders both series with ours larger and coloured differently", () => {
    const { container } = render(<MarketChart data={fixtureResearch} size={SIZE} />);
    const ours = dots(container).filter((d) => d.getAttribute("fill") === "var(--cost)");
    const others = dots(container).filter((d) => d.getAttribute("fill") === "var(--grey)");
    expect(ours).toHaveLength(2);
    expect(others.length).toBeGreaterThan(40);
    expect(Number(ours[0]!.getAttribute("r"))).toBeGreaterThan(Number(others[0]!.getAttribute("r")));
  });

  it("toggle switches the regression line and stats", () => {
    const { container } = render(<MarketChart data={fixtureResearch} size={SIZE} />);
    expect(screen.getByTestId("fit-stats").textContent).toContain("0,62");
    const before = container.querySelector(".recharts-line path")?.getAttribute("d");
    fireEvent.click(screen.getByRole("button", { name: "Lineal" }));
    expect(screen.getByTestId("fit-stats").textContent).toContain("0,31");
    expect(container.querySelector(".recharts-line path")?.getAttribute("d")).not.toBe(before);
  });

  it("hides the toggle option whose regression is null", () => {
    const data = { ...fixtureResearch, regression: { log: null, linear: fixtureResearch.regression.linear } };
    render(<MarketChart data={data} size={SIZE} />);
    expect(screen.queryByRole("button", { name: "Log" })).toBeNull();
    expect(screen.getByRole("button", { name: "Lineal" })).toBeTruthy();
    expect(screen.getByTestId("fit-stats").textContent).toContain("0,31");
  });

  it("opens the permalink when a dot is clicked", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = render(<MarketChart data={fixtureResearch} size={SIZE} />);
    const ours = dots(container).find((d) => d.getAttribute("fill") === "var(--cost)")!;
    fireEvent.click(ours.closest(".recharts-scatter-symbol") ?? ours);
    expect(open).toHaveBeenCalledWith(expect.stringContaining("https://articulo.mercadolibre.com.ar/"), "_blank", "noopener,noreferrer");
  });

  it("shows an empty state without points", () => {
    render(<MarketChart data={{ ...fixtureResearch, points: [] }} size={SIZE} />);
    expect(screen.getByText(/No hay datos de mercado/)).toBeTruthy();
  });

  it("lists excluded items collapsed by default", () => {
    render(<MarketChart data={fixtureResearch} size={SIZE} />);
    const btn = screen.getByRole("button", { name: /Excluidos \(3\)/ });
    expect(screen.queryByText("Precio atípico")).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByText("Precio atípico")).toBeTruthy();
    expect(screen.getByText("Ventas atípicas")).toBeTruthy();
  });
});

describe("<MarketTooltip />", () => {
  const base = fixtureResearch.points[0]!;
  it("shows seller, title, price and exact sold count", () => {
    const p = { ...base, soldQuantity: 1234, soldExact: true };
    render(<MarketTooltip active payload={[{ payload: p }]} />);
    expect(screen.getByText(p.sellerNickname).className).toContain("font-bold");
    expect(screen.getByText(p.title)).toBeTruthy();
    expect(screen.getByText(/Precio: \$ /)).toBeTruthy();
    expect(screen.getByText(/Vendidos: 1\.234$/)).toBeTruthy();
  });
  it("prefixes + when the count is a lower bound", () => {
    render(<MarketTooltip active payload={[{ payload: { ...base, soldQuantity: 100, soldExact: false } }]} />);
    expect(screen.getByText(/Vendidos: \+100$/)).toBeTruthy();
  });
  it("renders nothing when inactive", () => {
    const { container } = render(<MarketTooltip active={false} payload={[{ payload: base }]} />);
    expect(container.innerHTML).toBe("");
  });
});
