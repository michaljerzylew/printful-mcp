// Local stdio transport: `npx -y printful-mcp`. Newline-delimited JSON-RPC on stdin/stdout, logs on stderr.
// Same dispatcher, tools and skill as the HTTP server; no network listener, no API key needed (the client spawns us).

import { createInterface } from 'node:readline';
import { handleRpc, SERVER_INFO } from '../lib/mcp';

const HELP = `printful-mcp ${SERVER_INFO.version}: MCP server for Printful (stdio)

Usage: npx -y printful-mcp [--help] [--version]

Environment:
  PRINTFUL_API_TOKEN   Printful private token (required for API tools)
  PRINTFUL_STORE_ID    default store id (orders, shipping, files, webhooks)
  SKU_MAPPING_JSON     optional SKU → Printful mapping
  MAX_AUTO_CONFIRM_COST, DEFAULT_CURRENCY, DEFAULT_REGION, DEFAULT_VAT_RATE, DEFAULT_SHIPPING, PRINTFUL_LANGUAGE

Claude Desktop / Cursor config:
  { "mcpServers": { "printful": { "command": "npx", "args": ["-y", "printful-mcp"],
      "env": { "PRINTFUL_API_TOKEN": "…", "PRINTFUL_STORE_ID": "…" } } } }

Docs: ${SERVER_INFO.websiteUrl}`;

export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(SERVER_INFO.version + '\n');
    return;
  }

  // stdout is the protocol channel: anything else must go to stderr.
  console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);
  if (!env.PRINTFUL_API_TOKEN) console.error('[printful-mcp] PRINTFUL_API_TOKEN is not set: only offline tools (calculators, dry runs, skill) will work.');

  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const pending = new Set<Promise<void>>();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const msgs: any[] = Array.isArray(parsed) ? parsed : [parsed];
    const task = (async () => {
      const out = [];
      for (const m of msgs) {
        if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') {
          out.push({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
          continue;
        }
        if (typeof m.method !== 'string') continue; // response to a server request: nothing to do
        const r = await handleRpc(m, env as Record<string, unknown>);
        if (r) out.push(r);
      }
      if (out.length) send(Array.isArray(parsed) ? out : out[0]);
    })().catch((e) => console.error('[printful-mcp] internal error:', e));
    pending.add(task);
    task.finally(() => pending.delete(task));
  });

  await new Promise<void>((resolve) => rl.on('close', resolve));
  await Promise.allSettled([...pending]);
}
