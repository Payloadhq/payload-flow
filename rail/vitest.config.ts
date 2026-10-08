import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 90000,
    hookTimeout: 30000,
    // Restart/kill tests bind real ports; run serially.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Vendored v2.0.0 diagnostic modules (src/vendor) are not rail tests.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/vendor/**'],
  },
});
