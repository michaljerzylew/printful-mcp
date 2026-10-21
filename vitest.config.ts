import { defineConfig } from 'vitest/config';

// Standalone config: unit tests do not need the Sites/Cloudflare Vite plugins.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
