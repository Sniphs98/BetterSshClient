import { defineConfig } from 'vitest/config';

// Pure logic tests for the main-process core (config parsing, host merging, etc.) —
// no Electron runtime involved, mirrors the UI package's "pure function tests only"
// vitest convention.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
