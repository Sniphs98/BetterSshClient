import { describe, expect, it } from 'vitest';
import { SshSession } from './session.js';
import { setupKeyForHost } from './keySetup.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';

// Runs against the disposable local SSH test container (`docker compose up -d --build`
// at the repo root — see docker/ssh-test-target/README.md). Opt-in only —
// `npm run test:integration`.
//
// Deliberately only exercises `disablePasswordAuth: false`: the full flow would
// actually turn password auth off on the container, which every other integration
// test (and a developer poking at the container by hand) relies on staying on across
// repeated runs. Trying the full flow, including the rollback path, is exactly what
// the container's passwordless sudo is *for* — just do it by hand
// (`docker compose down && docker compose up -d` resets it after).

describe('setupKeyForHost against the test target', () => {
  it('generates a key, copies it, and verifies it works — without touching password auth', async () => {
    const host = testTargetHost({ name: `it-keysetup-${Date.now()}` });
    const passwordSession = await SshSession.connect(host);
    try {
      const result = await setupKeyForHost(host, passwordSession, false);
      expect(result.state).toBe('success');
      expect(result.passwordDisabled).toBe(false);

      // The generated key really does authenticate on its own — not just that the
      // flow reported success.
      const keyedSession = await SshSession.connect({ ...host, identityFile: result.keyPath, password: undefined });
      keyedSession.disconnect();

      // And password auth is still there, since this run declined to disable it.
      const stillPassword = await SshSession.connect(host);
      stillPassword.disconnect();
    } finally {
      passwordSession.disconnect();
    }
  });
});
