"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

const inputCls = "h-8 w-full rounded-lg border border-line bg-card px-2 text-[13px] text-ink";

export function CreateProductModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const utils = api.useUtils();
  const [f, setF] = useState({ name: "", ean: "", sku: "", category: "", stock: "", cost: "" });
  const [err, setErr] = useState<string | null>(null);
  const create = api.stockProducts.create.useMutation({
    onSuccess: async (r) => { await utils.stockProducts.invalidate(); onCreated(r.productId); },
    onError: (e) => setErr(e.message),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!f.name.trim()) return setErr("El nombre es obligatorio.");
    if (f.ean && !/^\d{13}$/.test(f.ean)) return setErr("El EAN debe tener 13 dígitos.");
    const stock = f.stock === "" ? undefined : Number(f.stock.replace(",", "."));
    const cost = f.cost === "" ? undefined : Number(f.cost.replace(",", "."));
    if ((stock !== undefined && !(stock >= 0)) || (cost !== undefined && !(cost >= 0))) return setErr("Stock y costo deben ser números positivos.");
    create.mutate({
      name: f.name.trim(), ean: f.ean || null, sku: f.sku.trim() || null, category: f.category.trim(), model: "", minUnits: null,
      ...(stock !== undefined ? { initialStock: stock } : {}), ...(cost !== undefined ? { initialCost: cost } : {}),
    });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Nuevo producto">
      <form onSubmit={submit} className="grid max-h-full w-full max-w-md gap-3 overflow-y-auto rounded-xl border border-line bg-card p-4">
        <h2 className="m-0 text-base font-semibold">Nuevo producto</h2>
        <label className="grid gap-0.5 text-xs text-mut">Nombre<input className={inputCls} value={f.name} onChange={set("name")} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-0.5 text-xs text-mut">EAN<input className={inputCls} inputMode="numeric" value={f.ean} onChange={set("ean")} /></label>
          <label className="grid gap-0.5 text-xs text-mut">SKU<input className={inputCls} value={f.sku} onChange={set("sku")} /></label>
        </div>
        <label className="grid gap-0.5 text-xs text-mut">Categoría<input className={inputCls} value={f.category} onChange={set("category")} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-0.5 text-xs text-mut">Stock inicial (opcional)<input className={inputCls} inputMode="decimal" value={f.stock} onChange={set("stock")} /></label>
          <label className="grid gap-0.5 text-xs text-mut">Costo unitario (opcional)<input className={inputCls} inputMode="decimal" value={f.cost} onChange={set("cost")} /></label>
        </div>
        {err && <p role="alert" className="m-0 text-[13px] text-neg">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-lg border border-line px-3 text-[13px]">Cancelar</button>
          <button type="submit" disabled={create.isPending} className="h-8 rounded-lg bg-navy px-3 text-[13px] font-semibold text-white disabled:opacity-50">Crear producto</button>
        </div>
      </form>
    </div>
  );
}
