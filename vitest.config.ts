import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    dir: 'test',
    globals: false,
    testTimeout: 15000,
  },
});
