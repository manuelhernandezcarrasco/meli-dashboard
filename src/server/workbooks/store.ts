import type { Base, Inputs, PrevCierre } from "~/lib/contracts";
import { loadBusinessConfig } from "~/server/config";
import { targetMonth } from "~/server/sync/rebuild";
import { db } from "~/server/db";
import { chunks, ensureAccount, type Db } from "~/server/store/bulk";
import { MERCADOLIBRE } from "~/server/store/marketplace";
import { readBase, readInputs } from "./read";
import type { UploadKind } from "./upload";

export interface UploadSummary {
  kind: UploadKind;
  fileName: string;
  uploadedAt: string;
  /** SKUs in the P&L, or direct-sale rows in the inputs file */
  rows: number;
}

const ROWS = 1000;
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Forces a recompute of the month on screen. Earlier months' snapshots are kept: they are the
 * list of history that "Recalcular histórico" refreshes.
 */
async function dropCurrentSnapshot(tx: Db, ownerId: string): Promise<void> {
  await tx.snapshot.deleteMany({ where: { accountId: ownerId, month: targetMonth(new Date()) } });
}

/** Replaces the P&L close (products + previous totals) of the account. */
async function replacePnl(tx: Db, ownerId: string, { base, prev }: { base: Base; prev: PrevCierre }): Promise<void> {
  await tx.product.deleteMany({ where: { accountId: ownerId } });
  await tx.pnlClosing.deleteMany({ where: { accountId: ownerId } });
  const products = Object.entries(base).map(([ean, b], position) => ({
    accountId: ownerId,
    ean,
    description: b.desc,
    model: b.modelo,
    category: b.cat,
    unitCost: b.cu,
    stockFinal: b.stock,
    assumedMargin: b.mg,
    prevMlCostPct: b.costoMlPctPrev,
    prevUnits: b.udsPrev,
    position,
  }));
  for (const data of chunks(products, ROWS)) await tx.product.createMany({ data });
  await tx.pnlClosing.create({
    data: {
      accountId: ownerId,
      salesMl: prev.ventaMl,
      salesDirect: prev.ventaVa,
      sales: prev.venta,
      mlCosts: prev.costoMl,
      cogs: prev.cogs,
      units: prev.uds,
      netIncome: prev.ingNetos,
      margin: prev.margen,
    },
  });
}

/** Replaces overrides, mappings, direct sales and stock receipts of the account. */
async function replaceInputs(tx: Db, ownerId: string, inputs: Inputs): Promise<void> {
  const where = { accountId: ownerId };
  await Promise.all([
    tx.costOverride.deleteMany({ where }),
    tx.productMapping.deleteMany({ where }),
    tx.directSale.deleteMany({ where }),
    tx.stockReceipt.deleteMany({ where }),
  ]);
  await tx.costOverride.createMany({
    data: Object.entries(inputs.override).map(([ean, o]) => ({
      accountId: ownerId,
      ean,
      unitCost: o.cu,
      description: o.desc,
      category: o.cat,
    })),
  });
  const mappings = [
    ...Object.entries(inputs.mapItem).map(([key, ean]) => ({
      accountId: ownerId, marketplace: MERCADOLIBRE, kind: "item" as const, key, ean,
    })),
    ...Object.entries(inputs.mapSku).map(([key, ean]) => ({
      accountId: ownerId, marketplace: MERCADOLIBRE, kind: "sku" as const, key, ean,
    })),
  ];
  for (const data of chunks(mappings, ROWS)) await tx.productMapping.createMany({ data });
  for (const data of chunks(inputs.va, ROWS)) {
    await tx.directSale.createMany({
      data: data.map((v) => ({
        accountId: ownerId,
        saleDate: day(v.date),
        customer: v.cliente,
        ean: v.ean,
        description: v.desc,
        quantity: v.qty,
        unitPrice: v.pu,
      })),
    });
  }
  for (const data of chunks(inputs.ingresos, ROWS)) {
    await tx.stockReceipt.createMany({
      data: data.map((i) => ({ accountId: ownerId, receiptDate: day(i.date), ean: i.ean, quantity: i.qty })),
    });
  }
}

/**
 * Parses an uploaded workbook, stores the normalized data for `ownerId` and drops the cached
 * snapshot of the month on screen so the next dashboard load recomputes with it. All or nothing.
 * Throws the reader's Spanish error message when the file does not have the expected sheets/headers.
 */
