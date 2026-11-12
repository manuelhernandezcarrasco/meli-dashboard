// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IndexResults, type IndexRow } from "./IndexResults";

afterEach(cleanup);

const rows: IndexRow[] = [
  { key: "a", title: "Cámara Sony", ean: "123", catalogProductId: "MLA-C1", lastScanAt: "2026-11-12T15:00:00Z" },
  { key: "b", title: "Cámara vieja", ean: null, catalogProductId: null, lastScanAt: null },
];
const base = { loading: false, error: null, onRetry: () => undefined, searching: true };

describe("<IndexResults />", () => {
  it("links catalog results to the detail page and disables the rest", () => {
    render(<IndexResults {...base} rows={rows} />);
    expect(screen.getByRole("link", { name: /Cámara Sony/ }).getAttribute("href")).toBe("/market-research/MLA-C1");
    expect(screen.getByText(/EAN: 123/)).toBeTruthy();
    expect(screen.getByText("Sin catálogo — no soportado todavía")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("shows empty states for search and for no scans", () => {
    const { rerender } = render(<IndexResults {...base} rows={[]} />);
    expect(screen.getByText("No encontramos productos con ese nombre.")).toBeTruthy();
    rerender(<IndexResults {...base} rows={[]} searching={false} />);
    expect(screen.getByText(/Todavía no investigaste/)).toBeTruthy();
  });

  it("shows loading and error with retry", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<IndexResults {...base} rows={[]} loading />);
    expect(screen.getByRole("status")).toBeTruthy();
    rerender(<IndexResults {...base} rows={[]} error="boom" onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    screen.getByRole("button", { name: "Reintentar" }).click();
    expect(onRetry).toHaveBeenCalled();
  });
});
