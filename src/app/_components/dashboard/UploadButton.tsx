"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Kind = "pnl" | "inputs";

interface Upload {
  kind: Kind;
  fileName: string;
  uploadedAt: string;
  rows: number;
}

const SLOTS: ReadonlyArray<{ kind: Kind; title: string; hint: string; unit: string }> = [
  { kind: "pnl", title: "P&L del cierre anterior", hint: "Hoja «P&L Detalle»: SKUs, costos y stock", unit: "SKUs" },
  { kind: "inputs", title: "Ventas directas y mapeo", hint: "Ventas Directas, Mapeo ML, Costos Override, Ingresos Stock", unit: "ventas directas" },
];

export function UploadButton({ onUploaded }: { onUploaded: () => void }) {
  const [open, setOpen] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<Partial<Record<Kind, HTMLInputElement | null>>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/upload");
      if (r.ok) setUploads(((await r.json()) as { uploads: Upload[] }).uploads);
    } catch {
      /* listing is best effort */
    }
  }, []);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function send(kind: Kind, file: File) {
    setBusy(kind);
    setError(null);
    try {
      const body = new FormData();
      body.set("kind", kind);
      body.set("file", file);
      const r = await fetch("/api/upload", { method: "POST", body });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? "No se pudo subir el archivo");
      await load();
      onUploaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo subir el archivo");
    } finally {
      setBusy(null);
    }
  }

  async function remove(kind: Kind) {
    setBusy(kind);
    setError(null);
    try {
      const r = await fetch(`/api/upload?kind=${kind}`, { method: "DELETE" });
      if (!r.ok) throw new Error("No se pudo quitar el archivo");
      await load();
      onUploaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo quitar el archivo");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-card px-3 py-1.5 text-[13px] text-ink"
      >
        Subir Excel
      </button>
      {open ? (
        <div className="absolute right-0 z-10 mt-2 w-[340px] rounded-xl border border-line bg-card p-3 text-left shadow-lg">
          {SLOTS.map((s) => {
            const up = uploads.find((u) => u.kind === s.kind);
            return (
              <div key={s.kind} className="mb-3 last:mb-0">
                <div className="text-[13px] font-semibold">{s.title}</div>
                <div className="text-xs text-mut">{s.hint}</div>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    ref={(el) => {
                      inputs.current[s.kind] = el;
                    }}
                    type="file"
                    accept=".xlsx"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void send(s.kind, f);
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => inputs.current[s.kind]?.click()}
                    className="cursor-pointer rounded-lg border border-line bg-card px-2.5 py-1 text-xs disabled:opacity-60"
                  >
                    {busy === s.kind ? "Procesando…" : up ? "Reemplazar" : "Elegir .xlsx"}
                  </button>
                  {up ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-xs text-mut" title={up.fileName}>
                        {up.fileName} · {up.rows} {s.unit}
                      </span>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void remove(s.kind)}
                        className="cursor-pointer border-0 bg-transparent text-xs text-neg underline disabled:opacity-60"
                      >
                        Quitar
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
          {error ? (
            <p role="alert" className="m-0 mt-2 text-xs text-neg">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
