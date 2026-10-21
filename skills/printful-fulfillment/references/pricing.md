# Pricing reference

## Production cost (catalog, no store needed)

`unit_cost = technique_base_price + Σ extra_placements + Σ paid_options`

- Base price depends on technique (dtg, embroidery, dtfilm, sublimation, …) and selling region (`europe`, `north_america`, `uk`, …).
- Exactly one placement is included in the base: the earliest eligible one in the product's placement list. Inside/outside labels and large embroidery are never included.
- Options such as `unlimited_color` (embroidery) or 3D puff add their listed price.
- Volume discount tiers (e.g. 25+ = 13%) are returned in `discount_tiers`; they apply automatically on Printful's side.

Example (EUR, Europe, 2026-10): Bella+Canvas 3001 Black M (4017): DTG base 10.50, `back` +5.25, `label_inside` +0.95 → front+back = 15.75, front+back+label = 16.70.

## Shipping

`printful_shipping_rates` returns methods (`STANDARD`, `EXPRESS`, …) with rate, currency and delivery days. Only `country_code` is required; `state_code` is required for US/CA/AU. Example: 1 tee to PL, STANDARD 4.45 EUR, 4–6 days.

## Exact order cost

`printful_estimate_order` → `costs`: subtotal, discount, shipping, digitization, additional_fee, fulfillment_fee, vat, tax, total. This is what Printful will charge. Example: tee front+back to PL = 18.50 + 4.99 shipping + 5.41 VAT = 28.90 USD.

## Retail price

- Markup mode: `net = cost × (1 + markup%) + markup_fixed`.
- Target-margin mode: `net = (cost + fee_fixed) / (1 − margin − fee% × (1 + VAT))`, so the margin holds after payment fees.
- `gross = net × (1 + VAT)`, then rounded: `0.99` → x.99 ending, `0` → whole units, `5` → next multiple of 5, `null` → none. After rounding net, profit and margin are recomputed from the rounded gross.
- `include_shipping: true` folds Printful shipping into the product price ("free delivery").
- `min_margin_pct` adds `margin_ok` as a guard.

VAT reminders: PL 23%, DE 19%, FR 20%, NL 21%, CZ 21%. Selling to EU consumers above the OSS threshold uses the customer's country VAT.
