"use client";

import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";
type Key = string | number | null;

export interface SortState { col: string; dir: SortDir }

/**
 * Click-to-sort state for a table. First click on a column sorts descending,
 * the next click flips to ascending, and so on. With no column selected the
 * rows keep their original order. Null keys always sort last.
 */
export function useSort<T>(rows: readonly T[], getters: Record<string, (r: T) => Key>) {
  const [sort, setSort] = useState<SortState | null>(null);

  const sorted = useMemo(() => {
    const get = sort ? getters[sort.col] : undefined;
    if (!sort || !get) return rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "es");
      return c * sign;
    });
    // getters are recreated each render but are pure per column
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);

  const toggle = (col: string) =>
    setSort((s) => (s?.col === col ? { col, dir: s.dir === "desc" ? "asc" : "desc" } : { col, dir: "desc" }));

  return { rows: sorted, sort, toggle };
}

function SortIcon({ dir }: { dir: SortDir | null }) {
  const on = "currentColor";
  const off = "currentColor";
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden className="shrink-0">
      <path d="M5 1 L9 5.5 H1 Z" fill={dir === "asc" ? on : off} opacity={dir === "asc" ? 1 : dir ? 0 : 0.35} />
      <path d="M5 13 L1 8.5 H9 Z" fill={dir === "desc" ? on : off} opacity={dir === "desc" ? 1 : dir ? 0 : 0.35} />
    </svg>
  );
}

/** Sortable <th>: label + up/down arrows; only the active direction is shown once sorted. */
export function SortTh({ col, sort, onSort, children, className = "" }: {
  col: string;
  sort: SortState | null;
  onSort: (col: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const dir = sort?.col === col ? sort.dir : null;
  return (
    <th
      className={className}
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] font-semibold tracking-[inherit] uppercase hover:text-ink ${
          dir ? "text-ink" : "text-mut"
        }`}
      >
        {children}
        <SortIcon dir={dir} />
      </button>
    </th>
  );
}
