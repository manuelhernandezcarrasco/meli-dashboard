#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PnL Diario en vivo — MercadoLibre + Venta Directa (MCG)
=======================================================

Trae las órdenes del mes desde la API de MercadoLibre, las cruza con el costo
(CU Pond.) y el stock final del P&L del cierre del mes anterior, suma la venta
directa cargada a mano y genera:

  * PnL_Diario_<Mes><Año>.xlsx   (Excel con fórmulas: Resumen, PnL Diario,
                                  Comparativo, PnL por SKU, Detalle Ventas, Base Costos, Sin Match)
  * Reportes/Reporte_Cierre_<fecha>.html  (al cierre de cada día: acumulado del mes vs mes anterior)
  * Dashboard_PnL_Diario.html    (dashboard local que se refresca solo)

Comandos:
  python ml_pnl_live.py auth      -> autoriza la app de ML una sola vez (guarda tokens.json)
  python ml_pnl_live.py sync      -> trae ventas y regenera Excel + dashboard una vez
  python ml_pnl_live.py loop      -> repite el sync cada N minutos (config: refresh_minutes) y a la
                                     hora_cierre genera el reporte del día (acumulado vs mes anterior)
  python ml_pnl_live.py reporte [AAAA-MM-DD] -> genera el reporte de cierre de ese día a mano
  python ml_pnl_live.py demo      -> genera todo con datos ficticios (sin API) para probar

Definiciones (mismas que el P&L mensual):
  Venta Total     = Venta ML (Ingresos por productos) + Venta Directa
  Costo ML        = cargo por venta + costo de envío a cargo del vendedor
                    (+ % de impuestos/retenciones estimado, configurable)
  Ingresos Netos  = Venta Total − Costo ML
  COGS            = Uds × CU Pond. del cierre anterior (o margen asumido por categoría)
  Margen Bruto    = Ingresos Netos − COGS
