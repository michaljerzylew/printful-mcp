// Shop order + SKU mapping → Printful v2 order body. Mirrors cli_anything.printful.core.mapping/fulfillment.

import { externalId } from './printful';

export class MappingError extends Error {}

const PH = /\{([a-zA-Z_]+(?:\.[a-zA-Z0-9_-]+)*)\}/g;
const RECIPIENT_FIELDS = [
  'name', 'company', 'address1', 'address2', 'city', 'state_code', 'state_name',
  'country_code', 'country_name', 'zip', 'phone', 'email', 'tax_number',
];

const hasOwn = (o: unknown, k: string) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const escapeRx = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Compile "TEE-{size}-{color}" / "MUG-*" into a safe RegExp with named groups. */
export function compilePattern(pattern: string): RegExp | null {
  if (!pattern.includes('{') && !pattern.includes('*')) return null;
  const names = new Set<string>();
  let rx = '';
  for (const part of pattern.split(/(\{[A-Za-z_][A-Za-z0-9_]{0,31}\}|\*)/)) {
    if (part === '*') rx += '.*';
    else if (/^\{[A-Za-z_][A-Za-z0-9_]{0,31}\}$/.test(part)) {
      const name = part.slice(1, -1);
      if (names.has(name)) throw new MappingError(`SKU pattern "${pattern}" repeats {${name}}`);
      names.add(name);
      rx += `(?<${name}>[^/]+?)`;
    } else {
      if (/[{}]/.test(part)) throw new MappingError(`SKU pattern "${pattern}": placeholders must look like {name}`);
      rx += escapeRx(part);
    }
  }
  return new RegExp(`^${rx}$`);
}

export function findRule(mapping: any, sku: string): [any, Record<string, string>] {
  const skus = mapping?.skus;
  if (!skus || typeof skus !== 'object') throw new MappingError('mapping.skus must be an object');
  if (hasOwn(skus, sku)) return [skus[sku], {}];
  for (const [pattern, rule] of Object.entries<any>(skus)) {
    const rx = compilePattern(pattern);
    const m = rx ? sku.match(rx) : null;
    if (m) return [rule, Object.assign(Object.create(null), m.groups ?? {})];
  }
  throw new MappingError(`SKU '${sku}' has no mapping`);
}

function lookup(ctx: any, dotted: string): any {
  let node = ctx;
  for (const part of dotted.split('.')) {
    if (hasOwn(node, part)) node = node[part];
    else return undefined;
  }
  return typeof node === 'function' ? undefined : node;
}

function fill(obj: any, ctx: any, missing: string[]): any {
  if (typeof obj === 'string') {
    const full = obj.match(/^\{([a-zA-Z_]+(?:\.[a-zA-Z0-9_-]+)*)\}$/);
    if (full) {
      const v = lookup(ctx, full[1]);
      if (v === undefined || v === null) missing.push(full[1]);
      return v;
    }
    return obj.replace(PH, (m, key) => {
      const v = lookup(ctx, key);
      if (v === undefined || v === null) {
        missing.push(key);
        return m;
      }
      return String(v);
    });
  }
  if (Array.isArray(obj)) return obj.map((x) => fill(x, ctx, missing));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fill(v, ctx, missing)]));
  return obj;
}

function prune(obj: any): any {
  if (Array.isArray(obj)) {
    return obj
      .map(prune)
      .filter((x) => !(x && typeof x === 'object' && 'name' in x && (x.value === undefined || x.value === null || x.value === '')));
  }
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, prune(v)]));
  }
  return obj;
}

