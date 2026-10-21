# Connecting MCP clients

The server speaks **Streamable HTTP** at `POST /mcp` (stateless, JSON responses) and accepts the key as
`Authorization: Bearer <key>`, `X-API-Key: <key>` or `?key=<key>`.

## ChatGPT

See [deploy-chatgpt-sites.md](deploy-chatgpt-sites.md#3-connect-to-chatgpt). Works with any public HTTPS host, not only Sites.

## Claude Code

```bash
claude mcp add --transport http printful https://<your-host>/mcp \
  --header "Authorization: Bearer <MCP_API_KEY>"
```

## Claude Desktop / claude.ai (custom connector)

Settings → Connectors → **Add custom connector** → URL `https://<your-host>/mcp?key=<MCP_API_KEY>`.

For stdio-only builds, bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "printful": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-host>/mcp", "--header", "Authorization: Bearer ${PRINTFUL_MCP_KEY}"],
      "env": { "PRINTFUL_MCP_KEY": "<MCP_API_KEY>" }
    }
  }
}
```

## Cursor / Windsurf / VS Code

```json
{
  "mcpServers": {
    "printful": {
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer <MCP_API_KEY>" }
    }
  }
}
```

## Programmatic (MCP TypeScript SDK)

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('https://<your-host>/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_API_KEY}` } },
});
const client = new Client({ name: 'my-shop', version: '1.0.0' });
await client.connect(transport);

const quote = await client.callTool({
  name: 'printful_quote',
  arguments: { variant_id: 4017, placements: [{ placement: 'front', technique: 'dtg' }], country_code: 'DE', target_margin_pct: 40, vat_rate: 0.19 },
});
```

## Raw JSON-RPC (curl)

```bash
curl -s https://<your-host>/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"printful_calc_cost","arguments":{"variant_id":4017,"placements":[{"placement":"front","technique":"dtg"}]}}}'
```
