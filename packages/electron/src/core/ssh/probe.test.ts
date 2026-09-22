import { describe, expect, it } from 'vitest';

import { generateQuickScanScript, ProbeOutput } from './probe.js';

// Ported from crates/omnyssh-core/src/ssh/probe.rs's #[cfg(test)] module.

describe('ProbeOutput.parse', () => {
  it('empty output has no sections', () => {
    expect(ProbeOutput.parse('').hasSection('OS')).toBe(false);
  });

  it('garbage output (no markers) has no sections', () => {
    const result = ProbeOutput.parse('random\ngarbage\ntext');
    expect(result.hasSection('OS')).toBe(false);
    expect(result.getSection('OS')).toBeUndefined();
  });

  it('a single section', () => {
    const output = '===BSSH:OS===\nUbuntu 22.04 LTS\n===BSSH:SERVICES===\nsshd.service\n';
    const result = ProbeOutput.parse(output);
    expect(result.hasSection('OS')).toBe(true);
    expect(result.hasSection('SERVICES')).toBe(true);
    expect(result.getSection('OS')).toBe('Ubuntu 22.04 LTS');
    expect(result.getSection('SERVICES')).toBe('sshd.service');
  });

  it('multiple sections', () => {
    const output = [
      '===BSSH:OS===',
      'NAME="Ubuntu"',
      'VERSION="22.04 LTS"',
      '===BSSH:DOCKER===',
      'abc123\tnginx-proxy\tUp 2 hours\tnginx:latest',
      'def456\tdb-master\tUp 5 days\tpostgres:15',
      '===BSSH:LISTEN===',
      '0.0.0.0:22\tLISTEN',
      '0.0.0.0:80\tLISTEN',
      ''
    ].join('\n');
    const result = ProbeOutput.parse(output);
    expect(result.hasSection('OS')).toBe(true);
    expect(result.hasSection('DOCKER')).toBe(true);
    expect(result.hasSection('LISTEN')).toBe(true);

    const docker = result.getSection('DOCKER');
    expect(docker).toContain('nginx-proxy');
    expect(docker).toContain('postgres:15');
  });

  it('an empty section reads as absent via hasSection', () => {
    const output = '===BSSH:OS===\nUbuntu\n===BSSH:DOCKER===\n===BSSH:SERVICES===\nsshd.service\n';
    const result = ProbeOutput.parse(output);
    expect(result.hasSection('OS')).toBe(true);
    expect(result.hasSection('DOCKER')).toBe(false);
    expect(result.hasSection('SERVICES')).toBe(true);
  });
});

describe('generateQuickScanScript', () => {
  it('contains every section marker and command', () => {
    const script = generateQuickScanScript();
    expect(script).toContain('===BSSH:OS===');
    expect(script).toContain('===BSSH:SERVICES===');
    expect(script).toContain('===BSSH:DOCKER===');
    expect(script).toContain('===BSSH:LISTEN===');
    expect(script).toContain('===BSSH:PROCESS===');
    expect(script).toContain('/etc/os-release');
    expect(script).toContain('systemctl list-units');
    expect(script).toContain('docker ps');
  });
});

describe('ProbeOutput.parseOsInfo', () => {
  it('prefers PRETTY_NAME', () => {
    const output = '===BSSH:OS===\nNAME="Ubuntu"\nVERSION="22.04.3 LTS (Jammy Jellyfish)"\nPRETTY_NAME="Ubuntu 22.04.3 LTS"\n';
    expect(ProbeOutput.parse(output).parseOsInfo()).toBe('Ubuntu 22.04.3 LTS');
  });

  it('falls back to NAME + VERSION', () => {
    const output = '===BSSH:OS===\nNAME="Debian GNU/Linux"\nVERSION="11 (bullseye)"\n';
    expect(ProbeOutput.parse(output).parseOsInfo()).toBe('Debian GNU/Linux 11 (bullseye)');
  });

  it('falls back to NAME alone', () => {
    const output = '===BSSH:OS===\nNAME="Alpine Linux"\n';
    expect(ProbeOutput.parse(output).parseOsInfo()).toBe('Alpine Linux');
  });

  it('handles single-quoted values', () => {
    const output = "===BSSH:OS===\nPRETTY_NAME='Fedora Linux 39'\n";
    expect(ProbeOutput.parse(output).parseOsInfo()).toBe('Fedora Linux 39');
  });

  it('handles unquoted values', () => {
    const output = '===BSSH:OS===\nPRETTY_NAME=Arch Linux\n';
    expect(ProbeOutput.parse(output).parseOsInfo()).toBe('Arch Linux');
  });

  it('returns undefined without an OS section', () => {
    expect(ProbeOutput.parse('').parseOsInfo()).toBeUndefined();
  });
});
