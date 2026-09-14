import { defineConfig } from 'vitest/config';

// Pure logic tests for the main-process core (config parsing, host merging, etc.) —
// no Electron runtime involved, mirrors the UI package's "pure function tests only"
// vitest convention. `*.integration.test.ts` files open a real SSH connection to the
// docker/ssh-test-target container instead — see vitest.integration.config.ts and
// `npm run test:integration`; excluded here so `npm test` stays hermetic.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**']
  }
});
