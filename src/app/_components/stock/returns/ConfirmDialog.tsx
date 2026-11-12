"use client";

import { useRef, useState } from "react";

import type { ReturnRow } from "~/lib/stock-contracts";
import { api } from "~/trpc/react";
import { ACTION_LABEL, confirmText, type ReturnAction } from "./actions";
import { btnGhost, btnPrimary, field, Modal } from "./Modal";

export function ConfirmDialog({ row, action, onClose, onDone }: {
  row: ReturnRow; action: ReturnAction; onClose: () => void; onDone: () => void;
}) {
  const [note, setNote] = useState("");
  // One key per dialog: a retry after a network error cannot apply the decision twice.
  const key = useRef(`return:${row.id}:${action}:${crypto.randomUUID()}`);
  const resolve = api.stockReturns.resolve.useMutation({ onSuccess: onDone });

  const submit = () => {
    if (resolve.isPending) return;
    resolve.mutate({
      returnId: row.id, outcome: action, idempotencyKey: key.current,
      note: note.trim() || undefined,
      confirmRestock: action === "restocked" ? true : undefined,
    });
  };

  return (
    <Modal title={`${ACTION_LABEL[action]} · ${row.productName}`}>
      <p className="m-0 mb-3 text-[13px]">
        Orden {row.orderId} · {row.quantity} u. {confirmText(action, row.quantity)}
      </p>
      <label className="mb-3 block text-xs text-mut">
        Nota (opcional)
        <textarea className={`${field} mt-1`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {resolve.error ? <p role="alert" className="mb-2 text-xs text-neg">{resolve.error.message}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnGhost} onClick={onClose} disabled={resolve.isPending}>Cancelar</button>
        <button type="button" className={btnPrimary} onClick={submit} disabled={resolve.isPending}>
          {resolve.isPending ? "Guardando…" : "Confirmar"}
        </button>
      </div>
    </Modal>
  );
}
