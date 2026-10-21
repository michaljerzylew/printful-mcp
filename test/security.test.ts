import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorize, handleHttp, originAllowed } from '../lib/mcp';
import { assertSafePath, externalId, pathId, Printful } from '../lib/printful';
import { isConfirmationCall, moneyGate, sameOrderMismatch, TOOLS } from '../lib/tools';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const req = (headers: Record<string, string> = {}, url = 'https://mcp.example.com/mcp') =>
  new Request(url, { method: 'POST', headers, body: '{}' });

afterEach(() => vi.restoreAllMocks());

describe('egress stays on api.printful.com (SSRF)', () => {
  it.each(['http\t://evil.com/x', 'http\n://evil.com', 'https://evil.com', '//evil.com/x', '/v2/../../x', '/v2/orders?confirm=true', '/v2/a#b', 'v2/orders'])(
    'rejects %j',
    async (path) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(new Printful('tok').request('GET', path)).rejects.toThrow(/unsafe|outside/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(() => assertSafePath(path)).toThrow();
    },
  );

  it('accepts normal API paths', () => {
    expect(assertSafePath('/v2/catalog-products/71/sizes')).toBe('/v2/catalog-products/71/sizes');
    expect(assertSafePath('/v2/orders/@SHOP-1')).toBe('/v2/orders/@SHOP-1');
  });
});

