# U0 — App shell (sidebar) + dashboard cleanup

## Goal
A collapsible navigation that matches the current look, and a leaner dashboard.

## Files you own
`src/app/layout.tsx` (shell wiring only), `src/app/_components/shell/*` (new), `src/app/_components/dashboard/Dashboard.tsx`, `src/app/_components/dashboard/tables.tsx` (remove `StockTable` and `Alerts` usage/exports that become dead), `src/app/stock/layout.tsx` (new: shell for the stock section + the tab bar component with Productos / Facturas / Alertas / Devoluciones / Sincronización; tabs link to routes owned by U1–U5), `src/app/stock/page.tsx` (redirect to `/stock/products`), tests.

## Behaviour
1. **Sidebar**: hamburger icon (three lines) in the header toggles it; **collapsed by default**; state remembered in `localStorage` (wrapped in try/catch, works without it). Links: Dashboard (`/`), Stock (`/stock`), Market research (`/market-research`). Active link highlighted. Keyboard accessible (button with `aria-expanded`, focus trap not required), closes on route change on mobile, works at 375 px width.
2. Reuse the existing design tokens, fonts, spacing and header (`actions` slot, filters, Clerk `UserButton` stay). Look at `Dashboard.tsx` and `tables.tsx` first and match them; do not introduce a new component library.
3. **Dashboard cleanup**: remove the critical-stock table and the "Alertas de datos" card. Add a compact badge "N alertas" linking to `/stock/alerts`, fed by `trpc.stockAlerts.counts` (until S7 merges, render nothing if the query errors or returns no data — no crash). Keep `stockCounts`/`stockRows` in `dashboard-math.ts` if anything else imports them; delete only what becomes dead, and say what you deleted.
4. Pages that do not exist yet (`/stock/products`, `/market-research` index) must not 404 the shell: the shell only links; each owner ships their page.
5. Sign-in/sign-up and the "Vinculá tu cuenta" screen render without the sidebar.

## Tests
Component tests: collapsed by default, toggle, persisted state, active link, badge shows count, dashboard no longer renders the two removed sections. Take screenshots at desktop and 375 px (dev server) and attach them to the report.

## Done when
`pnpm typecheck && pnpm lint && pnpm test` green; screenshots show shell + dashboard in light/dark if the app supports both.