"""

import json
import os
import re
import sys
import time
import random
import zlib
import datetime as dt
import urllib.parse
import urllib.request
import urllib.error
from collections import defaultdict

try:
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    from openpyxl.comments import Comment
except ImportError:
    print("Falta openpyxl. Instalalo con:  pip install openpyxl")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
TOKENS_PATH = os.path.join(HERE, "tokens.json")
CACHE_PATH = os.path.join(HERE, "cache_ml.json")

API = "https://api.mercadolibre.com"
MP_API = "https://api.mercadopago.com"
AUTH_URL = "https://auth.mercadolibre.com.ar/authorization"
TZ = dt.timezone(dt.timedelta(hours=-3))  # Argentina

MESES = ["", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio",
         "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]

CATEGORIAS = ["SONY", "PLAY STATION", "XBOX", "BOSCH", "VINOS", "ONFAN", "OTRAS"]
DEFAULT_MG = {"SONY": 0.08, "PLAY STATION": 0.08, "XBOX": 0.15, "BOSCH": 0.15,
              "VINOS": 0.20, "ONFAN": 0.20, "OTRAS": 0.30, "SIN MATCH": 0.30}


# --------------------------------------------------------------------------- utils
def log(msg):
    print(f"[{dt.datetime.now(TZ).strftime('%H:%M:%S')}] {msg}", flush=True)


def norm_ean(x):
    if x is None:
        return ""
    s = str(x).strip()
    if not s:
        return ""
    try:
        if re.fullmatch(r"\d+(\.0+)?", s) or re.fullmatch(r"\d+(\.\d+)?[eE]\+?\d+", s):
            return str(int(float(s)))
    except Exception:
        pass
    return s


def norm_hdr(x):
    s = str(x or "").strip().lower()
    for a, b in (("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u")):
        s = s.replace(a, b)
    return re.sub(r"[^a-z0-9%]", "", s)


def to_num(x, default=0.0):
    if x is None or x == "":
        return default
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).replace("$", "").replace(" ", "")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return default


def to_pct(x):
    """Acepta 0.15, 15, '15%'."""
    if x is None or x == "":
        return None
    v = to_num(str(x).replace("%", ""), None) if not isinstance(x, (int, float)) else float(x)
    if v is None:
        return None
    return v / 100 if v > 1 else v


def norm_cat(x):
    s = str(x or "").strip().upper()
    s = s.replace("PLAYSTATION", "PLAY STATION")
    if s in CATEGORIAS:
        return s
    for c in CATEGORIAS:
        if c in s:
            return c
    return s or "OTRAS"


def load_json(path, default):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_config():
    if not os.path.exists(CONFIG_PATH):
        print("No encuentro config.json. Copiá config.example.json como config.json y completalo.")
        sys.exit(1)
    cfg = load_json(CONFIG_PATH, {})
    cfg.setdefault("refresh_minutes", 15)
    cfg.setdefault("impuestos_ml_pct_estimado", "auto")
    cfg.setdefault("margen_asumido", DEFAULT_MG)
    cfg.setdefault("output_dir", HERE)
    if not cfg.get("mes"):
        cfg["mes"] = dt.datetime.now(TZ).strftime("%Y-%m")
    return cfg


def resolve(path):
    if not path:
        return path
    return path if os.path.isabs(path) else os.path.join(HERE, path)


# --------------------------------------------------------------------------- API ML
class ML:
    def __init__(self, cfg):
        self.cfg = cfg
        self.tokens = load_json(TOKENS_PATH, {})

    def _req(self, method, url, data=None, headers=None, auth=True, retries=4):
        headers = dict(headers or {})
        if auth:
            headers["Authorization"] = f"Bearer {self.tokens['access_token']}"
        body = None
        if data is not None:
            body = urllib.parse.urlencode(data).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        headers["Accept"] = "application/json"
        for i in range(retries):
            req = urllib.request.Request(url, data=body, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.loads(r.read().decode())
            except urllib.error.HTTPError as e:
                txt = e.read().decode(errors="ignore")
                if e.code == 401 and auth and i == 0:
                    self.refresh()
                    headers["Authorization"] = f"Bearer {self.tokens['access_token']}"
                    continue
                if e.code in (429, 500, 502, 503, 504):
                    time.sleep(2 ** i)
                    continue
                if e.code == 404:
                    return None
                raise RuntimeError(f"HTTP {e.code} en {url}: {txt[:300]}")
            except urllib.error.URLError:
                time.sleep(2 ** i)
        raise RuntimeError(f"No pude conectar con {url}")

    def get(self, path, params=None, headers=None):
        url = API + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        return self._req("GET", url, headers=headers)

    # --- OAuth
    def auth_interactive(self):
        c = self.cfg
        url = AUTH_URL + "?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": c["client_id"], "redirect_uri": c["redirect_uri"]})
        print("\n1) Abrí este link, ingresá con la cuenta de MCG y autorizá la app:\n")
        print("   " + url + "\n")
        print("2) Te va a redirigir a tu redirect_uri con ?code=TG-xxxx en la barra de direcciones.")
        code = input("3) Pegá acá el code (o la URL completa): ").strip()
        m = re.search(r"code=([^&\s]+)", code)
        if m:
            code = m.group(1)
        tok = self._req("POST", API + "/oauth/token", auth=False, data={
            "grant_type": "authorization_code", "client_id": c["client_id"],
            "client_secret": c["client_secret"], "code": code, "redirect_uri": c["redirect_uri"]})
        self._store(tok)
        me = self.get("/users/me")
        print(f"\nListo. Autorizado como {me.get('nickname')} (user_id {me.get('id')}).")

    def refresh(self):
        c = self.cfg
        if not self.tokens.get("refresh_token"):
            raise RuntimeError("No hay refresh_token. Corré:  python ml_pnl_live.py auth")
        tok = self._req("POST", API + "/oauth/token", auth=False, data={
            "grant_type": "refresh_token", "client_id": c["client_id"],
            "client_secret": c["client_secret"], "refresh_token": self.tokens["refresh_token"]})
        self._store(tok)
        log("Token renovado")

    def _store(self, tok):
        tok["obtained_at"] = time.time()
        self.tokens = tok
        save_json(TOKENS_PATH, tok)  # el refresh_token de ML es de un solo uso: siempre guardar el nuevo

    def ensure_token(self):
        t = self.tokens
        if not t.get("access_token"):
            raise RuntimeError("Falta autorizar. Corré:  python ml_pnl_live.py auth")
        if time.time() - t.get("obtained_at", 0) > t.get("expires_in", 21600) - 600:
            self.refresh()

    # --- Datos
    def orders_month(self, seller_id, y, m):
        start = dt.datetime(y, m, 1, tzinfo=TZ)
        end = dt.datetime(y + (m == 12), (m % 12) + 1, 1, tzinfo=TZ) - dt.timedelta(milliseconds=1)
        fmt = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000-03:00")
        out, offset = [], 0
        while True:
            r = self.get("/orders/search", {
                "seller": seller_id, "order.date_created.from": fmt(start),
                "order.date_created.to": fmt(end), "sort": "date_asc",
                "limit": 50, "offset": offset})
            res = (r or {}).get("results", [])
            out.extend(res)
            total = (r or {}).get("paging", {}).get("total", 0)
            offset += 50
            if offset >= total or not res:
                break
        return out

    def payment_taxes(self, pid):
        """Impuestos/retenciones de un pago según Mercado Pago (charges_details de tipo 'tax'
        a cargo del vendedor). Devuelve {"total": x, "det": {nombre: monto}} o None."""
        r = self._req("GET", f"{MP_API}/v1/payments/{pid}")
        if not r:
            return None
        return taxes_from_payment(r)

    def shipment_seller_cost(self, ship_id):
        r = self.get(f"/shipments/{ship_id}/costs", headers={"x-format-new": "true"})
        if not r:
            return 0.0
        senders = r.get("senders") or []
        return float(sum(to_num(s.get("cost")) for s in senders))

    def items_gtin(self, item_ids):
        """Devuelve {item_id: {"_item": gtin, variation_id: gtin}}."""
        res = {}
        ids = list(item_ids)
        for i in range(0, len(ids), 20):
            chunk = ids[i:i + 20]
            r = self.get("/items", {"ids": ",".join(chunk),
                                     "attributes": "id,attributes,variations,seller_custom_field"}) or []
            for it in r:
                body = it.get("body") or {}
                iid = body.get("id")
                if not iid:
                    continue
                d = {"_item": gtin_from_attrs(body.get("attributes"))}
                for v in body.get("variations") or []:
                    g = gtin_from_attrs(v.get("attributes"))
                    if g:
                        d[str(v.get("id"))] = g
                res[iid] = d
        return res


def taxes_from_payment(p):
    """Suma los cargos de tipo impuesto/retención que se descuentan al vendedor (collector)."""
    det, found = defaultdict(float), False
    for ch in p.get("charges_details") or []:
        if str(ch.get("type", "")).lower() != "tax":
            continue
        found = True
        frm = str(((ch.get("accounts") or {}).get("from")) or "collector").lower()
        if frm not in ("collector", "seller"):
            continue
        amt = (ch.get("amounts") or {})
        v = to_num(amt.get("original")) - to_num(amt.get("refunded"))
        if v:
            det[str(ch.get("name") or "impuesto")] += v
    if not found and p.get("charges_details") is None:
        return None  # pago sin detalle: se usa el % estimado
    return {"total": round(sum(det.values()), 2), "det": {k: round(v, 2) for k, v in det.items()}}


def gtin_from_attrs(attrs):
    for a in attrs or []:
        if a.get("id") in ("GTIN", "EAN", "UPC"):
            v = a.get("value_name") or ""
            v = v.split(",")[0].strip()
            if v:
                return norm_ean(v)
    return ""


# --------------------------------------------------------------------------- Base del cierre anterior
def read_base(path, cfg):
    """Lee 'P&L Detalle' del P&L del cierre anterior: EAN -> {desc, cat, cu, stock, mg}."""
    if not path or not os.path.exists(path):
        raise RuntimeError(f"No encuentro el P&L del cierre anterior: {path}")
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheet = None
    for name in wb.sheetnames:
        if norm_hdr(name) in ("pldetalle", "pyldetalle"):
            sheet = wb[name]
            break
    if sheet is None:
        raise RuntimeError(f"El archivo {os.path.basename(path)} no tiene la hoja 'P&L Detalle'")
    rows = list(sheet.iter_rows(values_only=True))
    hdr_i, cols = None, {}
    for i, row in enumerate(rows[:25]):
        n = [norm_hdr(c) for c in row]
        if "ean" in n and any(x.startswith("cupond") for x in n):
            hdr_i = i
            for j, h in enumerate(n):
                cols.setdefault(h, j)
            break
    if hdr_i is None:
        raise RuntimeError("No encontré la fila de encabezados (EAN / CU Pond.) en 'P&L Detalle'")

    def col(*names):
        for nm in names:
            for k, j in cols.items():
                if k == nm or k.startswith(nm):
                    return j
        return None

    c_cat, c_ean, c_desc, c_mod = col("cat"), col("ean"), col("descripcion"), col("modelo")
    c_cu, c_stk, c_mg = col("cupond"), col("stockfinal"), col("mgasum")
    c_vt, c_cml = col("ventatotal"), col("costoml")
    c_vml, c_vva, c_cogs, c_prof = col("ventaml"), col("ventava"), col("cogs"), col("profit")
    c_uml, c_uva = col("ml"), col("va")
    prev = {"venta_ml": 0.0, "venta_va": 0.0, "venta": 0.0, "costo_ml": 0.0, "cogs": 0.0, "uds": 0.0}
    base, cur_cat = {}, "OTRAS"
    mg_default = {k.upper(): v for k, v in cfg["margen_asumido"].items()}
    for row in rows[hdr_i + 1:]:
        def g(c):
            return row[c] if c is not None and c < len(row) else None
        ean = norm_ean(g(c_ean))
        desc = str(g(c_desc) or "").strip()
        cat_cell = str(g(c_cat) or "").strip()
        if not ean:
            # fila de título/subtotal de categoría
            label = (cat_cell or desc).upper()
            for c in CATEGORIAS:
                if c in label.replace("PLAYSTATION", "PLAY STATION") and "TOTAL" not in label:
                    cur_cat = c
            continue
        cat = norm_cat(cat_cell) if cat_cell else cur_cat
        cu = to_num(g(c_cu), 0.0)
        mg = to_pct(g(c_mg)) if c_mg is not None else None
        vt, cml = to_num(g(c_vt)), to_num(g(c_cml))
        prev["venta_ml"] += to_num(g(c_vml))
        prev["venta_va"] += to_num(g(c_vva))
        prev["venta"] += vt
        prev["costo_ml"] += cml
        prev["cogs"] += to_num(g(c_cogs))
        prev["uds"] += to_num(g(c_uml)) + to_num(g(c_uva))
        base[ean] = {
            "ean": ean, "desc": desc, "modelo": str(g(c_mod) or ""), "cat": cat,
            "cu": cu if cu > 0 else 0.0,
            "stock": to_num(g(c_stk), 0.0),
            "mg": mg if mg is not None else mg_default.get(cat, 0.30),
            "costo_ml_pct_prev": (cml / vt) if vt else None,
            "uds_prev": to_num(g(c_uml)) + to_num(g(c_uva)),
        }
    wb.close()
    prev["ing_netos"] = prev["venta"] - prev["costo_ml"]
    prev["margen"] = prev["ing_netos"] - prev["cogs"]
    log(f"Base cierre anterior: {len(base)} SKUs leídos de {os.path.basename(path)} "
        f"(Venta Total cierre: {prev['venta']:,.0f})")
    return base, prev


def read_inputs(path):
    """Workbook de carga manual: Ventas Directas, Mapeo ML, Costos Override."""
    out = {"va": [], "map_item": {}, "map_sku": {}, "override": {}, "ingresos": []}
    if not path or not os.path.exists(path):
        log("Aviso: no encontré el archivo de Ventas Directas / Mapeo; sigo sin él")
        return out
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)

    def table(name):
        if name not in wb.sheetnames:
            return []
        rows = list(wb[name].iter_rows(values_only=True))
        for i, r in enumerate(rows[:10]):
            n = [norm_hdr(c) for c in r]
            if "ean" in n:
                hdr = n
                data = []
                for rr in rows[i + 1:]:
                    if not any(v not in (None, "") for v in rr):
                        continue
                    data.append({hdr[j]: rr[j] for j in range(min(len(hdr), len(rr)))})
                return data
        return []

    for r in table("Ventas Directas"):
        f = r.get("fecha")
        if isinstance(f, dt.datetime):
            f = f.date()
        elif isinstance(f, str):
            try:
                f = dt.datetime.strptime(f.strip(), "%d/%m/%Y").date()
            except ValueError:
                f = None
        ean = norm_ean(r.get("ean"))
        qty = to_num(r.get("cantidad"))
        pu = to_num(next((v for k, v in r.items() if k.startswith("preciounit") or k == "precio"), None))
        if not f or not ean or not qty:
            continue
        if not pu:
            log(f"Aviso: venta directa del {f:%d/%m} (EAN {ean}) sin precio; se ignora")
            continue
        if str(r.get("cliente") or "").strip().upper().startswith("EJEMPLO"):
            continue
        out["va"].append({"fecha": f, "cliente": str(r.get("cliente") or ""), "ean": ean,
                          "desc": str(r.get("descripcion") or ""), "qty": qty, "pu": pu})
    for r in table("Mapeo ML"):
        ean = norm_ean(r.get("ean"))
        if not ean:
            continue
        iid = str(r.get("mlitemid") or "").strip().upper()
        sku = str(r.get("skuml") or r.get("sellersku") or "").strip()
        if iid:
            out["map_item"][iid] = ean
        if sku:
            out["map_sku"][sku] = ean
    for r in table("Costos Override"):
        ean = norm_ean(r.get("ean"))
        cu = to_num(next((v for k, v in r.items() if k.startswith("costounit")), None))
        if ean and cu > 0:
            out["override"][ean] = {"cu": cu, "desc": str(r.get("descripcion") or ""),
                                    "cat": norm_cat(r.get("cat")) if r.get("cat") else None}
    for r in table("Ingresos Stock"):
        f = r.get("fecha")
        if isinstance(f, dt.datetime):
            f = f.date()
        elif isinstance(f, str):
            try:
                f = dt.datetime.strptime(f.strip(), "%d/%m/%Y").date()
            except ValueError:
                f = None
        ean, qty = norm_ean(r.get("ean")), to_num(r.get("cantidad"))
        if f and ean and qty and not str(r.get("proveedor") or "").upper().startswith("EJEMPLO"):
            out["ingresos"].append({"fecha": f, "ean": ean, "qty": qty})
    wb.close()
    log(f"Inputs: {len(out['va'])} ventas directas, {len(out['map_item']) + len(out['map_sku'])} mapeos, "
        f"{len(out['override'])} costos override, {len(out['ingresos'])} ingresos de stock")
    return out


# --------------------------------------------------------------------------- Armado de líneas
def build_lines(orders, ship_costs, gtins, base, inputs, cfg, y, m, taxes=None):
    """Convierte órdenes ML + ventas directas del mes (y, m) en líneas de detalle con costo."""
    mg_default = {k.upper(): v for k, v in cfg["margen_asumido"].items()}
    imp_pct = float(cfg.get("impuestos_ml_pct_estimado") or 0)
    lines = []

    # prorrateo de envío por shipment (los packs comparten envío)
    ship_rev = defaultdict(float)
    paid = [o for o in orders if o.get("status") == "paid"]
    for o in paid:
        sid = (o.get("shipping") or {}).get("id")
        if sid:
            ship_rev[sid] += sum(to_num(i.get("unit_price")) * to_num(i.get("quantity"))
                                 for i in o.get("order_items", []))

    def cost_for(ean, desc_fallback, unit_price):
        if ean in inputs["override"]:
            ov = inputs["override"][ean]
            b = base.get(ean, {})
            return ov["cu"], "Override", ov.get("cat") or b.get("cat", "OTRAS"), b.get("desc") or ov["desc"] or desc_fallback
        if ean in base:
            b = base[ean]
            if b["cu"] > 0:
                return b["cu"], "Real (CU Pond. cierre)", b["cat"], b["desc"]
            return unit_price * (1 - b["mg"]), f"Asumido {b['mg']:.0%}", b["cat"], b["desc"]
        mg = mg_default.get("SIN MATCH", 0.30)
        return unit_price * (1 - mg), f"Sin match – asumido {mg:.0%}", "SIN MATCH", desc_fallback

    for o in paid:
        f = dt.datetime.fromisoformat(o["date_created"].replace("Z", "+00:00")).astimezone(TZ)
        items = o.get("order_items", [])
        rev_o = sum(to_num(i.get("unit_price")) * to_num(i.get("quantity")) for i in items)
        sid = (o.get("shipping") or {}).get("id")
        ship_o = 0.0
        if sid and ship_rev[sid]:
            ship_o = ship_costs.get(str(sid), 0.0) * rev_o / ship_rev[sid]
        # impuestos reales de Mercado Pago (si están), si no el % estimado
        tx_o, tx_det, has_mp = 0.0, defaultdict(float), False
        for pay in o.get("payments") or []:
            t = (taxes or {}).get(str(pay.get("id")))
            if t is not None and str(pay.get("status", "approved")) == "approved":
                has_mp = True
                tx_o += t["total"]
                for k, v in t["det"].items():
                    tx_det[k] += v
        for it in items:
            item = it.get("item") or {}
            iid = str(item.get("id") or "").upper()
            vid = str(item.get("variation_id") or "")
            sku = str(item.get("seller_sku") or item.get("seller_custom_field") or "").strip()
            qty = to_num(it.get("quantity"))
            pu = to_num(it.get("unit_price"))
            venta = pu * qty
            ean, via = "", ""
            if iid in inputs["map_item"]:
                ean, via = inputs["map_item"][iid], "Mapeo item"
            elif sku and sku in inputs["map_sku"]:
                ean, via = inputs["map_sku"][sku], "Mapeo SKU"
            elif sku and norm_ean(sku) in base:
                ean, via = norm_ean(sku), "SKU=EAN"
            else:
                g = gtins.get(iid, {})
                ean = g.get(vid) or g.get("_item") or ""
                via = "GTIN publicación" if ean else ""
            fee = to_num(it.get("sale_fee")) * qty
            ship_line = ship_o * (venta / rev_o) if rev_o else 0.0
            share = (venta / rev_o) if rev_o else 0.0
            imp_line = tx_o * share if has_mp else venta * imp_pct
            costo_ml = fee + ship_line + imp_line
            cu, fuente, cat, desc = cost_for(ean, item.get("title", ""), pu)
            if ean and ean not in base and ean not in inputs["override"]:
                cat = "SIN MATCH"
            lines.append({
                "fecha": f.date(), "hora": f.strftime("%H:%M"), "canal": "ML",
                "orden": str(o.get("pack_id") or o.get("id")), "item_id": iid, "sku": sku,
                "ean": ean or "", "match": via or "Sin match", "desc": desc or item.get("title", ""),
                "titulo_ml": item.get("title", ""), "cat": cat, "qty": qty, "pu": pu,
                "venta": venta, "cargo_venta": fee, "envio": ship_line,
                "imp_est": imp_line, "costo_ml": costo_ml, "cu": cu, "fuente": fuente,
                "imp_fuente": "Mercado Pago" if has_mp else f"Estimado {imp_pct:.1%}",
                "imp_det": "; ".join(f"{k} {v * share:,.0f}".replace(",", ".") for k, v in tx_det.items()),
            })

    for v in inputs["va"]:
        if (v["fecha"].year, v["fecha"].month) != (y, m):
            continue
        cu, fuente, cat, desc = cost_for(v["ean"], v["desc"], v["pu"])
        if v["ean"] not in base and v["ean"] not in inputs["override"]:
            cat = "SIN MATCH"
        lines.append({
            "fecha": v["fecha"], "hora": "", "canal": "VA", "orden": v["cliente"], "item_id": "",
            "sku": "", "ean": v["ean"], "match": "Carga manual", "desc": desc or v["desc"],
            "titulo_ml": "", "cat": cat, "qty": v["qty"], "pu": v["pu"], "venta": v["qty"] * v["pu"],
            "cargo_venta": 0.0, "envio": 0.0, "imp_est": 0.0, "costo_ml": 0.0, "cu": cu, "fuente": fuente,
            "imp_fuente": "", "imp_det": "",
        })
    lines.sort(key=lambda r: (r["fecha"], r["hora"], r["canal"]))
    return lines


# --------------------------------------------------------------------------- Stock crítico
ESTADOS = ["Vendido sin stock", "Agotado", "Crítico", "Bajo", "OK"]


def compute_stock(base, lines, inputs, cfg, y, m, corte, prev_days):
    """Stock restante, ritmo de venta, cobertura y estado por SKU.
    Restante = stock final del cierre + ingresos del mes − vendidas del mes.
    Ritmo = vendidas del mes ÷ días transcurridos; si en el mes no vendió, se usa el ritmo del mes anterior."""
    crit = float(cfg.get("stock_critico_dias", 7))
    bajo = float(cfg.get("stock_bajo_dias", 15))
    repo = float(cfg.get("reposicion_dias", 30))
    hoy = dt.date(y, m, corte)
    vend, ing = defaultdict(float), defaultdict(float)
    for L in lines:
        if L["ean"] and (L["fecha"].year, L["fecha"].month) == (y, m) and L["fecha"].day <= corte:
            vend[L["ean"]] += L["qty"]
    for i in inputs.get("ingresos", []):
        if (i["fecha"].year, i["fecha"].month) == (y, m) and i["fecha"] <= hoy:
            ing[i["ean"]] += i["qty"]
    out = []
    for e, b in base.items():
        v, n = vend.get(e, 0.0), ing.get(e, 0.0)
        ini = b["stock"]
        rest = ini + n - v
        r_cur = v / corte if corte else 0
        r_prev = b.get("uds_prev", 0) / prev_days if prev_days else 0
        rate, fuente = (r_cur, "mes actual") if v else (r_prev, "mes anterior")
        if rate <= 0 and rest <= 0:
            continue  # sin movimiento ni stock: discontinuado
        cov = rest / rate if rate > 0 and rest > 0 else (0 if rest <= 0 else None)
        if rest < 0:
            est = "Vendido sin stock"
        elif rest == 0:
            est = "Agotado"
        elif cov is not None and cov < crit:
            est = "Crítico"
        elif cov is not None and cov < bajo:
            est = "Bajo"
        else:
            est = "OK"
        out.append({
            "ean": e, "desc": b["desc"], "cat": b["cat"], "ini": ini, "ing": n, "vend": v, "rest": rest,
            "rate": round(rate, 2), "fuente_ritmo": fuente, "cov": None if cov is None else round(cov, 1),
            "quiebre": (hoy + dt.timedelta(days=int(cov))).isoformat() if cov else None,
            "reponer": max(0, round(rate * repo - max(rest, 0))), "estado": est, "cu": b["cu"],
        })
    # de más grave a menos grave: estado; dentro de cada estado, el más urgente primero
    out.sort(key=lambda x: (ESTADOS.index(x["estado"]),
                            x["rest"] if x["estado"] == "Vendido sin stock" else 0,
                            -x["rate"] if x["estado"] == "Agotado" else 0,
                            x["cov"] if x["cov"] is not None else 9e9, -x["rate"]))
    return out


# --------------------------------------------------------------------------- Excel
NAVY = "17375E"
F_HDR = PatternFill("solid", fgColor=NAVY)
F_SUB = PatternFill("solid", fgColor="DCE6F1")
F_NET = PatternFill("solid", fgColor="E2EFDA")
F_COST = PatternFill("solid", fgColor="FCE4D6")
F_ORANGE = PatternFill("solid", fgColor="FFC000")
F_INPUT = PatternFill("solid", fgColor="FFFF00")
FONT = "Arial"
NUM = '#,##0;(#,##0);"-"'
PCT = '0.0%;(0.0%);"-"'
THIN = Side(style="thin", color="BFBFBF")


def hdr_row(ws, r, headers, widths=None):
    for j, h in enumerate(headers, 1):
        c = ws.cell(r, j, h)
        c.font = Font(name=FONT, bold=True, color="FFFFFF", size=10)
        c.fill = F_HDR
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = Border(bottom=THIN)
    ws.row_dimensions[r].height = 30
    if widths:
        for j, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(j)].width = w


def style_body(ws, r1, r2, c1, c2, fmts=None):
    for r in range(r1, r2 + 1):
        for c in range(c1, c2 + 1):
            cell = ws.cell(r, c)
            if cell.font is None or cell.font.name != FONT or not cell.font.bold:
                cell.font = Font(name=FONT, size=10, bold=cell.font.bold if cell.font else False,
                                 color=cell.font.color if cell.font and cell.font.color else None)
            if fmts and c in fmts:
                cell.number_format = fmts[c]


def total_style(ws, r, c1, c2):
    for c in range(c1, c2 + 1):
        cell = ws.cell(r, c)
        cell.fill = F_HDR
        cell.font = Font(name=FONT, bold=True, color="FFFFFF", size=10)


def write_excel(path, lines, base, inputs, cfg, y, m, updated, unmatched, comp):
    wb = openpyxl.Workbook()
    mes_txt = f"{MESES[m]} {y}"
    n_days = (dt.date(y + (m == 12), (m % 12) + 1, 1) - dt.timedelta(days=1)).day

    # ---------------- Detalle Ventas
    wd = wb.active
    wd.title = "Detalle Ventas"
    H = ["Fecha", "Hora", "Canal", "Orden / Cliente", "Item ML", "SKU ML", "EAN", "Match",
         "Descripción", "Cat", "Uds", "Precio Unit", "Venta", "Cargo x venta", "Envío vendedor",
         "Impuestos", "Costo ML", "Ingresos Netos", "Costo Unit", "Fuente costo", "COGS",
         "Margen Bruto", "Mg.%", "Fuente impuestos", "Detalle impuestos (MP)"]
    hdr_row(wd, 1, H, [11, 7, 7, 16, 15, 14, 15, 13, 42, 13, 6, 12, 13, 12, 12, 11, 12, 14, 12, 22, 13, 13, 8, 15, 48])
    for i, L in enumerate(lines, 2):
        vals = [L["fecha"], L["hora"], L["canal"], L["orden"], L["item_id"], L["sku"], L["ean"],
                L["match"], L["desc"], L["cat"], L["qty"], L["pu"], f"=K{i}*L{i}",
                L["cargo_venta"], L["envio"], L["imp_est"], f"=N{i}+O{i}+P{i}", f"=M{i}-Q{i}",
                L["cu"], L["fuente"], f"=K{i}*S{i}", f"=R{i}-U{i}", f"=IF(M{i}=0,0,V{i}/M{i})",
                L.get("imp_fuente", ""), L.get("imp_det", "")]
        for j, v in enumerate(vals, 1):
            wd.cell(i, j, v)
        wd.cell(i, 1).number_format = "dd/mm/yyyy"
        for j in (12, 13, 14, 15, 16, 17, 18, 19, 21, 22):
            wd.cell(i, j).number_format = NUM
        wd.cell(i, 23).number_format = PCT
        wd.cell(i, 18).fill = F_NET
        if not L["fuente"].startswith("Real") and L["fuente"] != "Override":
            wd.cell(i, 20).fill = F_ORANGE
        for j in range(1, len(H) + 1):
            c = wd.cell(i, j)
            c.font = Font(name=FONT, size=9)
    last = max(2, len(lines) + 1)
    wd.freeze_panes = "A2"
    wd.auto_filter.ref = f"A1:{get_column_letter(len(H))}{last}"
    D = "'Detalle Ventas'!"
    rng = lambda col: f"{D}${col}$2:${col}${last}"

    # ---------------- PnL Diario
    wp = wb.create_sheet("PnL Diario", 0)
    wp["A1"] = f"PnL Diario de Margen Bruto — {mes_txt}"
    wp["A1"].font = Font(name=FONT, bold=True, size=14, color=NAVY)
    wp["A2"] = f"Actualizado: {updated}  ·  Costo base: P&L cierre {MESES[m - 1 if m > 1 else 12]}"
    wp["A2"].font = Font(name=FONT, italic=True, size=9, color="595959")
    HP = ["Fecha", "Uds", "Venta ML", "Venta Directa", "Venta Total", "Costo ML", "Ingresos Netos",
          "COGS", "Margen Bruto", "Mg.% s/Venta", "Mg.% s/Ing. Netos", "Margen Bruto Acum.", "Venta Total Acum."]
    R0 = 4
    hdr_row(wp, R0, HP, [12, 8, 15, 15, 15, 14, 15, 15, 15, 11, 12, 16, 16])
    for d in range(1, n_days + 1):
        r = R0 + d
        wp.cell(r, 1, dt.date(y, m, d)).number_format = "ddd dd/mm"
        A = f"$A{r}"
        wp.cell(r, 2, f"=SUMIFS({rng('K')},{rng('A')},{A})")
        wp.cell(r, 3, f'=SUMIFS({rng("M")},{rng("A")},{A},{rng("C")},"ML")')
        wp.cell(r, 4, f'=SUMIFS({rng("M")},{rng("A")},{A},{rng("C")},"VA")')
        wp.cell(r, 5, f"=C{r}+D{r}")
        wp.cell(r, 6, f"=SUMIFS({rng('Q')},{rng('A')},{A})")
        wp.cell(r, 7, f"=E{r}-F{r}")
        wp.cell(r, 8, f"=SUMIFS({rng('U')},{rng('A')},{A})")
        wp.cell(r, 9, f"=G{r}-H{r}")
        wp.cell(r, 10, f"=IF(E{r}=0,0,I{r}/E{r})")
        wp.cell(r, 11, f"=IF(G{r}=0,0,I{r}/G{r})")
        wp.cell(r, 12, f"=I{r}" if d == 1 else f"=L{r - 1}+I{r}")
        wp.cell(r, 13, f"=E{r}" if d == 1 else f"=M{r - 1}+E{r}")
        for j in range(1, 14):
            c = wp.cell(r, j)
            c.font = Font(name=FONT, size=10)
            if j > 1:
                c.number_format = PCT if j in (10, 11) else NUM
        wp.cell(r, 7).fill = F_NET
        wp.cell(r, 9).font = Font(name=FONT, size=10, bold=True)
        if dt.date(y, m, d).weekday() >= 5:
            wp.cell(r, 1).font = Font(name=FONT, size=10, color="808080")
    rt = R0 + n_days + 1
    wp.cell(rt, 1, "TOTAL MES")
    for j, col in enumerate("BCDEFGHI", 2):
        wp.cell(rt, j, f"=SUM({col}{R0 + 1}:{col}{rt - 1})")
    wp.cell(rt, 10, f"=IF(E{rt}=0,0,I{rt}/E{rt})")
    wp.cell(rt, 11, f"=IF(G{rt}=0,0,I{rt}/G{rt})")
    total_style(wp, rt, 1, 13)
    for j in range(2, 12):
        wp.cell(rt, j).number_format = PCT if j in (10, 11) else NUM
    wp.cell(rt + 2, 1, "Costo ML = cargo por venta + envío a cargo del vendedor + impuestos/retenciones por operación "
                       "según Mercado Pago (si un pago aún no tiene detalle: "
                       f"{cfg.get('impuestos_ml_pct_estimado', 0):.1%} s/venta calibrado con el cierre anterior). "
                       "El cierre mensual con el export de ML sigue siendo la cifra definitiva.").font = Font(name=FONT, size=8, italic=True, color="595959")
    wp.cell(rt + 3, 1, "COGS = Uds × CU Pond. del cierre anterior; sin costo real → margen asumido por categoría "
                       "(celdas naranjas en Detalle).").font = Font(name=FONT, size=8, italic=True, color="595959")
    wp.freeze_panes = wp.cell(R0 + 1, 2)

    # ---------------- PnL por SKU
    ws = wb.create_sheet("PnL por SKU", 1)
    HS = ["Cat", "EAN", "Descripción", "Stock Ini", "Uds ML", "Uds VA", "Uds Total", "Stock Restante",
          "Venta ML", "Venta VA", "Venta Total", "Costo ML", "Ingresos Netos", "COGS", "Margen Bruto",
          "Mg.%", "Fuente costo"]
    hdr_row(ws, 1, HS, [13, 15, 44, 9, 8, 8, 9, 10, 14, 13, 14, 13, 14, 14, 14, 8, 20])
    sold = defaultdict(lambda: {"fuente": "", "desc": "", "cat": ""})
    for L in lines:
        k = L["ean"] or f"ML:{L['item_id']}"
        sold[k]["fuente"] = L["fuente"]
        sold[k]["desc"] = sold[k]["desc"] or L["desc"]
        sold[k]["cat"] = L["cat"]
    keys = []
    order_cat = {c: i for i, c in enumerate(CATEGORIAS + ["SIN MATCH"])}
    all_keys = set(base.keys()) | set(sold.keys())
    for k in all_keys:
        b = base.get(k)
        cat = (b["cat"] if b else sold[k]["cat"]) or "OTRAS"
        if inputs["override"].get(k, {}).get("cat"):
            cat = inputs["override"][k]["cat"]
        keys.append((order_cat.get(cat, 99), cat, (b or {}).get("desc") or sold[k]["desc"], k))
    keys.sort()
    r = 2
    for _, cat, desc, k in keys:
        b = base.get(k, {})
        is_ml_only = k.startswith("ML:")
        crit_col, crit = ("E", k[3:]) if is_ml_only else ("G", k)
        cr = f'{rng(crit_col)},"{crit}"'
        ws.cell(r, 1, cat)
        ws.cell(r, 2, "" if is_ml_only else k)
        ws.cell(r, 3, desc or k)
        ws.cell(r, 4, b.get("stock", 0))
        ws.cell(r, 5, f'=SUMIFS({rng("K")},{cr},{rng("C")},"ML")')
        ws.cell(r, 6, f'=SUMIFS({rng("K")},{cr},{rng("C")},"VA")')
        ws.cell(r, 7, f"=E{r}+F{r}")
        ws.cell(r, 8, f"=D{r}-G{r}")
        ws.cell(r, 9, f'=SUMIFS({rng("M")},{cr},{rng("C")},"ML")')
        ws.cell(r, 10, f'=SUMIFS({rng("M")},{cr},{rng("C")},"VA")')
        ws.cell(r, 11, f"=I{r}+J{r}")
        ws.cell(r, 12, f"=SUMIFS({rng('Q')},{cr})")
        ws.cell(r, 13, f"=K{r}-L{r}")
        ws.cell(r, 14, f"=SUMIFS({rng('U')},{cr})")
        ws.cell(r, 15, f"=M{r}-N{r}")
        ws.cell(r, 16, f"=IF(K{r}=0,0,O{r}/K{r})")
        if k in inputs["override"]:
            fuente = "Override"
        elif b and b.get("cu", 0) > 0:
            fuente = "Real (CU Pond. cierre)"
        elif b:
            fuente = f"Asumido {b['mg']:.0%}"
        else:
            fuente = sold[k]["fuente"] or "Sin match"
        ws.cell(r, 17, fuente)
        for j in range(1, 18):
            c = ws.cell(r, j)
            c.font = Font(name=FONT, size=9)
            if 4 <= j <= 15:
                c.number_format = NUM
        ws.cell(r, 16).number_format = PCT
        ws.cell(r, 13).fill = F_NET
        if not (fuente.startswith("Real") or fuente == "Override"):
            ws.cell(r, 17).fill = F_ORANGE
        r += 1
    rts = r
    ws.cell(rts, 1, "TOTAL GENERAL")
    for j in range(4, 16):
        col = get_column_letter(j)
        ws.cell(rts, j, f"=SUM({col}2:{col}{rts - 1})")
        ws.cell(rts, j).number_format = NUM
    ws.cell(rts, 16, f"=IF(K{rts}=0,0,O{rts}/K{rts})")
    ws.cell(rts, 16).number_format = PCT
    total_style(ws, rts, 1, 17)
    ws.cell(rts + 1, 1, "Stock Restante = Stock final del cierre anterior − unidades vendidas en el mes "
                        "(sin ingresos del mes; ver hoja 'Stock Crítico', que sí los incluye).").font = Font(name=FONT, size=8, italic=True, color="595959")
    ws.freeze_panes = "D2"
    ws.auto_filter.ref = f"A1:Q{rts - 1}"

    # ---------------- Resumen
    wr = wb.create_sheet("Resumen", 0)
    wr["A1"] = f"PnL Diario MercadoLibre + Venta Directa — {mes_txt}"
    wr["A1"].font = Font(name=FONT, bold=True, size=15, color=NAVY)
    wr["A2"] = f"Actualizado: {updated}"
    wr["A2"].font = Font(name=FONT, italic=True, size=9, color="595959")
    P = "'PnL Diario'!"
    hdr_row(wr, 4, ["Concepto", "Mes acumulado", "% s/Venta", "Último día con venta", "% s/Venta"],
            [30, 18, 11, 20, 11])
    last_day = max([L["fecha"] for L in lines], default=dt.date(y, m, 1))
    ld_row = R0 + last_day.day
    conceptos = [("Venta ML", "C"), ("Venta Directa", "D"), ("Venta Total", "E"), ("Costo ML", "F"),
                 ("Ingresos Netos", "G"), ("COGS (costo mercadería vendida)", "H"), ("Margen Bruto", "I")]
    for i, (nm, col) in enumerate(conceptos, 5):
        wr.cell(i, 1, nm)
        wr.cell(i, 2, f"={P}{col}{rt}")
        wr.cell(i, 3, f"=IF($B$7=0,0,B{i}/$B$7)")
        wr.cell(i, 4, f"={P}{col}{ld_row}")
        wr.cell(i, 5, f"=IF($D$7=0,0,D{i}/$D$7)")
        for j in range(1, 6):
            c = wr.cell(i, j)
            c.font = Font(name=FONT, size=10, bold=nm in ("Venta Total", "Ingresos Netos", "Margen Bruto"))
            c.number_format = PCT if j in (3, 5) else NUM
        if nm == "Ingresos Netos":
            for j in range(1, 6):
                wr.cell(i, j).fill = F_NET
        if nm in ("Costo ML", "COGS (costo mercadería vendida)"):
            for j in range(1, 6):
                wr.cell(i, j).fill = F_COST
    total_style(wr, 11, 1, 5)
    wr.cell(4, 4).value = f"Día {last_day.strftime('%d/%m')}"
    wr.cell(12, 1, "Unidades vendidas")
    wr.cell(12, 2, f"={P}B{rt}")
    wr.cell(12, 4, f"={P}B{ld_row}")
    for j in (1, 2, 4):
        wr.cell(12, j).font = Font(name=FONT, size=10)
        wr.cell(12, j).number_format = NUM

    hdr_row(wr, 14, ["Categoría", "Venta Total", "Costo ML", "Ingresos Netos", "COGS", "Margen Bruto", "Mg.%", "Uds"],
            [30, 18, 14, 20, 14, 16, 9, 9])
    cats = CATEGORIAS + ["SIN MATCH"]
    for i, cat in enumerate(cats, 15):
        cr = f'{rng("J")},"{cat}"'
        wr.cell(i, 1, cat)
        wr.cell(i, 2, f"=SUMIFS({rng('M')},{cr})")
        wr.cell(i, 3, f"=SUMIFS({rng('Q')},{cr})")
        wr.cell(i, 4, f"=B{i}-C{i}")
        wr.cell(i, 5, f"=SUMIFS({rng('U')},{cr})")
        wr.cell(i, 6, f"=D{i}-E{i}")
        wr.cell(i, 7, f"=IF(B{i}=0,0,F{i}/B{i})")
        wr.cell(i, 8, f"=SUMIFS({rng('K')},{cr})")
        for j in range(1, 9):
            c = wr.cell(i, j)
            c.font = Font(name=FONT, size=10)
            c.number_format = PCT if j == 7 else NUM
    tr = 15 + len(cats)
    wr.cell(tr, 1, "TOTAL GENERAL")
    for j in (2, 3, 4, 5, 6, 8):
        col = get_column_letter(j)
        wr.cell(tr, j, f"=SUM({col}15:{col}{tr - 1})")
        wr.cell(tr, j).number_format = NUM
    wr.cell(tr, 7, f"=IF(B{tr}=0,0,F{tr}/B{tr})")
    wr.cell(tr, 7).number_format = PCT
    total_style(wr, tr, 1, 8)
    wr.cell(tr + 1, 1, "Control: Venta Total por categoría − Venta Total PnL Diario")
    wr.cell(tr + 1, 2, f"=B{tr}-B7")
    wr.cell(tr + 1, 2).number_format = NUM
    for j in (1, 2):
        wr.cell(tr + 1, j).font = Font(name=FONT, size=8, italic=True, color="595959")
    n_asum = sum(1 for L in lines if not (L["fuente"].startswith("Real") or L["fuente"] == "Override"))
    wr.cell(tr + 3, 1, f"Líneas con costo asumido: {n_asum}  ·  SKUs ML sin match: {len(unmatched)} "
                       "(ver hoja 'Sin Match' y completar 'Mapeo ML')").font = Font(name=FONT, size=9, bold=True, color="C00000" if (n_asum or unmatched) else "375623")

    # ---------------- Base Costos
    wbse = wb.create_sheet("Base Costos")
    hdr_row(wbse, 1, ["Cat", "EAN", "Descripción", "Modelo", "CU Pond. cierre", "Stock Final cierre",
                      "Mg. asumido", "Costo Override", "Costo usado"], [13, 15, 44, 16, 15, 14, 11, 14, 14])
    for i, b in enumerate(sorted(base.values(), key=lambda b: (order_cat.get(b["cat"], 99), b["desc"])), 2):
        ov = inputs["override"].get(b["ean"], {}).get("cu")
        vals = [b["cat"], b["ean"], b["desc"], b["modelo"], b["cu"] or None, b["stock"], b["mg"], ov,
                f'=IF(H{i}<>"",H{i},IF(E{i}>0,E{i},"Asumido"))']
        for j, v in enumerate(vals, 1):
            c = wbse.cell(i, j, v)
            c.font = Font(name=FONT, size=9, color="0000FF" if j in (5, 6, 7, 8) else None)
            c.number_format = PCT if j == 7 else NUM
        if not b["cu"] and not ov:
            wbse.cell(i, 5).fill = F_ORANGE
    wbse.freeze_panes = "D2"

    # ---------------- Sin Match
    wsm = wb.create_sheet("Sin Match")
    hdr_row(wsm, 1, ["Item ML", "SKU ML", "Título publicación", "Uds", "Venta", "Qué hacer"], [16, 16, 60, 8, 14, 50])
    for i, u in enumerate(unmatched, 2):
        for j, v in enumerate([u["item_id"], u["sku"], u["titulo"], u["qty"], u["venta"],
                               "Agregar en 'Mapeo ML' (Item ML → EAN) del archivo de Ventas Directas"], 1):
            c = wsm.cell(i, j, v)
            c.font = Font(name=FONT, size=9)
            if j in (4, 5):
                c.number_format = NUM
    if not unmatched:
        wsm.cell(2, 1, "Todas las ventas de ML matchearon con un EAN de la base.").font = Font(name=FONT, size=9, italic=True)

    add_comparativo(wb, comp, R0, rt, n_days)
    add_stock_sheet(wb, comp, cfg, updated)
    for sh in wb.worksheets:
        sh.sheet_view.showGridLines = False
    wb.save(path)


def add_stock_sheet(wb, comp, cfg, updated):
    st = comp.get("stock") or []
    ws = wb.create_sheet("Stock Crítico", 3)
    ws["A1"] = "Stock crítico"
    ws["A1"].font = Font(name=FONT, bold=True, size=14, color=NAVY)
    ws["A2"] = (f"Foto al {updated}. Restante = stock final del cierre + ingresos del mes (hoja 'Ingresos Stock') − vendidas. "
                f"Ritmo = uds/día del mes (o del mes anterior si aún no vendió). Crítico < {cfg.get('stock_critico_dias', 7)} días · "
                f"Bajo < {cfg.get('stock_bajo_dias', 15)} días · Reponer = cubrir {cfg.get('reposicion_dias', 30)} días.")
    ws["A2"].font = Font(name=FONT, italic=True, size=8, color="595959")
    H = ["Estado", "Cat", "EAN", "Descripción", "Stock Ini", "Ingresos", "Vendidas", "Restante", "Uds/día",
         "Ritmo según", "Cobertura (días)", "Quiebre est.", "Reponer (uds)", "Valor reposición (CU)"]
    hdr_row(ws, 4, H, [17, 13, 15, 46, 9, 9, 9, 9, 8, 13, 11, 12, 11, 15])
    fills = {"Vendido sin stock": PatternFill("solid", fgColor="F4B6B0"), "Agotado": PatternFill("solid", fgColor="FADBD8"),
             "Crítico": PatternFill("solid", fgColor="FCE4D6"), "Bajo": PatternFill("solid", fgColor="FFF2CC")}
    for i, x in enumerate(st, 5):
        q = dt.date.fromisoformat(x["quiebre"]) if x["quiebre"] else None
        vals = [x["estado"], x["cat"], x["ean"], x["desc"], x["ini"], x["ing"], x["vend"], f"=E{i}+F{i}-G{i}",
                x["rate"], x["fuente_ritmo"], x["cov"], q, x["reponer"], f"=M{i}*{x['cu'] or 0}"]
        for j, v in enumerate(vals, 1):
            c = ws.cell(i, j, v)
            c.font = Font(name=FONT, size=9, bold=(j == 1 and x["estado"] != "OK"))
            c.number_format = {9: "0.0", 11: "0.0", 12: "dd/mm/yyyy", 14: NUM}.get(j, NUM if j >= 5 else "General")
        if x["estado"] in fills:
            ws.cell(i, 1).fill = fills[x["estado"]]
        if not x["cu"]:
            ws.cell(i, 14).value = None
    ws.freeze_panes = "E5"
    ws.auto_filter.ref = f"A4:N{max(5, 4 + len(st))}"


def add_comparativo(wb, comp, R0, rt, n_days):
    """Hoja 'Comparativo': acumulado del mes vs mes anterior (a igual día y cierre P&L)."""
    wc = wb.create_sheet("Comparativo", 2)
    P = "'PnL Diario'!"
    N = comp["dia_corte"]
    pl, prev_c = comp["prev_label"], comp["prev_cierre"]
    wc["A1"] = f"Acumulado {comp['cur_label']} vs {pl}"
    wc["A1"].font = Font(name=FONT, bold=True, size=14, color=NAVY)
    wc["A2"] = (f"Corte: día {N}. '{pl} 1–{N}' = órdenes ML del mes anterior (API) + "
                f"venta directa cargada con esas fechas" + (f" (día {N} hasta las {comp['hora_corte']})" if comp.get("hora_corte") else "")
                + f"; '{pl} cierre' = totales del P&L mensual definitivo.")
    wc["A2"].font = Font(name=FONT, italic=True, size=8, color="595959")
    hdr_row(wc, 4, ["Concepto", f"Actual 1–{N}", f"{pl} 1–{N}", "Var. %", f"{pl} cierre",
                    "Proyección mes (run-rate)", "Proy. vs cierre ant."], [30, 17, 17, 9, 17, 18, 12])
    pa = comp["prev_acum_corte"]
    items = [("Venta Total", "E", "venta"), ("Costo ML", "F", "costo_ml"), ("Ingresos Netos", "G", "ing_netos"),
             ("COGS", "H", "cogs"), ("Margen Bruto", "I", "margen")]
    nd_row = R0 + N
    for i, (nm, col, key) in enumerate(items, 5):
        wc.cell(i, 1, nm)
        wc.cell(i, 2, f"=SUM({P}{col}{R0 + 1}:{col}{nd_row})")
        wc.cell(i, 3, round(pa[key], 2))
        wc.cell(i, 4, f"=IF(C{i}=0,0,B{i}/C{i}-1)")
        wc.cell(i, 5, round(prev_c[key], 2))
        wc.cell(i, 6, f"=B{i}/{N}*{n_days}")
        wc.cell(i, 7, f"=IF(E{i}=0,0,F{i}/E{i}-1)")
        for j in range(1, 8):
            c = wc.cell(i, j)
            c.font = Font(name=FONT, size=10, bold=nm in ("Venta Total", "Margen Bruto"),
                          color="0000FF" if j in (3, 5) else None)
            c.number_format = PCT if j in (4, 7) else NUM
    wc.cell(10, 1, "Mg. Bruto %")
    wc.cell(10, 2, "=IF(B5=0,0,B9/B5)")
    wc.cell(10, 3, "=IF(C5=0,0,C9/C5)")
    wc.cell(10, 4, "=B10-C10")
    wc.cell(10, 5, "=IF(E5=0,0,E9/E5)")
    wc.cell(10, 6, "=IF(F5=0,0,F9/F5)")
    wc.cell(10, 7, "=F10-E10")
    for j in range(1, 8):
        wc.cell(10, j).font = Font(name=FONT, size=10, bold=True)
        wc.cell(10, j).number_format = PCT
    total_style(wc, 10, 1, 7)
    wc.cell(11, 1, "Var. del Mg.% en puntos porcentuales; valores azules = mes anterior (dato fijo).").font = Font(
        name=FONT, size=8, italic=True, color="595959")

    hdr_row(wc, 13, ["Día", "Venta Total actual", f"Venta Total {pl}", "Venta Acum. actual",
                     f"Venta Acum. {pl}", "Var. % acum.", "Mg. Bruto Acum. actual",
                     f"Mg. Bruto Acum. {pl}", "Var. % acum.", "Mg.% acum. actual", f"Mg.% acum. {pl}"])
    for w, cl in zip([30, 17, 17, 17, 17, 11, 18, 18, 11, 12, 12], "ABCDEFGHIJK"):
        wc.column_dimensions[cl].width = w
    pdly = comp["prev_daily"]
    for d in range(1, max(n_days, len(pdly)) + 1):
        r = 13 + d
        wc.cell(r, 1, d)
        if d <= n_days:
            wc.cell(r, 2, f"={P}E{R0 + d}")
            wc.cell(r, 4, f"={P}M{R0 + d}")
            wc.cell(r, 7, f"={P}L{R0 + d}")
        if d <= len(pdly):
            wc.cell(r, 3, round(pdly[d - 1]["venta"], 2))
        wc.cell(r, 5, f"=C{r}" if d == 1 else f"=E{r - 1}+C{r}")
        mg_prev_acum = sum(x["margen"] for x in pdly[:d])
        wc.cell(r, 8, round(mg_prev_acum, 2))
        wc.cell(r, 6, f'=IF(OR(E{r}=0,{d}>{N}),"",D{r}/E{r}-1)')
        wc.cell(r, 9, f'=IF(OR(H{r}=0,{d}>{N}),"",G{r}/H{r}-1)')
        wc.cell(r, 10, f'=IF(OR(D{r}=0,{d}>{N}),"",G{r}/D{r})')
        wc.cell(r, 11, f'=IF(E{r}=0,"",H{r}/E{r})')
        for j in range(1, 12):
            c = wc.cell(r, j)
            c.font = Font(name=FONT, size=9, color="0000FF" if j in (3, 8) else None,
                          bold=(d == N))
            c.number_format = PCT if j in (6, 9, 10, 11) else NUM
            if d == N:
                c.fill = F_SUB
    wc.freeze_panes = "B14"


# --------------------------------------------------------------------------- Dashboard
def write_dashboard(path, lines, base, inputs, cfg, y, m, updated, unmatched, comp):
    rows = [{
        "f": L["fecha"].isoformat(), "h": L["hora"], "c": L["canal"], "o": L["orden"], "e": L["ean"],
        "d": L["desc"][:70], "k": L["cat"], "q": L["qty"], "v": round(L["venta"], 2),
        "ml": round(L["costo_ml"], 2), "g": round(L["qty"] * L["cu"], 2),
        "a": 0 if (L["fuente"].startswith("Real") or L["fuente"] == "Override") else 1,
    } for L in lines]
    stock = [{"d": x["desc"][:60], "k": x["cat"], "e": x["ean"], "i": x["ini"], "n": x["ing"], "v": x["vend"],
              "r": x["rest"], "rt": x["rate"], "f": x["fuente_ritmo"], "c": x["cov"], "q": x["quiebre"],
              "p": x["reponer"], "s": x["estado"]} for x in comp.get("stock") or []]
    data = {"rows": rows, "stock": stock, "updated": updated, "mes": f"{MESES[m]} {y}",
            "y": y, "m": m, "unmatched": unmatched[:30], "refresh": int(cfg.get("refresh_minutes", 15)),
            "imp": cfg.get("impuestos_ml_pct_estimado", 0),
            "umbral": {"crit": cfg.get("stock_critico_dias", 7), "bajo": cfg.get("stock_bajo_dias", 15),
                       "repo": cfg.get("reposicion_dias", 30)},
            "comp": {"prev_label": comp["prev_label"], "prev_cierre": comp["prev_cierre"],
                     "prev_daily": comp["prev_daily"], "n_days": comp["n_days"],
                     "prev_hoy": comp["prev_hoy"], "hora_corte": comp["hora_corte"],
                     "prev_acum_corte": comp["prev_acum_corte"], "dia_corte": comp["dia_corte"]}}
    tpl_path = os.path.join(HERE, "dashboard_template.html")
    with open(tpl_path, "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False, default=str))
    html = html.replace("__REFRESH_SECONDS__", str(int(cfg.get("refresh_minutes", 15)) * 60))
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)


# --------------------------------------------------------------------------- Orquestación
def days_in(y, m):
    return (dt.date(y + (m == 12), (m % 12) + 1, 1) - dt.timedelta(days=1)).day


def prev_ym(y, m):
    return (y - 1, 12) if m == 1 else (y, m - 1)


def daily_series(lines, y, m):
    n = days_in(y, m)
    out = [{"venta_ml": 0.0, "venta_va": 0.0, "venta": 0.0, "costo_ml": 0.0, "cogs": 0.0, "uds": 0.0}
           for _ in range(n)]
    for L in lines:
        if (L["fecha"].year, L["fecha"].month) != (y, m):
            continue
        d = out[L["fecha"].day - 1]
        d["venta_ml" if L["canal"] == "ML" else "venta_va"] += L["venta"]
        d["venta"] += L["venta"]
        d["costo_ml"] += L["costo_ml"]
        d["cogs"] += L["qty"] * L["cu"]
        d["uds"] += L["qty"]
    for d in out:
        d["ing_netos"] = d["venta"] - d["costo_ml"]
        d["margen"] = d["ing_netos"] - d["cogs"]
        for k in d:
            d[k] = round(d[k], 2)
    return out


def acum(series, n):
    keys = series[0].keys() if series else []
    return {k: sum(s[k] for s in series[:n]) for k in keys}


def compact_order(o):
    return {"id": o.get("id"), "pack_id": o.get("pack_id"), "status": o.get("status"),
            "date_created": o.get("date_created"), "shipping": {"id": (o.get("shipping") or {}).get("id")},
            "order_items": [{"item": {k: (it.get("item") or {}).get(k) for k in
                                      ("id", "title", "seller_sku", "seller_custom_field", "variation_id")},
                             "quantity": it.get("quantity"), "unit_price": it.get("unit_price"),
                             "sale_fee": it.get("sale_fee")} for it in o.get("order_items", [])],
            "payments": [{"id": pay.get("id"), "status": pay.get("status")} for pay in o.get("payments") or []]}


def fetch_month(ml, cache, seller, y, m, closed):
    """Órdenes de un mes. Un mes cerrado se guarda en cache y se re-descarga sólo los primeros días
    del mes siguiente (por cancelaciones tardías)."""
    key = f"{y}-{m:02d}"
    hit = cache.setdefault("orders", {}).get(key)
    today = dt.datetime.now(TZ).date()
    if closed and hit and hit.get("final"):
        return hit["orders"]
    orders = ml.orders_month(seller, y, m)
    if closed:
        final = today.day > 5
        cache["orders"][key] = {"orders": [compact_order(o) for o in orders], "final": final}
    return orders


def enrich(ml, cache, orders):
    now = dt.datetime.now(TZ)
    need = []
    for o in orders:
        sid = (o.get("shipping") or {}).get("id")
        if not sid or o.get("status") != "paid":
            continue
        created = dt.datetime.fromisoformat(o["date_created"].replace("Z", "+00:00"))
        fresh = (now - created).days < 3  # el costo de envío puede ajustarse los primeros días
        if str(sid) not in cache["ship"] or fresh:
            need.append(str(sid))
    need = list(dict.fromkeys(need))
    if need:
        log(f"Consultando costo de envío de {len(need)} envíos…")
    for sid in need:
        cache["ship"][sid] = ml.shipment_seller_cost(sid)
    item_ids = {str((it.get("item") or {}).get("id")).upper() for o in orders for it in o.get("order_items", [])}
    missing = [i for i in item_ids if i and i not in cache["gtin"]]
    if missing:
        cache["gtin"].update(ml.items_gtin(missing))
    # impuestos por operación desde Mercado Pago
    tx = cache.setdefault("tax", {})
    pend = []
    for o in orders:
        if o.get("status") != "paid":
            continue
        created = dt.datetime.fromisoformat(o["date_created"].replace("Z", "+00:00"))
        fresh = (now - created).days < 2
        for pay in o.get("payments") or []:
            pid = str(pay.get("id") or "")
            if pid and str(pay.get("status", "approved")) == "approved" and (pid not in tx or tx[pid] is None or fresh):
                pend.append(pid)
    pend = list(dict.fromkeys(pend))
    if pend:
        log(f"Consultando impuestos de {len(pend)} pagos en Mercado Pago…")
    fallos = 0
    for pid in pend:
        try:
            tx[pid] = ml.payment_taxes(pid)
        except RuntimeError as e:
            fallos += 1
            tx.setdefault(pid, None)
            if fallos == 1:
                log(f"Aviso: no pude leer pagos de Mercado Pago ({str(e)[:120]}); uso el % estimado")
            if fallos >= 5:
                break


def run_sync(cfg, demo=False):
    y, m = map(int, cfg["mes"].split("-"))
    py, pm = prev_ym(y, m)
    base, prev_cierre = read_base(resolve(cfg["base_pnl_path"]), cfg)
    inputs = read_inputs(resolve(cfg.get("ventas_directas_path")))
    cache = load_json(CACHE_PATH, {"ship": {}, "gtin": {}, "orders": {}})
    cache.setdefault("orders", {})

    if demo:
        orders, ship_costs, gtins = demo_orders(base, y, m, seed=42)
        porders, pships, pgtins = demo_orders(base, py, pm, seed=7, full=True, vol=0.85)
        ship_costs.update(pships)
        gtins.update(pgtins)
        taxes = demo_taxes(orders + porders)
    else:
        ml = ML(cfg)
        ml.ensure_token()
        seller = ml.tokens.get("user_id") or ml.get("/users/me")["id"]
        log(f"Descargando órdenes de {MESES[m]} {y}…")
        orders = fetch_month(ml, cache, seller, y, m, closed=False)
        log(f"{len(orders)} órdenes ({sum(o.get('status') == 'paid' for o in orders)} pagas)")
        porders = fetch_month(ml, cache, seller, py, pm, closed=True)
        log(f"{MESES[pm]}: {len(porders)} órdenes (para comparar a igual día)")
        enrich(ml, cache, orders + porders)
        save_json(CACHE_PATH, cache)
        ship_costs, gtins = cache["ship"], cache["gtin"]
        taxes = {k: v for k, v in cache.get("tax", {}).items() if v is not None}

    # Calibración de impuestos/retenciones de ML: la API no los trae por orden.
    # "auto" = (Costo ML del cierre − cargo+envío según API del mismo mes) / Venta ML del mes.
    imp_cfg = cfg.get("impuestos_ml_pct_estimado", "auto")
    if isinstance(imp_cfg, str):
        cfg["impuestos_ml_pct_estimado"] = 0.0
        p0 = [L for L in build_lines(porders, ship_costs, gtins, base, inputs, cfg, py, pm) if L["canal"] == "ML"]
        v0 = sum(L["venta"] for L in p0)
        c0 = sum(L["cargo_venta"] + L["envio"] for L in p0)  # base sin impuestos para el respaldo
        pct = 0.0
        if v0 and prev_cierre.get("costo_ml"):
            pct = max(0.0, min(0.15, (prev_cierre["costo_ml"] - c0) / v0))
        cfg["impuestos_ml_pct_estimado"] = round(pct, 4)
        log(f"Impuestos/retenciones ML calibrados con {MESES[pm]}: {pct:.1%} s/venta "
            f"(API cargo+envío {c0 / v0:.1%} vs cierre {prev_cierre['costo_ml'] / max(prev_cierre['venta_ml'], 1):.1%})"
            if v0 else "Sin órdenes del mes anterior para calibrar impuestos; uso 0%")
    lines = build_lines(orders, ship_costs, gtins, base, inputs, cfg, y, m, taxes)
    plines = build_lines(porders, ship_costs, gtins, base, inputs, cfg, py, pm, taxes)
    mp_l = [L for L in lines if L["canal"] == "ML"]
    if mp_l:
        con = sum(1 for L in mp_l if L["imp_fuente"] == "Mercado Pago")
        log(f"Impuestos: {con}/{len(mp_l)} líneas ML con detalle real de Mercado Pago; el resto, estimado")
    pml = [L for L in plines if L["canal"] == "ML"]
    if pml and prev_cierre.get("costo_ml"):
        c_api = sum(L["costo_ml"] for L in pml)
        log(f"Control {MESES[pm]}: Costo ML según API+MP {c_api:,.0f} vs P&L cierre {prev_cierre['costo_ml']:,.0f} "
            f"({c_api / prev_cierre['costo_ml'] - 1:+.1%})")

    um = {}
    for L in lines:
        if L["canal"] == "ML" and L["cat"] == "SIN MATCH":
            k = L["item_id"]
            u = um.setdefault(k, {"item_id": k, "sku": L["sku"], "titulo": L["titulo_ml"], "qty": 0, "venta": 0})
            u["qty"] += L["qty"]
            u["venta"] += L["venta"]
    unmatched = sorted(um.values(), key=lambda u: -u["venta"])

    n_days = days_in(y, m)
    today = dt.datetime.now(TZ).date()
    if (today.year, today.month) == (y, m):
        corte = today.day
    else:
        corte = max([L["fecha"].day for L in lines], default=n_days) if not demo else n_days
        if (today.year, today.month) > (y, m):
            corte = n_days
    if demo:
        corte = max([L["fecha"].day for L in lines], default=1)
    prev_daily = daily_series(plines, py, pm)
    if not any(prev_cierre[k] for k in ("venta", "cogs")):  # base sin totales: uso la API
        prev_cierre = acum(prev_daily, len(prev_daily))
    # Día en curso: el mes anterior se compara hasta la misma hora, no el día completo
    now = dt.datetime.now(TZ)
    en_curso = (now.year, now.month) == (y, m) and not demo or (demo and corte == now.day)
    prev_hoy = None
    if en_curso and corte <= len(prev_daily):
        hh = now.strftime("%H:%M")
        part = [L for L in plines if L["fecha"].day == corte and (L["hora"] or "00:00") <= hh]
        s = daily_series(part, py, pm)[corte - 1]
        prev_hoy = s
    pac = acum(prev_daily, min(corte, len(prev_daily)))
    if prev_hoy:
        pac = acum(prev_daily, corte - 1)
        for k in pac:
            pac[k] += prev_hoy[k]
    comp = {
        "cur_label": f"{MESES[m]} {y}", "prev_label": f"{MESES[pm]} {py}",
        "prev_cierre": {k: round(v, 2) for k, v in prev_cierre.items()},
        "prev_daily": prev_daily, "n_days": n_days, "dia_corte": corte,
        "prev_acum_corte": pac, "prev_hoy": prev_hoy,
        "hora_corte": now.strftime("%H:%M") if prev_hoy else None,
        "cur_daily": daily_series(lines, y, m),
    }
    comp["stock"] = compute_stock(base, lines, inputs, cfg, y, m, corte, days_in(py, pm))
    n_alert = sum(1 for x in comp["stock"] if x["estado"] in ("Vendido sin stock", "Agotado", "Crítico"))
    log(f"Stock: {n_alert} productos agotados o críticos")

    out_dir = resolve(cfg["output_dir"])
    os.makedirs(out_dir, exist_ok=True)
    updated = dt.datetime.now(TZ).strftime("%d/%m/%Y %H:%M")
    suffix = "_DEMO" if demo else ""
    xlsx = os.path.join(out_dir, f"PnL_Diario_{MESES[m]}{y}{suffix}.xlsx")
    html = os.path.join(out_dir, f"Dashboard_PnL_Diario{suffix}.html")
    try:
        write_excel(xlsx, lines, base, inputs, cfg, y, m, updated, unmatched, comp)
        log(f"Excel actualizado: {xlsx}")
    except PermissionError:
        log("El Excel está abierto, no lo pude sobrescribir. Cerralo y se actualiza en el próximo ciclo.")
    write_dashboard(html, lines, base, inputs, cfg, y, m, updated, unmatched, comp)
    log(f"Dashboard actualizado: {html}")
    return {"xlsx": xlsx, "html": html, "lines": lines, "plines": plines, "inputs": inputs, "base": base, "comp": comp, "cfg": cfg,
            "unmatched": unmatched, "y": y, "m": m, "updated": updated, "out_dir": out_dir, "suffix": suffix}


# --------------------------------------------------------------------------- Reporte de cierre diario
def fmt_ars(v):
    s = f"{abs(v):,.0f}".replace(",", ".")
    return f"({s})" if v < 0 else s


def fmt_pct(v, signed=False):
    if v is None:
        return "–"
    s = f"{v * 100:+.1f}%" if signed else f"{v * 100:.1f}%"
    return s.replace(".", ",")


def var(a, b):
    return None if not b else a / b - 1


def svg_acum(cur, prev, corte, cur_lbl, prev_lbl):
    """Gráfico de líneas de venta acumulada (SVG puro, se ve offline y al imprimir)."""
    W, H, L, R, T, B = 720, 260, 64, 16, 16, 34
    ca, s = [], 0
    for d in cur[:corte]:
        s += d["venta"]
        ca.append(s)
    pa, s = [], 0
    for d in prev:
        s += d["venta"]
        pa.append(s)
    n = max(len(cur), len(prev))
    top = max(ca + pa + [1]) * 1.08
    x = lambda i: L + (W - L - R) * i / max(n - 1, 1)
    yv = lambda v: T + (H - T - B) * (1 - v / top)
    grid = ""
    for k in range(5):
        v = top * k / 4
        grid += (f'<line x1="{L}" x2="{W - R}" y1="{yv(v):.1f}" y2="{yv(v):.1f}" stroke="#e3e6ea"/>'
                 f'<text x="{L - 8}" y="{yv(v) + 4:.1f}" text-anchor="end" font-size="10" fill="#6b7280">'
                 f'{v / 1e6:,.0f}M</text>')
    for dd in (1, 5, 10, 15, 20, 25, n):
        grid += (f'<text x="{x(dd - 1):.1f}" y="{H - 12}" text-anchor="middle" font-size="10" '
                 f'fill="#6b7280">{dd}</text>')
    pts = lambda arr: " ".join(f"{x(i):.1f},{yv(v):.1f}" for i, v in enumerate(arr))
    last = (f'<circle cx="{x(len(ca) - 1):.1f}" cy="{yv(ca[-1]):.1f}" r="4" fill="#1f5fa8"/>' if ca else "")
    return (f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="Venta acumulada">{grid}'
            f'<polyline fill="none" stroke="#9aa3ad" stroke-width="2" stroke-dasharray="5 4" points="{pts(pa)}"/>'
            f'<polyline fill="none" stroke="#1f5fa8" stroke-width="2.5" points="{pts(ca)}"/>{last}'
            f'<g font-size="11"><rect x="{L + 8}" y="{T + 4}" width="12" height="3" fill="#1f5fa8"/>'
            f'<text x="{L + 26}" y="{T + 9}" fill="#1f2937">{cur_lbl}</text>'
            f'<rect x="{L + 150}" y="{T + 4}" width="12" height="3" fill="#9aa3ad"/>'
            f'<text x="{L + 168}" y="{T + 9}" fill="#1f2937">{prev_lbl}</text></g></svg>')


def write_report(ctx, fecha=None):
    comp, lines, base = ctx["comp"], ctx["lines"], ctx["base"]
    y, m = ctx["y"], ctx["m"]
    corte = fecha.day if fecha else comp["dia_corte"]
    fecha = fecha or dt.date(y, m, corte)
    cur = comp["cur_daily"]
    hoy = cur[corte - 1]
    act = acum(cur, corte)
    pac = acum(comp["prev_daily"], min(corte, len(comp["prev_daily"])))
    if comp.get("prev_hoy") and corte == comp["dia_corte"]:
        pac = comp["prev_acum_corte"]  # reporte a mitad del día: mes anterior hasta la misma hora
    pci = comp["prev_cierre"]
    n = comp["n_days"]
    proy = {k: v / corte * n for k, v in act.items()}
    dias_venta = sum(1 for d in cur[:corte] if d["venta"])
    prom = {k: (act[k] / dias_venta if dias_venta else 0) for k in act}
    mg = lambda d: (d["margen"] / d["venta"]) if d.get("venta") else 0
    dia_lines = [L for L in lines if L["fecha"] == fecha]
    ordenes = len({L["orden"] for L in dia_lines if L["canal"] == "ML"})

    # categorías: acumulado actual vs mes anterior a igual día
    def cat_tot(ls, ymm, upto):
        out = defaultdict(lambda: {"venta": 0.0, "margen": 0.0})
        for L in ls:
            if (L["fecha"].year, L["fecha"].month) == ymm and L["fecha"].day <= upto:
                c = out[L["cat"]]
                c["venta"] += L["venta"]
                c["margen"] += L["venta"] - L["costo_ml"] - L["qty"] * L["cu"]
        return out
    ca = cat_tot(lines, (y, m), corte)
    # top SKUs del día
    sk = defaultdict(lambda: {"d": "", "q": 0, "v": 0.0, "mg": 0.0})
    for L in dia_lines:
        s = sk[L["ean"] or L["item_id"]]
        s["d"] = L["desc"]
        s["q"] += L["qty"]
        s["v"] += L["venta"]
        s["mg"] += L["venta"] - L["costo_ml"] - L["qty"] * L["cu"]
    top = sorted(sk.values(), key=lambda s: -s["v"])[:10]
    # stock
    stk = compute_stock(base, lines, ctx["inputs"], ctx["cfg"], y, m, corte, len(comp["prev_daily"]))
    bajo = [x for x in stk if x["estado"] in ("Vendido sin stock", "Agotado", "Crítico")]
    n_asum = sum(1 for L in lines if L["fecha"].day <= corte and
                 not (L["fuente"].startswith("Real") or L["fuente"] == "Override"))

    def badge(v, inverse=False):
        if v is None:
            return '<span class="b n">–</span>'
        good = v >= 0 if not inverse else v <= 0
        return f'<span class="b {"g" if good else "r"}">{fmt_pct(v, True)}</span>'

    rows_pl = ""
    for nm, k, inv in (("Venta ML", "venta_ml", False), ("Venta Directa", "venta_va", False),
                       ("Venta Total", "venta", False), ("Costo ML", "costo_ml", True),
                       ("Ingresos Netos", "ing_netos", False), ("COGS", "cogs", True),
                       ("Margen Bruto", "margen", False)):
        strong = k in ("venta", "ing_netos", "margen")
        pc = pci.get(k, 0)
        rows_pl += (f'<tr class="{"s" if strong else ""}"><td>{nm}</td><td>{fmt_ars(hoy[k])}</td>'
                    f'<td>{fmt_ars(act[k])}</td><td>{fmt_ars(pac.get(k, 0))}</td><td>{badge(var(act[k], pac.get(k, 0)), inv)}</td>'
                    f'<td>{fmt_ars(pc)}</td><td>{fmt_ars(proy[k])}</td><td>{badge(var(proy[k], pc), inv)}</td></tr>')
    mg_row = (f'<tr class="s"><td>Mg. Bruto %</td><td>{fmt_pct(mg(hoy))}</td><td>{fmt_pct(mg(act))}</td>'
              f'<td>{fmt_pct(mg(pac))}</td><td><span class="b {"g" if mg(act) >= mg(pac) else "r"}">'
              f'{(mg(act) - mg(pac)) * 100:+.1f} pp</span></td><td>{fmt_pct(mg(pci))}</td>'
              f'<td>{fmt_pct(mg(proy))}</td><td></td></tr>')
    cat_rows = ""
    pcat = cat_tot(ctx["plines"], prev_ym(y, m), corte)
    for c in CATEGORIAS + ["SIN MATCH"]:
        if c not in ca and c not in pcat:
            continue
        a = ca.get(c, {"venta": 0, "margen": 0})
        p = pcat.get(c, {"venta": 0, "margen": 0})
        cat_rows += (f'<tr><td>{c}</td><td>{fmt_ars(a["venta"])}</td><td>{fmt_ars(p["venta"])}</td>'
                     f'<td>{badge(var(a["venta"], p["venta"]))}</td><td>{fmt_ars(a["margen"])}</td>'
                     f'<td>{fmt_pct(a["margen"] / a["venta"]) if a["venta"] else "–"}</td>'
                     f'<td>{fmt_pct(p["margen"] / p["venta"]) if p["venta"] else "–"}</td></tr>')
    top_rows = "".join(f'<tr><td>{s["d"][:58]}</td><td>{s["q"]:.0f}</td><td>{fmt_ars(s["v"])}</td>'
                       f'<td>{fmt_ars(s["mg"])}</td><td>{fmt_pct(s["mg"] / s["v"]) if s["v"] else "–"}</td></tr>'
                       for s in top) or '<tr><td colspan="5">Sin ventas registradas en el día.</td></tr>'
    est_cls = {"Vendido sin stock": "r", "Agotado": "r", "Crítico": "r"}
    stock_rows = "".join(
        f'<tr><td>{x["desc"][:70]} <span style="color:var(--mut);font-size:11px">{x["cat"]}</span></td><td>{x["rest"]:.0f}</td><td>{x["rate"]:.1f}</td>'
        f'<td>{"–" if x["cov"] in (None, 0) else f"{x["cov"]:.0f} d"}</td>'
        f'<td>{x["reponer"]:.0f}</td><td><span class="b {est_cls.get(x["estado"], "n")}">{x["estado"]}</span></td></tr>'
        for x in bajo[:25]) or '<tr><td colspan="6">Sin productos críticos.</td></tr>'
    alerts = []
    if n_asum:
        alerts.append(f"{n_asum} líneas del mes con costo asumido (sin CU real en el cierre).")
    if ctx["unmatched"]:
        alerts.append(f"{len(ctx['unmatched'])} publicaciones de ML sin EAN: completar 'Mapeo ML'.")
    alerts_html = "".join(f"<li>{a}</li>" for a in alerts) or "<li>Sin alertas de datos.</li>"
    dias_es = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]

    html = f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cierre {fecha.strftime('%d/%m/%Y')} · PnL MCG</title>
<style>
:root{{--ink:#1f2937;--mut:#6b7280;--line:#e3e6ea;--bg:#f6f7f9;--card:#fff;--navy:#17375e;--g:#1b7a43;--r:#b42318}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif}}
.wrap{{max-width:980px;margin:0 auto;padding:28px 16px 48px}}
h1{{font-size:22px;margin:0;color:var(--navy)}}.sub{{color:var(--mut);margin:4px 0 22px}}
h2{{font-size:15px;margin:28px 0 10px;color:var(--navy)}}
.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}}
.k{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}}
.k .l{{font-size:12px;color:var(--mut)}}.k .v{{font-size:20px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums}}
.k .x{{font-size:12px;color:var(--mut);margin-top:2px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px 14px 10px;overflow-x:auto}}
table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}}
th{{font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--mut);font-weight:600;text-align:right;padding:9px 8px;border-bottom:1px solid var(--line);white-space:nowrap}}
td{{padding:7px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}}
th:first-child,td:first-child{{text-align:left;white-space:normal}}
tr.s td{{font-weight:650}}tr:last-child td{{border-bottom:0}}
.b{{display:inline-block;padding:1px 7px;border-radius:99px;font-size:12px;font-weight:600}}
.b.g{{background:#e6f4ea;color:var(--g)}}.b.r{{background:#fdecea;color:var(--r)}}.b.n{{color:var(--mut)}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}@media(max-width:760px){{.two{{grid-template-columns:1fr}}}}
ul{{margin:6px 0;padding-left:18px}}.note{{color:var(--mut);font-size:12px;margin-top:22px}}
@media print{{body{{background:#fff}}.wrap{{padding:0}}.card,.k{{break-inside:avoid}}}}
</style></head><body><div class="wrap">
<h1>Reporte de cierre diario · {dias_es[fecha.weekday()]} {fecha.strftime('%d/%m/%Y')}</h1>
<div class="sub">MercadoLibre + Venta Directa · Acumulado {comp['cur_label']} (días 1–{corte}) vs {comp['prev_label']} · generado {ctx['updated']}</div>
<div class="kpis">
<div class="k"><div class="l">Venta Total del día</div><div class="v">$ {fmt_ars(hoy['venta'])}</div><div class="x">{ordenes} órdenes ML · {hoy['uds']:.0f} uds</div></div>
<div class="k"><div class="l">Margen Bruto del día</div><div class="v">$ {fmt_ars(hoy['margen'])}</div><div class="x">Mg. {fmt_pct(mg(hoy))} · prom. diario {fmt_pct(mg(prom))}</div></div>
<div class="k"><div class="l">Venta acumulada</div><div class="v">$ {fmt_ars(act['venta'])}</div><div class="x">{badge(var(act['venta'], pac.get('venta', 0)))} vs {comp['prev_label'].split()[0]} a igual día</div></div>
<div class="k"><div class="l">Margen Bruto acumulado</div><div class="v">$ {fmt_ars(act['margen'])}</div><div class="x">{badge(var(act['margen'], pac.get('margen', 0)))} · Mg. {fmt_pct(mg(act))}</div></div>
<div class="k"><div class="l">Proyección mes</div><div class="v">$ {fmt_ars(proy['venta'])}</div><div class="x">{badge(var(proy['venta'], pci.get('venta', 0)))} vs cierre {comp['prev_label'].split()[0]}</div></div>
</div>
<h2>PnL de margen bruto</h2>
<div class="card"><table><thead><tr><th>Concepto</th><th>Día {corte}</th><th>Acum. 1–{corte}</th><th>{comp['prev_label'].split()[0]} 1–{corte}</th><th>Var.</th><th>{comp['prev_label'].split()[0]} cierre</th><th>Proyección</th><th>Proy. vs cierre</th></tr></thead>
<tbody>{rows_pl}{mg_row}</tbody></table></div>
<h2>Venta acumulada vs mes anterior</h2>
<div class="card" style="padding:12px">{svg_acum(cur, comp['prev_daily'], corte, comp['cur_label'], comp['prev_label'])}</div>
<h2>Por categoría · acumulado a igual día</h2>
<div class="card"><table><thead><tr><th>Categoría</th><th>Venta actual</th><th>Venta ant.</th><th>Var.</th><th>Mg. Bruto actual</th><th>Mg.% actual</th><th>Mg.% ant.</th></tr></thead><tbody>{cat_rows}</tbody></table></div>
<div class="two">
<div><h2>Top 10 productos del día</h2><div class="card"><table><thead><tr><th>Producto</th><th>Uds</th><th>Venta</th><th>Mg. Bruto</th><th>Mg.%</th></tr></thead><tbody>{top_rows}</tbody></table></div></div>
<div><h2>Alertas de datos</h2><div class="card"><ul>{alerts_html}</ul></div></div>
</div>
<h2>Stock crítico · de más grave a menos grave</h2>
<div class="card"><table><thead><tr><th>Producto</th><th>Restante</th><th>Uds/día</th><th>Cobertura</th><th>Reponer ({ctx['cfg'].get('reposicion_dias', 30)} d)</th><th>Estado</th></tr></thead><tbody>{stock_rows}</tbody></table></div>
<p class="note">Costo ML = cargo por venta + envío a cargo del vendedor + impuestos/retenciones de cada operación según Mercado Pago (estimado {fmt_pct(ctx['cfg'].get('impuestos_ml_pct_estimado') or 0)} s/venta si el pago aún no tiene detalle). El export mensual sigue siendo la cifra definitiva.
COGS = unidades × CU Pond. del cierre de {comp['prev_label']}; sin costo real se aplica margen asumido por categoría.
"{comp['prev_label'].split()[0]} 1–{corte}" usa las órdenes ML del mes anterior y la venta directa cargada con esas fechas; "cierre" son los totales del P&L mensual.
Stock restante = stock final del cierre + ingresos cargados en 'Ingresos Stock' − unidades vendidas en el mes. Proyección = acumulado ÷ {corte} × {n}.</p>
</div></body></html>"""
    rep_dir = os.path.join(ctx["out_dir"], "Reportes")
    os.makedirs(rep_dir, exist_ok=True)
    path = os.path.join(rep_dir, f"Reporte_Cierre_{fecha.isoformat()}{ctx['suffix']}.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    log(f"Reporte de cierre generado: {path}")
    return path


# --------------------------------------------------------------------------- Demo
def demo_orders(base, y, m, seed=42, full=False, vol=1.0):
    """Órdenes ficticias con la misma forma que la API, para probar sin credenciales."""
    rnd = random.Random(seed)
    skus = sorted(base.values(), key=lambda b: b["ean"])
    weights = [3 if b["cat"] in ("SONY", "PLAY STATION") else 2 if b["cat"] == "VINOS" else 1 for b in skus]
    today = dt.datetime.now(TZ).date()
    last = days_in(y, m) if full else (today.day if (today.year, today.month) == (y, m) else 25)
    orders, ships, gtins = [], {}, {}
    oid = 2000009000000 + seed * 100000
    for d in range(1, last + 1):
        wd = dt.date(y, m, d).weekday()
        n = int((rnd.randint(8, 16) + (5 if wd == 0 else 0) - (3 if wd == 6 else 0)) * vol * (1 + d / 120))
        for _ in range(n):
            b = rnd.choices(skus, weights)[0]
            cu = b["cu"] or 40000
            pu = round(cu / (1 - rnd.uniform(0.20, 0.34)) / 100) * 100
            qty = 1 if rnd.random() < 0.86 else 2
            iid = f"MLA{1400000000 + zlib.crc32(b['ean'].encode()) % 99999999}"
            gtins[iid] = {"_item": b["ean"]}
            oid += 1
            sid = 44000000000 + oid % 100000000
            ships[str(sid)] = round(pu * qty * rnd.uniform(0.02, 0.06)) if pu * qty < 300000 else 0
            hh = rnd.randint(8, 23)
            if not full and d == last:
                hh = rnd.randint(8, max(8, dt.datetime.now(TZ).hour if d == today.day else 23))
            orders.append({
                "id": oid, "pack_id": None, "status": "paid" if rnd.random() > 0.04 else "cancelled",
                "date_created": f"{y}-{m:02d}-{d:02d}T{hh:02d}:{rnd.randint(0, 59):02d}:00.000-03:00",
                "shipping": {"id": sid}, "payments": [{"id": 90000000000 + oid, "status": "approved"}],
                "order_items": [{"item": {"id": iid, "title": b["desc"], "seller_sku": "", "variation_id": None},
                                 "quantity": qty, "unit_price": pu, "sale_fee": round(pu * rnd.uniform(0.12, 0.16))}],
            })
    if not full:  # una publicación sin EAN, para mostrar el flujo de "Sin Match"
        orders.append({"id": oid + 1, "status": "paid", "date_created": f"{y}-{m:02d}-{last:02d}T12:00:00.000-03:00",
                       "shipping": {"id": 1}, "order_items": [{"item": {"id": "MLA1999999999",
                       "title": "Combo cable USB-C + cargador 65W", "seller_sku": "COMBO-65"},
                       "quantity": 1, "unit_price": 42000, "sale_fee": 5900}]})
        ships["1"] = 0
    return orders, ships, gtins


def demo_taxes(orders):
    """Detalle de impuestos ficticio con la forma de charges_details de Mercado Pago."""
    rnd = random.Random(11)
    out = {}
    juris = [("IIBB Retención CABA", 0.0), ("IIBB Retención Buenos Aires", 0.0), ("IIBB Retención Córdoba", 0.0)]
    for o in orders:
        for pay in o.get("payments") or []:
            if rnd.random() < 0.1:
                continue  # algunos pagos aún sin detalle -> estimado
            v = sum(it["unit_price"] * it["quantity"] for it in o["order_items"])
            name = rnd.choice(juris)[0]
            charges = [{"type": "tax", "name": name, "accounts": {"from": "collector", "to": "mp"},
                        "amounts": {"original": round(v * rnd.uniform(0.02, 0.045)), "refunded": 0}},
                       {"type": "tax", "name": "Imp. Débitos y Créditos", "accounts": {"from": "collector", "to": "mp"},
                        "amounts": {"original": round(v * 0.012), "refunded": 0}},
                       {"type": "fee", "name": "ml_sale_fee", "accounts": {"from": "collector", "to": "ml"},
                        "amounts": {"original": 1, "refunded": 0}}]
            out[str(pay["id"])] = taxes_from_payment({"charges_details": charges})
    return out


# --------------------------------------------------------------------------- CLI
def parse_hhmm(s):
    h, mi = map(int, str(s or "23:55").split(":"))
    return dt.time(h, mi)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "sync"
    if cmd == "demo":
        cfg = load_json(os.path.join(HERE, "config.demo.json"), None) or load_config()
        cfg.setdefault("margen_asumido", DEFAULT_MG)
        cfg.setdefault("output_dir", HERE)
        ctx = run_sync(cfg, demo=True)
        write_report(ctx)
        return
    cfg = load_config()
    if cmd == "auth":
        ML(cfg).auth_interactive()
    elif cmd == "sync":
        run_sync(cfg)
    elif cmd == "reporte":
        fecha = dt.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else dt.datetime.now(TZ).date()
        if not cfg.get("mes_fijo"):
            cfg["mes"] = fecha.strftime("%Y-%m")
        ctx = run_sync(cfg)
        write_report(ctx, fecha)
    elif cmd == "loop":
        mins = int(cfg.get("refresh_minutes", 15))
        cierre = parse_hhmm(cfg.get("hora_cierre", "23:55"))
        log(f"Modo continuo: actualizo cada {mins} min y genero el reporte de cierre a las "
            f"{cierre.strftime('%H:%M')}. Ctrl+C para cortar.")
        state = load_json(CACHE_PATH, {}).get("last_report")
        while True:
            now = dt.datetime.now(TZ)
            try:
                cfg = load_config()
                ctx = run_sync(cfg)
                if now.time() >= cierre and state != now.date().isoformat():
                    write_report(ctx, now.date())
                    state = now.date().isoformat()
                    c = load_json(CACHE_PATH, {})
                    c["last_report"] = state
                    save_json(CACHE_PATH, c)
            except Exception as e:
                log(f"Error en el ciclo: {e}")
            # dormir hasta el próximo ciclo, sin saltear la hora de cierre
            nxt = now + dt.timedelta(minutes=mins)
            cierre_dt = dt.datetime.combine(now.date(), cierre, tzinfo=TZ)
            if now < cierre_dt < nxt and state != now.date().isoformat():
                nxt = cierre_dt + dt.timedelta(seconds=5)
            time.sleep(max(5, (nxt - dt.datetime.now(TZ)).total_seconds()))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
