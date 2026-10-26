# PnL Diario en vivo — MercadoLibre + Venta Directa (MCG)

Un script que corre en tu compu, trae las ventas de MercadoLibre por API cada 15 minutos, las cruza con el **CU Pond. y stock final del P&L de cierre del mes anterior**, suma la venta directa que cargás a mano y genera:

| Salida | Qué es |
|---|---|
| `salida/Dashboard_PnL_Diario.html` | Dashboard en vivo (se refresca solo). Abrilo en el navegador y dejalo abierto. |
| `salida/PnL_Diario_<Mes><Año>.xlsx` | Excel con fórmulas: Resumen, PnL Diario, Comparativo, PnL por SKU, Detalle Ventas, Base Costos, Sin Match. |
| `salida/Reportes/Reporte_Cierre_<fecha>.html` | Reporte de cierre de cada día (23:55): acumulado del mes vs mes anterior a igual día y vs cierre. Se imprime/guarda en PDF desde el navegador. |

**Definiciones** (mismo criterio que el P&L mensual)
- Venta Total = Venta ML (precio × uds, "Ingresos por productos") + Venta Directa
- Costo ML = cargo por venta + envío a cargo del vendedor + impuestos/retenciones de cada operación según **Mercado Pago** (detalle por pago: IIBB por jurisdicción, débitos y créditos, etc.)
- Ingresos Netos = Venta Total − Costo ML
- COGS = uds × CU Pond. del cierre anterior; si no hay costo real, margen asumido por categoría (Sony/PS 8%, Xbox/Bosch 15%, Vinos/OnFan 20%, Otras 30%)
- Margen Bruto = Ingresos Netos − COGS

---

## Puesta en marcha (una sola vez)

**1. Python.** Necesitás Python 3.10 o superior. En una terminal:
```
pip install openpyxl
```

**2. App de MercadoLibre.** Entrá a https://developers.mercadolibre.com.ar → *Mis aplicaciones* → *Crear aplicación*, con la cuenta de MCG.
- Redirect URI: `https://www.google.com` (o cualquier URL https tuya)
- Permisos: lectura de órdenes/ventas y *offline access* (para que el acceso se renueve solo)
- Anotá el **App ID** y la **Secret Key**.

**3. Configuración.** Copiá `config.example.json` como `config.json` y completá:
- `client_id` / `client_secret` / `redirect_uri` de la app
- `base_pnl_path`: el P&L de cierre del mes anterior (ej. `PnL_MercadoLibre_Septiembre2026.xlsx`), en la misma carpeta o con su ruta completa
- Lo demás puede quedar como está: `refresh_minutes` 15, `hora_cierre` "23:55", `mes` vacío = mes en curso, `impuestos_ml_pct_estimado` "auto"

**4. Autorizar.**
```
python ml_pnl_live.py auth
```
Abrís el link que muestra, autorizás, y pegás la URL a la que te redirige (trae `code=TG-…`). Queda guardado en `tokens.json` — ese archivo es tu acceso a la cuenta: no lo compartas.

**5. Arrancar.**
```
python ml_pnl_live.py loop
```
Dejalo corriendo. Abrí `salida/Dashboard_PnL_Diario.html` en el navegador. A la hora de cierre genera el reporte del día.

Para que arranque solo al prender la compu: en Windows, *Programador de tareas* → tarea "Al iniciar sesión" que ejecute `python ruta\ml_pnl_live.py loop`; en Mac, agregalo como ítem de inicio o con `launchd`.

---

## Uso diario

- **Venta directa:** cargala en `Ventas_Directas_y_Mapeo.xlsx` (hoja *Ventas Directas*). Si cargás también las del mes anterior con su fecha, la comparación a igual día las incluye.
- **Publicaciones sin EAN:** si algo aparece en la hoja *Sin Match* del Excel o en las alertas, agregá el Item ML → EAN en la hoja *Mapeo ML*. Hasta entonces se costea con margen asumido 30%.
- **Ingresos de mercadería:** cargá compras e importaciones del mes en la hoja *Ingresos Stock* (fecha, EAN, cantidad). Se suman al stock para el listado de stock crítico.
- **Stock crítico:** en el dashboard, en la hoja *Stock Crítico* del Excel y en el reporte diario, ordenado de más grave a menos grave: vendido sin stock → agotado → crítico (< 7 días de cobertura) → bajo (< 15 días) → OK. Cobertura = restante ÷ ritmo de venta del mes (si un producto aún no vendió en el mes, se usa el ritmo del mes anterior). *Reponer* = unidades para cubrir 30 días. Los umbrales se cambian en `config.json` (`stock_critico_dias`, `stock_bajo_dias`, `reposicion_dias`).
- **Productos nuevos o compras del mes con otro costo:** cargalos en *Costos Override*; reemplazan al CU Pond. del cierre.
- **Excel abierto:** si lo tenés abierto cuando corre el ciclo, no se puede sobrescribir; se actualiza en el siguiente al cerrarlo. El dashboard se actualiza igual.
- **Reporte manual de un día:** `python ml_pnl_live.py reporte 2026-10-24`

## Cambio de mes

El script pasa solo al mes nuevo (con `mes` vacío). Cuando tengas el P&L de cierre del mes que terminó, actualizá `base_pnl_path` en `config.json` para que tome los costos y stock nuevos. Mientras no lo cambies, sigue usando el cierre anterior y la comparación "vs cierre" queda contra ese mes.

## Probar sin credenciales

```
python ml_pnl_live.py demo
```
Usa `config.demo.json` y la base ficticia de la carpeta `demo/`. Genera todo en `salida_demo/`.

## A tener en cuenta

- **Impuestos desde Mercado Pago.** Para cada orden paga, el script lee el pago en Mercado Pago (con el mismo acceso de la app) y suma los cargos de tipo impuesto/retención descontados al vendedor. El detalle queda en las últimas columnas de *Detalle Ventas* (por ej. "IIBB Retención Córdoba 2.266; Imp. Débitos y Créditos 683"), así podés separar lo de CABA, que es recuperable, del resto.
- Si un pago todavía no tiene detalle (o MP no responde), esa línea usa un % **calibrado automáticamente** con el mes anterior: (Costo ML del cierre − cargo y envío según API) ÷ Venta ML. La columna *Fuente impuestos* dice si el dato es de Mercado Pago o estimado.
- En cada ciclo la consola muestra un **control**: Costo ML del mes anterior según API + MP vs el P&L de cierre. Si la diferencia es chica, el Costo ML en vivo es confiable; si es grande, avisame y lo ajustamos.
- El P&L mensual con el export de ML sigue siendo la cifra definitiva.
- Los packs con varias órdenes comparten envío: el costo se prorratea por venta.
- Se cuentan sólo órdenes **pagas**; canceladas y devueltas no suman, igual que en el P&L.
- El **stock restante** es stock final del cierre + ingresos cargados − unidades vendidas.
- La comparación del día en curso se hace contra el mismo día del mes anterior **hasta la misma hora**.
