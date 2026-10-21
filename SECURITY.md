# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
[security advisory form](https://github.com/michaljerzylew/printful-mcp/security/advisories/new).
You will get an acknowledgement within 72 hours and a fix or mitigation plan within 14 days for confirmed issues.

## Scope

In scope: authentication bypass, leaking `PRINTFUL_API_TOKEN` or `MCP_API_KEY`, requests escaping `api.printful.com`,
confirming or paying for an order without the `max_cost` gate, injection through order or mapping data.

Out of scope: risks that require an attacker to already hold a valid `MCP_API_KEY` (treat the key like the Printful token itself),
and Printful API behaviour.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ |
