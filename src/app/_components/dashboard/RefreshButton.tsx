"use client";

export function RefreshButton({ onClick, pending, cooldown, message }: {
  onClick: () => void;
  pending: boolean;
  /** seconds left before another refresh is allowed */
  cooldown: number;
  /** transient message ("Espere N s") */
  message?: string | null;
}) {
  const disabled = pending || cooldown > 0;
  return (
    <div className="flex items-center gap-2">
      {message ? <span className="text-xs text-warn">{message}</span> : null}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? (
          <span
            role="status"
            aria-label="Actualizando"
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-mut border-t-transparent"
          />
        ) : null}
        {pending ? "Actualizando…" : cooldown > 0 ? `Actualizar (${cooldown} s)` : "Actualizar ahora"}
      </button>
    </div>
  );
}
