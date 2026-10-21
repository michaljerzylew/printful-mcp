---
name: printful-fulfillment
description: Operate Printful print-on-demand for an independent shop through this MCP server — find products and variants, calculate production cost, shipping, full order estimate and retail price with margin and VAT, send shop orders (including customer custom designs) to Printful for printing and direct shipping, confirm safely, track shipments, manage files, store products, templates, webhooks and mockups.
---

# Printful fulfillment for an independent shop

The shop (catalog, prices, checkout) lives outside Printful. Printful only prints and ships each order directly to the shop's customer. You are the operator between them.

## Ground rules

1. **Money gate.** `printful_confirm_order` and `printful_fulfill_shop_order` with `confirm: true` charge the owner's Printful balance and start production. Never do that unless the user explicitly asked to send/confirm this order in this conversation. Always pass `max_cost` (default: the order estimate total + 10%). Without explicit consent, create a **draft** (`confirm: false`) and show the costs.
2. **Idempotency.** The shop order number becomes Printful `external_id` verbatim. It must be 1–32 characters of `A-Z a-z 0-9 - _`, so map `#1001` to `1001` yourself. Re-sending the same shop order returns `exists`, never a duplicate. If a different order already uses that number, the tool returns `conflict` and does not confirm. Look up orders with `@<shop-order-number>` as `order_id`.
3. **Files must be public URLs** (PNG/JPG/PDF; Printful downloads them). A customer's upload is used as the layer URL of the chosen placement. Check print-area size with `printful_catalog_mockup_templates` or `printful_catalog_printfiles` when the user cares about quality; 150 DPI at final print size is the practical minimum.
4. **Store scope.** Orders, shipping rates, estimates, files, webhooks and store products need a store. If a tool answers "requires store_id", call `printful_stores_list` and pass `store_id` (or ask the owner to set `PRINTFUL_STORE_ID`).
5. Report results with numbers and currency. Printful bills in the account currency (often USD) even when catalog prices are shown in EUR or PLN. Pass `currency` with `max_cost` when you mean a specific currency.
6. **Never** use `printful_api` to confirm, submit or approve anything; the server blocks it. Use the dedicated tools.

## Workflow: price a new product

1. `printful_catalog_search` → product id (e.g. 71 = Bella+Canvas 3001 tee).
2. `printful_catalog_variants` with color/size → `catalog_variant_id` (e.g. 4017 = Black M).
3. `printful_calc_cost` with placements (`front`/`dtg`, `back`/`dtg`, `embroidery_chest_left`/`embroidery` + `unlimited_color`). The first eligible placement is included in the base price; labels and large embroidery are always extra.
4. `printful_shipping_rates` for the target country.
5. `printful_calc_retail` with target margin, VAT (e.g. 0.23 PL, 0.19 DE), payment fee and `.99` rounding, optionally with shipping folded into the price for "free delivery".

Details and formulas: `references/pricing.md`.

## Workflow: fulfil a shop order

1. Normalise the shop order into the canonical shape (`references/order-format.md`): recipient, items with `sku`, `quantity`, `price`, and `custom` fields for personalisation.
2. Map each line to a Printful item. Either pass ready `order_items` (catalog variant + placements + layers) or a `mapping` object (SKU → rule, with `{custom.front_url}` placeholders and `{size}` patterns). See `references/mapping.md`.
3. `printful_fulfill_shop_order` with `dry_run: true` → review the exact request.
4. `printful_estimate_order` (or create the draft) → present the cost to the user.
5. Only with explicit consent: `printful_fulfill_shop_order` with `confirm: true, max_cost: N`, or `printful_confirm_order` for an existing draft.
6. Tracking: `printful_order_shipments` (`@shop-order-number`). Status values: draft, pending, inreview, failed, onhold, inprocess, partial, fulfilled, canceled.

## Custom inserts and branding

- Packing slip per order: `customization.packing_slip` (message, store_name, email, phone, logo_url, custom_order_id). Store default: `printful_store_packing_slip`.
- Gift note: `customization.gift` (subject, message).
- Inside label: placement `label_inside` with your brand file; embroidery notes: product option `notes`.
- Embroidery orders can be held for design approval: `printful_approval_sheets` → approve (this releases production, so ask first) or request changes.

## Troubleshooting

- `held` → read `reason`: cost above `max_cost`, costs still calculating (retry in a few seconds), or currency mismatch.
- `failed` order → read `printful_get_order`; usually address, file URL not reachable, or print area mismatch. Fix with `printful_update_order` (drafts/failed only), then confirm again.
- 401 → token invalid/revoked. 403 → token lacks scope. 429 → slow down (server already retries).
- v2 estimation tasks sometimes stay `pending`; the server falls back to v1 synchronous estimate automatically.
