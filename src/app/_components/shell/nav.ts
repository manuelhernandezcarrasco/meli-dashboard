export interface NavItem { href: string; label: string }

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/stock", label: "Stock" },
  { href: "/market-research", label: "Market research" },
];

export const STOCK_TABS: readonly NavItem[] = [
  { href: "/stock/products", label: "Productos" },
  { href: "/stock/invoices", label: "Facturas" },
  { href: "/stock/alerts", label: "Alertas" },
  { href: "/stock/returns", label: "Devoluciones" },
  { href: "/stock/sync", label: "Sincronización" },
];

/** "/" only matches itself; every other link also matches its sub-routes. */
export function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Routes that render without the app shell. */
export function isShellFree(pathname: string | null): boolean {
  return !!pathname && /^\/(sign-in|sign-up)(\/|$)/.test(pathname);
}
