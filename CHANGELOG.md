# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-10-22

Makes ChatGPT plugins and ChatGPT Sites self-install work out of the box. These fixes come from a real installation
(deployed and connected as an internal 2.0.1 build).

### Added
- **Per-user OAuth endpoint `/api/printful/mcp`.** OAuth 2.1 with dynamic client registration and PKCE S256. A connection
  screen asks for the user's Printful token, validates it with Printful and stores it AES-GCM-encrypted per grant in D1.
  ChatGPT only receives connector tokens. Refresh-token rotation, revocation and rate limits are included. Tools advertise
  `securitySchemes`, and auth failures return `mcp/www_authenticate` so ChatGPT re-prompts.
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/api/printful/mcp`.
- D1 schema (`drizzle/` for ChatGPT Sites, `migrations/0001_oauth.sql` for wrangler), and `.openai/hosting.json` now declares the `DB` binding.
- `PUBLIC_ORIGIN`, `CONNECTOR_ENCRYPTION_KEY`, `OAUTH_REDIRECT_ORIGINS` (ChatGPT by default, Claude optional).
- Plugin manifest template in `plugin/`.
- Clear errors for design files Printful cannot fetch: files on `printful.com` or `files.cdn.printful.com` (Printful answers
  *"file URL is not a valid URL"*), non-http(s) URLs and local hosts. Checked before any order, estimate, mockup or file call.

### Fixed
- ChatGPT's `ui_locales=pl-PL` (and any unknown optional parameter) no longer breaks authorization with *"Unsupported
  authorization parameter"* (RFC 6749 §3.1). Duplicate parameters are still rejected.
- Docs: the plugin Sites auto-creates points at `/mcp`, which needs an API key ChatGPT cannot send. ChatGPT must connect the
  OAuth endpoint.

### Security
- An independent review of the OAuth code found 7 issues before release. All are fixed and covered by tests:
  - tenant isolation: operator settings such as `MAX_AUTO_CONFIRM_COST`, packing slip and SKU mapping no longer apply to OAuth users;
  - no module-level origin state (cross-request audience mix-ups);
  - per-grant rather than per-IP limits for ChatGPT traffic;
  - indexed, sampled cleanup instead of full scans;
  - code-replay and refresh-reuse revocation;
  - `access_denied` redirect on decline;
  - canonical-origin consent.
- Everything from the 1.0 review is preserved: fail-closed money gate, path and id validation, egress pinned to
  api.printful.com, no identity-header trust.
- 33 new tests (115 total) plus a workerd + D1 runtime test of the full OAuth flow.

## [1.1.0] - 2026-10-21

### Added
- **Local stdio mode:** `npx -y @michaljerzylew/printful-mcp`, for Claude Desktop, Cursor, Claude Code and any stdio MCP client.
  It needs no server and no deploy. It is a single bundled file (~33 kB, zero runtime dependencies, Node ≥ 18) with the same 44 tools, skill
  and money gate as the hosted server.
- `--help` / `--version` flags; a missing token is reported as a tool error, and offline tools keep working.
- Published to npm with provenance from GitHub Actions; release assets include the CLI tarball.
- End-to-end tests for the stdio CLI (82 tests total).

### Changed
- Runtime packages of the hosted build moved to `devDependencies`, so the npm package installs nothing.

## [1.0.0] - 2026-10-21

### Added
- MCP server (Streamable HTTP, stateless) for the Printful API v2 + v1 on Cloudflare Workers / ChatGPT Sites.
- 44 tools covering catalog, pricing, shipping, exact estimates, retail/margin calculator, quotes, orders, items, confirmation,
  cancellation, shipments, invoices, files, store products, product templates, webhooks, mockups, warehouse, approval sheets,
  US tax, statistics and a guarded raw API call.
- Shop-order fulfillment with SKU mapping (patterns, placeholders for customer designs, optional fields), idempotent by order number,
  drafts by default and a server-enforced `max_cost` gate on confirmation.
- Skill `printful-fulfillment` served through the MCP Skills extension (SEP-2640) with SHA-256 manifests, plus resources, a tool,
  server instructions and an uploadable zip.
- Bearer / X-API-Key auth with key rotation, optional ChatGPT Sites e-mail allow-list.
- Prompts `fulfill_order` and `price_product`.
- Unit tests, live smoke test, CI and release workflows.

[1.2.0]: https://github.com/michaljerzylew/printful-mcp/releases/tag/v1.2.0
[1.1.0]: https://github.com/michaljerzylew/printful-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/michaljerzylew/printful-mcp/releases/tag/v1.0.0
