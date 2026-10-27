// owner: T2
import type {
  Base,
  Gtins,
  Order,
  PaymentTaxes,
  ShipCosts,
} from "~/lib/contracts";
import { daysIn, nowArg } from "~/lib/dates";
import type { DataSource } from "./types";

/** Tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function crc32(s: string): number {
  let c = ~0;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i);
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const JURIS = [
  "IIBB Retención CABA",
  "IIBB Retención Buenos Aires",
  "IIBB Retención Córdoba",
];

export interface DemoOptions {
  base: Base;
  now: Date;
  seed?: number;
}

export class DemoDataSource implements DataSource {
  private readonly base: Base;
  private readonly now: Date;
  private readonly seed: number;
  private readonly ships: ShipCosts = {};
  private readonly gtins: Gtins = {};
  private readonly payValue = new Map<string, number>();

  constructor(opts: DemoOptions) {
    this.base = opts.base;
    this.now = opts.now;
    this.seed = opts.seed ?? 42;
  }

  async getOrdersMonth(y: number, m: number): Promise<Order[]> {
    const rnd = mulberry32(this.seed * 1_000_003 + y * 12 + m);
    const randint = (a: number, b: number) =>
      a + Math.floor(rnd() * (b - a + 1));
    const uniform = (a: number, b: number) => a + rnd() * (b - a);

    const skus = Object.values(this.base).sort((a, b) =>
      a.ean < b.ean ? -1 : a.ean > b.ean ? 1 : 0,
    );
    const weights = skus.map((b) =>
      b.cat === "SONY" || b.cat === "PLAY STATION" ? 3 : b.cat === "VINOS" ? 2 : 1,
    );
    const totalW = weights.reduce((a, b) => a + b, 0);
    const pick = () => {
      let r = rnd() * totalW;
      for (let i = 0; i < skus.length; i++) {
        r -= weights[i]!;
        if (r < 0) return skus[i]!;
      }
      return skus[skus.length - 1]!;
    };

    const today = nowArg(this.now);
    const current = today.y === y && today.m === m;
    const last = current ? today.d : daysIn(y, m);
    const orders: Order[] = [];
    let oid = 2_000_009_000_000 + ((y * 12 + m) % 1000) * 100_000;

    for (let d = 1; d <= last; d++) {
      const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
      const n = Math.floor(
        (randint(8, 16) + (wd === 1 ? 5 : 0) - (wd === 0 ? 3 : 0)) *
          (1 + d / 120),
      );
      for (let i = 0; i < n; i++) {
        const b = pick();
        const cu = b.cu || 40000;
        const pu = Math.round(cu / (1 - uniform(0.2, 0.34)) / 100) * 100;
        const qty = rnd() < 0.86 ? 1 : 2;
        const iid = `MLA${1_400_000_000 + (crc32(b.ean) % 99_999_999)}`;
        this.gtins[iid] = { _item: b.ean };
        oid += 1;
        const sid = 44_000_000_000 + (oid % 100_000_000);
        this.ships[String(sid)] =
          pu * qty < 300000 ? Math.round(pu * qty * uniform(0.02, 0.06)) : 0;
        let hh = randint(8, 23);
        if (current && d === last) hh = randint(8, Math.max(8, today.d === d ? Number(today.time.slice(0, 2)) : 23));
        const paid = rnd() > 0.04;
        const mm = randint(0, 59);
        const payId = 90_000_000_000 + oid;
        this.payValue.set(String(payId), pu * qty);
        orders.push({
          id: oid,
          packId: null,
          status: paid ? "paid" : "cancelled",
          dateCreated: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000-03:00`,
          shippingId: sid,
          items: [
            {
              itemId: iid,
              title: b.desc,
              sellerSku: "",
              sellerCustomField: null,
              variationId: null,
              quantity: qty,
              unitPrice: pu,
              saleFee: Math.round(pu * uniform(0.12, 0.16)),
            },
          ],
          payments: [{ id: payId, status: "approved" }],
        });
      }
    }
    if (current) {
      // a listing with no EAN, to exercise the "Sin match" flow
      this.ships["1"] = 0;
      orders.push({
        id: oid + 1,
        packId: null,
        status: "paid",
        dateCreated: `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}T12:00:00.000-03:00`,
        shippingId: 1,
        items: [
          {
            itemId: "MLA1999999999",
            title: "Combo cable USB-C + cargador 65W",
            sellerSku: "COMBO-65",
            sellerCustomField: null,
            variationId: null,
            quantity: 1,
            unitPrice: 42000,
            saleFee: 5900,
          },
        ],
        payments: [],
      });
    }
    return orders;
  }

  async getShipmentCosts(shippingIds: string[]): Promise<ShipCosts> {
    const out: ShipCosts = {};
    for (const id of shippingIds) if (id in this.ships) out[id] = this.ships[id]!;
    return out;
  }

  async getGtins(itemIds: string[]): Promise<Gtins> {
    const out: Gtins = {};
    for (const id of itemIds) if (id in this.gtins) out[id] = this.gtins[id]!;
    return out;
  }

  async getPaymentTaxes(
    paymentIds: string[],
  ): Promise<Record<string, PaymentTaxes | null>> {
    const out: Record<string, PaymentTaxes | null> = {};
    for (const id of paymentIds) {
      const v = this.payValue.get(id);
      const rnd = mulberry32(this.seed * 7919 + Number(id));
      if (v === undefined || rnd() < 0.1) {
        out[id] = null; // payment without detail -> estimated
        continue;
      }
      const name = JURIS[Math.floor(rnd() * JURIS.length)]!;
      const iibb = Math.round(v * (0.02 + rnd() * 0.025));
      const deb = Math.round(v * 0.012);
      out[id] = { total: iibb + deb, det: { [name]: iibb, "Imp. Débitos y Créditos": deb } };
    }
    return out;
  }
}