export async function saveUpload(
  ownerId: string,
  kind: UploadKind,
  fileName: string,
  buf: Buffer,
): Promise<UploadSummary> {
  const cfg = kind === "pnl" ? loadBusinessConfig() : null;
  const parsed = cfg ? await readBase(buf, cfg) : await readInputs(buf);
  const rows = cfg ? Object.keys((parsed as { base: Base }).base).length : (parsed as Inputs).va.length;
  await ensureAccount(ownerId);
  const row = await db.$transaction(
    async (tx) => {
      if (cfg) await replacePnl(tx, ownerId, parsed as { base: Base; prev: PrevCierre });
      else await replaceInputs(tx, ownerId, parsed as Inputs);
      const up = await tx.upload.upsert({
        where: { accountId_kind: { accountId: ownerId, kind } },
        create: { accountId: ownerId, kind, fileName, rowCount: rows },
        update: { fileName, rowCount: rows, uploadedAt: new Date() },
      });
      await dropCurrentSnapshot(tx, ownerId);
      return up;
    },
    { timeout: 60_000 },
  );
  return { kind, fileName, uploadedAt: row.uploadedAt.toISOString(), rows };
}

export async function listUploads(ownerId: string): Promise<UploadSummary[]> {
  const rows = await db.upload.findMany({ where: { accountId: ownerId }, orderBy: { kind: "asc" } });
  return rows.map((r) => ({
    kind: r.kind,
    fileName: r.fileName,
    uploadedAt: r.uploadedAt.toISOString(),
    rows: r.rowCount,
  }));
}

export async function deleteUpload(ownerId: string, kind: UploadKind): Promise<void> {
  await db.$transaction(async (tx) => {
    const where = { accountId: ownerId };
    if (kind === "pnl") await Promise.all([tx.product.deleteMany({ where }), tx.pnlClosing.deleteMany({ where })]);
    else {
      await Promise.all([
        tx.costOverride.deleteMany({ where }),
        tx.productMapping.deleteMany({ where }),
        tx.directSale.deleteMany({ where }),
        tx.stockReceipt.deleteMany({ where }),
      ]);
    }
    await tx.upload.deleteMany({ where: { ...where, kind } });
    await dropCurrentSnapshot(tx, ownerId);
  });
}

/** The user's uploaded data, or undefined for whatever they have not uploaded yet. */
export async function loadUploaded(
  ownerId: string,
): Promise<{ base?: Base; prev?: PrevCierre; inputs?: Inputs }> {
  const kinds = new Set((await db.upload.findMany({ where: { accountId: ownerId }, select: { kind: true } })).map((u) => u.kind));
  const out: { base?: Base; prev?: PrevCierre; inputs?: Inputs } = {};
  const where = { accountId: ownerId };
  if (kinds.has("pnl")) {
    const [products, closing] = await Promise.all([
      db.product.findMany({ where, orderBy: { position: "asc" } }),
      db.pnlClosing.findUnique({ where: { accountId: ownerId } }),
    ]);
    out.base = Object.fromEntries(
      products.map((p) => [
        p.ean,
        {
          ean: p.ean,
          desc: p.description,
          modelo: p.model,
          cat: p.category,
          cu: p.unitCost,
          stock: p.stockFinal,
          mg: p.assumedMargin,
          costoMlPctPrev: p.prevMlCostPct,
          udsPrev: p.prevUnits,
        },
      ]),
    );
    if (closing) {
      out.prev = {
        ventaMl: closing.salesMl,
        ventaVa: closing.salesDirect,
        venta: closing.sales,
        costoMl: closing.mlCosts,
        cogs: closing.cogs,
        uds: closing.units,
        ingNetos: closing.netIncome,
        margen: closing.margin,
      };
    }
  }
  if (kinds.has("inputs")) {
    const [overrides, mappings, sales, receipts] = await Promise.all([
      db.costOverride.findMany({ where }),
      db.productMapping.findMany({ where }),
      db.directSale.findMany({ where, orderBy: { id: "asc" } }),
      db.stockReceipt.findMany({ where, orderBy: { id: "asc" } }),
    ]);
    out.inputs = {
      va: sales.map((v) => ({
        date: isoDay(v.saleDate),
        cliente: v.customer,
        ean: v.ean,
        desc: v.description,
        qty: v.quantity.toNumber(),
        pu: v.unitPrice.toNumber(),
      })),
      mapItem: Object.fromEntries(mappings.filter((m) => m.kind === "item").map((m) => [m.key, m.ean])),
      mapSku: Object.fromEntries(mappings.filter((m) => m.kind === "sku").map((m) => [m.key, m.ean])),
      override: Object.fromEntries(
        overrides.map((o) => [o.ean, { cu: o.unitCost, desc: o.description, cat: o.category }]),
      ),
      ingresos: receipts.map((i) => ({ date: isoDay(i.receiptDate), ean: i.ean, qty: i.quantity.toNumber() })),
    };
  }
  return out;
}
