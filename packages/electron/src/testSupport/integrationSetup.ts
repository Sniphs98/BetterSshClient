import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

/**
 * Integration tests connect to a real sshd and exercise the real TOFU known_hosts
 * logic (knownHosts.ts hardcodes `~/.ssh/known_hosts`, with no override hook) and the
 * real key-setup flow (which writes `~/.ssh/omnyssh_<host>_ed25519`) — both read
 * `os.homedir()`, which Node resolves from `HOME` (POSIX) / `USERPROFILE` (Windows).
 * Redirecting those env vars to a throwaway temp directory for the run keeps every
 * side effect there instead of on the machine's real `~/.ssh`.
 */
let sandboxDir: string | undefined;

beforeAll(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), 'omnyssh-test-home-'));
  process.env.HOME = sandboxDir;
  process.env.USERPROFILE = sandboxDir;
});

afterAll(async () => {
  if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true });
});
