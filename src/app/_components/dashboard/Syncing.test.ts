// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SyncFailed, SyncingScreen } from "./Syncing";

afterEach(cleanup);

describe("<SyncingScreen />", () => {
  it("tells the user the Mercado Libre data is being fetched", () => {
    render(createElement(SyncingScreen, { skeleton: createElement("div", null, "esqueleto") }));
    expect(screen.getByRole("status").textContent).toContain("Conectado a Mercado Libre");
    expect(screen.getByRole("status").textContent).toContain("Trayendo tus ventas");
  });
});

describe("<SyncFailed />", () => {
  it("shows the error and retries on click", () => {
    const onRetry = vi.fn();
    render(createElement(SyncFailed, { message: "HTTP 500", onRetry, retrying: false }));
    expect(screen.getByRole("alert").textContent).toBe("HTTP 500");
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("disables the button while retrying", () => {
    render(createElement(SyncFailed, { message: "x", onRetry: () => undefined, retrying: true }));
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
