import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

const BIN = 'bin/printful-mcp.mjs';

beforeAll(() => {
  if (!existsSync(BIN)) execFileSync('node', ['scripts/build-cli.mjs'], { stdio: 'inherit' });
}, 60000);

/** Spawn the bundled CLI, send JSON-RPC lines, collect responses by id. */
function session(env: Record<string, string> = {}) {
  const childEnv = { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv;
  const p = spawn(process.execPath, [BIN], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map<unknown, (m: any) => void>();
  const lines: any[] = [];
  p.stdout.on('data', (d: Buffer) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be valid JSON-RPC
      lines.push(msg);
      waiters.get(msg.id)?.(msg);
    }
  });
  const call = (id: number, method: string, params: object = {}) =>
    new Promise<any>((resolve) => {
      waiters.set(id, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { p, call, lines, send: (raw: string) => p.stdin.write(raw + '\n') };
}

describe('stdio CLI', () => {
  it('prints version and help without touching stdin', () => {
    expect(execFileSync('node', [BIN, '--version']).toString().trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(execFileSync('node', [BIN, '--help']).toString()).toContain('npx -y');
  });

  it('speaks MCP over newline-delimited JSON and exits on EOF', async () => {
    const s = session();
    const init = await s.call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result.serverInfo.name).toBe('printful-mcp');
    s.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    const tools = await s.call(2, 'tools/list');
    expect(tools.result.tools.length).toBeGreaterThan(40);
    const calc = await s.call(3, 'tools/call', { name: 'printful_calc_retail', arguments: { cost: 10, markup_pct: 100, round_to: null } });
    expect(calc.result.structuredContent.price_gross).toBe('20.00');
    const skills = await s.call(4, 'skills/list');
    expect(skills.result.skills[0].uri).toBe('skill://printful-fulfillment/SKILL.md');
    const gate = await s.call(5, 'tools/call', { name: 'printful_confirm_order', arguments: { order_id: '1' } });
    expect(gate.result.structuredContent.status).toBe('held');
    s.send('not json');
    await new Promise((r) => setTimeout(r, 100));
    expect(s.lines.at(-1).error.code).toBe(-32700);
    const code = await new Promise((r) => {
      s.p.on('exit', r);
      s.p.stdin.end();
    });
    expect(code).toBe(0);
    // notification produced no output line
    expect(s.lines.filter((l) => l.id === undefined)).toHaveLength(0);
  }, 30000);

  it('reports a missing token as a tool error, not a crash', async () => {
    const s = session();
    const r = await s.call(1, 'tools/call', { name: 'printful_whoami', arguments: {} });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/PRINTFUL_API_TOKEN/);
    s.p.kill();
  }, 30000);
});
