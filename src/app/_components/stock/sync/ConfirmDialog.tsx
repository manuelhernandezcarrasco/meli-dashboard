"use client";

import type { ReactNode } from "react";

/** Modal confirmation. Every outward or destructive action in the sync tab goes through it. */
export function ConfirmDialog({ title, children, confirmLabel, busy = false, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-xl border border-line bg-card p-5 shadow-lg">
        <h3 className="m-0 mb-2 text-[15px] font-semibold">{title}</h3>
        <div className="mb-4 text-[13px] text-ink">{children}</div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg border border-line bg-card px-3 py-1.5 text-[13px]">
            Cancelar
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-card disabled:opacity-50">
            {busy ? "Procesando…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
