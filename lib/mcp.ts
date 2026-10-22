// Stateless MCP server over Streamable HTTP (JSON responses) with the Skills extension (SEP-2640).

import { Printful } from './printful';
import { SKILLS, type Skill } from './skills.generated';
import { TOOLS, toolError } from './tools';
import { authenticateOAuth, contextFor, enforceMcpRateLimit, enforceMcpSourceLimit, SCOPE, type Ctx, type OAuthEnv } from './oauth';

export const SERVER_INFO = {
  name: 'printful-mcp',
  title: 'Printful MCP',
  version: '1.2.0',
  websiteUrl: 'https://github.com/michaljerzylew/printful-mcp',
};
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2026-07-28'];
const LATEST_VERSION = '2025-11-25';
const SKILLS_EXT = 'io.modelcontextprotocol/skills';
const CACHE = { ttlMs: 300000, cacheScope: 'public' };
const MAX_RESULT_CHARS = 90000;
const OAUTH_SCHEMES = [{ type: 'oauth2', scopes: [SCOPE] }];

const INSTRUCTIONS = `Printful print-on-demand operator for an independent shop. Printful prints and ships each shop order directly to the customer.
Before any order work, load the skill "printful-fulfillment" (skill://printful-fulfillment/SKILL.md; also available via the printful_skill tool).
Money rule: printful_confirm_order and printful_fulfill_shop_order with confirm=true charge the owner's Printful balance — only after the user explicitly asks to send/confirm, and always with max_cost. Otherwise create drafts or use dry_run.
Pricing: printful_calc_cost (production), printful_shipping_rates, printful_estimate_order (exact total), printful_calc_retail / printful_quote (shop price, margin, VAT).`;

type Json = Record<string, any>;
export type Env = Record<string, any>;

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

const enc = new TextEncoder();

function skillUri(s: Skill, path = 'SKILL.md') {
  return `skill://${s.name}/${path}`;
}

function skillEntry(s: Skill) {
  return {
    uri: skillUri(s),
    frontmatter: s.frontmatter,
    resources: s.files.map((f) => ({ uri: skillUri(s, f.path), digest: f.digest, size: f.size })),
  };
}

function findFile(uri: string) {
  for (const s of SKILLS) for (const f of s.files) if (skillUri(s, f.path) === uri) return { skill: s, file: f };
  return null;
}

function capabilities() {
  return {
    tools: { listChanged: false },
    resources: { listChanged: false, subscribe: false },
    prompts: { listChanged: false },
    extensions: { [SKILLS_EXT]: { directoryRead: true } },
  };
}

function directoryChildren(uri: string) {
  const prefix = uri.replace(/\/$/, '') + '/';
  const seen = new Map<string, Json>();
  for (const s of SKILLS) {
    for (const f of s.files) {
      const full = skillUri(s, f.path);
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      const [head, ...tail] = rest.split('/');
      if (tail.length) seen.set(head, { uri: prefix + head, name: head, mimeType: 'inode/directory' });
      else seen.set(head, { uri: full, name: head, mimeType: 'text/markdown' });
    }
  }
  return [...seen.values()];
}

export async function handleRpc(msg: Json, env: Env): Promise<Json | null> {
  const isNotification = !('id' in msg);
  try {
    const result = await dispatch(msg.method, msg.params ?? {}, env);
    if (isNotification) return null;
    return { jsonrpc: '2.0', id: msg.id, result };
  } catch (e: any) {
    if (isNotification) return null;
    const err = e instanceof RpcError ? e : new RpcError(-32603, e?.message ?? String(e));
    return { jsonrpc: '2.0', id: msg.id, error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) } };
  }
}