describe('path ids cannot redirect requests', () => {
  it.each(['123/confirmation?', '../../orders/1/confirm?', '1?x=1', '1#a', 'a b', '', '@'])('rejects %j', (id) => {
    expect(() => pathId(id)).toThrow();
  });
  it.each(['123', '@SHOP-1001', 'abc_DEF-9'])('accepts %j', (id) => expect(pathId(id)).toBe(id));

  it('order_items add with a crafted order_id never reaches the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const pf = new Printful('tok', '1');
    await expect(tool('printful_order_items').run({ order_id: '123/confirmation?', action: 'add', item: {} }, { pf, env: {} })).rejects.toThrow();
    await expect(tool('printful_store_products').run({ action: 'add_variant', product_id: '../../orders/1/confirm?', body: {} }, { pf, env: {} })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('money gate fails closed', () => {
  const draft = (total: unknown, extra: object = {}) => ({ status: 'draft', costs: { calculation_status: 'done', total, currency: 'USD', ...extra } });

  it.each([undefined, null, '', 'abc', NaN, 0, -5])('holds when max_cost is %j', (max) => {
    expect(moneyGate(draft('10.00'), max)).toMatch(/max_cost/);
  });
  it('holds while costs are calculating', () => expect(moneyGate(draft('10', { calculation_status: 'calculating' }), 50)).toMatch(/calculating/));
  it('holds when total is missing', () => expect(moneyGate({ costs: { calculation_status: 'done' } }, 50)).toMatch(/total/));
  it('holds above the ceiling', () => expect(moneyGate(draft('60.01'), 60)).toMatch(/exceeds/));
  it('holds on currency mismatch', () => expect(moneyGate(draft('10'), 50, 'EUR')).toMatch(/USD/));
  it('passes within the ceiling', () => expect(moneyGate(draft('59.99'), '60', 'usd')).toBeNull());

  it('printful_confirm_order without a numeric max_cost never confirms', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u: any, init: any) => {
      calls.push(`${init.method} ${new URL(u).pathname}`);
      return Response.json({ data: { id: 5, status: 'draft', costs: { calculation_status: 'done', total: '30.00', currency: 'USD' } } });
    });
    const r = await tool('printful_confirm_order').run({ order_id: '5', max_cost: 'lots' }, { pf: new Printful('tok', '1'), env: {} });
    expect(r.status).toBe('held');
    expect(calls).toEqual([]);
  });
});

describe('printful_api cannot confirm', () => {
  it.each([
    ['POST', '/v2/orders/1/confirmation', {}, {}],
    ['POST', '/orders/1/confirm', {}, {}],
    ['POST', '/orders', { confirm: 'true' }, {}],
    ['PUT', '/orders/9', {}, { confirm: true }],
    ['POST', '/approval-sheets', {}, {}],
  ])('%s %s is blocked', (m, p, q, b) => expect(isConfirmationCall(m, p, q, b)).toBe(true));

  it('allows reads and drafts', () => {
    expect(isConfirmationCall('GET', '/v2/orders/1', {}, {})).toBe(false);
    expect(isConfirmationCall('POST', '/v2/orders', {}, {})).toBe(false);
  });

  it('tool refuses before any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(tool('printful_api').run({ method: 'POST', path: '/v2/orders/1/confirmation' }, { pf: new Printful('t'), env: {} })).rejects.toThrow(/cannot confirm/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('idempotency keys', () => {
  it('rejects ids that would be rewritten or truncated', () => {
    expect(() => externalId('A/1')).toThrow();
    expect(() => externalId('#1001')).toThrow();
    expect(() => externalId('x'.repeat(33))).toThrow();
    expect(externalId('SHOP-1001')).toBe('SHOP-1001');
  });
  it('detects a different order behind the same external_id', () => {
    const existing = { recipient: { name: 'Anna', country_code: 'PL', zip: '00-001' }, order_items: [{ quantity: 1 }] };
    expect(sameOrderMismatch(existing, { recipient: { name: 'Bob', country_code: 'PL' }, order_items: [{ quantity: 1 }] })).toMatch(/name/);
    expect(sameOrderMismatch(existing, { recipient: { name: 'anna', country_code: 'pl', zip: '00-001' }, order_items: [{ quantity: 1 }] })).toBeNull();
  });
});

describe('authentication', () => {
  const env = { MCP_API_KEY: 'k'.repeat(32), ALLOWED_EMAILS: 'owner@example.com' };

  it('accepts bearer, x-api-key and ?key=', () => {
    expect(authorize(req({ authorization: `Bearer ${'k'.repeat(32)}` }), env).ok).toBe(true);
    expect(authorize(req({ 'x-api-key': 'k'.repeat(32) }), env).ok).toBe(true);
    expect(authorize(req({}, `https://h/mcp?key=${'k'.repeat(32)}`), env).ok).toBe(true);
  });
  it('rejects wrong keys and query keys when disabled', () => {
    expect(authorize(req({ authorization: 'Bearer nope' }), env).ok).toBe(false);
    expect(authorize(req({}, `https://h/mcp?key=${'k'.repeat(32)}`), { ...env, ALLOW_QUERY_KEY: 'false' }).ok).toBe(false);
  });
  it('ignores a forged ChatGPT identity header unless TRUST_SITES_IDENTITY=true', () => {
    expect(authorize(req({ 'oai-authenticated-user-email': 'owner@example.com' }), env).ok).toBe(false);
    expect(authorize(req({ 'oai-authenticated-user-email': 'owner@example.com' }), { ...env, TRUST_SITES_IDENTITY: 'true' }).ok).toBe(true);
  });
  it('refuses to run unconfigured', () => expect(authorize(req({ authorization: 'Bearer x' }), {}).ok).toBe(false));
  it('blocks unknown browser origins', () => {
    expect(originAllowed(req({ origin: 'https://evil.example' }), {})).toBe(false);
    expect(originAllowed(req({ origin: 'https://chatgpt.com' }), {})).toBe(true);
    expect(originAllowed(req({}), {})).toBe(true);
  });
  it('HTTP: 401 without key, 403 for foreign origin', async () => {
    const e = { MCP_API_KEY: 'secret-key' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect((await handleHttp(new Request('https://h/mcp', { method: 'POST', body }), e)).status).toBe(401);
    expect(
      (await handleHttp(new Request('https://h/mcp', { method: 'POST', body, headers: { authorization: 'Bearer secret-key', origin: 'https://evil.example' } }), e)).status,
    ).toBe(403);
  });
});
