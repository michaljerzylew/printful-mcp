/**
 * OAuth 2.1 bridge for the per-user Printful MCP endpoint (ChatGPT plugins, Claude connectors).
 * The user types their Printful API token into a server-rendered form; the token is validated, encrypted per grant
 * (AES-GCM, key derived from CONNECTOR_ENCRYPTION_KEY) and stored in D1. Clients only ever receive connector tokens.
 *
 * Origin: PUBLIC_ORIGIN env var, else the request origin. Set PUBLIC_ORIGIN in production so metadata is stable.
 */
export const MCP_PATH = '/api/printful/mcp';
export const SCOPE = 'printful';
export const RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

/** Per-request deployment context. Passed explicitly, never stored in module state (Workers share isolates across requests). */
export interface Ctx { origin: string; resource: string; resourceMetadata: string; providers: string[] }
export function contextFor(req: Request, env: { PUBLIC_ORIGIN?: string; OAUTH_REDIRECT_ORIGINS?: string }): Ctx {
  const origin = (env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : new URL(req.url)).origin;
  const providers = String(env.OAUTH_REDIRECT_ORIGINS ?? 'chatgpt').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return { origin, resource: `${origin}${MCP_PATH}`, resourceMetadata: `${origin}${RESOURCE_METADATA_PATH}`, providers };
}
const enc = new TextEncoder();
const dec = new TextDecoder();
export interface OAuthEnv { DB: D1Database; CONNECTOR_ENCRYPTION_KEY: string; PUBLIC_ORIGIN?: string; OAUTH_REDIRECT_ORIGINS?: string }
interface Client { id: string; redirect_uri: string; name: string }
interface AuthRequest { client: Client; redirectUri: string; challenge: string; state: string; scope: string; resource: string; query: string }
interface CodeRow { client_id: string; redirect_uri: string; challenge: string; resource: string; scope: string; grant_id: string; credential: string; expires_at: number }
interface GrantRow { id: string; client_id: string; resource: string; scope: string; credential: string; access_expires: number; refresh_expires: number; revoked: number }
export interface AuthorizationView { action: string; csrf: string; clientName: string; error?: string }
export type AuthorizationRenderer = (view: AuthorizationView) => string;
class OAuthError extends Error {
  constructor(readonly code: string, readonly safeMessage: string, readonly status = 400) { super(safeMessage); }
}
const now = () => Math.floor(Date.now() / 1000);
function bytes64(bytes: Uint8Array): string { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function from64(value: string): Uint8Array<ArrayBuffer> { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new OAuthError('invalid_request', 'Malformed encoded value.'); const normal = value.replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(normal + '='.repeat((4 - normal.length % 4) % 4)); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
const random = () => bytes64(crypto.getRandomValues(new Uint8Array(32)));
export const hashOAuthValue = async (s: string) => bytes64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
async function keyBytes(env: OAuthEnv) { const value = env.CONNECTOR_ENCRYPTION_KEY; if (!value) throw new OAuthError('server_error', 'Connector encryption is not configured.', 503); const bytes = from64(value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')); if (bytes.length !== 32) throw new OAuthError('server_error', 'Connector encryption is not configured.', 503); return bytes; }
async function deriveKey(env: OAuthEnv, purpose: 'encryption' | 'signing') {
  const root = await crypto.subtle.importKey('raw', await keyBytes(env), 'HKDF', false, ['deriveKey']);
  const algorithm = purpose === 'encryption' ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256', length: 256 };
  const usages: KeyUsage[] = purpose === 'encryption' ? ['encrypt', 'decrypt'] : ['sign', 'verify'];
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('printful-mcp-oauth-v1'), info: enc.encode(purpose) }, root, algorithm, false, usages);
}
async function hmac(env: OAuthEnv) { return deriveKey(env, 'signing'); }
export async function encryptCredential(token: string, subject: string, env: OAuthEnv): Promise<string> {
  const key = await deriveKey(env, 'encryption');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`printful-credential:v1:${subject}`) }, key, enc.encode(token));
  return `v1.${bytes64(iv)}.${bytes64(new Uint8Array(ciphertext))}`;
}
export async function decryptCredential(ciphertext: string, subject: string, env: OAuthEnv): Promise<string> {
  const parts = ciphertext.split('.'); if (parts.length !== 3 || parts[0] !== 'v1') throw new OAuthError('invalid_grant', 'Reconnect Printful.');
  try {
    const key = await deriveKey(env, 'encryption');
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(parts[1]), additionalData: enc.encode(`printful-credential:v1:${subject}`) }, key, from64(parts[2])));
  } catch { throw new OAuthError('invalid_grant', 'Reconnect Printful.'); }
}
export const oauthSecurityHeaders = {
  'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
};
function json(value: unknown, status = 200, extra: Record<string, string> = {}) { return new Response(JSON.stringify(value), { status, headers: { ...oauthSecurityHeaders, 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra } }); }
function err(e: unknown) { if (e instanceof OAuthError) return json({ error: e.code, error_description: e.safeMessage }, e.status, e.status === 429 ? { 'Retry-After': '60' } : {}); return json({ error: 'server_error', error_description: 'Unable to complete authorization. Please retry.' }, 503); }
function one(p: URLSearchParams, name: string, required = true): string {
  const values = p.getAll(name); if (values.length > 1 || (required && (!values.length || !values[0]))) throw new OAuthError('invalid_request', `Invalid ${name}.`); return values[0] ?? '';
}
function scopeOf(value: string | undefined): string { if (value === undefined) return SCOPE; if (value !== SCOPE) throw new OAuthError('invalid_scope', 'Only the printful scope is supported.'); return value; }
function resourceOf(c: Ctx, value: string) { if (value !== c.resource) throw new OAuthError('invalid_target', 'Resource must match the Printful MCP endpoint.'); return value; }
/** Allowed OAuth callbacks: exact origin + path prefix. Default ChatGPT only; add Claude via OAUTH_REDIRECT_ORIGINS=chatgpt,claude. */
const REDIRECTS: Record<string, { origin: string; paths: (p: string) => boolean }> = {
  chatgpt: { origin: 'https://chatgpt.com', paths: (p) => p.startsWith('/connector/oauth/') || p === '/connector_platform_oauth_redirect' },
  claude: { origin: 'https://claude.ai', paths: (p) => p === '/api/mcp/auth_callback' },
};
function redirectOf(c: Ctx, value: string) {
  let u: URL; try { u = new URL(value); } catch { throw new OAuthError('invalid_redirect_uri', 'Invalid redirect URI.'); }
  const ok = !u.username && !u.password && !u.hash && c.providers.some((k) => REDIRECTS[k] && u.origin === REDIRECTS[k].origin && REDIRECTS[k].paths(u.pathname));
  if (!ok) throw new OAuthError('invalid_redirect_uri', 'This callback URL is not allowed.');
  return u.href;
}
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OAuthError('invalid_request', 'Expected an object.'); return v as Record<string, unknown>; }
function field(v: unknown, max: number, label: string): string { if (typeof v !== 'string' || !v || v.length > max || /[\u0000-\u001f]/.test(v)) throw new OAuthError('invalid_request', `Invalid ${label}.`); return v; }
async function readBody(req: Request, max = 16384): Promise<string> {
  if (Number(req.headers.get('Content-Length') ?? 0) > max) throw new OAuthError('invalid_request', 'Request is too large.', 413);
  if (!req.body) throw new OAuthError('invalid_request', 'Missing request body.');
  const reader = req.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel(); reject(new OAuthError('invalid_request', 'Request timed out.', 408)); }, 10000); });
  try { while (true) { const part = await Promise.race([reader.read(), timeout]); if (part.done) break; size += part.value.length; if (size > max) { await reader.cancel(); throw new OAuthError('invalid_request', 'Request is too large.', 413); } chunks.push(part.value); } }
  finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
  const buffer = new Uint8Array(size); let at = 0; for (const chunk of chunks) { buffer.set(chunk, at); at += chunk.length; } return dec.decode(buffer);
}
async function form(req: Request) { if (!req.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'Use URL-encoded form data.', 415); return new URLSearchParams(await readBody(req)); }
/**
 * Fixed-window rate limit in D1, keyed by HMAC(route, subject, minute). ChatGPT calls from a small pool of egress IPs, so
 * per-IP limits are generous (they only stop floods); the per-grant limit is what protects each connection.
 */
