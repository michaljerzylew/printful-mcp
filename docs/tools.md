# Tool reference

Generated from the server's `tools/list` (44 tools). Results are JSON in `content[0].text`, mirrored in `structuredContent`.
Errors come back as tool results with `isError: true` and a hint.

Legend: 🔒 read-only · ✏️ writes · ⚠️ destructive or money-moving (clients should ask first). **Bold** = required. `store_id` is optional everywhere and defaults to `PRINTFUL_STORE_ID`.

## Account & store

| Tool | | Description | Parameters |
|---|:-:|---|---|
| `printful_whoami` | 🔒 | Token scopes, stores visible to the token and the default store. Call first when anything fails. | — |
| `printful_stores_list` | 🔒 | List Printful stores (id, name, type). | — |
| `printful_store_get` | 🔒 | Details of one store. | — |
| `printful_store_statistics` | 🔒 | Sales, costs and profit statistics for a date range. | **date_from**, **date_to**, currency, report_types |
| `printful_store_packing_slip` | ✏️ | Set default packing-slip branding for the store (email, phone, message, logo_url, store_name, custom_order_id). | email, phone, message, logo_url, store_name, custom_order_id |

## Catalog

| Tool | | Description | Parameters |
|---|:-:|---|---|
| `printful_catalog_search` | 🔒 | Search Printful catalog products by text (name, type, brand, model) with optional filters. Returns product ids. | query, category_ids, techniques, placements, selling_region_name, destination_country, limit |
| `printful_catalog_product` | 🔒 | Full catalog product: techniques, placements, sizes, colors, options. | **product_id**, selling_region_name |
| `printful_catalog_variants` | 🔒 | Variants of a product (variant id = catalog_variant_id for orders). Filter by color/size. | **product_id**, color, size |
| `printful_catalog_categories` | 🔒 | List catalog categories, or one category by id. | category_id |
| `printful_catalog_prices` | 🔒 | Production price list for a product or variant: techniques, placements, options. | product_id, variant_id, currency, selling_region_name |
| `printful_catalog_sizes` | 🔒 | Size guide for a product. | **product_id**, unit |
| `printful_catalog_availability` | 🔒 | Stock availability of a product or variant by region/technique. | product_id, variant_id, techniques, selling_region_name |
| `printful_catalog_images` | 🔒 | Blank product/variant images. | product_id, variant_id, placement, colors |
| `printful_catalog_shipping_countries` | 🔒 | Countries a product ships to. | **product_id** |
| `printful_catalog_mockup_templates` | 🔒 | Print-area geometry and template images per placement (use to size customer artwork). | **product_id**, placements |
| `printful_catalog_mockup_styles` | 🔒 | Mockup styles available for a product. | **product_id**, placements |
| `printful_catalog_printfiles` | 🔒 | Required print-file pixel sizes and DPI per placement (v1). | **product_id**, technique |
| `printful_countries` | 🔒 | Countries and states Printful ships to. | — |

## Pricing & quoting

| Tool | | Description | Parameters |
|---|:-:|---|---|
| `printful_calc_cost` | 🔒 | Production cost of one variant with placements and options (no store needed). First eligible placement is included in base price. | **variant_id**, placements, quantity, currency, selling_region_name |
| `printful_shipping_rates` | 🔒 | Shipping methods and rates to a destination for given items (needs store). | **recipient**, **items**, currency |
| `printful_estimate_order` | 🔒 | Exact Printful charge (products + shipping + VAT/tax) for an order. Accepts a v2 order body, a shop order (+mapping), or quick items. | order, shop_order, mapping, recipient, items |
| `printful_calc_retail` | 🔒 | Shop price from cost: markup or target margin, VAT, payment fees, .99 rounding, optional shipping folded into price. | **cost**, shipping, include_shipping, markup_pct, markup_fixed, target_margin_pct, vat_rate, round_to, payment_fee_pct, payment_fee_fixed, min_margin_pct |
| `printful_quote` | 🔒 | One call: production cost, cheapest shipping to country, and suggested retail price. | **variant_id**, placements, quantity, country_code, currency, target_margin_pct, markup_pct, vat_rate, include_shipping |

## Fulfillment & orders

