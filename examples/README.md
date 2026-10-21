# Examples

| File | Use |
|---|---|
| `shop-order.json` | Canonical shop order with a customer's own design (T-shirt) and an embroidery note (cap). |
| `sku-mapping.json` | Mapping for those SKUs: size and color patterns, `{custom.*}` placeholders, inside label, optional notes. |

Ask your agent:

> Dry-run this shop order with this mapping using printful_fulfill_shop_order, then estimate it.

Or put the mapping into the `SKU_MAPPING_JSON` secret, and every order only needs `shop_order`.
