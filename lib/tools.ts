// MCP tool catalogue: every Printful scope of the token + calculator + shop fulfillment.

import { buildPrintfulOrder, MappingError } from './mapping';
import { assertDesignUrl, assertDesignUrls, assertSafePath, catalogCost, estimateOrder, externalId, pathId, Printful, PrintfulError, retailPrice, type Placement } from './printful';

export type Ctx = { pf: Printful; env: Record<string, any> };

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: any;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: any, ctx: Ctx) => Promise<any>;
};

const S = {
  str: (description: string) => ({ type: 'string', description }),
  int: (description: string) => ({ type: 'integer', description }),
  num: (description: string) => ({ type: 'number', description }),
  bool: (description: string) => ({ type: 'boolean', description }),
  obj: (description: string) => ({ type: 'object', description, additionalProperties: true }),
  arr: (description: string, items: any = { type: 'object', additionalProperties: true }) => ({ type: 'array', description, items }),
};

const storeId = S.str('Printful store id. Defaults to the Site secret PRINTFUL_STORE_ID.');
const orderId = S.str('Printful order id, or "@" + external id (your shop order number), e.g. "@SHOP-1001".');
const placementSchema = {
  type: 'object',
  properties: {
    placement: S.str('Placement id, e.g. front, back, sleeve_left, label_inside, embroidery_chest_left, embroidery_front.'),
    technique: S.str('dtg, embroidery, dtfilm, sublimation, cut-sew, uv, …'),
    layers: S.arr('File layers (public URLs). Required for orders/mockups, optional for pricing.', {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['file'] },
        url: S.str('Public PNG/JPG/PDF URL.'),
        position: S.obj('Optional {width,height,top,left} in inches within the print area.'),
      },
      required: ['url'],
    }),
    placement_options: S.arr('e.g. [{"name":"unlimited_color","value":true}]'),
  },
  required: ['placement'],
};
const recipientSchema = {
  type: 'object',
  properties: {
    country_code: S.str('ISO-2 country, e.g. PL, DE, US.'),
    state_code: S.str('Required for US, CA, AU.'),
    zip: S.str('Postal code.'),
    city: S.str('City.'),
    address1: S.str('Street address.'),
  },
  required: ['country_code'],
};

export const WEBHOOK_EVENTS = [
  'order_created', 'order_updated', 'order_failed', 'order_canceled', 'order_put_hold', 'order_put_hold_approval', 'order_remove_hold',
  'shipment_sent', 'shipment_returned', 'shipment_out_of_stock', 'shipment_canceled', 'shipment_put_hold', 'shipment_put_hold_approval',
  'shipment_remove_hold', 'product_synced', 'product_updated', 'product_deleted', 'catalog_stock_updated', 'catalog_price_changed',
  'mockup_task_finished', 'approval_sheet_status_changed',
] as const;

function eventType(t: unknown): string {
  if (!WEBHOOK_EVENTS.includes(t as any)) throw new Error(`Unknown webhook event "${String(t)}". Allowed: ${WEBHOOK_EVENTS.join(', ')}`);
  return t as string;
}

/**
 * Fail-closed money gate. Returns null when confirmation may proceed, otherwise the reason to hold.
 * Requires a finite positive ceiling, finished cost calculation, a numeric total and (when given) a matching currency.
 */
export function moneyGate(order: any, maxCost: unknown, currency?: string): string | null {
  const max = typeof maxCost === 'string' && maxCost.trim() === '' ? NaN : Number(maxCost);
  if (maxCost === undefined || maxCost === null || !Number.isFinite(max) || max <= 0) {
    return 'max_cost (a positive number) is required to confirm an order';
  }
  const costs = order?.costs ?? {};
  if (costs.calculation_status !== undefined && costs.calculation_status !== 'done') {
    return `costs are still calculating (${costs.calculation_status}); retry in a moment`;
  }
  const total = Number(costs.total);
  if (costs.total === undefined || costs.total === null || !Number.isFinite(total)) return 'order total is not available yet; retry';
  if (currency && costs.currency && String(costs.currency).toUpperCase() !== String(currency).toUpperCase()) {
    return `order is charged in ${costs.currency}, max_cost was given in ${currency}`;
  }
  if (total > max) return `cost ${costs.total} ${costs.currency ?? ''} exceeds max_cost ${max}`.trim();
  return null;
}

/** Detect an idempotency hit that is actually a different order (same external_id, other recipient/items). */
export function sameOrderMismatch(existing: any, body: any): string | null {
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const er = existing?.recipient ?? {};
  const br = body?.recipient ?? {};
  for (const k of ['name', 'country_code', 'zip']) {
    if (br[k] !== undefined && norm(er[k]) !== norm(br[k])) return `recipient.${k} differs`;
  }
  const count = (items: any[]) => (items ?? []).reduce((n, i) => n + Number(i?.quantity ?? 1), 0);
  if (Array.isArray(existing?.order_items) && count(existing.order_items) !== count(body.order_items)) return 'item quantities differ';
  return null;
}

/** Endpoints that submit orders for production. printful_api must never reach them. */
export function isConfirmationCall(method: string, path: string, query?: Record<string, unknown>, body?: any): boolean {
  const m = method.toUpperCase();
  const p = path.replace(/\/+$/, '').toLowerCase();
  if (/^\/v2\/orders\/[^/]+\/confirmation$/.test(p)) return true;
  if (/^\/orders\/[^/]+\/confirm$/.test(p)) return true;
  if (/^\/v2\/approval-sheets|^\/approval-sheets/.test(p) && m !== 'GET') return true;
  const truthy = (v: unknown) => v === true || ['true', '1', 'yes'].includes(String(v).toLowerCase());
  if ((p === '/orders' || /^\/orders\/[^/]+$/.test(p)) && (m === 'POST' || m === 'PUT')) {
    if (truthy(query?.confirm) || truthy(body?.confirm)) return true;
  }
  return false;
}

