import { describe, expect, it } from 'vitest';

import type { CoreEvent } from '../../event.js';
import { LocalPtyManager, localTerminalEnv } from './localPty.js';
import { listTerminalProfiles } from './profiles.js';

describe('localTerminalEnv', () => {
  it("keeps the app's environment, drops Electron's switches, and names the terminal", () => {
    const env = localTerminalEnv({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', UNSET: undefined });
    expect(env).toMatchObject({ PATH: '/usr/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(env).not.toHaveProperty('UNSET');
  });
});

describe('LocalPtyManager', () => {
  it('opens a real shell here, runs what is typed, and ends it', async () => {
    // Command Prompt on Windows (always there), else the login shell.
    const profiles = await listTerminalProfiles();
    const profile = profiles.find((p) => p.id === 'cmd') ?? profiles.find((p) => p.kind !== 'wsl');
    expect(profile).toBeDefined();

    let output = '';
    const events: CoreEvent[] = [];
    const manager = new LocalPtyManager((_id, data) => (output += data.toString('utf8')));
    const id = await manager.open(41, profile!.id, 80, 24, (e) => events.push(e));
    expect(manager.has(id)).toBe(true);

    manager.write(id, Buffer.from('echo local-pty-$((6*7))-%OS%\r'));
    const deadline = Date.now() + 15_000;
    while (!/local-pty-(42|\$\(\(6\*7\)\))/.test(output) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toMatch(/local-pty-/);

    manager.resize(id, 100, 30);
    manager.close(id);
    expect(manager.has(id)).toBe(false);
    // Closed by us: no "the shell exited" notice to close the tab again.
    await new Promise((r) => setTimeout(r, 300));
    expect(events.filter((e) => e.type === 'ptyExited')).toEqual([]);
  }, 30_000);

  it("says so when a profile isn't on this machine", async () => {
    const events: CoreEvent[] = [];
    const manager = new LocalPtyManager(() => {});
    await expect(manager.open(42, 'no-such-profile', 80, 24, (e) => events.push(e))).rejects.toThrow("no terminal profile 'no-such-profile'");
    expect(events.map((e) => e.type)).toEqual(['error', 'ptyExited']);
  });
});
