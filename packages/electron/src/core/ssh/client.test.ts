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

  it('round-trips a default connection path, and omits it when unset', () => {
    const withPath = { ...defaultHost(), name: 'a', hostname: 'a', defaultPath: '/var/www' };
    const written = hostToToml(withPath);
    expect(written.default_path).toBe('/var/www');
    expect(hostFromToml(written).defaultPath).toBe('/var/www');

    const withoutPath = hostFromToml({ name: 'b', hostname: 'b' });
    expect(withoutPath.defaultPath).toBeUndefined();
    expect(hostToToml(withoutPath)).not.toHaveProperty('default_path');
  });

  it('round-trips a startup command, and omits it when unset', () => {
    const withCommand = { ...defaultHost(), name: 'a', hostname: 'a', startupCommand: 'tmux attach || tmux' };
    const written = hostToToml(withCommand);
    expect(written.startup_command).toBe('tmux attach || tmux');
    expect(hostFromToml(written).startupCommand).toBe('tmux attach || tmux');

    const withoutCommand = hostFromToml({ name: 'b', hostname: 'b' });
    expect(withoutCommand.startupCommand).toBeUndefined();
    expect(hostToToml(withoutCommand)).not.toHaveProperty('startup_command');
  });
});