const RO = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

const U = Printful.unwrap;

function withStore(ctx: Ctx, args: any): Printful {
  if (args?.store_id) ctx.pf.storeId = String(args.store_id);
  return ctx.pf;
}

function catalogItems(items: any[], placements?: Placement[]) {
  return items.map((i) => ({
    source: 'catalog',
    catalog_variant_id: Number(i.catalog_variant_id ?? i.variant_id),
    quantity: Number(i.quantity ?? 1),
    ...((i.placements ?? placements)?.length ? { placements: i.placements ?? placements } : {}),
  }));
}

function shippingItems(items: any[]) {
  return items.map((i) =>
    i.warehouse_variant_id
      ? { source: 'catalog', warehouse_variant_id: i.warehouse_variant_id, quantity: i.quantity ?? 1 }
      : {
          source: 'catalog',
          catalog_variant_id: Number(i.catalog_variant_id),
          quantity: Number(i.quantity ?? 1),
          ...(i.placements?.length
            ? { placements: i.placements.map((p: any) => ({ placement: p.placement, technique: p.technique, ...(p.placement_options ? { placement_options: p.placement_options } : {}) })) }
            : {}),
        },
  );
}

function slim(list: any[], keys: string[]) {
  return list.map((x) => Object.fromEntries(keys.map((k) => [k, x?.[k]])));
}

function mappingFrom(args: any, env: Record<string, any>) {
  if (args.mapping) return args.mapping;
  if (env.SKU_MAPPING_JSON) {
    try {
      return JSON.parse(env.SKU_MAPPING_JSON);
    } catch {
      throw new MappingError('Site secret SKU_MAPPING_JSON is not valid JSON');
    }
  }
  return undefined;
}

