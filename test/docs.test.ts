import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { generate } from '../scripts/gen-tool-docs';

// docs/tools.md must match the live registry. Regenerate with: UPDATE_DOCS=1 npx vitest run test/docs.test.ts
it('docs/tools.md is up to date', async () => {
  const fresh = await generate();
  if (process.env.UPDATE_DOCS) writeFileSync('docs/tools.md', fresh);
  expect(readFileSync('docs/tools.md', 'utf8')).toBe(fresh);
});