async function dispatch(method: string, params: Json, env: Env): Promise<any> {
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
      return { protocolVersion, capabilities: capabilities(), serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
    }
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: capabilities(),
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
        ...CACHE,
      };
    case 'ping':
      return {};
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return {};

    // ── tools ──
    case 'tools/list':
      return {
        tools: [
          ...TOOLS.map(({ run: _r, ...t }) =>
            env.AUTH_MODE === 'oauth' ? { ...t, securitySchemes: OAUTH_SCHEMES, _meta: { securitySchemes: OAUTH_SCHEMES } } : t,
          ),
          {
            name: 'printful_skill',
            title: 'Printful operating skill',
            description: 'Read the printful-fulfillment skill (workflows, money rules, formats). Call before order work if the host did not load skills. path: SKILL.md, references/pricing.md, references/order-format.md, references/mapping.md',
            inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Default SKILL.md' } } },
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
        ],
      };
    case 'tools/call': {
      const name = params.name;
      const args = params.arguments ?? {};
      if (name === 'printful_skill') {
        const hit = findFile(skillUri(SKILLS[0], args.path ?? 'SKILL.md'));
        if (!hit) throw new RpcError(-32602, `Unknown skill file ${args.path}`);
        return { content: [{ type: 'text', text: hit.file.text }] };
      }
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) throw new RpcError(-32602, `Unknown tool ${name}`);
      // Offline tools (retail calculator, dry runs, validation) work without a token; API calls fail with a clear hint.
      const pf = new Printful(env.PRINTFUL_API_TOKEN ?? '', env.PRINTFUL_STORE_ID ? String(env.PRINTFUL_STORE_ID) : undefined, env.PRINTFUL_LANGUAGE);
      try {
        const data = await tool.run(args, { pf, env });
        const text = JSON.stringify(data, null, 2) ?? 'null';
        if (text.length > MAX_RESULT_CHARS) {
          // Large results: return a truncated text view only, never the full payload.
          return {
            content: [{ type: 'text', text: `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated ${text.length - MAX_RESULT_CHARS} chars; narrow the query with filters or limit)` }],
            structuredContent: { truncated: true, total_chars: text.length },
          };
        }
        return {
          content: [{ type: 'text', text }],
          structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : { items: data },
        };
      } catch (e) {
        if (env.AUTH_MODE === 'oauth' && e instanceof Error && 'status' in e && ((e as any).status === 401 || (e as any).status === 403)) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Printful rejected this connection. Reconnect with a valid token that has the required permissions.' }],
            _meta: { 'mcp/www_authenticate': [oauthChallenge({ resourceMetadata: String(env.RESOURCE_METADATA) }, 'Reconnect your Printful account')] },
          };
        }
        return { isError: true, content: [{ type: 'text', text: toolError(e) }] };
      }
    }

    // ── skills extension (SEP-2640) ──
    case 'skills/list':
      return { resultType: 'complete', skills: SKILLS.map(skillEntry), ...CACHE };
    case 'skills/get': {
      const s = SKILLS.find((x) => skillUri(x) === params.uri);
      if (!s) throw new RpcError(-32602, `Unknown skill: ${params.uri}`);
      return { resultType: 'complete', skill: skillEntry(s), ...CACHE };
    }

    // ── resources ──
    case 'resources/list':
      return {
        resources: SKILLS.flatMap((s) =>
          s.files.map((f) => ({
            uri: skillUri(s, f.path),
            name: `${s.name}/${f.path}`,
            title: f.path === 'SKILL.md' ? `Skill: ${s.name}` : `${s.name} — ${f.path}`,
            description: f.path === 'SKILL.md' ? s.frontmatter.description : undefined,
            mimeType: 'text/markdown',
            size: f.size,
          })),
        ),
      };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read': {
      const hit = findFile(params.uri);
      if (!hit) throw new RpcError(-32602, `Unknown resource: ${params.uri}`);
      return { resultType: 'complete', contents: [{ uri: params.uri, mimeType: 'text/markdown', text: hit.file.text }], ...CACHE };
    }
    case 'resources/directory/read': {
      const uri = String(params.uri ?? '');
      const children = directoryChildren(uri);
      if (!children.length) throw new RpcError(-32602, `Unknown directory: ${uri}`);
      return { resultType: 'complete', resources: children };
    }

    // ── prompts ──
    case 'prompts/list':
      return {
        prompts: [
          { name: 'fulfill_order', title: 'Fulfil a shop order', description: 'Send a shop order to Printful safely (dry run → estimate → confirm with consent).', arguments: [{ name: 'order', description: 'Shop order JSON or description', required: true }] },
          { name: 'price_product', title: 'Price a product', description: 'Production cost, shipping and retail price for a product idea.', arguments: [{ name: 'product', description: 'e.g. black tee M with front+back print', required: true }, { name: 'country', description: 'Destination country', required: false }] },
        ],
      };
    case 'prompts/get': {
      const a = params.arguments ?? {};
      const skill = SKILLS[0].files[0].text;
      const text =
        params.name === 'fulfill_order'
          ? `${skill}\n\n---\nFulfil this shop order following the workflow above. Start with dry_run, then estimate, show me the cost and wait for my explicit confirmation before confirm=true.\n\n${a.order ?? ''}`
          : params.name === 'price_product'
            ? `${skill}\n\n---\nPrice this product: ${a.product ?? ''}. Destination: ${a.country ?? 'PL'}. Show production cost breakdown, shipping, exact estimate if possible and a suggested retail price at 40% margin incl. VAT.`
            : null;
      if (!text) throw new RpcError(-32602, `Unknown prompt ${params.name}`);
      return { messages: [{ role: 'user', content: { type: 'text', text } }] };
    }

    case 'logging/setLevel':
      return {};
    case 'completion/complete':
      return { completion: { values: [], hasMore: false } };
  }
  throw new RpcError(-32601, `Method not found: ${method}`);
}