export const TOOLS: Tool[] = [
  // ── account & stores ─────────────────────────────────────────────────
  {
    name: 'printful_whoami',
    title: 'Printful account check',
    description: 'Token scopes, stores visible to the token and the default store. Call first when anything fails.',
    inputSchema: { type: 'object', properties: {} },
    annotations: RO,
    run: async (_a, { pf }) => {
      const scopes = U(await pf.get('/v2/oauth-scopes', undefined, false));
      const stores = U(await pf.get('/v2/stores', undefined, false));
      return { scopes: (scopes ?? []).map((s: any) => s.value ?? s.scope ?? s), stores, default_store_id: pf.storeId ?? null };
    },
  },
  {
    name: 'printful_stores_list',
    title: 'List stores',
    description: 'List Printful stores (id, name, type).',
    inputSchema: { type: 'object', properties: {} },
    annotations: RO,
    run: async (_a, { pf }) => U(await pf.get('/v2/stores', undefined, false)),
  },
  {
    name: 'printful_store_get',
    title: 'Store details',
    description: 'Details of one store.',
    inputSchema: { type: 'object', properties: { store_id: storeId } },
    annotations: RO,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      if (!pf.storeId) throw new Error('store_id required');
      return U(await pf.get(`/v2/stores/${pathId(pf.storeId, 'store_id')}`, undefined, false));
    },
  },
  {
    name: 'printful_store_statistics',
    title: 'Store statistics',
    description: 'Sales, costs and profit statistics for a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        date_from: S.str('YYYY-MM-DD'),
        date_to: S.str('YYYY-MM-DD'),
        currency: S.str('Currency code'),
        report_types: S.str('Comma list: sales_and_costs, profit, average_fulfillment_type, costs_by_amount, costs_by_product, costs_by_variant, printful_costs, sales_and_costs_summary, total_paid_orders'),
      },
      required: ['date_from', 'date_to'],
    },
    annotations: RO,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      if (!pf.storeId) throw new Error('store_id required (or set PRINTFUL_STORE_ID)');
      return U(
        await pf.get(`/v2/stores/${pathId(pf.storeId, 'store_id')}/statistics`, {
          date_from: a.date_from,
          date_to: a.date_to,
          currency: a.currency,
          report_types: a.report_types ?? 'sales_and_costs,profit,costs_by_product,total_paid_orders',
        }, false),
      );
    },
  },
  {
    name: 'printful_store_packing_slip',
    title: 'Set store packing slip',
    description: 'Set default packing-slip branding for the store (email, phone, message, logo_url, store_name, custom_order_id).',
    inputSchema: {
      type: 'object',
      properties: { store_id: storeId, email: S.str(''), phone: S.str(''), message: S.str(''), logo_url: S.str(''), store_name: S.str(''), custom_order_id: S.str('') },
    },
    annotations: WRITE,
    run: async (a, ctx) => {
      const { store_id: _s, ...body } = a;
      return U(await withStore(ctx, a).post('/store/packing-slip', body));
    },
  },

  // ── catalog ──────────────────────────────────────────────────────────
  {
    name: 'printful_catalog_search',
    title: 'Search catalog',
    description: 'Search Printful catalog products by text (name, type, brand, model) with optional filters. Returns product ids.',
    inputSchema: {
      type: 'object',
      properties: {
        query: S.str('Text filter, e.g. "hoodie", "3001", "mug".'),
        category_ids: S.str('Comma list of category ids.'),
        techniques: S.str('Comma list: dtg, embroidery, sublimation, dtfilm, …'),
        placements: S.str('Comma list of placement ids.'),
        selling_region_name: S.str('worldwide, europe, north_america, uk, …'),
        destination_country: S.str('Only products shippable to this ISO-2 country.'),
        limit: S.int('Max results (default 25).'),
      },
    },
    annotations: RO,
    run: async (a, { pf }) => {
      const { query, limit = 25, ...filters } = a;
      const all = await pf.paginate('/v2/catalog-products', filters, query ? 2000 : limit, false);
      const q = (query ?? '').toLowerCase();
      const hits = q
        ? all.filter((p) => [p.name, p.type, p.brand, p.model].some((v) => String(v ?? '').toLowerCase().includes(q)))
        : all;
      return slim(hits.slice(0, limit), ['id', 'type', 'name', 'brand', 'model', 'variant_count', 'is_discontinued']);
    },
  },
  {
    name: 'printful_catalog_product',
    title: 'Catalog product',
    description: 'Full catalog product: techniques, placements, sizes, colors, options.',
    inputSchema: { type: 'object', properties: { product_id: S.int(''), selling_region_name: S.str('') }, required: ['product_id'] },
    annotations: RO,
    run: async (a, { pf }) => U(await pf.get(`/v2/catalog-products/${pathId(a.product_id, 'product_id')}`, { selling_region_name: a.selling_region_name }, false)),
  },
  {
    name: 'printful_catalog_variants',
    title: 'Catalog variants',
    description: 'Variants of a product (variant id = catalog_variant_id for orders). Filter by color/size.',
    inputSchema: { type: 'object', properties: { product_id: S.int(''), color: S.str(''), size: S.str('') }, required: ['product_id'] },
    annotations: RO,
    run: async (a, { pf }) => {
      let v = await pf.paginate(`/v2/catalog-products/${pathId(a.product_id, 'product_id')}/catalog-variants`, {}, 1000, false);
      if (a.color) v = v.filter((x) => String(x.color).toLowerCase() === a.color.toLowerCase());
      if (a.size) v = v.filter((x) => String(x.size).toLowerCase() === a.size.toLowerCase());
      return slim(v, ['id', 'color', 'color_code', 'size', 'name', 'placement_dimensions']);
    },
  },
  {
    name: 'printful_catalog_categories',
    title: 'Catalog categories',
    description: 'List catalog categories, or one category by id.',
    inputSchema: { type: 'object', properties: { category_id: S.int('') } },
    annotations: RO,
    run: async (a, { pf }) =>
      U(await pf.get(a.category_id ? `/v2/catalog-categories/${pathId(a.category_id, 'category_id')}` : '/v2/catalog-categories', undefined, false)),
  },
  {
    name: 'printful_catalog_prices',
    title: 'Catalog price list',
    description: 'Production price list for a product or variant: techniques, placements, options.',
    inputSchema: {
      type: 'object',
      properties: { product_id: S.int(''), variant_id: S.int('If given, prices for this variant only.'), currency: S.str('EUR, USD, PLN, …'), selling_region_name: S.str('') },
    },
    annotations: RO,
    run: async (a, { pf }) =>
      U(
        await pf.get(
          a.variant_id ? `/v2/catalog-variants/${pathId(a.variant_id, 'variant_id')}/prices` : `/v2/catalog-products/${pathId(a.product_id, 'product_id')}/prices`,
          { currency: a.currency, selling_region_name: a.selling_region_name },
          false,
        ),
      ),
  },
  {
    name: 'printful_catalog_sizes',
    title: 'Size guide',
    description: 'Size guide for a product.',
    inputSchema: { type: 'object', properties: { product_id: S.int(''), unit: { type: 'string', enum: ['cm', 'inches'] } }, required: ['product_id'] },
    annotations: RO,
    run: async (a, { pf }) => U(await pf.get(`/v2/catalog-products/${pathId(a.product_id, 'product_id')}/sizes`, { unit: a.unit ?? 'cm' }, false)),
  },
  {
    name: 'printful_catalog_availability',
    title: 'Stock availability',
    description: 'Stock availability of a product or variant by region/technique.',
    inputSchema: { type: 'object', properties: { product_id: S.int(''), variant_id: S.int(''), techniques: S.str(''), selling_region_name: S.str('') } },
    annotations: RO,
    run: async (a, { pf }) =>
      U(
        await pf.get(
          a.variant_id ? `/v2/catalog-variants/${pathId(a.variant_id, 'variant_id')}/availability` : `/v2/catalog-products/${pathId(a.product_id, 'product_id')}/availability`,
          { techniques: a.techniques, selling_region_name: a.selling_region_name },
          false,
        ),
      ),
  },
  {
    name: 'printful_catalog_images',
    title: 'Blank product images',
    description: 'Blank product/variant images.',
    inputSchema: { type: 'object', properties: { product_id: S.int(''), variant_id: S.int(''), placement: S.str(''), colors: S.str('') } },
    annotations: RO,
    run: async (a, { pf }) =>
      U(
        await pf.get(
          a.variant_id ? `/v2/catalog-variants/${pathId(a.variant_id, 'variant_id')}/images` : `/v2/catalog-products/${pathId(a.product_id, 'product_id')}/images`,
          { placement: a.placement, colors: a.colors },
          false,
        ),
      ),
  },
  {
    name: 'printful_catalog_shipping_countries',
    title: 'Shipping countries',
    description: 'Countries a product ships to.',
    inputSchema: { type: 'object', properties: { product_id: S.int('') }, required: ['product_id'] },
    annotations: RO,
    run: async (a, { pf }) => U(await pf.get(`/v2/catalog-products/${pathId(a.product_id, 'product_id')}/shipping-countries`, undefined, false)),
  },
  {
    name: 'printful_catalog_mockup_templates',
    title: 'Print areas / mockup templates',
    description: 'Print-area geometry and template images per placement (use to size customer artwork).',
    inputSchema: { type: 'object', properties: { product_id: S.int(''), placements: S.str('Comma list') }, required: ['product_id'] },
    annotations: RO,
    run: async (a, { pf }) => pf.paginate(`/v2/catalog-products/${pathId(a.product_id, 'product_id')}/mockup-templates`, { placements: a.placements }, 200, false),
  },
  {
    name: 'printful_catalog_mockup_styles',
    title: 'Mockup styles',
    description: 'Mockup styles available for a product.',
    inputSchema: { type: 'object', properties: { product_id: S.int(''), placements: S.str('') }, required: ['product_id'] },
    annotations: RO,
    run: async (a, { pf }) => pf.paginate(`/v2/catalog-products/${pathId(a.product_id, 'product_id')}/mockup-styles`, { placements: a.placements }, 200, false),
  },
  {
    name: 'printful_catalog_printfiles',
    title: 'Print file requirements',
    description: 'Required print-file pixel sizes and DPI per placement (v1).',
    inputSchema: { type: 'object', properties: { product_id: S.int(''), technique: S.str('') }, required: ['product_id'] },
    annotations: RO,
    run: async (a, { pf }) => U(await pf.get(`/mockup-generator/printfiles/${pathId(a.product_id, 'product_id')}`, { technique: a.technique }, false)),
  },
  {
    name: 'printful_countries',
    title: 'Countries',
    description: 'Countries and states Printful ships to.',
    inputSchema: { type: 'object', properties: {} },
    annotations: RO,
    run: async (_a, { pf }) => slim(await pf.paginate('/v2/countries', {}, 500, false), ['code', 'name', 'region', 'states']),
  },

  // ── calculator ───────────────────────────────────────────────────────
  {
    name: 'printful_calc_cost',
    title: 'Production cost calculator',
    description: 'Production cost of one variant with placements and options (no store needed). First eligible placement is included in base price.',
    inputSchema: {
      type: 'object',
      properties: {
        variant_id: S.int('catalog_variant_id'),
        placements: S.arr('Placements to print.', placementSchema),
        quantity: S.int('Default 1.'),
        currency: S.str('Default EUR (Site var DEFAULT_CURRENCY).'),
        selling_region_name: S.str('Default europe (Site var DEFAULT_REGION).'),
      },
      required: ['variant_id'],
    },
    annotations: RO,
    run: async (a, { pf, env }) =>
      catalogCost(pf, a.variant_id, a.placements ?? [], a.quantity ?? 1, a.currency ?? env.DEFAULT_CURRENCY ?? 'EUR', a.selling_region_name ?? env.DEFAULT_REGION ?? 'europe'),
  },
  {
    name: 'printful_shipping_rates',
    title: 'Shipping rates',
    description: 'Shipping methods and rates to a destination for given items (needs store).',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        recipient: recipientSchema,
        items: S.arr('[{catalog_variant_id, quantity, placements?}]'),
        currency: S.str(''),
      },
      required: ['recipient', 'items'],
    },
    annotations: RO,
    run: async (a, ctx) =>
      U(
        await withStore(ctx, a).post('/v2/shipping-rates', {
          recipient: a.recipient,
          order_items: shippingItems(a.items),
          ...(a.currency ? { currency: a.currency } : {}),
        }),
      ),
  },
  {
    name: 'printful_estimate_order',
    title: 'Exact order estimate',
    description: 'Exact Printful charge (products + shipping + VAT/tax) for an order. Accepts a v2 order body, a shop order (+mapping), or quick items.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        order: S.obj('Printful v2 order body {recipient, order_items}.'),
        shop_order: S.obj('Canonical shop order (see skill references/order-format.md).'),
        mapping: S.obj('SKU mapping (optional; defaults to Site secret SKU_MAPPING_JSON).'),
        recipient: recipientSchema,
        items: S.arr('Quick mode: [{catalog_variant_id, quantity, placements with layers}]'),
      },
    },
    annotations: RO,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      let body = a.order;
      if (!body && a.shop_order) body = buildPrintfulOrder(a.shop_order, mappingFrom(a, ctx.env), { shipping: ctx.env.DEFAULT_SHIPPING });
      if (!body) {
        if (!a.recipient || !a.items) throw new Error('Pass order, shop_order, or recipient+items');
        if (!a.recipient.zip) throw new Error('recipient.zip is required for an exact estimate (tax and shipping depend on it)');
        body = { recipient: a.recipient, order_items: catalogItems(a.items) };
      }
      assertDesignUrls(body);
      return estimateOrder(pf, body);
    },
  },
  {
    name: 'printful_calc_retail',
    title: 'Retail price & margin calculator',
    description: 'Shop price from cost: markup or target margin, VAT, payment fees, .99 rounding, optional shipping folded into price.',
    inputSchema: {
      type: 'object',
      properties: {
        cost: S.num('Printful cost per unit.'),
        shipping: S.num('Printful shipping cost per unit.'),
        include_shipping: S.bool('Fold shipping into price (free delivery).'),
        markup_pct: S.num(''),
        markup_fixed: S.num(''),
        target_margin_pct: S.num('Margin on net price; overrides markup.'),
        vat_rate: S.num('e.g. 0.23'),
        round_to: { type: ['number', 'null'], description: '0.99 (default), 0.9, 0 = whole, 5 = step, null = none' },
        payment_fee_pct: S.num(''),
        payment_fee_fixed: S.num(''),
        min_margin_pct: S.num(''),
      },
      required: ['cost'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a) => retailPrice(a),
  },
  {
    name: 'printful_quote',
    title: 'Quote: cost + shipping + suggested price',
    description: 'One call: production cost, cheapest shipping to country, and suggested retail price.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        variant_id: S.int(''),
        placements: S.arr('', placementSchema),
        quantity: S.int(''),
        country_code: S.str('Destination for shipping (optional).'),
        currency: S.str(''),
        target_margin_pct: S.num(''),
        markup_pct: S.num(''),
        vat_rate: S.num(''),
        include_shipping: S.bool(''),
      },
      required: ['variant_id'],
    },
    annotations: RO,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      const qty = a.quantity ?? 1;
      const currency = a.currency ?? ctx.env.DEFAULT_CURRENCY ?? 'EUR';
      const production = await catalogCost(pf, a.variant_id, a.placements ?? [], qty, currency, ctx.env.DEFAULT_REGION ?? 'europe');
      let shipping: any = null;
      let shipping_error: string | null = null;
      if (a.country_code) {
        try {
          const rates = U(
            await pf.post('/v2/shipping-rates', {
              recipient: { country_code: a.country_code },
              order_items: shippingItems([{ catalog_variant_id: a.variant_id, quantity: qty, placements: a.placements }]),
              currency,
            }),
          );
          shipping = [...rates].sort((x: any, y: any) => Number(x.rate) - Number(y.rate))[0] ?? null;
        } catch (e: any) {
          shipping_error = e.message;
        }
      }
      const retail = retailPrice({
        cost: Number(production.unit_cost),
        shipping: shipping ? Number(shipping.rate) / qty : 0,
        include_shipping: a.include_shipping,
        target_margin_pct: a.target_margin_pct ?? (a.markup_pct === undefined ? 40 : undefined),
        markup_pct: a.markup_pct,
        vat_rate: a.vat_rate ?? Number(ctx.env.DEFAULT_VAT_RATE ?? 0.23),
      });
      return { production, shipping, shipping_error, retail_per_unit: retail };
    },
  },

  // ── shop fulfillment ─────────────────────────────────────────────────
  {
    name: 'printful_fulfill_shop_order',
    title: 'Send shop order to Printful',
    description:
      'Turn a shop order (with customer custom designs) into a Printful order for printing and direct shipping. Idempotent by shop order id. dry_run returns the request only. confirm=true CHARGES the Printful balance — only with explicit user consent, always with max_cost.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        shop_order: S.obj('Canonical shop order (references/order-format.md). May contain ready `order_items` instead of `items`.'),
        mapping: S.obj('SKU mapping (optional; defaults to Site secret SKU_MAPPING_JSON).'),
        dry_run: S.bool('Only build and return the Printful request.'),
        confirm: S.bool('Submit for fulfillment (charges money). Default false = draft.'),
        max_cost: S.num('Required with confirm=true: ceiling for the Printful total (falls back to MAX_AUTO_CONFIRM_COST).'),
        currency: S.str('Currency of max_cost (optional, checked against the order currency).'),
      },
      required: ['shop_order'],
    },
    annotations: WRITE,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      const body = buildPrintfulOrder(a.shop_order, mappingFrom(a, ctx.env), {
        shipping: ctx.env.DEFAULT_SHIPPING,
        packing_slip: ctx.env.PACKING_SLIP_JSON ? JSON.parse(ctx.env.PACKING_SLIP_JSON) : undefined,
      });
      assertDesignUrls(body);
      const result: any = { shop_order_id: a.shop_order.id, external_id: body.external_id };
      if (a.dry_run) return { ...result, status: 'dry_run', request: body };
      let order: any;
      try {
        order = U(await pf.get(`/v2/orders/@${pathId(body.external_id, 'external_id')}`));
        result.status = 'exists';
      } catch (e) {
        if (!(e instanceof PrintfulError && e.status === 404)) throw e;
        order = U(await pf.post('/v2/orders', body));
        result.status = 'created';
      }
      result.printful_order_id = order.id;
      result.printful_status = order.status;
      result.costs = order.costs;
      if (result.status === 'exists') {
        const mismatch = sameOrderMismatch(order, body);
        if (mismatch) {
          return { ...result, status: 'conflict', reason: `A different Printful order already uses external_id ${body.external_id}: ${mismatch}. Not confirming.` };
        }
      }
      if (a.confirm && order.status === 'draft') {
        const max = a.max_cost ?? ctx.env.MAX_AUTO_CONFIRM_COST;
        const hold = moneyGate(order, max, a.currency);
        if (hold) return { ...result, status: 'held', reason: hold };
        const c = U(await pf.post(`/v2/orders/${pathId(order.id, 'order_id')}/confirmation`, {}));
        result.status = 'confirmed';
        result.printful_status = c.status;
      }
      return result;
    },
  },

  // ── orders ───────────────────────────────────────────────────────────
  {
    name: 'printful_orders_list',
    title: 'List orders',
    description: 'List Printful orders (newest first). Optional status filter: draft, pending, failed, canceled, onhold, inprocess, partial, fulfilled.',
    inputSchema: { type: 'object', properties: { store_id: storeId, status: S.str(''), limit: S.int('Default 20, max 100.'), offset: S.int('Skip this many orders (paging).') } },
    annotations: RO,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      const limit = Math.min(100, Math.max(1, Number(a.limit ?? 20)));
      const list = a.status
        ? await pf.paginate('/orders', { status: a.status, offset: a.offset }, limit)
        : await pf.paginate('/v2/orders', { offset: a.offset }, limit);
      return list.map((o) => ({
        id: o.id,
        external_id: o.external_id,
        status: o.status,
        created: o.created_at ?? o.created,
        country: o.recipient?.country_code,
        total: o.costs?.total,
        currency: o.costs?.currency,
      }));
    },
  },
  {
    name: 'printful_get_order',
    title: 'Get order',
    description: 'Full order: recipient, items, costs, status.',
    inputSchema: { type: 'object', properties: { store_id: storeId, order_id: orderId }, required: ['order_id'] },
    annotations: RO,
    run: async (a, ctx) => U(await withStore(ctx, a).get(`/v2/orders/${pathId(a.order_id, 'order_id')}`)),
  },
  {
    name: 'printful_create_order',
    title: 'Create order (raw)',
    description: 'Create a DRAFT order from a raw Printful v2 order body. Does not charge.',
    inputSchema: { type: 'object', properties: { store_id: storeId, order: S.obj('v2 order body') }, required: ['order'] },
    annotations: WRITE,
    run: async (a, ctx) => {
      assertDesignUrls(a.order);
      return U(await withStore(ctx, a).post('/v2/orders', a.order));
    },
  },
  {
    name: 'printful_update_order',
    title: 'Update order',
    description: 'PATCH (RFC 7386) a draft or failed order.',
    inputSchema: { type: 'object', properties: { store_id: storeId, order_id: orderId, patch: S.obj('Partial order body') }, required: ['order_id', 'patch'] },
    annotations: WRITE,
    run: async (a, ctx) => U(await withStore(ctx, a).patch(`/v2/orders/${pathId(a.order_id, 'order_id')}`, a.patch)),
  },
  {
    name: 'printful_confirm_order',
    title: 'Confirm order (charges money)',
    description: 'Submit a draft for fulfillment: Printful charges the balance and starts production. Only with explicit user consent. Pass max_cost.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        order_id: orderId,
        max_cost: S.num('Required ceiling. The order is held if the Printful total exceeds it or is not final yet.'),
        currency: S.str('Currency of max_cost (optional, checked against the order currency).'),
      },
      required: ['order_id', 'max_cost'],
    },
    annotations: DESTRUCTIVE,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      const early = moneyGate({ costs: { calculation_status: 'done', total: 0 } }, a.max_cost);
      if (early) return { status: 'held', reason: early };
      const o = U(await pf.get(`/v2/orders/${pathId(a.order_id, 'order_id')}`));
      if (o.status !== 'draft') return { status: 'skipped', reason: `order is ${o.status}, only drafts can be confirmed`, order_id: o.id };
      const hold = moneyGate(o, a.max_cost, a.currency);
      if (hold) return { status: 'held', reason: hold, costs: o.costs };
      return U(await pf.post(`/v2/orders/${pathId(o.id, 'order_id')}/confirmation`, {}));
    },
  },
  {
    name: 'printful_delete_order',
    title: 'Delete draft order',
    description: 'Delete an order in draft/failed/canceled state that was not charged.',
    inputSchema: { type: 'object', properties: { store_id: storeId, order_id: orderId }, required: ['order_id'] },
    annotations: DESTRUCTIVE,
    run: async (a, ctx) => (await withStore(ctx, a).del(`/v2/orders/${pathId(a.order_id, 'order_id')}`), { deleted: a.order_id }),
  },
  {
    name: 'printful_cancel_order',
    title: 'Cancel order',
    description: 'Cancel an order that is not yet in production (v1 cancel).',
    inputSchema: { type: 'object', properties: { store_id: storeId, order_id: orderId }, required: ['order_id'] },
    annotations: DESTRUCTIVE,
    run: async (a, ctx) => U(await withStore(ctx, a).del(`/orders/${pathId(a.order_id, 'order_id')}`)),
  },
  {
    name: 'printful_order_items',
    title: 'Order items',
    description: 'List, add, update or delete items of a draft order.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        order_id: orderId,
        action: { type: 'string', enum: ['list', 'add', 'update', 'delete'] },
        item_id: S.str('For update/delete.'),
        item: S.obj('Item body for add/update.'),
      },
      required: ['order_id', 'action'],
    },
    annotations: WRITE,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      const base = `/v2/orders/${pathId(a.order_id, 'order_id')}/order-items`;
      if (a.action === 'list') return pf.paginate(base, {}, 500);
      if (a.item) assertDesignUrls(a.item, 'item');
      if (a.action === 'add') return U(await pf.post(base, a.item));
      if (a.action === 'update') return U(await pf.patch(`${base}/${pathId(a.item_id, 'item_id')}`, a.item));
      await pf.del(`${base}/${pathId(a.item_id, 'item_id')}`);
      return { deleted: a.item_id };
    },
  },
  {
    name: 'printful_order_shipments',
    title: 'Shipments & tracking',
    description: 'Shipments with carrier, tracking number and URL.',
    inputSchema: { type: 'object', properties: { store_id: storeId, order_id: orderId }, required: ['order_id'] },
    annotations: RO,
    run: async (a, ctx) => {
      const list = await withStore(ctx, a).paginate(`/v2/orders/${pathId(a.order_id, 'order_id')}/shipments`, {}, 100);
      return list.map((s) => ({
        id: s.id,
        status: s.shipment_status,
        carrier: s.carrier,
        service: s.service,
        tracking_number: s.tracking_number,
        tracking_url: s.tracking_url,
        shipped_at: s.shipped_at,
        delivered_at: s.delivered_at,
      }));
    },
  },
  {
    name: 'printful_order_invoice',
    title: 'Order invoice',
    description: 'Invoice metadata (PDF content is base64 — summarised).',
    inputSchema: { type: 'object', properties: { store_id: storeId, order_id: orderId }, required: ['order_id'] },
    annotations: RO,
    run: async (a, ctx) => {
      const inv = U(await withStore(ctx, a).get(`/v2/orders/${pathId(a.order_id, 'order_id')}/invoices`));
      if (inv?.content) return { ...inv, content: `<base64 PDF, ${inv.content.length} chars>` };
      return inv;
    },
  },

  // ── files ────────────────────────────────────────────────────────────
  {
    name: 'printful_files',
    title: 'File library',
    description: 'Add a file from public URL, get a file, or suggest embroidery thread colors.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        action: { type: 'string', enum: ['add', 'get', 'thread_colors'] },
        url: S.str('Public URL (add, thread_colors).'),
        file_id: S.str('For get.'),
        role: { type: 'string', enum: ['printfile', 'label', 'preview'] },
        filename: S.str(''),
        visible: S.bool('Show in dashboard File Library (default true).'),
      },
      required: ['action'],
    },
    annotations: WRITE,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      if (a.action === 'get') return U(await pf.get(`/v2/files/${pathId(a.file_id, 'file_id')}`));
      if (a.action === 'thread_colors') return U(await pf.post('/files/thread-colors', { file_url: assertDesignUrl(a.url) }));
      return U(await pf.post('/v2/files', { url: assertDesignUrl(a.url), role: a.role ?? 'printfile', visible: a.visible ?? true, ...(a.filename ? { filename: a.filename } : {}) }));
    },
  },

  // ── store products (sync) ───────────────────────────────────────────
  {
    name: 'printful_store_products',
    title: 'Store products',
    description: 'Printful store (sync) products: list, get, create, update, delete, add_variant, get_variant, update_variant, delete_variant. ids accept "@external_id".',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'add_variant', 'get_variant', 'update_variant', 'delete_variant'] },
        product_id: S.str(''),
        variant_id: S.str('Sync variant id or @external_id.'),
        body: S.obj('create: {sync_product:{name,external_id,thumbnail}, sync_variants:[{variant_id, retail_price, external_id, files:[{type,url}]}]}'),
        search: S.str(''),
        status: { type: 'string', enum: ['all', 'synced', 'unsynced', 'ignored', 'imported', 'discontinued', 'out_of_stock'] },
      },
      required: ['action'],
    },
    annotations: WRITE,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      switch (a.action) {
        case 'list':
          {
          const list = await pf.paginate('/store/products', { status: a.status }, 1000);
          const q = String(a.search ?? '').toLowerCase();
          return q ? list.filter((p) => [p.name, p.external_id].some((v) => String(v ?? '').toLowerCase().includes(q))) : list;
        }
        case 'get':
          return U(await pf.get(`/store/products/${pathId(a.product_id, 'product_id')}`));
        case 'create':
          assertDesignUrls(a.body, 'body');
          return U(await pf.post('/store/products', a.body));
        case 'update':
          return U(await pf.put(`/store/products/${pathId(a.product_id, 'product_id')}`, a.body));
        case 'delete':
          return U(await pf.del(`/store/products/${pathId(a.product_id, 'product_id')}`));
        case 'add_variant':
          return U(await pf.post(`/store/products/${pathId(a.product_id, 'product_id')}/variants`, a.body));
        case 'get_variant':
          return U(await pf.get(`/store/variants/${pathId(a.variant_id, 'variant_id')}`));
        case 'update_variant':
          return U(await pf.put(`/store/variants/${pathId(a.variant_id, 'variant_id')}`, a.body));
        case 'delete_variant':
          return U(await pf.del(`/store/variants/${pathId(a.variant_id, 'variant_id')}`));
      }
      throw new Error(`unknown action ${a.action}`);
    },
  },

  // ── templates ───────────────────────────────────────────────────────
  {
    name: 'printful_product_templates',
    title: 'Product templates',
    description: 'Product templates: list, get, delete. Use a template in orders via source=product_template.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'get', 'delete'] }, template_id: S.str('id or @external_product_id'), search: S.str('') },
      required: ['action'],
    },
    annotations: WRITE,
    run: async (a, { pf }) => {
      if (a.action === 'list') return pf.paginate('/product-templates', { search: a.search }, 500);
      if (a.action === 'get') return U(await pf.get(`/product-templates/${pathId(a.template_id, 'template_id')}`));
      return U(await pf.del(`/product-templates/${pathId(a.template_id, 'template_id')}`));
    },
  },

  // ── webhooks ────────────────────────────────────────────────────────
  {
    name: 'printful_webhooks',
    title: 'Webhooks',
    description:
      'Webhook configuration (v2): get, set (default_url + events), set_event, disable, disable_event. Events: order_created, order_updated, order_failed, order_canceled, order_put_hold, order_put_hold_approval, order_remove_hold, shipment_sent, shipment_returned, shipment_out_of_stock, shipment_canceled, shipment_put_hold, shipment_put_hold_approval, shipment_remove_hold, product_synced, product_updated, product_deleted, catalog_stock_updated, catalog_price_changed, mockup_task_finished, approval_sheet_status_changed. The secret_key returned by `set` is shown once — the owner must store it.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        action: { type: 'string', enum: ['get', 'set', 'set_event', 'disable', 'disable_event'] },
        url: S.str('HTTPS URL.'),
        events: S.arr('Event types.', { type: 'string' }),
        event_type: S.str('For set_event/disable_event/get.'),
        stock_product_ids: S.arr('For catalog_stock_updated.', { type: 'integer' }),
        expires_at: S.str('ISO datetime.'),
      },
      required: ['action'],
    },
    annotations: WRITE,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      const params = a.stock_product_ids?.length ? [{ name: 'products', value: a.stock_product_ids.map((id: number) => ({ id })) }] : undefined;
      switch (a.action) {
        case 'get':
          return U(await pf.get(a.event_type ? `/v2/webhooks/${eventType(a.event_type)}` : '/v2/webhooks'));
        case 'set': {
          (a.events ?? []).forEach(eventType);
          if (!a.url || !/^https:\/\//.test(a.url)) throw new Error('url must be an https:// URL');
          const events = (a.events?.length ? a.events : ['order_created', 'order_updated', 'order_failed', 'order_canceled', 'order_put_hold', 'order_remove_hold', 'shipment_sent', 'shipment_returned', 'shipment_out_of_stock', 'shipment_canceled']).map(
            (t: string) => ({ type: t, ...(t === 'catalog_stock_updated' && params ? { params } : {}) }),
          );
          return U(await pf.post('/v2/webhooks', { default_url: a.url, events, ...(a.expires_at ? { expires_at: a.expires_at } : {}) }));
        }
        case 'set_event':
          return U(await pf.post(`/v2/webhooks/${eventType(a.event_type)}`, { type: a.event_type, ...(a.url ? { url: a.url } : {}), ...(params ? { params } : {}) }));
        case 'disable':
          await pf.del('/v2/webhooks');
          return { disabled: 'all' };
        case 'disable_event':
          await pf.del(`/v2/webhooks/${eventType(a.event_type)}`);
          return { disabled: a.event_type };
      }
      throw new Error(`unknown action ${a.action}`);
    },
  },

  // ── mockups ─────────────────────────────────────────────────────────
  {
    name: 'printful_mockups',
    title: 'Mockup generator',
    description: 'Create a mockup task (product preview with a design) and wait up to ~25 s, or get a task by id.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        action: { type: 'string', enum: ['create', 'get'] },
        task_id: S.str(''),
        product_id: S.int('catalog product id'),
        variant_ids: S.arr('', { type: 'integer' }),
        placements: S.arr('With layers (design URLs).', placementSchema),
        mockup_style_ids: S.arr('', { type: 'integer' }),
        format: { type: 'string', enum: ['jpg', 'png'] },
        width: S.int('px'),
      },
      required: ['action'],
    },
    annotations: WRITE,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      if (a.action === 'get') return U(await pf.get('/v2/mockup-tasks', { id: a.task_id }));
      const product: any = {
        source: 'catalog',
        catalog_product_id: a.product_id,
        catalog_variant_ids: a.variant_ids,
        placements: (a.placements ?? []).map((p: Placement) => ({ technique: 'dtg', ...p })),
      };
      if (a.mockup_style_ids?.length) product.mockup_style_ids = a.mockup_style_ids;
      assertDesignUrls(product.placements, 'placements');
      let tasks = U(await pf.post('/v2/mockup-tasks', { format: a.format ?? 'jpg', ...(a.width ? { mockup_width_px: a.width } : {}), products: [product] }));
      let task = Array.isArray(tasks) ? tasks[0] : tasks;
      const deadline = Date.now() + 25000;
      while (task?.status === 'pending' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        tasks = U(await pf.get('/v2/mockup-tasks', { id: task.id }));
        task = Array.isArray(tasks) ? tasks[0] : tasks;
      }
      return task;
    },
  },

  // ── warehouse, approval sheets, tax ─────────────────────────────────
  {
    name: 'printful_warehouse',
    title: 'Warehouse products',
    description: 'Printful Warehousing products: list (optional name filter) or get.',
    inputSchema: { type: 'object', properties: { store_id: storeId, product_id: S.str(''), name: S.str('') } },
    annotations: RO,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      return a.product_id ? U(await pf.get(`/v2/warehouse-products/${pathId(a.product_id, 'product_id')}`)) : pf.paginate('/v2/warehouse-products', { 'filter[name*]': a.name }, 500);
    },
  },
  {
    name: 'printful_approval_sheets',
    title: 'Design approval sheets',
    description: 'Orders held for design approval (e.g. embroidery): list, approve (releases the design to production — ask the user first), request_changes.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        action: { type: 'string', enum: ['list', 'approve', 'request_changes'] },
        order_id: S.str('Filter for list.'),
        confirm_hash: S.str('For approve/request_changes.'),
        message: S.str('Change request text.'),
        file_urls: S.arr('Corrected files.', { type: 'string' }),
      },
      required: ['action'],
    },
    annotations: DESTRUCTIVE,
    run: async (a, ctx) => {
      const pf = withStore(ctx, a);
      if (a.action === 'list') return U(await pf.get('/v2/approval-sheets', { order_id: a.order_id }));
      if (!/^[A-Za-z0-9]{8,128}$/.test(String(a.confirm_hash ?? ''))) throw new Error('confirm_hash from printful_approval_sheets list is required');
      if (a.action === 'approve') return U(await pf.post('/approval-sheets', { status: 'approved' }, { confirm_hash: a.confirm_hash }));
      return U(
        await pf.post('/approval-sheets/changes', { message: a.message, files: (a.file_urls ?? []).map((url: string) => ({ url })) }, { confirm_hash: a.confirm_hash }),
      );
    },
  },
  {
    name: 'printful_tax',
    title: 'US sales tax',
    description: 'US sales tax: list countries/states with tax, or rate for a recipient.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['countries', 'rate'] }, recipient: recipientSchema }, required: ['action'] },
    annotations: RO,
    run: async (a, { pf }) =>
      a.action === 'countries' ? U(await pf.get('/tax/countries', undefined, false)) : U(await pf.post('/tax/rates', { recipient: a.recipient })),
  },

  // ── escape hatch ────────────────────────────────────────────────────
  {
    name: 'printful_api',
    title: 'Raw Printful API call',
    description: 'Any Printful API call (v1 path or /v2/...) on api.printful.com. Use only when no dedicated tool fits. Order confirmation and design approval are blocked here; ask the user before any other mutation.',
    inputSchema: {
      type: 'object',
      properties: {
        store_id: storeId,
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: S.str('e.g. /v2/catalog-products/71/sizes'),
        query: S.obj(''),
        body: S.obj(''),
      },
      required: ['method', 'path'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    run: async (a, ctx) => {
      const method = String(a.method ?? '').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('method must be GET, POST, PUT, PATCH or DELETE');
      const path = assertSafePath(a.path);
      if (isConfirmationCall(method, path, a.query, a.body)) {
        throw new Error('printful_api cannot confirm orders or approve designs. Use printful_confirm_order (with max_cost) or printful_approval_sheets.');
      }
      return withStore(ctx, a).request(method, path, { query: a.query, body: a.body });
    },
  },
];

export function toolError(e: unknown): string {
  if (e instanceof PrintfulError) {
    const hint = e.needsStore
      ? ' Hint: pass store_id or set the Site secret PRINTFUL_STORE_ID (see printful_stores_list).'
      : e.status === 401
        ? ' Hint: PRINTFUL_API_TOKEN invalid or revoked.'
        : e.status === 403
          ? ' Hint: token lacks the scope for this operation.'
          : '';
    return `${e.message}.${hint}${e.raw ? `\nDetails: ${JSON.stringify(e.raw).slice(0, 1500)}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export { externalId };
