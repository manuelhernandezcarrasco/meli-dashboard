"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { btnGhost, btnPrimary, field, Modal } from "./Modal";

export function RegisterReturnDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const products = api.stockProducts.list.useQuery({});
  const create = api.stockReturns.create.useMutation({ onSuccess: onDone });
  const [orderId, setOrderId] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");

  const order = Number(orderId);
  const qty = Number(quantity);
  const valid = Number.isInteger(order) && order > 0 && productId !== "" && qty > 0;

  const submit = () => {
    if (!valid || create.isPending) return;
    create.mutate({ orderId: order, lineNo: 0, productId: Number(productId), quantity: qty, reason: reason.trim() || undefined });
  };

  return (
    <Modal title="Registrar devolución">
      <div className="mb-3 grid gap-2.5">
        <label className="text-xs text-mut">
          Número de orden
          <input className={`${field} mt-1`} inputMode="numeric" value={orderId} onChange={(e) => setOrderId(e.target.value)} />
        </label>
        <label className="text-xs text-mut">
          Producto
          <select className={`${field} mt-1`} value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Elegí un producto…</option>
            {(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-mut">
          Cantidad
          <input className={`${field} mt-1`} type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </label>
        <label className="text-xs text-mut">
          Motivo (opcional)
          <input className={`${field} mt-1`} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      {create.error ? <p role="alert" className="mb-2 text-xs text-neg">{create.error.message}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnGhost} onClick={onClose} disabled={create.isPending}>Cancelar</button>
        <button type="button" className={btnPrimary} onClick={submit} disabled={!valid || create.isPending}>
          {create.isPending ? "Guardando…" : "Registrar"}
        </button>
      </div>
    </Modal>
  );
}
