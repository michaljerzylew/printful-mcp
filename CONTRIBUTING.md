# Contributing

Thanks for helping improve Printful MCP.

## Setup

```bash
npm ci
cp .env.example .dev.vars   # a Printful token with a test store is enough
npm run check               # typecheck + unit tests
npm run build && cp .dev.vars dist/server/ && npm start
npm run smoke -- http://127.0.0.1:8787 <MCP_API_KEY>
```

## Guidelines

- **One tool, one job.** New tools need a precise `description`, a JSON Schema with descriptions on every field, and correct
  `annotations` (`readOnlyHint` for reads, `destructiveHint` for anything that charges, deletes or cancels).
- **Never weaken the money gate.** Any path that can submit an order for production must require `max_cost`.
- **Match the Printful OpenAPI.** Link the endpoint you use in the PR description.
- **Skill changes** go in `skills/printful-fulfillment/`. `npm run build` re-embeds them with fresh digests.
- Add or update tests in `test/` for logic changes. The smoke test must stay read-only.
- Changed a tool? Regenerate the reference: `UPDATE_DOCS=1 npx vitest run test/docs.test.ts` (CI fails if `docs/tools.md` is stale).
- Conventional commits (`feat:`, `fix:`, `docs:` …) are appreciated.

## Releasing

Update `CHANGELOG.md` and the version in `package.json` and `lib/mcp.ts`, then tag `vX.Y.Z`. The release workflow verifies
the version, builds the deploy zip, the skill zip and the CLI tarball, and publishes to npm with provenance when the
`NPM_TOKEN` repository secret is set.
