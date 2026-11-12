"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isActive, STOCK_TABS } from "./nav";

export function StockTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Secciones de stock" className="mb-4 overflow-x-auto border-b border-line">
      <ul className="m-0 flex list-none gap-1 p-0">
        {STOCK_TABS.map((t) => {
          const active = isActive(pathname, t.href);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px block whitespace-nowrap border-b-2 px-3 py-2 text-[13px] no-underline ${
                  active ? "border-navy font-semibold text-ink" : "border-transparent text-mut hover:text-ink"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
