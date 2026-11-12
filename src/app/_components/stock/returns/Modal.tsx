import type { ReactNode } from "react";

export function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-[420px] rounded-xl border border-line bg-card p-4 shadow-lg">
        <h2 className="m-0 mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export const btnPrimary = "cursor-pointer rounded-lg border border-navy bg-navy px-3 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60";
export const btnGhost = "cursor-pointer rounded-lg border border-line bg-card px-3 py-2 text-[13px] disabled:opacity-60";
export const field = "w-full rounded-lg border border-line bg-card px-2.5 py-2 text-[13px]";
