import { toArgParts } from "~/lib/dates";
import { normEan, toNum } from "~/lib/normalize";
import type {
  Base,
  BusinessConfig,
  Gtins,
  Inputs,
  Line,
  Order,
  ShipCosts,
  TaxMap,
} from "~/lib/contracts";

/** Python `f"{x:,.0f}"` with "." as thousands separator (ties to even). */
function fmtThousands(x: number): string {
  let r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) r -= 1;
  const s = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return r < 0 ? `-${s}` : s;
}

const pct0 = (v: number) => `${(v * 100).toFixed(0)}%`;
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Port of `build_lines` (legacy 497–598). */
export function buildLines(
  orders: Order[],
  shipCosts: ShipCosts,
  gtins: Gtins,
  base: Base,
  inputs: Inputs,
  cfg: BusinessConfig,
  y: number,
  m: number,
  taxes?: TaxMap,
): Line[] {
  const mgDefault: Record<string, number> = {};
  for (const [k, v] of Object.entries(cfg.margenAsumido)) mgDefault[k.toUpperCase()] = v;
  const impPct =
    typeof cfg.impuestosMlPctEstimado === "number" ? cfg.impuestosMlPctEstimado : 0;
  const lines: Line[] = [];

  const paid = orders.filter((o) => o.status === "paid");
  const revOf = (o: Order) =>
    o.items.reduce((s, i) => s + toNum(i.unitPrice) * toNum(i.quantity), 0);

  // shipping is shared by every order of the same shipment
  const shipRev = new Map<number, number>();
  for (const o of paid) {
    if (o.shippingId) shipRev.set(o.shippingId, (shipRev.get(o.shippingId) ?? 0) + revOf(o));
  }

  const costFor = (ean: string, descFallback: string, unitPrice: number) => {
    const ov = inputs.override[ean];
    if (ov) {
      const b = base[ean];
      return {
        cu: ov.cu,
        source: "Override",
        cat: ov.cat || b?.cat || "OTRAS",
        desc: b?.desc || ov.desc || descFallback,
      };
    }
    const b = base[ean];
    if (b) {
      if (b.cu > 0) return { cu: b.cu, source: "Real (CU Pond. cierre)", cat: b.cat, desc: b.desc };
      return {
        cu: unitPrice * (1 - b.mg),
        source: `Asumido ${pct0(b.mg)}`,
        cat: b.cat,
        desc: b.desc,
      };
    }
    const mg = mgDefault["SIN MATCH"] ?? 0.3;
    return {
      cu: unitPrice * (1 - mg),
      source: `Sin match – asumido ${pct0(mg)}`,
      cat: "SIN MATCH",
      desc: descFallback,
    };
  };

  for (const o of paid) {
    const f = toArgParts(o.dateCreated);
    const revO = revOf(o);
    const sid = o.shippingId;
    let shipO = 0;
    const shipTotal = sid ? (shipRev.get(sid) ?? 0) : 0;
    if (sid && shipTotal) shipO = ((shipCosts[String(sid)] ?? 0) * revO) / shipTotal;

    // real Mercado Pago taxes when present, otherwise the estimated %
    let txO = 0;
    let hasMp = false;
    const txDet = new Map<string, number>();
    for (const pay of o.payments) {
      const t = taxes?.[String(pay.id)];
      if (t && pay.status === "approved") {
        hasMp = true;
        txO += t.total;
        for (const [k, v] of Object.entries(t.det)) txDet.set(k, (txDet.get(k) ?? 0) + v);
      }
    }

    for (const it of o.items) {
      const iid = it.itemId.toUpperCase();
      const vid = it.variationId ? String(it.variationId) : "";
      const sku = (it.sellerSku || it.sellerCustomField || "").trim();
      const qty = toNum(it.quantity);
      const pu = toNum(it.unitPrice);
      const venta = pu * qty;
      let ean = "";
      let via = "";
      if (iid in inputs.mapItem) {
        ean = inputs.mapItem[iid]!;
        via = "Mapeo item";
      } else if (sku && sku in inputs.mapSku) {
        ean = inputs.mapSku[sku]!;
        via = "Mapeo SKU";
      } else if (sku && normEan(sku) in base) {
        ean = normEan(sku);
        via = "SKU=EAN";
      } else {
        const g = gtins[iid] ?? {};
        ean = (vid && g[vid]) || g._item || "";
        via = ean ? "GTIN publicación" : "";
      }
      const fee = toNum(it.saleFee) * qty;
      const share = revO ? venta / revO : 0;
      const shipLine = shipO * share;
      const impLine = hasMp ? txO * share : venta * impPct;
      const c = costFor(ean, it.title, pu);
      const cat = ean && !(ean in base) && !(ean in inputs.override) ? "SIN MATCH" : c.cat;
      lines.push({
        date: f.date,
        time: f.time,
        channel: "ML",
        order: String(o.packId || o.id),
        itemId: iid,
        sku,
        ean,
        matchVia: via || "Sin match",
        desc: c.desc || it.title,
        titleMl: it.title,
        cat,
        qty,
        pu,
        venta,
        cargoVenta: fee,
        envio: shipLine,
        impEst: impLine,
        costoMl: fee + shipLine + impLine,
        cu: c.cu,
        costSource: c.source,
        taxSource: hasMp ? "Mercado Pago" : `Estimado ${pct1(impPct)}`,
        taxDetail: [...txDet].map(([k, v]) => `${k} ${fmtThousands(v * share)}`).join("; "),
      });
    }
  }

  for (const v of inputs.va) {
    if (v.date.slice(0, 7) !== `${y}-${String(m).padStart(2, "0")}`) continue;
    const c = costFor(v.ean, v.desc, v.pu);
    const cat = !(v.ean in base) && !(v.ean in inputs.override) ? "SIN MATCH" : c.cat;
    lines.push({
      date: v.date,
      time: "",
      channel: "VA",
      order: v.cliente,
      itemId: "",
      sku: "",
      ean: v.ean,
      matchVia: "Carga manual",
      desc: c.desc || v.desc,
      titleMl: "",
      cat,
      qty: v.qty,
      pu: v.pu,
      venta: v.qty * v.pu,
      cargoVenta: 0,
      envio: 0,
      impEst: 0,
      costoMl: 0,
      cu: c.cu,
      costSource: c.source,
      taxSource: "",
      taxDetail: "",
    });
  }

  const key = (l: Line) => `${l.date}\u0000${l.time}\u0000${l.channel}`;
  return lines.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
