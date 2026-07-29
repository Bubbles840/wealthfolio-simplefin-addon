import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    // The companion is a separate vitest project with its own node-environment
    // config. Without this the root project also collects companion/src/*.test.ts
    // and runs them under jsdom, so every companion file ran twice under two
    // different configs — which is how a `vi.mock('fs')` that only works for
    // namespace imports came to dictate the shape of production code.
    exclude: [...configDefaults.exclude, 'companion/**'],
  },
});
