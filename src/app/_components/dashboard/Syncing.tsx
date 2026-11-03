"use client";

import type { ReactNode } from "react";

/** First sync after linking Mercado Libre: nothing to show yet, so say what is happening. */
export function SyncingScreen({ skeleton }: { skeleton: ReactNode }) {
  return (
    <div className="relative">
      <div className="pointer-events-none opacity-40" aria-hidden="true">
        {skeleton}
      </div>
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-x-4 top-24 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-[13px] shadow-lg"
      >
        <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-mut border-t-transparent" />
        <span>
          <strong className="block font-semibold">Conectado a Mercado Libre</strong>
          <span className="text-mut">
            Trayendo tus ventas. La primera vez puede tardar un minuto…
          </span>
        </span>
      </div>
    </div>
  );
}

/** The first sync failed and there is no earlier snapshot to fall back on. */
export function SyncFailed({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="m-0 text-[22px] font-semibold tracking-tight">
        No pudimos traer tus datos de Mercado Libre
      </h1>
      <p role="alert" className="m-0 text-[13px] text-neg">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="cursor-pointer rounded-lg bg-ink px-4 py-2 text-[13px] font-semibold text-card disabled:cursor-not-allowed disabled:opacity-60"
      >
        {retrying ? "Reintentando…" : "Reintentar"}
      </button>
    </main>
  );
}
