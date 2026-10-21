// End-to-end smoke test against a running server: node scripts/smoke.mjs [baseUrl] [apiKey] [--offline]
// Read-only Printful calls + shop-order dry run. Never creates or confirms orders.
// --offline skips every check that needs a Printful token (used in CI).
import { createHash } from 'node:crypto';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const OFFLINE = process.argv.includes('--offline'); // protocol-only checks, no Printful token needed (CI)
const BASE = args[0] ?? process.env.MCP_URL ?? 'http://127.0.0.1:8787';
const KEY = args[1] ?? process.env.MCP_API_KEY ?? '';
let id = 0;
let failed = 0;

async function rpc(method, params = {}, key = KEY) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
}
async function call(name, args = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  if (body.error) throw new Error(JSON.stringify(body.error));
  const res = body.result;
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  if (!cond) failed++;
}
async function step(label, fn) {
  try {
    await fn();
  } catch (e) {
    check(label, false, String(e.message ?? e).slice(0, 300));
  }
}

await step('auth rejects missing key', async () => {
  const r = await rpc('tools/list', {}, '');
  check('auth rejects missing key', r.status === 401);
});
await step('initialize', async () => {
  const { body } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  check('initialize', body.result.serverInfo.name === 'printful-mcp' && body.result.capabilities.extensions['io.modelcontextprotocol/skills'], body.result.protocolVersion);
});
await step('server/discover', async () => {
  const { body } = await rpc('server/discover');
  check('server/discover declares resources + skills ext', !!body.result.capabilities.resources && !!body.result.capabilities.extensions['io.modelcontextprotocol/skills']);
});
let skills;
await step('skills/list', async () => {
  const { body } = await rpc('skills/list');
  skills = body.result.skills;
  check('skills/list', body.result.resultType === 'complete' && skills[0].uri === 'skill://printful-fulfillment/SKILL.md' && body.result.ttlMs > 0, `${skills.length} skill(s), ${skills[0].resources.length} files`);
});
await step('skills digests', async () => {
  for (const res of skills[0].resources) {
    const { body } = await rpc('resources/read', { uri: res.uri });
    const buf = Buffer.from(body.result.contents[0].text, 'utf8');
    const ok = buf.length === res.size && 'sha256:' + createHash('sha256').update(buf).digest('hex') === res.digest;
    check(`digest+size ${res.uri}`, ok);
  }
});
await step('skills/get + unknown', async () => {
  const ok = await rpc('skills/get', { uri: 'skill://printful-fulfillment/SKILL.md' });
  const bad = await rpc('skills/get', { uri: 'skill://nope/SKILL.md' });
  check('skills/get known/unknown(-32602)', ok.body.result.skill.frontmatter.name === 'printful-fulfillment' && bad.body.error.code === -32602);
});
await step('directory read', async () => {
  const { body } = await rpc('resources/directory/read', { uri: 'skill://printful-fulfillment/references' });
  check('resources/directory/read', body.result.resources.length === 3);
});
let tools;
await step('tools/list', async () => {
  const { body } = await rpc('tools/list');
  tools = body.result.tools;
  check('tools/list', tools.length >= 35, `${tools.length} tools`);
});
if (!OFFLINE) await step('whoami', async () => {
  const w = await call('printful_whoami');
  check('printful_whoami (live)', w.scopes.includes('orders') && w.stores.length >= 1, `stores=${w.stores.map((s) => s.id)}`);
});
if (!OFFLINE) await step('catalog search', async () => {
  const r = await call('printful_catalog_search', { query: '3001', limit: 5 });
  check('printful_catalog_search', r.some((p) => p.id === 71));
});
if (!OFFLINE) await step('variants', async () => {
  const r = await call('printful_catalog_variants', { product_id: 71, color: 'Black', size: 'M' });
  check('printful_catalog_variants', r[0].id === 4017);
});
if (!OFFLINE) await step('calc cost', async () => {
  const r = await call('printful_calc_cost', { variant_id: 4017, placements: [{ placement: 'front', technique: 'dtg' }, { placement: 'back', technique: 'dtg' }] });
  check('printful_calc_cost front+back', r.unit_cost === '15.75', `${r.unit_cost} ${r.currency}`);
});
if (!OFFLINE) await step('shipping', async () => {
  const r = await call('printful_shipping_rates', { recipient: { country_code: 'PL' }, items: [{ catalog_variant_id: 4017, quantity: 1 }] });
  check('printful_shipping_rates PL', Number(r[0].rate) > 0, `${r[0].shipping} ${r[0].rate} ${r[0].currency}`);
});
if (!OFFLINE) await step('quote', async () => {
  const r = await call('printful_quote', { variant_id: 4017, placements: [{ placement: 'front', technique: 'dtg' }], country_code: 'PL', target_margin_pct: 45, include_shipping: true });
  check('printful_quote', !!r.shipping && Number(r.retail_per_unit.margin_pct) >= 45, `gross ${r.retail_per_unit.price_gross}`);
});
await step('retail', async () => {
  const r = await call('printful_calc_retail', { cost: 10, markup_pct: 100, vat_rate: 0, round_to: null });
  check('printful_calc_retail', r.price_gross === '20.00');
});
const shopOrder = {
  id: 'SMOKE-1',
  recipient: { name: 'Anna Nowak', address1: 'Marszalkowska 10', city: 'Warszawa', zip: '00-001', country_code: 'PL' },
  items: [{ id: 'L1', sku: 'TEE-CUSTOM-BLK-M', quantity: 1, price: '34.99', custom: { front_url: 'https://picsum.photos/id/237/3000/3000.jpg' } }],
  gift: { subject: 'Hi', message: 'Enjoy' },
};
const mapping = {
  skus: {
    'TEE-CUSTOM-BLK-{size}': {
      catalog_variant_id: { S: 4016, M: 4017, L: 4018 },
      variant_key: 'size',
      placements: [{ placement: 'front', technique: 'dtg', layers: [{ type: 'file', url: '{custom.front_url}' }] }],
    },
  },
};
await step('fulfill dry run', async () => {
  const r = await call('printful_fulfill_shop_order', { shop_order: shopOrder, mapping, dry_run: true });
  check('printful_fulfill_shop_order dry_run', r.status === 'dry_run' && r.request.order_items[0].catalog_variant_id === 4017 && r.request.order_items[0].placements[0].layers[0].url.includes('picsum'));
});
if (!OFFLINE) await step('estimate from shop order', async () => {
  const r = await call('printful_estimate_order', { shop_order: shopOrder, mapping });
  check('printful_estimate_order (live)', Number(r.costs.total) > 0, `${r.api} total ${r.costs.total} ${r.costs.currency}`);
});
await step('mapping error', async () => {
  const { body } = await rpc('tools/call', { name: 'printful_fulfill_shop_order', arguments: { shop_order: { ...shopOrder, items: [{ sku: 'TEE-CUSTOM-BLK-M' }] }, mapping, dry_run: true } });
  check('missing personalisation → tool error', body.result.isError && body.result.content[0].text.includes('custom.front_url'));
});
if (!OFFLINE) await step('lists', async () => {
  await call('printful_orders_list', { limit: 5 });
  await call('printful_webhooks', { action: 'get' });
  await call('printful_store_products', { action: 'list' });
  await call('printful_product_templates', { action: 'list' });
  check('orders/webhooks/products/templates read', true);
});
await step('safety gates', async () => {
  const bad = async (name, args) => {
    const { body } = await rpc('tools/call', { name, arguments: args });
    return body.result?.isError === true || body.result?.structuredContent?.status === 'held';
  };
  check('crafted order_id rejected', await bad('printful_order_items', { order_id: '1/confirmation?', action: 'add', item: {} }));
  check('printful_api confirmation blocked', await bad('printful_api', { method: 'POST', path: '/v2/orders/1/confirmation' }));
  check('printful_api absolute URL blocked', await bad('printful_api', { method: 'GET', path: 'http\t://example.com/x' }));
  {
    const { body } = await rpc('tools/call', { name: 'printful_confirm_order', arguments: { order_id: '0' } });
    check('confirm without max_cost held before any API call', body.result?.structuredContent?.status === 'held' && /max_cost/.test(body.result.structuredContent.reason));
  }
  check('unsafe shop order id rejected', await bad('printful_fulfill_shop_order', { shop_order: { ...shopOrder, id: 'A/1' }, mapping, dry_run: true }));
});
await step('skill tool', async () => {
  const { body } = await rpc('tools/call', { name: 'printful_skill', arguments: { path: 'references/pricing.md' } });
  check('printful_skill tool', body.result.content[0].text.startsWith('# Pricing'));
});
await step('prompts', async () => {
  const { body } = await rpc('prompts/get', { name: 'price_product', arguments: { product: 'black tee M' } });
  check('prompts/get', body.result.messages[0].content.text.includes('black tee M'));
});
await step('notification 202', async () => {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  check('notification → 202', r.status === 202);
});

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
