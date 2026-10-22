// OAuth bridge: DCR, PKCE S256, signed request-bound consent form, encrypted grants, refresh rotation, revocation.
// Ported from the 2.0.1 regression suite (ui_locales, unknown extensions, duplicates, tampered state) onto node:sqlite.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateOAuth, decryptCredential, encryptCredential, handleOAuth } from '../lib/oauth';
import { handleOAuthMcp } from '../lib/mcp';

const ORIGIN = 'https://pf.example.com';
const RESOURCE = `${ORIGIN}/api/printful/mcp`;
const CALLBACK = 'https://chatgpt.com/connector/oauth/test-callback';

function makeEnv(extra: Record<string, string> = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('migrations/0001_oauth.sql', 'utf8'));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as any[])) as any) ?? null,
    run: async () => db.prepare(sql).run(...(args as any[])),
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
  });
  const DB = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => {
      db.exec('BEGIN');
      try {
        const r = [];
        for (const s of stmts) r.push(await s.run());
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { db, env: { DB, CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PUBLIC_ORIGIN: ORIGIN, ...extra } as any };
}

const req = (path: string, body?: Record<string, unknown>, json = false, headers: Record<string, string> = {}) =>
  new Request(ORIGIN + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', ...headers } : headers,
    body: body ? (json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString()) : undefined,
  });

const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function register(env: any, redirect = CALLBACK) {
  const r = await handleOAuth(req('/api/oauth/register', { redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, true), env);
  return { status: r.status, client: (await r.json()) as any };
}

function authQuery(clientId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-test',
    resource: RESOURCE,
    scope: 'printful',
    ...extra,
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    expect(new URL(String(url)).origin).toBe('https://api.printful.com');
    return Response.json({ data: [{ value: 'stores/read' }] });
  });
});
afterEach(() => vi.restoreAllMocks());

describe('OAuth discovery', () => {
  it('publishes metadata bound to the deployment origin', async () => {
    const { env } = makeEnv();
    const as = (await (await handleOAuth(req('/.well-known/oauth-authorization-server'), env)).json()) as any;
    expect(as).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    const pr = (await (await handleOAuth(req('/.well-known/oauth-protected-resource/api/printful/mcp'), env)).json()) as any;
    expect(pr).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN] });
  });
  it('falls back to the request origin when PUBLIC_ORIGIN is unset', async () => {
    const { env } = makeEnv();
    delete env.PUBLIC_ORIGIN;
    const as = (await (await handleOAuth(new Request("https://other.example/.well-known/oauth-authorization-server"), env)).json()) as any;
    expect(as.issuer).toBe('https://other.example');
  });
});

