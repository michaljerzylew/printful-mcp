import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleHttp, handleRpc } from '../lib/mcp';
import { SKILLS } from '../lib/skills.generated';
import { TOOLS } from '../lib/tools';

const env = { MCP_API_KEY: 'test-key' };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  handleHttp(
    new Request('https://h/mcp', { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer test-key', 'content-type': 'application/json', ...headers } }),
    env,
  );
const rpc = async (method: string, params: object = {}) => (await handleRpc({ jsonrpc: '2.0', id: 1, method, params }, env))!;

describe('MCP lifecycle', () => {
  it('initialize negotiates a stable version and declares the Skills extension', async () => {
    const r = (await rpc('initialize', { protocolVersion: '2025-06-18' })).result;
    expect(r.protocolVersion).toBe('2025-06-18');
    expect(r.capabilities.extensions['io.modelcontextprotocol/skills']).toEqual({ directoryRead: true });
    expect(r.capabilities.resources).toBeDefined();
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-11-25');
  });
  it('notifications get 202, requests with id null get a response', async () => {
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const r = await post({ jsonrpc: '2.0', id: null, method: 'ping' });
    expect(r.status).toBe(200);
  });
  it('rejects invalid requests and unsupported protocol headers', async () => {
    expect(((await (await post({ hello: 1 })).json()) as any).error.code).toBe(-32600);
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400);
    expect(((await rpc('nope')) as any).error.code).toBe(-32601);
  });
});

describe('tools', () => {
  it('every tool has a schema, a description and annotations', async () => {
    const { tools } = (await rpc('tools/list')).result;
    expect(tools.length).toBe(TOOLS.length + 1);
    expect(new Set(tools.map((t: any) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^printful_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations).toBeDefined();
    }
  });
  it('money-moving tools are marked destructive', () => {
    for (const n of ['printful_confirm_order', 'printful_cancel_order', 'printful_delete_order', 'printful_api', 'printful_approval_sheets']) {
      expect(TOOLS.find((t) => t.name === n)!.annotations.destructiveHint).toBe(true);
    }
  });
  it('reports a missing token as a tool error, not a protocol error', async () => {
    const r = (await rpc('tools/call', { name: 'printful_whoami', arguments: {} })).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/PRINTFUL_API_TOKEN/);
    const calc = (await rpc('tools/call', { name: 'printful_calc_retail', arguments: { cost: 10, markup_pct: 100, round_to: null } })).result;
    expect(calc.structuredContent.price_gross).toBe('20.00');
  });
});

describe('Skills extension (SEP-2640)', () => {
  it('lists skills with complete, verifiable manifests', async () => {
    const r = (await rpc('skills/list')).result;
    expect(r).toMatchObject({ resultType: 'complete', cacheScope: 'public' });
    const skill = r.skills[0];
    expect(skill.uri).toBe('skill://printful-fulfillment/SKILL.md');
    expect(skill.frontmatter.name).toBe('printful-fulfillment');
    for (const res of skill.resources) {
      const read = (await rpc('resources/read', { uri: res.uri })).result.contents[0].text as string;
      const buf = Buffer.from(read, 'utf8');
      expect(buf.length).toBe(res.size);
      expect('sha256:' + createHash('sha256').update(buf).digest('hex')).toBe(res.digest);
    }
  });
  it('directory name matches frontmatter name', () => {
    for (const s of SKILLS) expect(s.frontmatter.name).toBe(s.name);
  });
  it('skills/get and unknown URIs', async () => {
    expect((await rpc('skills/get', { uri: 'skill://printful-fulfillment/SKILL.md' })).result.skill.uri).toBe('skill://printful-fulfillment/SKILL.md');
    expect(((await rpc('skills/get', { uri: 'skill://nope/SKILL.md' })) as any).error.code).toBe(-32602);
    expect(((await rpc('resources/read', { uri: 'skill://printful-fulfillment/../secret' })) as any).error.code).toBe(-32602);
  });
  it('directory read lists direct children only', async () => {
    const root = (await rpc('resources/directory/read', { uri: 'skill://printful-fulfillment' })).result.resources;
    expect(root.map((r: any) => r.name).sort()).toEqual(['SKILL.md', 'references']);
    expect(root.find((r: any) => r.name === 'references').mimeType).toBe('inode/directory');
  });
});
