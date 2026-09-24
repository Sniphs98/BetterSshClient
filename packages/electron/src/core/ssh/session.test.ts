import { describe, expect, it } from 'vitest';
import { defaultHost, type Host } from './client.js';
import { buildCdShellCommand, connectBudgetMs, useHosts } from './session.js';

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
    const outer = host('bssh-test-outer-bastion');
    const inner = host('bssh-test-inner-bastion', outer.name);
    const target = host('bssh-test-target', inner.name);
    useHosts([outer, inner, target]);
    // Two bastions plus the target: three per-hop connect budgets.
    expect(await connectBudgetMs(target)).toBe(3 * (await connectBudgetMs(outer)));
  });
});