describe('no shared state between concurrent requests (review finding 2)', () => {
  it('interleaved hosts keep their own issuer', async () => {
    const { env } = makeEnv();
    delete env.PUBLIC_ORIGIN;
    const hosts = ['https://a.example', 'https://b.example', 'https://c.example'];
    const res = await Promise.all(
      Array.from({ length: 30 }, (_, i) => hosts[i % 3]).map(async (h) => {
        const r = (await (await handleOAuth(new Request(h + '/.well-known/oauth-authorization-server'), env)).json()) as any;
        return [h, r.issuer];
      }),
    );
    for (const [h, iss] of res) expect(iss).toBe(h);
  });
  it('a token minted for one origin is not accepted on another', async () => {
    const { env } = makeEnv();
    const { client } = await register(env);
    const q = authQuery(client.client_id);
    let view: any;
    await handleOAuth(req('/api/oauth/authorize?' + q), env, (v) => ((view = v), ''));
    const cb = new URL((await handleOAuth(req('/api/oauth/authorize?' + q, { api_token: 'u', csrf: view.csrf, consent: 'yes' }), env)).headers.get('Location')!);
    const t: any = await (
      await handleOAuth(req('/api/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: CALLBACK, resource: RESOURCE, code: cb.searchParams.get('code')!, code_verifier: verifier }), env)
    ).json();
    const other = { ...env, PUBLIC_ORIGIN: 'https://other.example' };
    expect(await authenticateOAuth(new Request('https://other.example/api/printful/mcp', { headers: { Authorization: 'Bearer ' + t.access_token } }), other)).toBeNull();
    expect(await authenticateOAuth(new Request(RESOURCE, { headers: { Authorization: 'Bearer ' + t.access_token } }), env)).not.toBeNull();
  });
});

describe('dynamic client registration', () => {
  it('accepts ChatGPT callbacks and rejects others', async () => {
    const { env } = makeEnv();
    expect((await register(env)).status).toBe(201);
    expect((await register(env, 'https://chatgpt.com/evil')).status).toBe(400);
    expect((await register(env, 'https://attacker.example/cb')).status).toBe(400);
    expect((await register(env, 'https://claude.ai/api/mcp/auth_callback')).status).toBe(400);
  });
  it('admits Claude only when enabled', async () => {
    const { env } = makeEnv({ OAUTH_REDIRECT_ORIGINS: 'chatgpt,claude' });
    expect((await register(env, 'https://claude.ai/api/mcp/auth_callback')).status).toBe(201);
  });
});

describe('authorization request (2.0.1 regression: ChatGPT sends ui_locales)', () => {
  it('ignores unknown optional parameters such as ui_locales', async () => {
    const { env } = makeEnv();
    const { client } = await register(env);
    const r = await handleOAuth(req('/api/oauth/authorize?' + authQuery(client.client_id, { ui_locales: 'pl-PL', future_extension: 'x' })), env, () => '<html>ok</html>');
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Content-Security-Policy')).toContain(`form-action 'self' ${ORIGIN} https://chatgpt.com`);
  });
  it.each(['client_id', 'redirect_uri', 'resource', 'state', 'ui_locales'])('rejects a duplicated %s', async (key) => {
    const { env } = makeEnv();
    const { client } = await register(env);
    const q = authQuery(client.client_id, { ui_locales: 'pl-PL' });
    q.append(key, 'dup');
    expect((await handleOAuth(req('/api/oauth/authorize?' + q), env)).status).toBe(400);
  });
  it('redirects consent to the canonical PUBLIC_ORIGIN (review finding 7)', async () => {
    const { env } = makeEnv();
    const r = await handleOAuth(new Request('https://preview.workers.dev/api/oauth/authorize?a=1'), env);
    expect(r.status).toBe(308);
    expect(r.headers.get('Location')).toBe(ORIGIN + '/api/oauth/authorize?a=1');
  });
  it('requires S256 and the exact resource', async () => {
    const { env } = makeEnv();
    const { client } = await register(env);
    expect((await handleOAuth(req('/api/oauth/authorize?' + authQuery(client.client_id, { code_challenge_method: 'plain' })), env)).status).toBe(400);
    expect((await handleOAuth(req('/api/oauth/authorize?' + authQuery(client.client_id, { resource: ORIGIN + '/mcp' })), env)).status).toBe(400);
  });
});

describe('full flow', () => {
  async function connect(env: any) {
    const { client } = await register(env);
    const q = authQuery(client.client_id, { ui_locales: 'pl-PL' });
    let view: any;
    await handleOAuth(req('/api/oauth/authorize?' + q), env, (v) => ((view = v), '<html></html>'));
    // tampered state invalidates the signed form
    const tampered = new URLSearchParams(q);
    tampered.set('state', 'tampered');
    expect((await handleOAuth(req('/api/oauth/authorize?' + tampered, { api_token: 'pf-user-token', csrf: view.csrf, consent: 'yes' }), env)).status).toBe(400);
    const denied = await handleOAuth(req('/api/oauth/authorize?' + q, { api_token: 'pf-user-token', csrf: view.csrf, consent: 'no' }), env);
    expect(denied.status).toBe(303);
    expect(new URL(denied.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
    // a declined form cannot be reused, but a fresh form still works
    expect((await handleOAuth(req('/api/oauth/authorize?' + q, { api_token: 'pf-user-token', csrf: view.csrf, consent: 'yes' }), env)).status).toBe(400);
    let view2: any;
    await handleOAuth(req('/api/oauth/authorize?' + q), env, (v) => ((view2 = v), ''));
    view = view2;
    const auth = await handleOAuth(req('/api/oauth/authorize?' + q, { api_token: 'pf-user-token', csrf: view.csrf, consent: 'yes' }), env);
    expect(auth.status).toBe(303);
    const cb = new URL(auth.headers.get('Location')!);
    expect(cb.searchParams.get('state')).toBe('state-test');
    expect(cb.searchParams.get('iss')).toBe(ORIGIN);
    // replaying the form fails
    expect((await handleOAuth(req('/api/oauth/authorize?' + q, { api_token: 'pf-user-token', csrf: view.csrf, consent: 'yes' }), env)).status).toBe(400);
    const tokenReq = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: CALLBACK, resource: RESOURCE, code: cb.searchParams.get('code')!, code_verifier: verifier };
    const tok = await handleOAuth(req('/api/oauth/token', tokenReq), env);
    expect(tok.status).toBe(200);
    return { client, tokens: (await tok.json()) as any, tokenReq };
  }

  it('connects, refreshes with rotation and revokes; stores only ciphertext', async () => {
    const { env, db } = makeEnv();
    const { client, tokens } = await connect(env);
    const mcpReq = (t: string) => new Request(RESOURCE, { headers: { Authorization: 'Bearer ' + t } });
    expect((await authenticateOAuth(mcpReq(tokens.access_token), env))!.token).toBe('pf-user-token');

    const refresh = { grant_type: 'refresh_token', client_id: client.client_id, resource: RESOURCE, refresh_token: tokens.refresh_token };
    const fresh = (await (await handleOAuth(req('/api/oauth/token', refresh), env)).json()) as any;
    expect(await authenticateOAuth(mcpReq(tokens.access_token), env)).toBeNull(); // old access token retired by rotation
    expect((await authenticateOAuth(mcpReq(fresh.access_token), env))!.token).toBe('pf-user-token');

    expect((await handleOAuth(req('/api/oauth/revoke', { client_id: client.client_id, token: fresh.refresh_token }), env)).status).toBe(200);
    expect(await authenticateOAuth(mcpReq(fresh.access_token), env)).toBeNull();
    expect(JSON.stringify(db.prepare('SELECT * FROM oauth_grants').all())).not.toContain('pf-user-token');
  });

  it('binds ciphertext to its grant', async () => {
    const { env } = makeEnv();
    const c = await encryptCredential('secret', 'grant-a', env);
    await expect(decryptCredential(c, 'grant-b', env)).rejects.toThrow();
    expect(await decryptCredential(c, 'grant-a', env)).toBe('secret');
  });

  it('rejects a token Printful does not accept and re-renders the form', async () => {
    const { env } = makeEnv();
    const { client } = await register(env);
    const q = authQuery(client.client_id);
    let view: any;
    await handleOAuth(req('/api/oauth/authorize?' + q), env, (v) => ((view = v), ''));
    fetchSpy.mockImplementation(async () => new Response('{}', { status: 401 }));
    const r = await handleOAuth(req('/api/oauth/authorize?' + q, { api_token: 'bad', csrf: view.csrf, consent: 'yes' }), env, (v) => v.error ?? '');
    expect(r.status).toBe(401);
    expect(await r.text()).toMatch(/rejected/);
  });

  it('per-user MCP endpoint: discovery anonymous, API tools require OAuth, never uses a server token', async () => {
    const { env } = makeEnv({ PRINTFUL_API_TOKEN: 'server-token-must-not-be-used' });
    const call = (method: string, params: object = {}, token?: string) =>
      handleOAuthMcp(
        new Request(RESOURCE, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }),
        env,
      );
    const list = (await (await call('tools/list')).json()) as any;
    expect(list.result.tools[0].securitySchemes).toEqual([{ type: 'oauth2', scopes: ['printful'] }]);
    const anon = await call('tools/call', { name: 'printful_stores_list', arguments: {} });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/printful/mcp"`);
    expect((await call('tools/call', { name: 'printful_calc_retail', arguments: { cost: 10, markup_pct: 100, round_to: null } })).status).toBe(200);

    const { tokens } = await connect(env);
    const seen: string[] = [];
    fetchSpy.mockImplementation(async (_u: any, init: any) => {
      seen.push(init.headers.Authorization);
      return Response.json({ data: [{ id: 1, name: 'Shop' }] });
    });
    const ok = (await (await call('tools/call', { name: 'printful_stores_list', arguments: {} }, tokens.access_token)).json()) as any;
    expect(ok.result.isError).toBeUndefined();
    expect(seen).toEqual(['Bearer pf-user-token']);
  });

  it('fails clearly when D1 or the encryption key is missing', async () => {
    const r = await handleOAuthMcp(new Request(RESOURCE, { method: 'POST', body: '{}' }), { PUBLIC_ORIGIN: ORIGIN });
    expect(r.status).toBe(503);
  });
});

describe('replay handling (review finding 5)', () => {
  async function codeFor(env: any) {
    const { client } = await register(env);
    const q = authQuery(client.client_id);
    let view: any;
    await handleOAuth(req('/api/oauth/authorize?' + q), env, (v) => ((view = v), ''));
    const cb = new URL((await handleOAuth(req('/api/oauth/authorize?' + q, { api_token: 'u', csrf: view.csrf, consent: 'yes' }), env)).headers.get('Location')!);
    return { client, tokenReq: { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: CALLBACK, resource: RESOURCE, code: cb.searchParams.get('code')!, code_verifier: verifier } };
  }
  const bearer = (t: string) => new Request(RESOURCE, { headers: { Authorization: 'Bearer ' + t } });

  it('a wrong PKCE verifier burns the code', async () => {
    const { env } = makeEnv();
    const { tokenReq } = await codeFor(env);
    expect((await handleOAuth(req('/api/oauth/token', { ...tokenReq, code_verifier: 'b'.repeat(43) }), env)).status).toBe(400);
    expect((await handleOAuth(req('/api/oauth/token', tokenReq), env)).status).toBe(400);
  });
  it('replaying a redeemed code revokes the grant it produced', async () => {
    const { env } = makeEnv();
    const { tokenReq } = await codeFor(env);
    const t: any = await (await handleOAuth(req('/api/oauth/token', tokenReq), env)).json();
    expect(await authenticateOAuth(bearer(t.access_token), env)).not.toBeNull();
    expect((await handleOAuth(req('/api/oauth/token', tokenReq), env)).status).toBe(400);
    expect(await authenticateOAuth(bearer(t.access_token), env)).toBeNull();
  });
  it('reusing a rotated refresh token revokes the whole grant', async () => {
    const { env } = makeEnv();
    const { client, tokenReq } = await codeFor(env);
    const t: any = await (await handleOAuth(req('/api/oauth/token', tokenReq), env)).json();
    const refresh = { grant_type: 'refresh_token', client_id: client.client_id, resource: RESOURCE, refresh_token: t.refresh_token };
    const fresh: any = await (await handleOAuth(req('/api/oauth/token', refresh), env)).json();
    expect(await authenticateOAuth(bearer(fresh.access_token), env)).not.toBeNull();
    expect((await handleOAuth(req('/api/oauth/token', refresh), env)).status).toBe(400); // stolen old token replayed
    expect(await authenticateOAuth(bearer(fresh.access_token), env)).toBeNull();
    expect((await handleOAuth(req('/api/oauth/token', { ...refresh, refresh_token: fresh.refresh_token }), env)).status).toBe(400);
  });
});

describe('tenant isolation on the OAuth endpoint (review finding 1)', () => {
  it('operator settings never reach other users', async () => {
    const { env } = makeEnv({
      PRINTFUL_API_TOKEN: 'operator-token',
      PRINTFUL_STORE_ID: '999',
      MAX_AUTO_CONFIRM_COST: '1000',
      PACKING_SLIP_JSON: '{"store_name":"Operator Shop","email":"op@example.com"}',
      SKU_MAPPING_JSON: '{"skus":{"OP-SKU":{"catalog_variant_id":1,"placements":[{"placement":"front","layers":[{"type":"file","url":"https://op.example/a.png"}]}]}}}',
      MCP_API_KEY: 'operator-key',
    });
    const { client } = await register(env);
    const q = authQuery(client.client_id);
    let view: any;
    await handleOAuth(req('/api/oauth/authorize?' + q), env, (v) => ((view = v), ''));
    const cb = new URL((await handleOAuth(req('/api/oauth/authorize?' + q, { api_token: 'user-token', csrf: view.csrf, consent: 'yes' }), env)).headers.get('Location')!);
    const tokens: any = await (
      await handleOAuth(req('/api/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: CALLBACK, resource: RESOURCE, code: cb.searchParams.get('code')!, code_verifier: verifier }), env)
    ).json();
    const seen: any[] = [];
    fetchSpy.mockImplementation(async (u: any, init: any) => {
      seen.push({ url: String(u), auth: init.headers.Authorization, store: init.headers['X-PF-Store-Id'], body: init.body });
      if (String(u).includes('/v2/orders/@')) return new Response('{"error":{"message":"nf"}}', { status: 404 });
      return Response.json({ data: { id: 7, status: 'draft', costs: { calculation_status: 'done', total: '50.00', currency: 'USD' } } });
    });
    const call = async (name: string, args: object) =>
      (await (
        await handleOAuthMcp(
          new Request(RESOURCE, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens.access_token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }),
          env,
        )
      ).json()) as any;
    const order = { id: 'U1', recipient: { name: 'U', address1: 'a', city: 'c', zip: '1', country_code: 'PL' }, order_items: [{ source: 'catalog', catalog_variant_id: 4017, quantity: 1, placements: [{ placement: 'front', technique: 'dtg', layers: [{ type: 'file', url: 'https://u.example/a.png' }] }] }] };
    const r = await call('printful_fulfill_shop_order', { shop_order: order, confirm: true });
    expect(r.result.structuredContent.status).toBe('held'); // operator's MAX_AUTO_CONFIRM_COST must not apply
    expect(seen.some((s) => s.url.includes('/confirmation'))).toBe(false);
    expect(seen.every((s) => s.auth === 'Bearer user-token' && s.store === undefined)).toBe(true);
    expect(seen.map((s) => s.body ?? '').join('')).not.toContain('Operator Shop');
    const m = await call('printful_fulfill_shop_order', { shop_order: { ...order, order_items: undefined, items: [{ sku: 'OP-SKU' }] }, dry_run: true });
    expect(m.result.isError).toBe(true); // operator's SKU mapping is not available to users
  });
});
