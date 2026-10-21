// Printful REST client (v1 + v2) for Workers runtime. Token and default store come from Site secrets.

export const PRINTFUL_BASE = 'https://api.printful.com';
const PRINTFUL_ORIGIN = new URL(PRINTFUL_BASE).origin;
// Relative API paths only: no scheme, no query/fragment, no dot segments, no control characters.
const SAFE_PATH = /^\/(?:[A-Za-z0-9_\-@]+\/?)*[A-Za-z0-9_\-@]*$/;

/** Validate an id that is interpolated into a URL path (numeric id, external id, or "@external_id"). */
export function pathId(value: unknown, field = 'id'): string {
  const s = String(value ?? '');
  if (!/^@?[A-Za-z0-9_-]{1,64}$/.test(s)) {
    throw new Error(`Invalid ${field} "${s.slice(0, 80)}": use a numeric id or @external_id (letters, digits, - and _).`);
  }
  return s;
}

/** Path for printful_api: must stay on api.printful.com and must not touch confirmation endpoints. */
export function assertSafePath(path: string): string {
  if (typeof path !== 'string' || !SAFE_PATH.test(path)) {
    throw new Error('path must be a relative Printful API path like /v2/catalog-products/71 (no scheme, query, fragment or dot segments).');
  }
  return path;
}

function retryAfterMs(h: Headers): number {
  const raw = h.get('Retry-After') ?? h.get('X-Ratelimit-Reset');
  if (!raw) return 2000;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(20, Math.max(1, secs)) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(20000, Math.max(1000, at - Date.now())) : 2000;
}

