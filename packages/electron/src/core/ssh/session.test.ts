import { describe, expect, it } from 'vitest';
import { buildCdShellCommand } from './session.js';

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
