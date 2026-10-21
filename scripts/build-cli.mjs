// Bundles the stdio server into bin/printful-mcp.mjs: one self-contained file, zero runtime dependencies.
import { chmodSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const out = new URL('../bin/printful-mcp.mjs', import.meta.url).pathname;

await build({
  stdin: {
    contents: "import { main } from './cli/stdio.ts';\nmain().catch((e) => { console.error(e); process.exit(1); });\n",
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: out,
  banner: { js: `#!/usr/bin/env node\n// printful-mcp ${version}: https://github.com/michaljerzylew/printful-mcp (MIT)` },
  legalComments: 'none',
  logLevel: 'warning',
});
chmodSync(out, 0o755);
console.log(`built ${out}`);
