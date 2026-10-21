# Canonical shop order

```json
{
  "id": "SHOP-1001",
  "currency": "EUR",
  "shipping_method": "STANDARD",
  "recipient": {
    "name": "Anna Nowak", "address1": "ul. Marszałkowska 10/5", "city": "Warszawa",
    "zip": "00-001", "country_code": "PL", "phone": "+48500100200", "email": "anna@example.com"
  },
  "items": [
    {"id": "L1", "sku": "TEE-CUSTOM-BLK-M", "quantity": 1, "price": "34.99",
     "name": "T-shirt with your photo", "custom": {"front_url": "https://cdn.example.com/u/anna-dog.png"}},
    {"id": "L2", "sku": "CAP-EMB-NAVY", "quantity": 2, "price": "24.99",
     "custom": {"logo_url": "https://cdn.example.com/u/logo.png", "notes": "Gold thread"}}
  ],
  "totals": {"shipping": "4.99", "discount": "0", "tax": "0"},
  "gift": {"subject": "For you", "message": "Happy birthday!"},
  "packing_slip": {"message": "Thank you!", "store_name": "My Shop"}
}
```

Required: `id`, `recipient.name`, `address1`, `city`, `country_code`, `zip` (except IE/HK/AE), `state_code` for US/CA/AU, and at least one item with `sku`.

`id` → Printful `external_id` (used verbatim; must match `^[A-Za-z0-9_-]{1,32}$`, otherwise the order is rejected) and packing slip `custom_order_id`.
`totals` → `retail_costs` (shown on customs docs for international shipments).
`price` per item → `retail_price`.

## Resulting Printful v2 order item

```json
{"source": "catalog", "catalog_variant_id": 4017, "quantity": 1, "external_id": "L1", "retail_price": "34.99",
 "placements": [{"placement": "front", "technique": "dtg",
   "layers": [{"type": "file", "url": "https://cdn.example.com/u/anna-dog.png",
               "position": {"width": 10, "height": 10, "top": 2, "left": 1}}]}]}
```

`position` is in inches inside the print area; omit it to centre automatically.
Other sources: `{"source": "product_template", "product_template_id": 123, "catalog_variant_id": 4017}` and warehouse items `{"source": "catalog", "warehouse_variant_id": 9}`.
