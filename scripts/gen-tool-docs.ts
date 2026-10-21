// Builds docs/tools.md from the live tool registry. Run: UPDATE_DOCS=1 npx vitest run test/docs.test.ts
import { writeFileSync } from 'node:fs';
import { handleRpc } from '../lib/mcp';

const GROUPS: [string, string[]][] = [
  ['Account & store', ['whoami', 'stores_list', 'store_get', 'store_statistics', 'store_packing_slip']],
  ['Catalog', ['catalog_search', 'catalog_product', 'catalog_variants', 'catalog_categories', 'catalog_prices', 'catalog_sizes', 'catalog_availability', 'catalog_images', 'catalog_shipping_countries', 'catalog_mockup_templates', 'catalog_mockup_styles', 'catalog_printfiles', 'countries']],
  ['Pricing & quoting', ['calc_cost', 'shipping_rates', 'estimate_order', 'calc_retail', 'quote']],
  ['Fulfillment & orders', ['fulfill_shop_order', 'orders_list', 'get_order', 'create_order', 'update_order', 'confirm_order', 'delete_order', 'cancel_order', 'order_items', 'order_shipments', 'order_invoice', 'approval_sheets']],
  ['Files, products, templates, webhooks, mockups', ['files', 'store_products', 'product_templates', 'webhooks', 'mockups', 'warehouse', 'tax', 'api']],
  ['Skill', ['skill']],
];

export async function generate(): Promise<string> {
  const { tools } = (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}))!.result;
  const byName = new Map<string, any>(tools.map((t: any) => [t.name, t]));
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  let out = `# Tool reference\n\nGenerated from the server's \`tools/list\` (${tools.length} tools). Results are JSON in \`content[0].text\`, mirrored in \`structuredContent\`.\nErrors come back as tool results with \`isError: true\` and a hint.\n\nLegend: 🔒 read-only · ✏️ writes · ⚠️ destructive or money-moving (clients should ask first). **Bold** = required. \`store_id\` is optional everywhere and defaults to \`PRINTFUL_STORE_ID\`.\n\n`;
  const seen = new Set<string>();
  for (const [title, names] of GROUPS) {
    out += `## ${title}\n\n| Tool | | Description | Parameters |\n|---|:-:|---|---|\n`;
    for (const n of names) {
      const t = byName.get(`printful_${n}`);
      if (!t) throw new Error(`missing printful_${n}`);
      seen.add(t.name);
      const a = t.annotations ?? {};
      const icon = a.destructiveHint ? '⚠️' : a.readOnlyHint ? '🔒' : '✏️';
      const req: string[] = t.inputSchema.required ?? [];
      const props = Object.keys(t.inputSchema.properties ?? {}).filter((p) => p !== 'store_id');
      out += `| \`${t.name}\` | ${icon} | ${cell(t.description)} | ${props.map((p) => (req.includes(p) ? `**${p}**` : p)).join(', ') || '—'} |\n`;
    }
    out += '\n';
  }
  const missing = tools.map((t: any) => t.name).filter((n: string) => !seen.has(n));
  if (missing.length) throw new Error(`undocumented tools: ${missing}`);
  return out;
}
