import { describe, expect, it } from 'vitest';
import { defaultHost, type Host } from './client.js';
import { buildCdShellCommand, connectBudgetMs, hostKeyMessage, unreachableMessage, useHosts } from './session.js';

describe('buildCdShellCommand', () => {
  it('cds into the path, then execs a login shell', () => {
    const cmd = buildCdShellCommand('/var/www');
    expect(cmd).toBe(`cd '/var/www' 2>/dev/null; exec "$SHELL" -l`);
  });

  it('falls through to the login default rather than aborting if cd fails', () => {
    const cmd = buildCdShellCommand('/var/www');
    expect(cmd).toContain('2>/dev/null;');
    expect(cmd).not.toContain('&&');
  });

  it('escapes a single quote in the path', () => {
    const cmd = buildCdShellCommand("/srv/o'brien");
    expect(cmd).toContain(`'/srv/o'\\''brien'`);
  });
});

describe('useHosts', () => {
  const host = (name: string, proxyJump?: string): Host => ({ ...defaultHost(), name, hostname: `${name}.example`, proxyJump });

  it('resolves jump chains against the host list it was given, not the config files', async () => {
    // Neither host exists on disk: the chain can only resolve from the given list.
    const outer = host('remoty-test-outer-bastion');
    const inner = host('remoty-test-inner-bastion', outer.name);
    const target = host('remoty-test-target', inner.name);
    useHosts([outer, inner, target]);
    // Two bastions plus the target: three per-hop connect budgets.
    expect(await connectBudgetMs(target)).toBe(3 * (await connectBudgetMs(outer)));
  });
});

describe('hostKeyMessage', () => {
  it('names the changed key and the command that removes the old one', () => {
    const msg = hostKeyMessage({ name: 'test-container', hostname: '127.0.0.1', port: 2222 }, 'key-changed');
    expect(msg).toContain('host key of test-container (127.0.0.1:2222) has changed');
    expect(msg).toContain('ssh-keygen -R "[127.0.0.1]:2222"');
    // Port 22 is written without brackets, as known_hosts has it.
    expect(hostKeyMessage({ name: 'web', hostname: 'web.example.com', port: 22 }, 'key-changed')).toContain('ssh-keygen -R "web.example.com"');
  });

  it('says when known_hosts cannot be read', () => {
    expect(hostKeyMessage({ name: 'web', hostname: 'w', port: 22 }, 'unreadable')).toMatch(/known_hosts can't be read/);
  });
});

describe('unreachableMessage', () => {
  const host = { name: 'web', hostname: '10.0.0.5', port: 2222 };
  it('says why the server could not be reached, in plain words', () => {
    expect(unreachableMessage(host, 'connect ECONNREFUSED 10.0.0.5:2222')).toMatch(/nothing is listening on that port/);
    expect(unreachableMessage(host, 'getaddrinfo ENOTFOUND 10.0.0.5')).toBe('Could not reach web: there is no host called 10.0.0.5');
    expect(unreachableMessage(host, 'Timed out while waiting for handshake')).toMatch(/no answer/);
    expect(unreachableMessage(host, 'connect EHOSTUNREACH')).toMatch(/no route/);
    expect(unreachableMessage(host, 'something odd')).toBe('Could not reach web (10.0.0.5:2222): something odd');
  });
});