// ── auth ─────────────────────────────────────────────────────────────────

function safeEqual(a: string, b: string) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

export function authorize(req: Request, env: Env): { ok: true; via: string } | { ok: false; reason: string } {
  const keys = String(env.MCP_API_KEYS ?? env.MCP_API_KEY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Identity headers are only trustworthy behind ChatGPT Sites, which sets them itself. Off unless explicitly enabled.
  const trustSites = String(env.TRUST_SITES_IDENTITY ?? '').toLowerCase() === 'true';
  const allowedEmails = trustSites
    ? String(env.ALLOWED_EMAILS ?? '')
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const auth = req.headers.get('authorization') ?? '';
  const bearer = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '';
  const queryKeyAllowed = String(env.ALLOW_QUERY_KEY ?? 'true').toLowerCase() !== 'false';
  const url = new URL(req.url);
  const candidates = [bearer, req.headers.get('x-api-key') ?? '', queryKeyAllowed ? (url.searchParams.get('key') ?? '') : ''].filter(Boolean);
  if (keys.length && candidates.some((c) => keys.some((k) => safeEqual(c, k)))) return { ok: true, via: 'api-key' };
  const email = (req.headers.get('oai-authenticated-user-email') ?? '').toLowerCase();
  if (trustSites && email && allowedEmails.includes(email)) return { ok: true, via: `chatgpt:${email}` };
  if (!keys.length && !allowedEmails.length) return { ok: false, reason: 'Server not configured: set MCP_API_KEY.' };
  return { ok: false, reason: 'Missing or invalid API key.' };
}

/** DNS-rebinding protection (MCP Streamable HTTP): browsers send Origin; reject unknown origins. */
export function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser clients
  const own = new URL(req.url).origin;
  const allowed = String(env.ALLOWED_ORIGINS ?? 'https://chatgpt.com,https://chat.openai.com,https://claude.ai')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return origin === own || allowed.includes('*') || allowed.includes(origin);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate',
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

export async function handleHttp(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'GET') {
    // No server-initiated stream in this stateless server.
    return new Response('Method Not Allowed: this MCP endpoint is stateless (POST only).', { status: 405, headers: { Allow: 'POST', ...CORS } });
  }
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });
  if (!originAllowed(req, env)) {
    await req.arrayBuffer().catch(() => undefined);
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } }, 403);
  }

  const auth = authorize(req, env);
  if (!auth.ok) {
    // Drain the request body: an unread body on a keep-alive connection makes workerd reset the next request.
    await req.arrayBuffer().catch(() => undefined);
    return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: auth.reason } }, 401, {
      'WWW-Authenticate': 'Bearer realm="printful-mcp", error="invalid_token"',
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  const pv = req.headers.get('mcp-protocol-version');
  if (pv && !SUPPORTED_VERSIONS.includes(pv)) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version ${pv}` } }, 400);
  }

  // JSON-RPC batching was removed from MCP in 2025-06-18; still accepted for older clients.
  const batch = Array.isArray(body);
  const msgs: any[] = batch ? body : [body];
  if (!msgs.length) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, 400);
  const responses = (
    await Promise.all(
      msgs.map((m) => {
        if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') {
          return Promise.resolve({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
        }
        if (typeof m.method !== 'string') return Promise.resolve(null); // a response from the client: acknowledge
        return handleRpc(m, env);
      }),
    )
  ).filter((r): r is Json => r !== null);
  if (!responses.length) return new Response(null, { status: 202, headers: CORS });
  const init = msgs.find((m) => m?.method === 'initialize');
  const extra: Record<string, string> = init ? { 'Mcp-Session-Id': crypto.randomUUID() } : {};
  return json(batch ? responses : responses[0], 200, extra);
}

// ── OAuth endpoint (/api/printful/mcp): each user connects their own Printful token ─────────────────────────

const oauthChallenge = (c: Pick<Ctx, 'resourceMetadata'>, description: string) =>
  `Bearer resource_metadata="${c.resourceMetadata}", error="invalid_token", error_description="${description}", scope="${SCOPE}"`;

/** Methods that never touch Printful and are safe before the user connects (discovery, skill, calculators). */
const PUBLIC_TOOLS = new Set(['printful_skill', 'printful_calc_retail']);

/**
 * Per-user MCP endpoint for ChatGPT plugins / Sites and other OAuth clients. Discovery works anonymously; calling an
 * API tool requires an OAuth access token, which resolves to that user's encrypted Printful token. A server-wide
 * PRINTFUL_API_TOKEN is never used here, so one deployment can safely serve many users.
 */
export async function handleOAuthMcp(req: Request, env: Env): Promise<Response> {
  const c = contextFor(req, env as { PUBLIC_ORIGIN?: string });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'GET') return new Response('Method Not Allowed: POST JSON-RPC to this endpoint.', { status: 405, headers: { Allow: 'POST', ...CORS } });
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });
  if (!originAllowed(req, env)) {
    await req.arrayBuffer().catch(() => undefined);
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } }, 403);
  }
  if (!env.DB || !env.CONNECTOR_ENCRYPTION_KEY) {
    await req.arrayBuffer().catch(() => undefined);
    return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'OAuth is not configured: bind D1 as DB and set CONNECTOR_ENCRYPTION_KEY.' } }, 503);
  }

  let body: any;
  try {
    const text = await readBounded(req, 262144);
    body = JSON.parse(text);
  } catch (e) {
    return json({ jsonrpc: '2.0', id: null, error: { code: e instanceof RangeError ? -32600 : -32700, message: e instanceof RangeError ? 'Request too large' : 'Parse error' } }, e instanceof RangeError ? 413 : 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'One JSON-RPC 2.0 request per POST is required.' } }, 400);
  }

  // Per-user endpoint: tools see an allowlisted env only. Never the operator's token, store, money ceiling
  // (MAX_AUTO_CONFIRM_COST), packing slip, SKU mapping or secrets. Each connected user brings their own settings.
  const requestEnv: Env = {
    AUTH_MODE: 'oauth',
    RESOURCE_METADATA: c.resourceMetadata,
    DEFAULT_CURRENCY: env.DEFAULT_CURRENCY,
    DEFAULT_REGION: env.DEFAULT_REGION,
  };
  const needsPrintful = body.method === 'tools/call' && !PUBLIC_TOOLS.has(body.params?.name);
  if (needsPrintful) {
    const oauthEnv = env as unknown as OAuthEnv;
    let grant: Awaited<ReturnType<typeof authenticateOAuth>> = null;
    try {
      if (!(await enforceMcpSourceLimit(req, oauthEnv))) return json({ error: 'Too many requests. Retry shortly.' }, 429, { 'Retry-After': '60' });
      grant = await authenticateOAuth(req, oauthEnv);
      if (grant && !(await enforceMcpRateLimit(req, oauthEnv, grant.grantId))) {
        return json({ error: 'Too many requests for this connection. Retry shortly.' }, 429, { 'Retry-After': '60' });
      }
    } catch {
      return json({ error: 'Temporarily unable to verify the connection.' }, 503);
    }
    if (!grant) {
      const challenge = oauthChallenge(c, 'Connect your Printful account');
      return json(
        { jsonrpc: '2.0', id: body.id ?? null, result: { isError: true, content: [{ type: 'text', text: 'Connect your Printful account to continue.' }], _meta: { 'mcp/www_authenticate': [challenge] } } },
        401,
        { 'WWW-Authenticate': challenge },
      );
    }
    requestEnv.PRINTFUL_API_TOKEN = grant.token;
  }
  const response = await handleRpc(body, requestEnv);
  if (!response) return new Response(null, { status: 202, headers: CORS });
  return json(response);
}

async function readBounded(req: Request, max: number): Promise<string> {
  if (Number(req.headers.get('content-length') ?? 0) > max) throw new RangeError('too large');
  const reader = req.body?.getReader();
  if (!reader) throw new SyntaxError('empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = setTimeout(() => void reader.cancel(), 10000);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > max) {
        await reader.cancel();
        throw new RangeError('too large');
      }
      chunks.push(part.value);
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}
