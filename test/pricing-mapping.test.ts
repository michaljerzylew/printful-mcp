import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildItem, buildPrintfulOrder, compilePattern, findRule, MappingError } from '../lib/mapping';
import { catalogCost, Printful, retailPrice } from '../lib/printful';

afterEach(() => vi.restoreAllMocks());

const PRICES = {
  data: {
    currency: 'EUR',
    product: {
      id: 71,
      placements: [
        { id: 'embroidery_chest_left', technique_key: 'embroidery', price: '5.95', placement_options: [{ name: 'unlimited_color', price: { true: '7.50', false: '0.00' } }], layers: [] },
        { id: 'front', technique_key: 'dtg', price: '5.25', placement_options: [], layers: [{ additional_price: '0.00' }] },
        { id: 'front', technique_key: 'dtfilm', price: '6.00', placement_options: [], layers: [] },
        { id: 'back', technique_key: 'dtg', price: '5.25', placement_options: [], layers: [] },
        { id: 'label_inside', technique_key: 'dtg', price: '0.95', placement_options: [], layers: [] },
      ],
    },
    variant: { id: 4017, techniques: [{ technique_key: 'dtg', price: '10.50' }, { technique_key: 'embroidery', price: '12.50' }, { technique_key: 'dtfilm', price: '11.75' }] },
    discount_tiers: [],
  },
};
const mockPrices = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(PRICES));

describe('catalogCost', () => {
  it('includes the first placement and charges the rest', async () => {
    mockPrices();
    const r = await catalogCost(new Printful('t'), 4017, [{ placement: 'back', technique: 'dtg' }, { placement: 'front', technique: 'dtg' }], 3);
    expect(r.unit_cost).toBe('15.75');
    expect(r.line_cost).toBe('47.25');
  });
  it('never includes labels', async () => {
    mockPrices();
    const r = await catalogCost(new Printful('t'), 4017, [{ placement: 'label_inside', technique: 'dtg' }]);
    expect(r.unit_cost).toBe('11.45');
  });
  it('adds paid options', async () => {
    mockPrices();
    const r = await catalogCost(new Printful('t'), 4017, [{ placement: 'embroidery_chest_left', technique: 'embroidery', placement_options: [{ name: 'unlimited_color', value: true }] }]);
    expect(r.unit_cost).toBe('20.00');
  });
  it('picks the placement price for the requested technique', async () => {
    mockPrices();
    const r = await catalogCost(new Printful('t'), 4017, [{ placement: 'back', technique: 'dtfilm' }, { placement: 'front', technique: 'dtfilm' }].slice(1));
    expect(r.technique).toBe('dtfilm');
    expect(r.unit_cost).toBe('11.75');
  });
  it('rejects unknown placements', async () => {
    mockPrices();
    await expect(catalogCost(new Printful('t'), 4017, [{ placement: 'moon', technique: 'dtg' }])).rejects.toThrow(/Unknown placements/);
  });
});

describe('retailPrice', () => {
  it('hits the target margin after VAT and fees, with .99 rounding', () => {
    const r = retailPrice({ cost: 15.75, shipping: 4.45, include_shipping: true, target_margin_pct: 40, vat_rate: 0.23, payment_fee_pct: 2.9, payment_fee_fixed: 0.25, min_margin_pct: 40 });
    expect(r.price_gross.endsWith('.99')).toBe(true);
    expect(Number(r.margin_pct)).toBeGreaterThanOrEqual(40);
    expect(r.margin_ok).toBe(true);
  });
  it('matches the README example', () => {
    expect(retailPrice({ cost: 15.75, shipping: 4.45, include_shipping: true, target_margin_pct: 40, vat_rate: 0.23 }).price_gross).toBe('41.99');
  });
  it.each([
    [null, '20.00'],
    [0, '20.00'],
    [5, '20.00'],
    [0.99, '20.99'],
  ])('round_to=%j', (round_to, gross) => {
    expect(retailPrice({ cost: 10, markup_pct: 100, round_to: round_to as any }).price_gross).toBe(gross);
  });
  it('rejects impossible margins', () => {
    expect(() => retailPrice({ cost: 10, target_margin_pct: 100 })).toThrow();
    expect(() => retailPrice({ cost: 10, target_margin_pct: 90, payment_fee_pct: 20 })).toThrow();
  });
});

