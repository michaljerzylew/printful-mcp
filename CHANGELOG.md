# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

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

[1.1.0]: https://github.com/michaljerzylew/printful-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/michaljerzylew/printful-mcp/releases/tag/v1.0.0
