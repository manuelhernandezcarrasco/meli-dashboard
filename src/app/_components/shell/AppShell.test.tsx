// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/";
let conn: { data?: { linked: boolean } } = { data: { linked: true } };
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));
vi.mock("~/trpc/react", () => ({
  api: { dashboard: { connection: { useQuery: () => conn } } },
}));

import { AppShell, SIDEBAR_KEY } from "./AppShell";
import { StockTabs } from "./StockTabs";

beforeEach(() => {
  pathname = "/";
  conn = { data: { linked: true } };
  localStorage.clear();
});
afterEach(cleanup);

const shell = () => render(<AppShell><p>contenido</p></AppShell>);
const hamburger = () => screen.getByRole("button", { name: "Menú" });

describe("<AppShell />", () => {
  it("is collapsed by default", () => {
    shell();
    expect(hamburger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Stock" })).toBeNull();
    expect(screen.getByText("contenido")).toBeTruthy();
  });

  it("toggles and lists the three links", () => {
    shell();
    fireEvent.click(hamburger());
    expect(hamburger().getAttribute("aria-expanded")).toBe("true");
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/stock", "/market-research"]);
    fireEvent.click(hamburger());
    expect(screen.queryByRole("link", { name: "Stock" })).toBeNull();
  });

  it("remembers the state", () => {
    const first = shell();
    fireEvent.click(hamburger());
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe("open");
    first.unmount();
    shell();
    expect(hamburger().getAttribute("aria-expanded")).toBe("true");
  });

  it("works when localStorage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("no"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("no"); });
    shell();
    fireEvent.click(hamburger());
    expect(hamburger().getAttribute("aria-expanded")).toBe("true");
    spy.mockRestore();
    set.mockRestore();
  });

  it("highlights the active link, including sub-routes", () => {
    pathname = "/stock/products";
    shell();
    fireEvent.click(hamburger());
    expect(screen.getByRole("link", { name: "Stock" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBeNull();
  });

  it("renders without the shell on sign-in and for unlinked accounts", () => {
    pathname = "/sign-in";
    shell();
    expect(screen.queryByRole("button", { name: "Menú" })).toBeNull();
    cleanup();
    pathname = "/";
    conn = { data: { linked: false } };
    shell();
    expect(screen.queryByRole("button", { name: "Menú" })).toBeNull();
    expect(screen.getByText("contenido")).toBeTruthy();
  });
});

describe("<StockTabs />", () => {
  it("lists the five tabs and marks the current one", () => {
    pathname = "/stock/alerts";
    render(<StockTabs />);
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Productos", "Facturas", "Alertas", "Devoluciones", "Sincronización",
    ]);
    expect(screen.getByRole("link", { name: "Alertas" }).getAttribute("aria-current")).toBe("page");
  });
});
