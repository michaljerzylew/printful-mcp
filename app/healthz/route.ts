import { env } from 'cloudflare:workers';
import { SERVER_INFO } from '@/lib/mcp';

export const dynamic = 'force-dynamic';

export function GET() {
  const e = env as unknown as Record<string, unknown>;
  return Response.json({
    ok: true,
    server: SERVER_INFO,
    configured: {
      printful_token: Boolean(e.PRINTFUL_API_TOKEN),
      store_id: Boolean(e.PRINTFUL_STORE_ID),
      mcp_api_key: Boolean(e.MCP_API_KEY || e.MCP_API_KEYS),
      sku_mapping: Boolean(e.SKU_MAPPING_JSON),
    },
  });
}