export class PrintfulError extends Error {
  constructor(
    public status: number,
    message: string,
    public raw: unknown,
    public method: string,
    public path: string,
  ) {
    super(`HTTP ${status} ${method} ${path}: ${message}`);
  }
  get needsStore(): boolean {
    return this.message.includes('requires `store_id`');
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export class Printful {
  constructor(
    private token: string,
    public storeId?: string,
    private language?: string,
  ) {}

  async request(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; store?: boolean; raw?: boolean } = {},
  ): Promise<any> {
    if (!this.token) throw new Error('PRINTFUL_API_TOKEN is not set (server secret, or env var for the stdio CLI).');
    if (!SAFE_PATH.test(path)) throw new Error(`Refusing unsafe Printful path: ${JSON.stringify(path).slice(0, 120)}`);
    const url = new URL(PRINTFUL_BASE + path);
    if (url.origin !== PRINTFUL_ORIGIN) throw new Error('Refusing request outside api.printful.com');
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'printful-mcp/1.0.0 (+https://github.com/michaljerzylew/printful-mcp)',
    };
    if (opts.store !== false && this.storeId) headers['X-PF-Store-Id'] = this.storeId;
    if (this.language) headers['X-PF-Language'] = this.language;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    let resp: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      resp = await fetch(url, { method, headers, body });
      if (resp.status === 429 && attempt < 3) {
        await sleep(retryAfterMs(resp.headers));
        continue;
      }
      if (resp.status >= 500 && method === 'GET' && attempt < 2) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      break;
    }
    if (opts.raw) return resp!;
    const text = await resp!.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!resp!.ok) {
      let msg = resp!.statusText;
      if (payload && typeof payload === 'object') {
        if (payload.error && typeof payload.error === 'object') msg = payload.error.message ?? msg;
        else if (typeof payload.result === 'string') msg = payload.result;
        else if (typeof payload.data === 'string') msg = payload.data;
      }
      throw new PrintfulError(resp!.status, msg, payload, method, url.pathname);
    }
    return payload ?? { status: resp!.status };
  }

  get = (path: string, query?: Query, store = true) => this.request('GET', path, { query, store });
  post = (path: string, body: unknown = {}, query?: Query, store = true) =>
    this.request('POST', path, { body, query, store });
  put = (path: string, body: unknown = {}) => this.request('PUT', path, { body });
  patch = (path: string, body: unknown = {}) => this.request('PATCH', path, { body });
  del = (path: string) => this.request('DELETE', path);

  static unwrap(p: any): any {
    if (p && typeof p === 'object') {
      if ('data' in p) return p.data;
      if ('result' in p) return p.result;
    }
    return p;
  }

  async paginate(path: string, query: Query = {}, max = 100, store = true): Promise<any[]> {
    const out: any[] = [];
    let offset = Number(query.offset ?? 0);
    const page = 100;
    for (;;) {
      const p = await this.get(path, { ...query, limit: Math.min(page, max - out.length), offset }, store);
      let items = Printful.unwrap(p);
      if (items && !Array.isArray(items) && Array.isArray(items.items)) items = items.items;
      items = items ?? [];
      out.push(...items);
      offset += items.length;
      const total = p?.paging?.total;
      if (out.length >= max || !items.length || items.length < page || (total !== undefined && offset >= total)) {
        return out.slice(0, max);
      }
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── pricing ──────────────────────────────────────────────────────────────

export type Placement = {
  placement: string;
  technique?: string;
  layers?: { type: 'file'; url: string; position?: { width: number; height: number; top: number; left: number } }[];
  placement_options?: { name: string; value: unknown }[];
};

const c2 = (n: number) => Math.round(n * 100) / 100;
const s2 = (n: number) => c2(n).toFixed(2);

export async function catalogCost(
  pf: Printful,
  variantId: number,
  placements: Placement[],
  quantity = 1,
  currency?: string,
  region?: string,
) {
  const prices = Printful.unwrap(
    await pf.get(`/v2/catalog-variants/${variantId}/prices`, { currency, selling_region_name: region }, false),
  );
  const available: any[] = prices.product?.placements ?? [];
  const order = available.map((p) => p.id);
  const variant = prices.variant ?? prices.variants?.[0] ?? {};
  const techniques: Record<string, any> = Object.fromEntries(
    (variant.techniques ?? []).map((t: any) => [t.technique_key, t]),
  );
  let technique = placements[0]?.technique ?? Object.keys(techniques)[0];
  if (!techniques[technique]) {
    throw new Error(`Technique '${technique}' not available for variant ${variantId}; available: ${Object.keys(techniques)}`);
  }
  const base = Number(techniques[technique].discounted_price ?? techniques[technique].price);
  const breakdown: { item: string; price: string }[] = [{ item: `base (${technique})`, price: s2(base) }];
  let total = base;
  const unknown = placements.filter((p) => !order.includes(p.placement)).map((p) => p.placement);
  if (unknown.length) throw new Error(`Unknown placements ${unknown}; available: ${order.join(', ')}`);
  const chosen = [...placements].sort((a, b) => order.indexOf(a.placement) - order.indexOf(b.placement));
  let includedDone = false;
  for (const p of chosen) {
    const tech = p.technique ?? technique;
    const meta = available.find((a) => a.id === p.placement && a.technique_key === tech) ?? available.find((a) => a.id === p.placement);
    if (meta.technique_key && meta.technique_key !== tech) {
      throw new Error(`Placement ${p.placement} is printed with ${meta.technique_key}, not ${tech}`);
    }
    const layerExtra = (meta.layers ?? []).reduce((n: number, l: any) => n + Number(l.additional_price ?? 0), 0);
    const price = Number(meta.discounted_price ?? meta.price) + layerExtra;
    const special = p.placement.startsWith('label_') || (p.placement.includes('large') && meta.technique_key === 'embroidery');
    if (!includedDone && !special) {
      includedDone = true;
      breakdown.push({ item: `placement ${p.placement} (included)`, price: '0.00' });
    } else {
      breakdown.push({ item: `placement ${p.placement}`, price: s2(price) });
      total += price;
    }
    for (const opt of p.placement_options ?? []) {
      const mo = (meta.placement_options ?? []).find((m: any) => m.name === opt.name);
      const op = Number(mo?.price?.[String(opt.value).toLowerCase()] ?? 0);
      if (op) {
        breakdown.push({ item: `option ${opt.name}=${opt.value} @ ${p.placement}`, price: s2(op) });
        total += op;
      }
    }
  }
  return {
    variant_id: variantId,
    currency: prices.currency,
    technique,
    unit_cost: s2(total),
    quantity,
    line_cost: s2(total * quantity),
    breakdown,
    discount_tiers: prices.discount_tiers,
    note: 'Catalog production cost; excludes shipping, VAT and volume discounts. Use printful_estimate_order for exact totals.',
  };
}

export function retailPrice(o: {
  cost: number;
  shipping?: number;
  include_shipping?: boolean;
  markup_pct?: number;
  markup_fixed?: number;
  target_margin_pct?: number;
  vat_rate?: number;
  round_to?: number | null;
  payment_fee_pct?: number;
  payment_fee_fixed?: number;
  min_margin_pct?: number;
}) {
  const cost = o.cost + (o.include_shipping ? (o.shipping ?? 0) : 0);
  const vat = o.vat_rate ?? 0;
  const feePct = (o.payment_fee_pct ?? 0) / 100;
  const feeFix = o.payment_fee_fixed ?? 0;
  let net: number;
  if (o.target_margin_pct !== undefined && o.target_margin_pct !== null) {
    const m = o.target_margin_pct / 100;
    const denom = 1 - m - feePct * (1 + vat);
    if (m >= 1 || denom <= 0) throw new Error('Margin + payment fee must be < 100%');
    net = (cost + feeFix) / denom;
  } else {
    net = cost * (1 + (o.markup_pct ?? 0) / 100) + (o.markup_fixed ?? 0);
  }
  let gross = net * (1 + vat);
  const r = o.round_to === undefined ? 0.99 : o.round_to;
  if (r === null) gross = c2(gross);
  else if (r === 0) gross = Math.ceil(gross - 1e-9);
  else if (r < 1) {
    let cand = Math.floor(gross) + r;
    if (cand < gross - 1e-9) cand += 1;
    gross = c2(cand);
  } else gross = Math.ceil(gross / r - 1e-9) * r;
  net = gross / (1 + vat);
  const fees = gross * feePct + feeFix;
  const profit = net - cost - fees;
  const margin = net ? (profit / net) * 100 : 0;
  return {
    cost: s2(cost),
    price_gross: s2(gross),
    price_net: s2(net),
    vat: s2(gross - net),
    payment_fees: s2(fees),
    profit: s2(profit),
    margin_pct: s2(margin),
    markup_pct: s2(cost ? (profit / cost) * 100 : 0),
    shipping_in_price: !!o.include_shipping,
    ...(o.min_margin_pct !== undefined ? { margin_ok: margin >= o.min_margin_pct } : {}),
  };
}

export async function estimateOrder(pf: Printful, body: any, timeoutMs = 20000) {
  const req: any = {
    recipient: pick(body.recipient ?? {}, ['country_code', 'state_code', 'zip']),
    order_items: body.order_items,
  };
  if (body.retail_costs) req.retail_costs = body.retail_costs;
  let task = Printful.unwrap(await pf.post('/v2/order-estimation-tasks', req));
  const id = task.id;
  const deadline = Date.now() + timeoutMs;
  while (['pending', 'processing', undefined].includes(task.status) && Date.now() < deadline) {
    await sleep(2000);
    task = Printful.unwrap(await pf.get('/v2/order-estimation-tasks', { id }));
  }
  if (!['pending', 'processing', undefined].includes(task.status)) return { api: 'v2', ...task };
  // v2 tasks can stay pending for minutes; fall back to synchronous v1 estimate.
  const v1 = Printful.unwrap(await pf.post('/orders/estimate-costs', v1EstimateBody(body)));
  const nonDefault = (body.order_items ?? []).some((i: any) => (i.placements ?? []).some((p: any) => p.technique && p.technique !== 'dtg'));
  return {
    api: 'v1',
    v2_task_id: id,
    status: 'completed',
    ...v1,
    ...(nonDefault ? { note: 'v1 fallback estimate uses each product\'s default technique; re-run printful_estimate_order later for an exact v2 figure.' } : {}),
  };
}

export function v1EstimateBody(body: any) {
  const r = { name: 'Estimate', address1: 'Estimate 1', city: 'Estimate', ...(body.recipient ?? {}) };
  const items = (body.order_items ?? []).map((it: any) => {
    if (it.source === 'product_template') {
      return { variant_id: it.catalog_variant_id, product_template_id: it.product_template_id, quantity: it.quantity ?? 1 };
    }
    const files = (it.placements ?? []).flatMap((p: any) =>
      (p.layers ?? []).filter((l: any) => l.url).map((l: any) => ({ type: p.placement, url: l.url })),
    );
    const v1: any = { variant_id: it.catalog_variant_id, quantity: it.quantity ?? 1, files };
    if (it.product_options?.length) v1.options = it.product_options.map((o: any) => ({ id: o.name, value: o.value }));
    if (it.retail_price) v1.retail_price = it.retail_price;
    return v1;
  });
  return { recipient: r, items };
}

export function pick<T extends object>(o: T, keys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined && v !== null && v !== '')) as Partial<T>;
}

/**
 * Shop order number → Printful external_id. Must be used verbatim: silent rewriting would make "A/1" and "A-1"
 * collide and let idempotency return (and confirm) someone else's order.
 */
export function externalId(id: unknown): string {
  const s = String(id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(s)) {
    throw new Error(`Shop order id "${s.slice(0, 64)}" cannot be a Printful external_id: use 1–32 characters from A-Z a-z 0-9 - _ (e.g. map "#1001" to "1001").`);
  }
  return s;
}
