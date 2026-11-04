"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Scrollable pane whose scrollbar thumb is only visible while scrolling. */
export function ScrollPane({ className = "", children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div
      ref={ref}
      className={`scroll-y ${className}`}
      onScroll={() => {
        const el = ref.current;
        if (!el) return;
        el.dataset.scrolling = "true";
        clearTimeout(timer.current);
        timer.current = setTimeout(() => delete el.dataset.scrolling, 800);
      }}
    >
      {children}
    </div>
  );
}
