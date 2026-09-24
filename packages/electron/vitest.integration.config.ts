import { defineConfig } from 'vitest/config';

// Real-SSH-server tests, opt-in only (`npm run test:integration`) — they connect to
// the docker/ssh-test-target container (`docker compose up -d --build` at the repo
// root) instead of mocking ssh2, and are deliberately excluded from the default
// `npm test` sweep (vitest.config.ts) since they need Docker running and touch a live
// TCP connection, breaking the "pure function tests only, no network" convention the
// rest of this package's tests hold to. See docker/ssh-test-target/README.md.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    setupFiles: ['./src/testSupport/integrationSetup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
