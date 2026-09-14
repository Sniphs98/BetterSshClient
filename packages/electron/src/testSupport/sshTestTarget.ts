import type { Host } from '../core/ssh/client.js';

/**
 * Connection details for the disposable local SSH test container (`docker compose up
 * -d --build` at the repo root — see docker/ssh-test-target/README.md). Only imported
 * by `*.integration.test.ts` files; excluded from the production build the same way
 * `*.test.ts` is (see tsconfig.json).
 *
 * Overridable via env vars so CI, or a machine with the container mapped to a
 * different port, can point these tests elsewhere without editing the suite.
 */
export function testTargetHost(overrides: Partial<Host> = {}): Host {
  return {
    name: 'ssh-test-target',
    hostname: process.env.OMNYSSH_TEST_SSH_HOST ?? '127.0.0.1',
    port: Number(process.env.OMNYSSH_TEST_SSH_PORT ?? 2222),
    user: process.env.OMNYSSH_TEST_SSH_USER ?? 'omnyssh',
    password: process.env.OMNYSSH_TEST_SSH_PASSWORD ?? 'omnyssh',
    tags: [],
    source: 'manual',
    monitoring: 'ssh',
    ...overrides
  };
}
