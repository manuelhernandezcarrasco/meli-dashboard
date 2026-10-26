# T5 — Dashboard UI (React)

**Depends on:** T0 merged · **Blocks:** T7 (and T6's final visual check) · **Parallel with:** T1 T2 T3 T4
**Needs DB:** no · **Branch:** `t5-dashboard-ui`

## Goal
Rebuild `legacy/dashboard_template.html` as React components, identical sections and numbers, driven by the tRPC `dashboard.*` procedures (stubbed by T0 with `src/lib/sample-dashboard.json` until T6 makes them real).

## Files you own
`src/app/_components/dashboard/*` (replace placeholder `index.tsx`), `src/app/page.tsx`, `src/app/layout.tsx` (title/lang `es-AR` only), `src/styles/globals.css`, `src/lib/dashboard-math.ts` (+ tests). Add `recharts` with `pnpm add recharts` (the only new dependency). Do **not** edit routers or contracts.

## Spec
1. **Read `legacy/dashboard_template.html` fully first.** All client-side maths in it (KPI aggregation, filters by channel/category, top products, category table, alerts, waterfall, acumulado, formatting) moves to `src/lib/dashboard-math.ts` as **pure, tested functions** taking `DashboardData`. Keep formulas identical (Mg.% = margen / venta, etc.).
2. Page structure (same order as the template): header (title with month, live indicator, "actualizado dd/MM/yyyy HH:mm", channel toggle Todos/ML/VA, category select) → **Hoy** KPIs → **Mes acumulado** KPIs (with deltas vs previous month at the same day) → charts row 1 (*Venta diaria y margen bruto*: bars + Mg.% line; *Del precio al margen* waterfall) → row 2 (*Venta acumulada vs mes anterior a igual día*; *Por categoría* table) → row 3 (*Últimas ventas*, *Top productos del mes*, *Alertas de datos*) → *Stock crítico* with state chips + table → footer.
3. Charts with Recharts (replacing Chart.js). Server data arrives via `api.dashboard.get.useQuery()`; refetch every 60 s (`refetchInterval`). Show a skeleton while loading and an error banner if the query fails (keep last data visible).
4. **"Actualizar ahora" button** in the header → `api.dashboard.refresh.useMutation()`; disabled while running or during cooldown; shows a spinner; on `TOO_MANY_REQUESTS` show "Espere N s"; on success invalidate `dashboard.get`. Also show a small "DEMO" badge when `dashboard.status` says `source === "demo"` (add the field in the *UI types only*; T0's stub may not return it, so treat undefined as live).
5. Tailwind for layout and theme (dark-friendly, same palette idea as the template: navy header, green/orange/red states). Responsive down to phone width. Numbers formatted `es-AR` (`1.234.567`, negatives in parentheses like the template), percentages 1 decimal.
6. Components small and typed: `Header`, `KpiRow`, `Kpi`, `DailyChart`, `Waterfall`, `AccumChart`, `CategoryTable`, `SalesFeed`, `TopProducts`, `Alerts`, `StockTable`, `RefreshButton`. No `any`.

## Tests (Vitest, no browser needed)
- `dashboard-math`: with `src/lib/sample-dashboard.json` — KPI totals for month equal the sums of `rows`; channel filter ML+VA = Todos; category filter; top products ordered by venta; waterfall steps add up (`venta − costoML − cogs = margen`); acumulado vs `comp.prevAccumAtCut`.
- A render smoke test with `@testing-library/react` (add as dev dependency) mounting `<Dashboard data={sample} />` (presentational component taking data as prop) and finding the section titles.

## Manual check
`pnpm dev`, open `http://localhost:3000`, compare visually with `legacy/dashboard_template.html` opened with its own data (`python3 -m http.server` is not needed; just open the file). Report differences you intentionally made.

## Acceptance
`pnpm typecheck && pnpm lint && pnpm test && pnpm build` green. Page works with the T0 stub data.

## Out of scope
Server logic, cache, cooldown enforcement (T6), auth, Excel/closing report.
