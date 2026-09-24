// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

// Mirrors ui.test.ts's sidebarCollapsed persistence tests — same shape, same fake
// settings bridge, same fresh-module-per-test isolation.
const backend = { get: vi.fn(), set: vi.fn() };
vi.mock('$lib/ipc/settingsStore', () => ({ loadSettingsStore: vi.fn(async () => backend) }));

async function fresh() {
  vi.resetModules();
  return (await import('./sidebarMode')).sidebarMode;
}

describe('sidebar mode persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    backend.get.mockReset();
    backend.set.mockReset().mockResolvedValue(undefined);
  });

  it('defaults to ssh with no mirror set', async () => {
    const sidebarMode = await fresh();
    expect(get(sidebarMode)).toBe('ssh');
  });

  it('mirrors a set to localStorage so the next boot paints the right mode', async () => {
    const sidebarMode = await fresh();
    sidebarMode.set('remoteDesktop');
    expect(get(sidebarMode)).toBe('remoteDesktop');
    expect(localStorage.getItem('better-ssh-client-sidebar-mode')).toBe('remoteDesktop');
  });

  it('initialises from the localStorage mirror', async () => {
    localStorage.setItem('better-ssh-client-sidebar-mode', 'remoteDesktop');
    const sidebarMode = await fresh();
    expect(get(sidebarMode)).toBe('remoteDesktop');
  });

  it('writes the canonical settings store on a user set', async () => {
    const sidebarMode = await fresh();
    sidebarMode.set('remoteDesktop');
    await vi.waitFor(() => {
      expect(backend.set).toHaveBeenCalledWith('sidebarMode', 'remoteDesktop');
    });
  });

  it('hydrate applies the stored value', async () => {
    backend.get.mockResolvedValue('remoteDesktop');
    const sidebarMode = await fresh();
    await sidebarMode.hydrate();
    expect(get(sidebarMode)).toBe('remoteDesktop');
  });

  it('hydrate does not clobber a fresh user set', async () => {
    backend.get.mockResolvedValue('remoteDesktop');
    const sidebarMode = await fresh();
    sidebarMode.set('ssh');
    await sidebarMode.hydrate();
    expect(get(sidebarMode)).toBe('ssh');
  });

  it('hydrate ignores a garbage stored value', async () => {
    backend.get.mockResolvedValue('bogus');
    const sidebarMode = await fresh();
    await sidebarMode.hydrate();
    expect(get(sidebarMode)).toBe('ssh');
  });
});
