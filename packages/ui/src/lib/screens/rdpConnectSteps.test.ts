import { describe, expect, it } from 'vitest';
import { advance, formatElapsed, rdpConnectSteps, stepStatus } from './rdpConnectSteps';

describe('rdpConnectSteps', () => {
  it('a direct connection: viewer, reach, secure, sign in', () => {
    expect(rdpConnectSteps({ onePassword: false, server: '10.0.0.5:3389' }).map((s) => s.label)).toEqual([
      'Starting the viewer',
      'Reaching 10.0.0.5:3389',
      'Securing the connection',
      'Signing in'
    ]);
  });

  it('adds 1Password and the SSH tunnel where the profile uses them', () => {
    expect(rdpConnectSteps({ onePassword: true, viaHost: 'bastion', server: 'office-pc' }).map((s) => s.stage)).toEqual([
      'viewer',
      'onePassword',
      'tunnel',
      'reach',
      'secure',
      'signin'
    ]);
    expect(rdpConnectSteps({ onePassword: false, viaHost: 'bastion', server: 'x' })[1].label).toBe(
      'Opening SSH tunnel through bastion'
    );
  });
});

describe('advance', () => {
  const steps = rdpConnectSteps({ onePassword: false, server: 'x' });

  it('moves forward, skipping steps nobody reported', () => {
    expect(advance(steps, 'viewer', 'reach')).toBe('reach');
    expect(advance(steps, 'reach', 'signin')).toBe('signin');
  });

  it('never goes back, and ignores stages these steps lack', () => {
    expect(advance(steps, 'secure', 'reach')).toBe('secure');
    expect(advance(steps, 'viewer', 'onePassword')).toBe('viewer');
    expect(advance(steps, 'viewer', 'tunnel')).toBe('viewer');
  });
});

describe('stepStatus', () => {
  const steps = rdpConnectSteps({ onePassword: false, server: 'x' });

  it('done before the current step, active on it, pending after', () => {
    expect(steps.map((_, i) => stepStatus(steps, 'secure', i, false))).toEqual(['done', 'done', 'active', 'pending']);
  });

  it('the current step is the one that failed', () => {
    expect(steps.map((_, i) => stepStatus(steps, 'reach', i, true))).toEqual(['done', 'failed', 'pending', 'pending']);
  });
});

describe('formatElapsed', () => {
  it('stays quiet for the first seconds, then counts', () => {
    expect(formatElapsed(1500)).toBe('');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(75_000)).toBe('1m 15s');
  });
});
