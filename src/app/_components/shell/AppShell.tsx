"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { api } from "~/trpc/react";
import { isActive, isShellFree, NAV_ITEMS } from "./nav";

export const SIDEBAR_KEY = "pnl-sidebar";

function readOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "open";
  } catch {
    return false;
  }
}
function writeOpen(open: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? "open" : "closed");
  } catch {
    /* storage unavailable */
  }
}

function isMobile(): boolean {
  try {
    return window.matchMedia("(max-width: 767px)").matches;
  } catch {
    return false;
  }
}

/** Collapsible navigation around every page except sign-in/up and the "link your account" screen. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const free = isShellFree(pathname);
  // same query the dashboard uses (shared cache); an unlinked account sees the bare connect screen
  const conn = api.dashboard.connection.useQuery(undefined, { enabled: !free, retry: false });
  const [open, setOpen] = useState(false); // collapsed by default, also on the server render

  useEffect(() => {
    if (readOpen() && !isMobile()) setOpen(true);
  }, []);

  // on phones the sidebar is an overlay: close it after navigating
  useEffect(() => {
    if (isMobile()) setOpen(false);
  }, [pathname]);

  if (free || conn.data?.linked === false) return <>{children}</>;

  const toggle = () => {
    setOpen((o) => {
      writeOpen(!o);
      return !o;
    });
  };

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-30 flex h-11 items-center gap-3 border-b border-line bg-card px-4">
        <button
          type="button"
          aria-label="Menú"
          aria-expanded={open}
          aria-controls="app-sidebar"
          onClick={toggle}
          className="-ml-2 inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-ink hover:bg-bg"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
          </svg>
        </button>
        <span className="text-sm font-semibold tracking-tight">PnL en vivo</span>
      </div>
      <div className="flex">
        {open && (
          <>
            <div
              aria-hidden
              data-testid="sidebar-backdrop"
              onClick={toggle}
              className="fixed inset-0 top-11 z-30 bg-black/30 md:hidden"
            />
            <nav
              id="app-sidebar"
              aria-label="Navegación principal"
              className="fixed top-11 bottom-0 left-0 z-40 w-60 shrink-0 overflow-y-auto border-r border-line bg-card p-3 md:sticky md:z-20 md:h-[calc(100dvh-2.75rem)] md:w-56 md:self-start"
            >
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {NAV_ITEMS.map((n) => {
                  const active = isActive(pathname, n.href);
                  return (
                    <li key={n.href}>
                      <Link
                        href={n.href}
                        aria-current={active ? "page" : undefined}
                        className={`block rounded-lg px-3 py-2 text-[13px] no-underline ${
                          active ? "bg-navy font-semibold text-card" : "text-ink hover:bg-bg"
                        }`}
                      >
                        {n.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </>
        )}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
