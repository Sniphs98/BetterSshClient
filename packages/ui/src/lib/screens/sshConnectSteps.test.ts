import { describe, expect, it } from 'vitest';
import { advance, sshConnectSteps, stageOfError, stepStatus, suggestedCommand } from './sshConnectSteps';

const plain = { hostname: '10.0.0.5', user: 'deploy' };

describe('sshConnectSteps', () => {
  it('a plain host: reach, host key, sign in, shell', () => {
    expect(sshConnectSteps(plain, '10.0.0.5:22', 'deploy').map((s) => s.label)).toEqual([
      'Reaching 10.0.0.5:22',
      'Checking the host key',
      'Signing in as deploy',
      'Opening the shell'
    ]);
  });

  it('adds 1Password and the jump host where the host uses them', () => {
    const steps = sshConnectSteps({ ...plain, passwordRef: 'op://IT/web/password', proxyJump: 'bastion' }, 'x', 'deploy');
    expect(steps.map((s) => s.stage)).toEqual(['onePassword', 'jump', 'reach', 'hostKey', 'signIn', 'shell']);
    expect(steps[1].label).toBe('Connecting through bastion');
  });
});

describe('advance and stepStatus', () => {
  const steps = sshConnectSteps(plain, 'x', 'u');

  it('moves forward only', () => {
    expect(advance(steps, null, 'hostKey')).toBe('hostKey');
    expect(advance(steps, 'signIn', 'reach')).toBe('signIn');
    expect(advance(steps, 'reach', 'jump')).toBe('reach');
  });

  it('before any report the first step is going on; a failure stops at the current one', () => {
    expect(steps.map((_, i) => stepStatus(steps, null, i, false))).toEqual(['active', 'pending', 'pending', 'pending']);
    expect(steps.map((_, i) => stepStatus(steps, 'hostKey', i, true))).toEqual(['done', 'failed', 'pending', 'pending']);
  });
});

describe('suggestedCommand', () => {
  it('finds the ssh-keygen command in a changed-key error', () => {
    expect(suggestedCommand('… remove the old key with: ssh-keygen -R "[127.0.0.1]:2222" — then connect again.')).toBe(
      'ssh-keygen -R "[127.0.0.1]:2222"'
    );
    expect(suggestedCommand('SSH authentication failed for web')).toBeNull();
  });
});

describe('stageOfError', () => {
  it('reads where a connection stopped from its error', () => {
    expect(stageOfError('The host key of web (10.0.0.5:22) has changed since the last connection.')).toBe('hostKey');
    expect(stageOfError('Could not reach web (10.0.0.5:22): no answer')).toBe('reach');
    expect(stageOfError('SSH authentication failed for web')).toBe('signIn');
    expect(stageOfError("ProxyJump via 'bastion' failed: …")).toBe('jump');
    expect(stageOfError('channel open failure')).toBeNull();
  });
});
