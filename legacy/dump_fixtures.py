#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dumps deterministic fixtures from the legacy Python for the TypeScript port.

Usage (from the project root, with openpyxl available):
    python3 legacy/dump_fixtures.py

Writes tests/fixtures/demo/*.json (contract-shaped, camelCase) and
src/lib/sample-dashboard.json. "now" is frozen at 2026-10-20 15:30 (-03:00), cut day 20.
"""
import datetime as _dt
import importlib.util
import json
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "tests", "fixtures", "demo")
SAMPLE = os.path.join(ROOT, "src", "lib", "sample-dashboard.json")

spec = importlib.util.spec_from_file_location("ml_pnl_live", os.path.join(HERE, "ml_pnl_live.py"))
ml = importlib.util.module_from_spec(spec)
sys.modules["ml_pnl_live"] = ml
spec.loader.exec_module(ml)

TZ = ml.TZ
FROZEN = _dt.datetime(2026, 10, 20, 15, 30, tzinfo=TZ)


class _Meta(type(_dt.datetime)):
    def __instancecheck__(cls, inst):
        return isinstance(inst, _dt.datetime)


class FakeDT(_dt.datetime, metaclass=_Meta):
    @classmethod
    def now(cls, tz=None):
        return FROZEN if tz is None else FROZEN.astimezone(tz)


ml.dt = types.SimpleNamespace(
    datetime=FakeDT, date=_dt.date, timedelta=_dt.timedelta, timezone=_dt.timezone)

CUT = 20
Y, M = 2026, 10


def load_cfg():
    cfg = ml.load_json(os.path.join(HERE, "config.demo.json"), {})
    cfg.setdefault("refresh_minutes", 15)
    cfg.setdefault("margen_asumido", ml.DEFAULT_MG)
    cfg["mes"] = f"{Y}-{M:02d}"
    cfg["base_pnl_path"] = os.path.join(ROOT, "demo", "PnL_MercadoLibre_Septiembre2026_DEMO.xlsx")
    cfg["ventas_directas_path"] = os.path.join(ROOT, "demo", "Ventas_Directas_DEMO.xlsx")
    return cfg


def iso(d):
    return d.isoformat() if hasattr(d, "isoformat") else d


TOTALS = {"venta_ml": "ventaMl", "venta_va": "ventaVa", "venta": "venta", "costo_ml": "costoMl",
          "cogs": "cogs", "uds": "uds", "ing_netos": "ingNetos", "margen": "margen"}


def totals(d):
    return {TOTALS[k]: v for k, v in d.items() if k in TOTALS}


def order(o):
    c = ml.compact_order(o)
    return {
        "id": c["id"], "packId": c["pack_id"], "status": c["status"], "dateCreated": c["date_created"],
        "shippingId": c["shipping"]["id"],
        "items": [{
            "itemId": str(it["item"]["id"]).upper(), "title": it["item"].get("title") or "",
            "sellerSku": it["item"].get("seller_sku"), "sellerCustomField": it["item"].get("seller_custom_field"),
            "variationId": it["item"].get("variation_id"), "quantity": it["quantity"],
            "unitPrice": it["unit_price"], "saleFee": it["sale_fee"]} for it in c["order_items"]],
        "payments": [{"id": p["id"], "status": p["status"]} for p in c["payments"]],
    }


def line(L):
    return {
        "date": iso(L["fecha"]), "time": L["hora"], "channel": L["canal"], "order": L["orden"],
        "itemId": L["item_id"], "sku": L["sku"], "ean": L["ean"], "matchVia": L["match"],
        "desc": L["desc"], "titleMl": L["titulo_ml"], "cat": L["cat"], "qty": L["qty"], "pu": L["pu"],
        "venta": L["venta"], "cargoVenta": L["cargo_venta"], "envio": L["envio"], "impEst": L["imp_est"],
        "costoMl": L["costo_ml"], "cu": L["cu"], "costSource": L["fuente"], "taxSource": L["imp_fuente"],
        "taxDetail": L["imp_det"],
    }


def stock_item(x):
    return {
        "ean": x["ean"], "desc": x["desc"], "cat": x["cat"], "initial": x["ini"], "inflow": x["ing"],
        "sold": x["vend"], "remaining": x["rest"], "rate": x["rate"], "rateSource": x["fuente_ritmo"],
        "coverage": x["cov"], "breakDate": x["quiebre"], "reorder": x["reponer"], "state": x["estado"],
        "cu": x["cu"],
    }


def write(name, data, path=None):
    path = path or os.path.join(OUT, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, default=str)
        f.write("\n")


def main():
    cfg = load_cfg()
    py, pm = ml.prev_ym(Y, M)
    base, prev = ml.read_base(cfg["base_pnl_path"], cfg)
    inputs = ml.read_inputs(cfg["ventas_directas_path"])

    orders, ships, gtins = ml.demo_orders(base, Y, M, seed=42)
    porders, pships, pgtins = ml.demo_orders(base, py, pm, seed=7, full=True, vol=0.85)
    ships.update(pships)
    gtins.update(pgtins)
    taxes = {k: v for k, v in ml.demo_taxes(orders + porders).items() if v is not None}

    # same "auto" calibration as run_sync
    cfg["impuestos_ml_pct_estimado"] = 0.0
    p0 = [L for L in ml.build_lines(porders, ships, gtins, base, inputs, cfg, py, pm) if L["canal"] == "ML"]
    v0 = sum(L["venta"] for L in p0)
    c0 = sum(L["cargo_venta"] + L["envio"] for L in p0)
    pct = 0.0
    if v0 and prev.get("costo_ml"):
        pct = max(0.0, min(0.15, (prev["costo_ml"] - c0) / v0))
    cfg["impuestos_ml_pct_estimado"] = round(pct, 4)

    lines = ml.build_lines(orders, ships, gtins, base, inputs, cfg, Y, M, taxes)
    plines = ml.build_lines(porders, ships, gtins, base, inputs, cfg, py, pm, taxes)
    stock = ml.compute_stock(base, lines, inputs, cfg, Y, M, CUT, ml.days_in(py, pm))

    write("orders.json", [order(o) for o in orders])
    write("prev_orders.json", [order(o) for o in porders])
    write("ship_costs.json", ships)
    write("gtins.json", gtins)
    write("taxes.json", taxes)
    write("base.json", {e: {
        "ean": b["ean"], "desc": b["desc"], "modelo": b["modelo"], "cat": b["cat"], "cu": b["cu"],
        "stock": b["stock"], "mg": b["mg"], "costoMlPctPrev": b["costo_ml_pct_prev"], "udsPrev": b["uds_prev"],
    } for e, b in base.items()})
    write("prev_cierre.json", totals(prev))
    write("inputs.json", {
        "va": [{"date": iso(v["fecha"]), "cliente": v["cliente"], "ean": v["ean"], "desc": v["desc"],
                "qty": v["qty"], "pu": v["pu"]} for v in inputs["va"]],
        "mapItem": inputs["map_item"], "mapSku": inputs["map_sku"],
        "override": inputs["override"],
        "ingresos": [{"date": iso(i["fecha"]), "ean": i["ean"], "qty": i["qty"]} for i in inputs["ingresos"]],
    })
    write("lines.json", [line(L) for L in lines])
    write("prev_lines.json", [line(L) for L in plines])
    write("daily.json", [totals(d) for d in ml.daily_series(lines, Y, M)])
    write("prev_daily.json", [totals(d) for d in ml.daily_series(plines, py, pm)])
    write("stock.json", [stock_item(x) for x in stock])
    write("meta.json", {"y": Y, "m": M, "cutDay": CUT, "prevDays": ml.days_in(py, pm), "taxPct": cfg["impuestos_ml_pct_estimado"],
                        "frozenNow": FROZEN.isoformat()})

    # Full run (also builds the Excel + HTML in a temp dir) to get the dashboard JSON
    cfg2 = load_cfg()
    with tempfile.TemporaryDirectory() as tmp:
        cfg2["output_dir"] = tmp
        res = ml.run_sync(cfg2, demo=True)
        html = open(res["html"], encoding="utf-8").read()
    marker = "const DATA = "
    i = html.index(marker) + len(marker)
    data, _ = json.JSONDecoder().raw_decode(html[i:])
    write("dashboard.python.json", data)

    comp = data["comp"]
    sample = {
        "rows": [{"date": r["f"], "time": r["h"], "channel": r["c"], "order": r["o"], "ean": r["e"],
                  "desc": r["d"], "cat": r["k"], "qty": r["q"], "sale": r["v"], "costML": r["ml"],
                  "cogs": r["g"], "assumed": bool(r["a"])} for r in data["rows"]],
        "stock": [{"desc": s["d"], "cat": s["k"], "ean": s["e"], "initial": s["i"], "inflow": s["n"],
                   "sold": s["v"], "remaining": s["r"], "rate": s["rt"], "rateSource": s["f"],
                   "coverage": s["c"], "breakDate": s["q"], "reorder": s["p"], "state": s["s"]}
                  for s in data["stock"]],
        "updatedAt": data["updated"], "monthLabel": data["mes"], "y": data["y"], "m": data["m"],
        "unmatched": [{"itemId": u["item_id"], "sku": u["sku"], "title": u["titulo"], "qty": u["qty"],
                       "venta": u["venta"]} for u in data["unmatched"]],
        "refreshMinutes": data["refresh"], "taxPct": data["imp"],
        "thresholds": {"crit": data["umbral"]["crit"], "low": data["umbral"]["bajo"], "repo": data["umbral"]["repo"]},
        "comp": {
            "prevLabel": comp["prev_label"], "prevCierre": totals(comp["prev_cierre"]),
            "prevDaily": [totals(d) for d in comp["prev_daily"]], "nDays": comp["n_days"],
            "prevToday": totals(comp["prev_hoy"]) if comp["prev_hoy"] else None,
            "cutTime": comp["hora_corte"], "prevAccumAtCut": totals(comp["prev_acum_corte"]),
            "cutDay": comp["dia_corte"],
        },
    }
    write(None, sample, path=SAMPLE)
    print("fixtures written:", len(lines), "lines,", len(stock), "stock rows, taxPct", cfg["impuestos_ml_pct_estimado"])


if __name__ == "__main__":
    main()
