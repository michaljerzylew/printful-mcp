// OAuth + per-user MCP in real workerd with D1 (Miniflare). Upstream Printful is a fixture; nothing leaves the machine.
// Covers: DCR, ChatGPT ui_locales, signed form, PKCE, code/refresh replay (incl. concurrent refresh), revoke,
// encrypted storage, and that /api/printful/mcp uses the user's token, never a server-wide one.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://pf.example.com';
const resource = origin + '/api/printful/mcp';
const bundle = await build({
  stdin: {
    contents: `import { handleOAuth } from './lib/oauth.ts'; import { handleOAuthMcp } from './lib/mcp.ts';
      export default { async fetch(req, env) { const p = new URL(req.url).pathname;
        return p === '/api/printful/mcp' ? handleOAuthMcp(req, env) : handleOAuth(req, env, (v) => '<form data-csrf="' + v.csrf + '"></form>'); } };`,
    resolveDir: root,
    sourcefile: 'oauth-runtime.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
});

const upstream = [];
const mf = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-01-01',
  d1Databases: { DB: 'oauth-runtime' },
  bindings: { CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PUBLIC_ORIGIN: origin, PRINTFUL_API_TOKEN: 'server-token-must-not-be-used' },
  outboundService: async (req) => {
    const u = new URL(req.url);
    assert.equal(u.origin, 'https://api.printful.com');
    upstream.push(`${u.pathname} ${req.headers.get('Authorization')}`);
    return Response.json({ data: [{ id: 1, name: 'Fixture store', value: 'stores/read' }] });
  },
});

try {
  const db = await mf.getD1Database('DB');
  const sql = await readFile(new URL('../migrations/0001_oauth.sql', import.meta.url), 'utf8');
  await db.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
  const send = (path, body, json = false, headers = {}) =>
    mf.dispatchFetch(origin + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', ...headers } : headers,
      body: body ? (json ? JSON.stringify(body) : new URLSearchParams(body).toString()) : undefined,
      redirect: 'manual',
    });
  const rpc = (method, params, token) =>
    send('/api/printful/mcp', { jsonrpc: '2.0', id: 1, method, params }, true, token ? { Authorization: 'Bearer ' + token } : {});

  let r = await send('/api/oauth/register', { redirect_uris: ['https://chatgpt.com/connector/oauth/runtime'], token_endpoint_auth_method: 'none' }, true);
  assert.equal(r.status, 201);
  const client = await r.json();
  const verifier = 'v'.repeat(43);
  const q = new URLSearchParams({
    client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    state: 'runtime-state', resource, scope: 'printful', ui_locales: 'pl-PL',
  });

  r = await rpc('tools/call', { name: 'printful_stores_list', arguments: {} });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('WWW-Authenticate'), /resource_metadata=/);

  r = await send('/api/oauth/authorize?' + q);
  assert.equal(r.status, 200, 'ui_locales must not break the consent screen');
  const csrf = /data-csrf="([^"]+)"/.exec(await r.text())[1];
  r = await send('/api/oauth/authorize?' + q, { csrf, api_token: 'user-printful-token', consent: 'yes' });
  assert.equal(r.status, 303);
  const code = new URL(r.headers.get('Location')).searchParams.get('code');
  r = await send('/api/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code, code_verifier: verifier, resource });
  assert.equal(r.status, 200);
  const tokens = await r.json();

  r = await rpc('tools/call', { name: 'printful_stores_list', arguments: {} }, tokens.access_token);
  assert.equal(r.status, 200);
  assert.ok(!(await r.json()).result.isError);
  assert.ok(upstream.every((u) => u.endsWith('Bearer user-printful-token')), 'server token leaked: ' + upstream);

  const refresh = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource };
  const raced = await Promise.all([send('/api/oauth/token', refresh), send('/api/oauth/token', refresh)]);
  assert.deepEqual(raced.map((x) => x.status).sort(), [200, 400], 'concurrent refresh must succeed exactly once');
  const next = await raced.find((x) => x.status === 200).json();
  // The losing racer presented an already-rotated refresh token: treated as theft, the whole grant is revoked (RFC 9700).
  assert.equal((await rpc('tools/call', { name: 'printful_stores_list', arguments: {} }, tokens.access_token)).status, 401);
  assert.equal((await rpc('tools/call', { name: 'printful_stores_list', arguments: {} }, next.access_token)).status, 401, 'grant must be revoked after refresh reuse');
  assert.equal((await send('/api/oauth/revoke', { client_id: client.client_id, token: next.refresh_token })).status, 200);

  const rows = await db.prepare('SELECT credential FROM oauth_grants').all();
  assert.ok(!JSON.stringify(rows).includes('user-printful-token'), 'token stored in plaintext');
  console.log(`PASS workerd + D1 OAuth runtime (${upstream.length} upstream calls, all with the user token)`);
} finally {
  await mf.dispose();
}
