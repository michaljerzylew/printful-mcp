# Security model

Printful MCP can spend money (confirmed orders are charged to your Printful balance) and touches customer addresses.
These are the safeguards and their limits.

## Authentication

- Every `POST /mcp` must carry a valid key (`Authorization: Bearer`, `X-API-Key` or `?key=`). Keys are compared in constant time.
- `?key=` exists for connectors that cannot send headers. URLs end up in access logs and browser history, so prefer headers
  and set `ALLOW_QUERY_KEY=false` when you can.
- `MCP_API_KEYS` accepts a comma-separated list, so you can rotate without downtime.
- **Identity headers are ignored by default.** On a restricted ChatGPT Site you can set `TRUST_SITES_IDENTITY=true` together
  with `ALLOWED_EMAILS` to admit users Sites has signed in (`oai-authenticated-user-email`). Anywhere else this header can be
  forged by any client, so never enable it outside Sites.
- Browser requests must come from an allowed `Origin` (`ALLOWED_ORIGINS`) as DNS-rebinding protection. Non-browser clients send no Origin.
- With no key configured, the server rejects all MCP calls.
- `/healthz` reports only booleans, never values. `/` lists tools and skills, which are public information.

## Money gate

| Path | Behaviour |
|---|---|
| `printful_create_order`, `printful_fulfill_shop_order` (default) | Creates a **draft**. Nothing is charged. |
| `printful_fulfill_shop_order` with `confirm: true` | Requires `max_cost` (or `MAX_AUTO_CONFIRM_COST`). Returns `conflict` when the order number belongs to a different order. |
| `printful_confirm_order` | `max_cost` is required and checked against the live order total. Only drafts are confirmed. |
| `printful_api` | Generic escape hatch (`destructiveHint`). Blocks `/v2/orders/*/confirmation`, `/orders/*/confirm`, `confirm=true` on v1 create/update, and design approval. |
| `printful_approval_sheets` approve | Marked destructive: approving a design releases production. |

All three gates are **fail-closed**: a missing, non-numeric or non-positive `max_cost`, costs still calculating, a missing total
or a currency mismatch all hold the order. `printful_confirm_order` checks `max_cost` before it even reads the order.

The skill and server instructions tell the model to confirm only after explicit user consent. MCP clients that honour
`destructiveHint` will also ask before running these tools.

## Request integrity

- Requests go only to `https://api.printful.com`. The client refuses absolute URLs, control characters, `?`, `#` and dot segments in paths,
  and verifies the final origin before sending.
- Every id interpolated into a path must match `^@?[A-Za-z0-9_-]{1,64}$`, so an `order_id` like `123/confirmation?` cannot reroute a call.
- Shop order numbers become `external_id` verbatim (`^[A-Za-z0-9_-]{1,32}$`). When an existing order with the same number has
  a different recipient or item count, the tool returns `conflict` instead of confirming it.
- SKU mapping only reads own properties, so `{custom.toString}` or a SKU named `constructor` cannot pull values from the prototype.
  SKU patterns are compiled from a strict grammar.

## Data handling

- The server is stateless: it stores no orders, addresses or files. Requests go only to `https://api.printful.com`.
- Tool results can contain customer addresses (order details). Your MCP client and model provider see what the agent reads.
- Design files must be public URLs, because Printful downloads them. Use unguessable URLs or short-lived signed URLs for customer uploads.

## Hardening checklist

- [ ] Generate `MCP_API_KEY` with `openssl rand -hex 32`. Never reuse the Printful token.
- [ ] Keep the deployment private (ChatGPT Sites audience: only you or your workspace).
- [ ] Set `ALLOW_QUERY_KEY=false` if every client can send headers.
- [ ] Use a Printful token scoped to what you need.
- [ ] Set `MAX_AUTO_CONFIRM_COST` to a sane ceiling.
- [ ] Rotate keys if a connector URL containing `?key=` was ever shared.