export function buildItem(mapping: any, line: any, order: any): any {
  const [ruleRaw, captured] = findRule(mapping, line.sku);
  if (!ruleRaw || typeof ruleRaw !== 'object' || Array.isArray(ruleRaw)) throw new MappingError(`SKU ${line.sku}: mapping rule must be an object`);
  const rule = JSON.parse(JSON.stringify(ruleRaw));
  const optional = new Set<string>(rule.optional ?? []);
  delete rule.optional;
  const ctx = { custom: line.custom ?? {}, meta: line.meta ?? {}, item: line, order, sku: captured, ...captured };
  if (rule.catalog_variant_id && typeof rule.catalog_variant_id === 'object') {
    const key = rule.variant_key;
    const val = key ? (captured[key] ?? lookup(ctx, key) ?? lookup(line.meta, key)) : undefined;
    if (val === undefined || !hasOwn(rule.catalog_variant_id, String(val))) {
      throw new MappingError(`SKU ${line.sku}: no variant for ${key}=${val}; known: ${Object.keys(rule.catalog_variant_id)}`);
    }
    rule.catalog_variant_id = rule.catalog_variant_id[val as string];
  }
  delete rule.variant_key;
  const missing: string[] = [];
  const filled = prune(fill(rule, ctx, missing));
  const hard = [...new Set(missing.filter((m) => !optional.has(m)))];
  if (hard.length) throw new MappingError(`SKU ${line.sku}: missing personalisation data: ${hard.join(', ')}`);
  const common: any = { quantity: Number(line.quantity ?? 1), external_id: String(line.id ?? line.sku).slice(0, 32) };
  if (line.name) common.name = line.name;
  if (line.price !== undefined && line.price !== null) common.retail_price = String(line.price);
  if (filled.product_template_id) {
    return { source: 'product_template', product_template_id: filled.product_template_id, catalog_variant_id: Number(filled.catalog_variant_id), ...common };
  }
  if (filled.warehouse_variant_id) return { source: 'catalog', warehouse_variant_id: Number(filled.warehouse_variant_id), ...common };
  if (!filled.placements?.length) throw new MappingError(`SKU ${line.sku}: catalog item needs placements with a file`);
  const item: any = { source: 'catalog', catalog_variant_id: Number(filled.catalog_variant_id), ...common, placements: filled.placements };
  if (filled.product_options?.length) item.product_options = filled.product_options;
  if (filled.orientation) item.orientation = filled.orientation;
  return item;
}

export function validateShopOrder(o: any): string[] {
  const errs: string[] = [];
  const r = o?.recipient ?? {};
  if (!o?.id) errs.push('id required');
  for (const f of ['name', 'address1', 'city', 'country_code']) if (!r[f]) errs.push(`recipient.${f} required`);
  const cc = String(r.country_code ?? '').toUpperCase();
  if (['US', 'CA', 'AU'].includes(cc) && !r.state_code) errs.push('recipient.state_code required for US/CA/AU');
  if (!r.zip && !['IE', 'HK', 'AE'].includes(cc)) errs.push('recipient.zip required');
  if (!o?.items?.length && !o?.order_items?.length) errs.push('items required');
  (o?.items ?? []).forEach((it: any, i: number) => {
    if (!it.sku) errs.push(`items[${i}].sku required`);
  });
  return errs;
}

export function buildPrintfulOrder(shop: any, mapping: any | undefined, defaults: { shipping?: string; packing_slip?: any } = {}) {
  const errs = validateShopOrder(shop);
  if (errs.length) throw new MappingError(errs.join('; '));
  const recipient: any = Object.fromEntries(
    Object.entries(shop.recipient).filter(([k, v]) => RECIPIENT_FIELDS.includes(k) && v !== null && v !== undefined && v !== ''),
  );
  recipient.country_code = String(recipient.country_code).toUpperCase();
  let items: any[];
  if (shop.order_items?.length) items = shop.order_items;
  else {
    if (!mapping) throw new MappingError('No mapping: pass `mapping`, set SKU_MAPPING_JSON secret, or pass ready `order_items`');
    items = shop.items.map((l: any) => buildItem(mapping, l, shop));
  }
  const totals = shop.totals ?? {};
  const retail: any = {};
  for (const k of ['shipping', 'discount', 'tax']) if (totals[k] !== undefined && totals[k] !== null && totals[k] !== '') retail[k] = String(totals[k]);
  if (Object.keys(retail).length) retail.currency = shop.currency ?? mapping?.currency ?? 'EUR';
  const slip = { ...(defaults.packing_slip ?? {}), ...(shop.packing_slip ?? {}) };
  slip.custom_order_id ??= String(shop.id);
  const body: any = {
    external_id: externalId(shop.id),
    shipping: shop.shipping_method ?? defaults.shipping ?? 'STANDARD',
    recipient,
    order_items: items,
    customization: { packing_slip: slip },
  };
  if (shop.gift) body.customization.gift = shop.gift;
  if (Object.keys(retail).length) body.retail_costs = retail;
  return body;
}