async function rate(req: Request, env: OAuthEnv, route: string, limit: number, subject?: string) {
  const minute = Math.floor(now() / 60); const source = subject ?? req.headers.get('CF-Connecting-IP') ?? 'shared';
  const digest = bytes64(new Uint8Array(await crypto.subtle.sign('HMAC', await hmac(env), enc.encode(`rate:v1:${route}:${source}:${minute}`))));
  const row = await env.DB.prepare('INSERT INTO oauth_rate_limits(rate_key,count,expires_at) VALUES(?,1,?) ON CONFLICT(rate_key) DO UPDATE SET count=count+1 RETURNING count').bind(digest, now() + 120).first<{ count: number }>();
  if (!row || row.count > limit) throw new OAuthError('temporarily_unavailable', 'Too many attempts. Retry in one minute.', 429);
  // Housekeeping on ~2% of calls, with index-friendly deletes (no full scans on the hot path).
  if (Math.random() < 0.02) await cleanup(env).catch(() => undefined);
}
export async function cleanup(env: OAuthEnv): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_rate_limits WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM oauth_form_nonces WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM oauth_grants WHERE refresh_expires < ?').bind(t),
    env.DB.prepare('DELETE FROM oauth_grants WHERE revoked = 1'),
    // DCR clients that never completed a grant within a day
    env.DB.prepare('DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants)').bind(t - 86400),
  ]);
}
/** Fail closed if D1 or encryption bindings cannot enforce the quota. */
export async function enforceMcpSourceLimit(req: Request, env: OAuthEnv): Promise<boolean> {
  try { await rate(req, env, 'mcp-source', 3000); return true; } catch { return false; }
}
export async function enforceMcpRateLimit(req: Request, env: OAuthEnv, grantId: string): Promise<boolean> {
  try { await rate(req, env, 'mcp-grant', 120, grantId); return true; } catch { return false; }
}
export function oauthMetadata(c: Ctx) { const CONNECTOR_ORIGIN = c.origin; return { issuer: CONNECTOR_ORIGIN, authorization_response_iss_parameter_supported: true, authorization_endpoint: `${CONNECTOR_ORIGIN}/api/oauth/authorize`, token_endpoint: `${CONNECTOR_ORIGIN}/api/oauth/token`, registration_endpoint: `${CONNECTOR_ORIGIN}/api/oauth/register`, revocation_endpoint: `${CONNECTOR_ORIGIN}/api/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: [SCOPE] }; }
export function protectedResourceMetadata(c: Ctx) { return { resource: c.resource, authorization_servers: [c.origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Printful MCP' }; }
export function oauthChallenge(c: Ctx) { return `Bearer resource_metadata="${c.resourceMetadata}", error="invalid_token", error_description="Connect your Printful account"`; }
async function registration(c: Ctx, req: Request, env: OAuthEnv) {
  await rate(req, env, 'register', 60); await rate(req, env, 'register-global', 600, 'all');
  if (!req.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new OAuthError('invalid_request', 'Use JSON.', 415);
  let raw: unknown; try { raw = JSON.parse(await readBody(req)); } catch { throw new OAuthError('invalid_request', 'Invalid JSON.'); }
  const p = object(raw);
  if (!Array.isArray(p.redirect_uris) || p.redirect_uris.length !== 1) throw new OAuthError('invalid_redirect_uri', 'Register exactly one redirect URI.');
  const redirect = redirectOf(c, field(p.redirect_uris[0], 2048, 'redirect_uri'));
  if (p.token_endpoint_auth_method !== undefined && p.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only public clients with S256 PKCE are supported.');
  if (p.grant_types !== undefined && (!Array.isArray(p.grant_types) || p.grant_types.some(x => x !== 'authorization_code' && x !== 'refresh_token'))) throw new OAuthError('invalid_client_metadata', 'Unsupported grant type.');
  if (p.response_types !== undefined && (!Array.isArray(p.response_types) || p.response_types.length !== 1 || p.response_types[0] !== 'code')) throw new OAuthError('invalid_client_metadata', 'Only response_type code is supported.');
  const name = p.client_name === undefined ? 'ChatGPT' : field(p.client_name, 100, 'client_name');
  if (p.scope !== undefined) scopeOf(field(p.scope, 64, 'scope'));
  const id = `pf_client_${random()}`; await env.DB.prepare('INSERT INTO oauth_clients(id,redirect_uri,name,created_at) VALUES(?,?,?,?)').bind(id, redirect, name, now()).run();
  return json({ client_id: id, client_id_issued_at: now(), client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE }, 201);
}
async function authRequest(c: Ctx, url: URL, env: OAuthEnv): Promise<AuthRequest> {
  if (url.search.length > 8192) throw new OAuthError('invalid_request', 'Authorization request is too large.');
  const p = url.searchParams; const allowed = new Set(['client_id','redirect_uri','response_type','code_challenge','code_challenge_method','state','scope','resource']);
  // RFC 6749 section 3.1: ignore unrecognized parameters (ChatGPT sends ui_locales).
  // Reject duplicates before filtering; only supported fields enter the signed request.
  for (const key of p.keys()) if (p.getAll(key).length !== 1) throw new OAuthError('invalid_request', 'Duplicate authorization parameter.');
  for (const key of [...p.keys()]) if (!allowed.has(key)) p.delete(key);
  if (one(p, 'response_type') !== 'code' || one(p, 'code_challenge_method') !== 'S256') throw new OAuthError('invalid_request', 'Authorization code with S256 PKCE is required.');
  const id = field(one(p, 'client_id'), 128, 'client_id'); const client = await env.DB.prepare('SELECT id,redirect_uri,name FROM oauth_clients WHERE id=?').bind(id).first<Client>();
  if (!client) throw new OAuthError('invalid_client', 'Register the client before authorizing.');
  const redirectUri = redirectOf(c, one(p, 'redirect_uri')); if (redirectUri !== client.redirect_uri) throw new OAuthError('invalid_request', 'Redirect URI does not match the registration.');
  const challenge = one(p, 'code_challenge'); if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new OAuthError('invalid_request', 'Invalid S256 challenge.');
  const state = field(one(p, 'state'), 2048, 'state'); const resource = resourceOf(c, one(p, 'resource'));
  const scope = scopeOf(p.has('scope') ? one(p, 'scope') : undefined);
  const query = [...p.entries()].sort(([a,av],[b,bv])=>a.localeCompare(b)||av.localeCompare(bv)).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return { client, redirectUri, challenge, state, resource, scope, query };
}
async function makeCsrf(a: AuthRequest, env: OAuthEnv) {
  const payload = bytes64(enc.encode(JSON.stringify({ v: 1, iat: now(), exp: now() + 600, nonce: random(), request: await hashOAuthValue(a.query) })));
  const sig = bytes64(new Uint8Array(await crypto.subtle.sign('HMAC', await hmac(env), enc.encode(payload)))); return `${payload}.${sig}`;
}
async function verifyCsrf(value: string, a: AuthRequest, env: OAuthEnv) {
  if (value.length > 2048) throw new OAuthError('invalid_request', 'Expired or invalid authorization form.');
  const parts = value.split('.'); if (parts.length !== 2) throw new OAuthError('invalid_request', 'Expired or invalid authorization form.');
  let v: Record<string, unknown>;
  try { if (!await crypto.subtle.verify('HMAC', await hmac(env), from64(parts[1]), enc.encode(parts[0]))) throw new Error(); v = object(JSON.parse(dec.decode(from64(parts[0])))); } catch { throw new OAuthError('invalid_request', 'Expired or invalid authorization form.'); }
  if (v.v !== 1 || typeof v.exp !== 'number' || typeof v.iat !== 'number' || v.exp < now() || v.iat > now()+30 || v.exp - v.iat !== 600 || typeof v.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.nonce) || v.request !== await hashOAuthValue(a.query)) throw new OAuthError('invalid_request', 'Expired or invalid authorization form.');
  return { nonceHash: await hashOAuthValue(v.nonce), expires: v.exp };
}
export async function validatePrintfulCredential(token: string): Promise<void> {
  if (!token || token.length > 4096 || /\s|[\u0000-\u001f]/.test(token)) throw new OAuthError('invalid_request', 'Enter a valid Printful API token.');
  const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(), 15000);
  try {
    const response = await fetch('https://api.printful.com/v2/oauth-scopes', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
    if (response.status === 401 || response.status === 403) throw new OAuthError('access_denied', 'Printful rejected this API token.', 401);
    if (response.status === 429) throw new OAuthError('temporarily_unavailable', 'Printful is limiting requests. Retry shortly.', 429);
    if (!response.ok) throw new OAuthError('temporarily_unavailable', 'Printful could not validate the token. Retry shortly.', 502);
    const reader = response.body?.getReader(); if (!reader) throw new OAuthError('temporarily_unavailable', 'Invalid response from Printful.', 502);
    let size = 0; let text = '';
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) { await reader.cancel(); throw new OAuthError('temporarily_unavailable', 'Invalid response from Printful.', 502); } text += dec.decode(part.value, { stream: true }); } } finally { reader.releaseLock(); }
    let payload: Record<string, unknown>; try { payload = object(JSON.parse(text)); } catch { throw new OAuthError('temporarily_unavailable', 'Invalid response from Printful.', 502); }
    if (!Array.isArray(payload.data)) throw new OAuthError('temporarily_unavailable', 'Invalid response from Printful.', 502);
  } catch (e) { if (e instanceof OAuthError) throw e; throw new OAuthError('temporarily_unavailable', 'Printful could not be reached. Retry shortly.', 502); }
  finally { clearTimeout(timer); }
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] ?? c));
export function defaultAuthorizationPage(v: AuthorizationView) { return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Printful</title><body><main><h1>Connect Printful</h1><p>Connect to ${escapeHtml(v.clientName)} using your Printful API token.</p>${v.error?`<p role="alert">${escapeHtml(v.error)}</p>`:''}<form method="post" action="${escapeHtml(v.action)}"><input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}"><label>Printful API token<input type="password" name="api_token" required autocomplete="off" maxlength="4096"></label><label><input type="checkbox" name="consent" value="yes" required>Allow this connection to use my Printful API token</label><button>Connect Printful</button></form></main></body></html>`; }
const formActions = (c: Ctx) => [c.origin, ...c.providers.map((k) => REDIRECTS[k]?.origin)].filter(Boolean).join(' ');
function htmlPage(c: Ctx, content: string, status = 200) { return new Response(content, { status, headers: { ...oauthSecurityHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self' ${formActions(c)}; base-uri 'none'; frame-ancestors 'none'` } }); }
async function authorize(c: Ctx, req: Request, env: OAuthEnv, renderer: AuthorizationRenderer) {
  await rate(req, env, 'authorize', 120); const a = await authRequest(c, new URL(req.url), env);
  const view = async (error?: string, status = 200) => htmlPage(c, renderer({ action: `${c.origin}/api/oauth/authorize?${a.query}`, csrf: await makeCsrf(a, env), clientName: a.client.name, error }), status);
  if (req.method === 'GET') return view();
  const p = await form(req); for (const k of p.keys()) if (!['csrf','api_token','consent','deny'].includes(k)) throw new OAuthError('invalid_request', 'Unexpected form field.');
  const csrf = await verifyCsrf(one(p,'csrf'), a, env);
  if (p.get('consent') !== 'yes') {
    // Validated request + signed form, user declined: tell the client (RFC 6749 §4.1.2.1) instead of dead-ending.
    // Burn the form nonce so a declined form cannot be resubmitted with consent.
    try { await env.DB.prepare('INSERT INTO oauth_form_nonces(nonce_hash,expires_at) VALUES(?,?)').bind(csrf.nonceHash, csrf.expires).run(); }
    catch { throw new OAuthError('invalid_request', 'This form was already used. Start a new connection.'); }
    const deny = new URL(a.redirectUri); deny.searchParams.set('error','access_denied'); deny.searchParams.set('state',a.state); deny.searchParams.set('iss', c.origin);
    return new Response(null,{status:303,headers:{...oauthSecurityHeaders,Location:deny.href}});
  }
  const token = one(p,'api_token').trim();
  try { await validatePrintfulCredential(token); } catch (e) { if (e instanceof OAuthError) return view(e.safeMessage, e.status); throw e; }
  const code = random(); const grantId = `pf_grant_${random()}`; const cipher = await encryptCredential(token, grantId, env);
  // The form nonce and authorization code are committed together. Replayed forms fail closed.
  try { await env.DB.batch([
    env.DB.prepare('INSERT INTO oauth_form_nonces(nonce_hash,expires_at) VALUES(?,?)').bind(csrf.nonceHash, csrf.expires),
    env.DB.prepare('INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,challenge,resource,scope,grant_id,credential,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(await hashOAuthValue(code), a.client.id, a.redirectUri, a.challenge, a.resource, a.scope, grantId, cipher, now()+300),
    env.DB.prepare('DELETE FROM oauth_form_nonces WHERE expires_at < ?').bind(now()),
    env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now()),
  ]); } catch { throw new OAuthError('invalid_request', 'This form was already used. Start a new connection.'); }
  const target = new URL(a.redirectUri); target.searchParams.set('code',code); target.searchParams.set('state',a.state); target.searchParams.set('iss', c.origin);
  return new Response(null,{status:303,headers:{...oauthSecurityHeaders,Location:target.href,'Content-Security-Policy':`default-src 'none'; form-action 'self' ${formActions(c)}; base-uri 'none'; frame-ancestors 'none'`}});
}
async function exchange(c: Ctx, req: Request, env: OAuthEnv) {
  await rate(req, env, 'token', 1200); const p = await form(req); const grantType = one(p,'grant_type');
  const clientId = field(one(p,'client_id'),128,'client_id'); const resource = resourceOf(c, one(p,'resource'));
  const client = await env.DB.prepare('SELECT id,redirect_uri,name FROM oauth_clients WHERE id=?').bind(clientId).first<Client>(); if (!client) throw new OAuthError('invalid_client','Unknown client.',401);
  const access = random(); const refresh = random(); const accessHash = await hashOAuthValue(access); const refreshHash = await hashOAuthValue(refresh); let grantedScope = SCOPE;
  if (grantType === 'authorization_code') {
    const code = field(one(p,'code'),128,'code'); const redirect = redirectOf(c, one(p,'redirect_uri')); const verifier = one(p,'code_verifier'); if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant','Invalid authorization code or PKCE verifier.');
    const challenge = await hashOAuthValue(verifier); const codeHash = await hashOAuthValue(code);
    // Single use: consume the code first (by hash + client), then check PKCE/redirect/resource. A wrong verifier burns it.
    const row = await env.DB.prepare('DELETE FROM oauth_codes WHERE code_hash=? AND client_id=? RETURNING client_id,redirect_uri,challenge,resource,scope,grant_id,credential,expires_at').bind(codeHash,clientId).first<CodeRow>();
    if (!row) {
      // Replay of an already-redeemed code: revoke the grant it produced (RFC 6749 §4.1.2).
      await env.DB.prepare("UPDATE oauth_grants SET revoked=1,credential='' WHERE code_hash=?").bind(codeHash).run();
      throw new OAuthError('invalid_grant','Invalid, expired or already-used authorization code.');
    }
    if (row.expires_at <= now() || row.redirect_uri !== redirect || row.challenge !== challenge || row.resource !== resource) throw new OAuthError('invalid_grant','Invalid, expired or already-used authorization code.');
    await decryptCredential(row.credential,row.grant_id,env); grantedScope = scopeOf(row.scope);
    await env.DB.prepare('INSERT INTO oauth_grants(id,client_id,resource,scope,credential,access_hash,access_expires,refresh_hash,refresh_expires,revoked,code_hash) VALUES(?,?,?,?,?,?,?,?,?,0,?)').bind(row.grant_id,clientId,resource,grantedScope,row.credential,accessHash,now()+3600,refreshHash,now()+2592000,codeHash).run();
  } else if (grantType === 'refresh_token') {
    const old = field(one(p,'refresh_token'),128,'refresh_token'); if (p.has('scope')) scopeOf(one(p,'scope'));
    const oldHash = await hashOAuthValue(old);
    // D1 serializes this compare-and-swap: the old refresh hash can succeed exactly once.
    const row = await env.DB.prepare('UPDATE oauth_grants SET access_hash=?,access_expires=?,refresh_hash=?,prev_refresh_hash=? WHERE refresh_hash=? AND client_id=? AND resource=? AND refresh_expires>? AND revoked=0 RETURNING id,client_id,resource,scope,credential,access_expires,refresh_expires,revoked').bind(accessHash,now()+3600,refreshHash,oldHash,oldHash,clientId,resource,now()).first<GrantRow>();
    if (!row) {
      // Reuse of a rotated refresh token signals theft: revoke the whole grant (RFC 9700 §4.14).
      await env.DB.prepare("UPDATE oauth_grants SET revoked=1,credential='' WHERE prev_refresh_hash=? AND client_id=?").bind(oldHash,clientId).run();
      throw new OAuthError('invalid_grant','Expired, revoked or already-used refresh token. Reconnect Printful.');
    }
    await decryptCredential(row.credential,row.id,env); grantedScope = scopeOf(row.scope);
  } else throw new OAuthError('unsupported_grant_type','Use authorization_code or refresh_token.');
  return json({ access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:grantedScope,resource });
}
async function revoke(req: Request, env: OAuthEnv) {
  await rate(req,env,'revoke',60);const p=await form(req);const token=field(one(p,'token'),128,'token');const client=field(one(p,'client_id'),128,'client_id');
  const digest=await hashOAuthValue(token);await env.DB.prepare("UPDATE oauth_grants SET revoked=1,credential='' WHERE client_id=? AND (access_hash=? OR refresh_hash=?)").bind(client,digest,digest).run();return json({});
}
export async function authenticateOAuth(req: Request, env: OAuthEnv): Promise<{ token: string; grantId: string; scope: string } | null> {
  const c = contextFor(req, env);
  const token=/^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.get('Authorization')??'')?.[1];if(!token)return null;
  const row=await env.DB.prepare('SELECT id,client_id,resource,scope,credential,access_expires,refresh_expires,revoked FROM oauth_grants WHERE access_hash=? AND access_expires>? AND revoked=0').bind(await hashOAuthValue(token),now()).first<GrantRow>();
  if(!row||row.resource!==c.resource||row.scope!==SCOPE)return null;
  try{return{token:await decryptCredential(row.credential,row.id,env),grantId:row.id,scope:row.scope};}catch{return null;}
}
export async function handleOAuth(req: Request, env: OAuthEnv, renderer: AuthorizationRenderer = defaultAuthorizationPage): Promise<Response> {
  try {
    const c = contextFor(req, env);
    const reqUrl = new URL(req.url); const path=reqUrl.pathname;
    // Consent must run on the canonical origin (issuer, form action and CSP all use it).
    if (path==='/api/oauth/authorize' && req.method==='GET' && reqUrl.origin!==c.origin) return new Response(null,{status:308,headers:{...oauthSecurityHeaders,Location:c.origin+path+reqUrl.search}});
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{...oauthSecurityHeaders,'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'}});
    if(req.method==='GET'&&path==='/.well-known/oauth-authorization-server')return json(oauthMetadata(c));
    if(req.method==='GET'&&path===RESOURCE_METADATA_PATH)return json(protectedResourceMetadata(c));
    if(path==='/api/oauth/authorize'&&(req.method==='GET'||req.method==='POST'))return await authorize(c,req,env,renderer);
    if(req.method==='POST'&&path==='/api/oauth/register')return await registration(c,req,env);
    if(req.method==='POST'&&path==='/api/oauth/token')return await exchange(c,req,env);
    if(req.method==='POST'&&path==='/api/oauth/revoke')return await revoke(req,env);
    return json({error:'not_found'},404);
  } catch(e){return err(e);}
}
