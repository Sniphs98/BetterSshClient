import { describe, expect, it } from 'vitest';
import { collectMetrics } from './pool.js';
import { SshSession } from './session.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';

// The metric script against a real sshd and a real (Linux) userland: every section has
// to come back under its own marker and parse, all from the one exec.

describe('collectMetrics against the test target', () => {
  it('fills every Linux metric from a single script run', async () => {
    const session = await SshSession.connect(testTargetHost());
    try {
      const m = await collectMetrics(session);
      for (const pct of [m.cpuPercent, m.ramPercent, m.diskPercent]) {
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
      }
      expect(m.uptime).toBeTruthy();
      expect(m.loadAvg).toMatch(/^\S+ \S+ \S+$/);
    } finally {
      session.disconnect();
    }
  });

  it('keeps the monitoring connection itself out of the top processes', async () => {
    const session = await SshSession.connect(testTargetHost());
    try {
      const { topProcesses } = await collectMetrics(session);
      const names = (topProcesses ?? []).map((p) => p.name);
      for (const own of ['sh', 'ps', 'awk', 'head', 'top']) expect(names).not.toContain(own);
    } finally {
      session.disconnect();
    }
  });
});
