# F1 — Combo (pack) builder UI  (future, after X1)

## Why
Some listings are packs made of several different products. The data model (`ListingLink` → `ListingLinkComponent[]`) and the stock math (`min floor(onHand / qty)`) already support it; v1 only exposes single-component links.

## Scope
- Remove the "Combos: próximamente" guard in the `stock-products` router (the single validation point from S5).
- Link UI: add several components (product + quantity) to one listing/variation, with live "stock disponible" preview.
- A sale of the combo decrements **every** component (S4 already does this per component); a stock change in any component changes the combo's available quantity and triggers a push for every listing that contains it.
- Product drawer shows "Forma parte de" (combos that include it).
- Alerts: a combo is out of stock when any component is; low stock uses the limiting component.
- Tests: pack with two components, shared component across two combos, push triggered for both.

Write this ticket in full (files, tests) when scheduling it.