| Tool | | Description | Parameters |
|---|:-:|---|---|
| `printful_fulfill_shop_order` | ✏️ | Turn a shop order (with customer custom designs) into a Printful order for printing and direct shipping. Idempotent by shop order id. dry_run returns the request only. confirm=true CHARGES the Printful balance — only with explicit user consent, always with max_cost. | **shop_order**, mapping, dry_run, confirm, max_cost, currency |
| `printful_orders_list` | 🔒 | List Printful orders (newest first). Optional status filter: draft, pending, failed, canceled, onhold, inprocess, partial, fulfilled. | status, limit, offset |
| `printful_get_order` | 🔒 | Full order: recipient, items, costs, status. | **order_id** |
| `printful_create_order` | ✏️ | Create a DRAFT order from a raw Printful v2 order body. Does not charge. | **order** |
| `printful_update_order` | ✏️ | PATCH (RFC 7386) a draft or failed order. | **order_id**, **patch** |
| `printful_confirm_order` | ⚠️ | Submit a draft for fulfillment: Printful charges the balance and starts production. Only with explicit user consent. Pass max_cost. | **order_id**, **max_cost**, currency |
| `printful_delete_order` | ⚠️ | Delete an order in draft/failed/canceled state that was not charged. | **order_id** |
| `printful_cancel_order` | ⚠️ | Cancel an order that is not yet in production (v1 cancel). | **order_id** |
| `printful_order_items` | ✏️ | List, add, update or delete items of a draft order. | **order_id**, **action**, item_id, item |
| `printful_order_shipments` | 🔒 | Shipments with carrier, tracking number and URL. | **order_id** |
| `printful_order_invoice` | 🔒 | Invoice metadata (PDF content is base64 — summarised). | **order_id** |
| `printful_approval_sheets` | ⚠️ | Orders held for design approval (e.g. embroidery): list, approve (releases the design to production — ask the user first), request_changes. | **action**, order_id, confirm_hash, message, file_urls |

## Files, products, templates, webhooks, mockups

| Tool | | Description | Parameters |
|---|:-:|---|---|
| `printful_files` | ✏️ | Add a file from public URL, get a file, or suggest embroidery thread colors. | **action**, url, file_id, role, filename, visible |
| `printful_store_products` | ✏️ | Printful store (sync) products: list, get, create, update, delete, add_variant, get_variant, update_variant, delete_variant. ids accept "@external_id". | **action**, product_id, variant_id, body, search, status |
| `printful_product_templates` | ✏️ | Product templates: list, get, delete. Use a template in orders via source=product_template. | **action**, template_id, search |
| `printful_webhooks` | ✏️ | Webhook configuration (v2): get, set (default_url + events), set_event, disable, disable_event. Events: order_created, order_updated, order_failed, order_canceled, order_put_hold, order_put_hold_approval, order_remove_hold, shipment_sent, shipment_returned, shipment_out_of_stock, shipment_canceled, shipment_put_hold, shipment_put_hold_approval, shipment_remove_hold, product_synced, product_updated, product_deleted, catalog_stock_updated, catalog_price_changed, mockup_task_finished, approval_sheet_status_changed. The secret_key returned by `set` is shown once — the owner must store it. | **action**, url, events, event_type, stock_product_ids, expires_at |
| `printful_mockups` | ✏️ | Create a mockup task (product preview with a design) and wait up to ~25 s, or get a task by id. | **action**, task_id, product_id, variant_ids, placements, mockup_style_ids, format, width |
| `printful_warehouse` | 🔒 | Printful Warehousing products: list (optional name filter) or get. | product_id, name |
| `printful_tax` | 🔒 | US sales tax: list countries/states with tax, or rate for a recipient. | **action**, recipient |
| `printful_api` | ⚠️ | Any Printful API call (v1 path or /v2/...) on api.printful.com. Use only when no dedicated tool fits. Order confirmation and design approval are blocked here; ask the user before any other mutation. | **method**, **path**, query, body |

## Skill

| Tool | | Description | Parameters |
|---|:-:|---|---|
| `printful_skill` | 🔒 | Read the printful-fulfillment skill (workflows, money rules, formats). Call before order work if the host did not load skills. path: SKILL.md, references/pricing.md, references/order-format.md, references/mapping.md | path |

