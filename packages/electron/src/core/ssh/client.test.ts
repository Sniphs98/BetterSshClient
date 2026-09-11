import { describe, expect, it } from 'vitest';
import { defaultHost, hostFromToml, hostToToml, normalizeMonitorMode } from './client.js';

// Ported from crates/omnyssh-core/src/ssh/client.rs's #[cfg(test)] module.

describe('normalizeMonitorMode', () => {
  it('accepts every spelling the wire and the TUI form use', () => {
    for (const spelling of ['tcp_port', 'tcp', 'tcpPort']) {
      expect(normalizeMonitorMode(spelling)).toBe('tcp_port');
    }
    expect(normalizeMonitorMode('ssh')).toBe('ssh');
  });

  it('rejects an unknown spelling rather than silently defaulting', () => {
    expect(() => normalizeMonitorMode('bogus')).toThrow();
  });
});

describe('hostFromToml / hostToToml round trip', () => {
  it('the monitoring default round-trips without touching the file', () => {
    const host = hostFromToml({ name: 'web', hostname: '10.0.0.1' });
    expect(host.monitoring).toBe('ssh');
    expect(host.monitorPort).toBeUndefined();

    const written = hostToToml(host);
    expect(written).not.toHaveProperty('monitoring');
    expect(written).not.toHaveProperty('monitor_port');
  });

  it('a reachability host persists its mode and probe port', () => {
    const host = { ...defaultHost(), name: 'fw', hostname: '10.0.0.9', monitoring: 'tcp_port' as const, monitorPort: 8443 };
    const written = hostToToml(host);
    const read = hostFromToml(written);
    expect(read.monitoring).toBe('tcp_port');
    expect(read.monitorPort).toBe(8443);
  });

  it('omits optional fields the Rust struct also omits at their default', () => {
    const host = hostFromToml({ name: 'a', hostname: 'a.example.com' });
    const written = hostToToml(host);
    expect(written).not.toHaveProperty('identity_file');
    expect(written).not.toHaveProperty('password');
  });

  it('persists a password in plaintext, matching the Rust behaviour', () => {
    const host = { ...defaultHost(), name: 'a', hostname: 'a', password: 'secret' };
    const written = hostToToml(host);
    const read = hostFromToml(written);
    expect(read.password).toBe('secret');
  });
});