const MAPPING = {
  skus: {
    'TEE-CUSTOM-BLK-{size}': {
      catalog_variant_id: { S: 4016, M: 4017 },
      variant_key: 'size',
      placements: [{ placement: 'front', technique: 'dtg', layers: [{ type: 'file', url: '{custom.front_url}' }] }],
    },
    'CAP-{color}': {
      catalog_variant_id: { BLK: 7854 },
      variant_key: 'color',
      placements: [{ placement: 'embroidery_front', technique: 'embroidery', layers: [{ type: 'file', url: '{custom.logo_url}' }] }],
      product_options: [{ name: 'notes', value: '{custom.notes}' }],
      optional: ['custom.notes'],
    },
    'MUG-*': { product_template_id: 99, catalog_variant_id: 1320 },
    STOCK: { warehouse_variant_id: 7 },
  },
};

describe('mapping', () => {
  it('resolves size patterns and customer designs', () => {
    const it1 = buildItem(MAPPING, { id: 'L1', sku: 'TEE-CUSTOM-BLK-M', quantity: 2, custom: { front_url: 'https://x/a.png' } }, {});
    expect(it1).toMatchObject({ source: 'catalog', catalog_variant_id: 4017, quantity: 2 });
    expect(it1.placements[0].layers[0].url).toBe('https://x/a.png');
  });
  it('drops empty optional options', () => {
    expect(buildItem(MAPPING, { sku: 'CAP-BLK', custom: { logo_url: 'https://x/l.png' } }, {}).product_options).toBeUndefined();
  });
  it('reports missing personalisation', () => {
    expect(() => buildItem(MAPPING, { sku: 'TEE-CUSTOM-BLK-M' }, {})).toThrow(/custom.front_url/);
  });
  it('does not read inherited properties', () => {
    expect(() => buildItem(MAPPING, { sku: 'TEE-CUSTOM-BLK-M', custom: {} as any }, {})).toThrow(MappingError);
    expect(() => buildItem({ skus: { X: { catalog_variant_id: 1, placements: [{ placement: 'front', layers: [{ type: 'file', url: '{custom.toString}' }] }] } } }, { sku: 'X', custom: {} }, {})).toThrow(/toString/);
    expect(() => findRule(MAPPING, 'constructor')).toThrow(/no mapping/);
    expect(() => buildItem(MAPPING, { sku: 'TEE-CUSTOM-BLK-constructor', custom: { front_url: 'u' } }, {})).toThrow(/no variant/);
  });
  it('compiles patterns safely', () => {
    expect(compilePattern('A.{x}')!.test('A.1')).toBe(true);
    expect(compilePattern('A.{x}')!.test('AB1')).toBe(false);
    expect(() => compilePattern('{a}-{a}')).toThrow(/repeats/);
    expect(() => compilePattern('{1}')).toThrow(MappingError);
    expect(compilePattern('PLAIN')).toBeNull();
  });
  it('supports templates and warehouse items (v2 shape)', () => {
    expect(buildItem(MAPPING, { sku: 'MUG-RED' }, {})).toMatchObject({ source: 'product_template', product_template_id: 99 });
    expect(buildItem(MAPPING, { sku: 'STOCK' }, {})).toMatchObject({ source: 'catalog', warehouse_variant_id: 7 });
  });
  it('builds a complete v2 order body', () => {
    const body = buildPrintfulOrder(
      {
        id: 'SHOP-1',
        recipient: { name: 'A', address1: 'x', city: 'y', zip: '1', country_code: 'pl' },
        items: [{ sku: 'TEE-CUSTOM-BLK-S', custom: { front_url: 'u' }, price: '30' }],
        totals: { shipping: '5' },
        gift: { subject: 's', message: 'm' },
      },
      MAPPING,
      { shipping: 'STANDARD' },
    );
    expect(body).toMatchObject({ external_id: 'SHOP-1', shipping: 'STANDARD', recipient: { country_code: 'PL' }, retail_costs: { shipping: '5', currency: 'EUR' } });
    expect(body.customization.packing_slip.custom_order_id).toBe('SHOP-1');
    expect(body.customization.gift.message).toBe('m');
  });
  it('validates addresses', () => {
    expect(() => buildPrintfulOrder({ id: '1', recipient: { country_code: 'US' }, items: [{ sku: 'X' }] }, MAPPING)).toThrow(/state_code/);
  });
});
