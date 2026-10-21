# SKU mapping

A mapping translates shop SKUs to Printful items. Pass it as `mapping` to `printful_fulfill_shop_order`, or let the owner store it in the Site secret `SKU_MAPPING_JSON`.

```json
{
  "skus": {
    "TEE-LOGO-BLK-M": {
      "catalog_variant_id": 4017,
      "placements": [{"placement": "front", "technique": "dtg",
                      "layers": [{"type": "file", "url": "https://cdn.example.com/designs/logo.png"}]}]
    },
    "TEE-CUSTOM-BLK-{size}": {
      "catalog_variant_id": {"S": 4016, "M": 4017, "L": 4018, "XL": 4019},
      "variant_key": "size",
      "placements": [
        {"placement": "front", "technique": "dtg", "layers": [{"type": "file", "url": "{custom.front_url}"}]},
        {"placement": "label_inside", "technique": "dtg", "layers": [{"type": "file", "url": "https://cdn.example.com/brand/label.png"}]}
      ]
    },
    "CAP-EMB-{color}": {
      "catalog_variant_id": {"BLK": 7854, "NAVY": 7857},
      "variant_key": "color",
      "placements": [{"placement": "embroidery_front", "technique": "embroidery",
                      "layers": [{"type": "file", "url": "{custom.logo_url}"}]}],
      "product_options": [{"name": "notes", "value": "{custom.notes}"}],
      "optional": ["custom.notes"]
    },
    "MUG-TEMPLATE": {"product_template_id": 123456, "catalog_variant_id": 1320}
  }
}
```

Rules:
- Exact SKU match first, then patterns. `{name}` captures a segment; `variant_key` picks the variant from the captured value.
- Placeholders: `{custom.X}`, `{meta.X}`, `{item.X}`, `{order.X}`. A missing value is an error unless listed in `optional` (then the option is dropped).
- Catalog items need at least one placement with a file layer.
- Verify variant ids with `printful_catalog_variants` before relying on a mapping.
