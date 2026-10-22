# Connecting MCP clients

Two ways to run it:

- **Local stdio:** `npx -y @michaljerzylew/printful-mcp`. The client starts the process, so no server and no `MCP_API_KEY` are needed. Configure it with environment variables.
- **Hosted:** Streamable HTTP at `POST /mcp` (stateless, JSON responses). The key goes in `Authorization: Bearer <key>`, `X-API-Key: <key>` or `?key=<key>`.

## Local (stdio): Claude Desktop, Cursor, Windsurf, VS Code, Zed

```json
{
  "mcpServers": {
    "printful": {
      "command": "npx",
      "args": ["-y", "@michaljerzylew/printful-mcp"],
      "env": {
        "PRINTFUL_API_TOKEN": "<your Printful token>",
        "PRINTFUL_STORE_ID": "<your store id>",
        "MAX_AUTO_CONFIRM_COST": "100"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add printful -e PRINTFUL_API_TOKEN=<token> -e PRINTFUL_STORE_ID=<id> -- npx -y @michaljerzylew/printful-mcp
```

Before the npm registry release, use the GitHub release tarball in `args`:
`["-y", "--package=https://github.com/michaljerzylew/printful-mcp/releases/download/v1.2.0/printful-mcp-cli-1.2.0.tgz", "printful-mcp"]`.

`npx -y @michaljerzylew/printful-mcp --help` lists every supported variable. Logs go to stderr; stdout carries only protocol messages.

## Hosted (HTTP)

### ChatGPT

See [deploy-chatgpt-sites.md](deploy-chatgpt-sites.md#3-connect-to-chatgpt). Works with any public HTTPS host, not only Sites.

### Claude Code

```bash
claude mcp add --transport http printful https://<your-host>/mcp \
  --header "Authorization: Bearer <MCP_API_KEY>"
```

### claude.ai (custom connector)

Settings → Connectors → **Add custom connector** → URL `https://<your-host>/mcp?key=<MCP_API_KEY>`.

### Cursor / Windsurf / VS Code (remote)

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

### Programmatic (MCP TypeScript SDK)

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

### Raw JSON-RPC (curl)

```bash
curl -s https://<your-host>/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"printful_calc_cost","arguments":{"variant_id":4017,"placements":[{"placement":"front","technique":"dtg"}]}}}'
```
