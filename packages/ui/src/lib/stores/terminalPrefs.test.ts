// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const backend = { get: vi.fn(), set: vi.fn() };
vi.mock('$lib/ipc/settingsStore', () => ({ loadSettingsStore: vi.fn(async () => backend) }));

async function fresh() {
  vi.resetModules();
  return import('./terminalPrefs');
}

describe('terminalRightClick', () => {
  beforeEach(() => {
    localStorage.clear();
    backend.get.mockReset();
    backend.set.mockReset().mockResolvedValue(undefined);
  });

  it('defaults to the menu', async () => {
    const { terminalRightClick } = await fresh();
    expect(get(terminalRightClick)).toBe('menu');
  });

  it('mirrors a change to localStorage and the settings store', async () => {
    const { terminalRightClick } = await fresh();
    terminalRightClick.set('paste');

    expect(get(terminalRightClick)).toBe('paste');
    expect(localStorage.getItem('omnyssh-terminal-right-click')).toBe('paste');
    await vi.waitFor(() => expect(backend.set).toHaveBeenCalledWith('terminalRightClick', 'paste'));
  });

  it('initialises from the localStorage mirror', async () => {
    localStorage.setItem('omnyssh-terminal-right-click', 'paste');
    const { terminalRightClick } = await fresh();
    expect(get(terminalRightClick)).toBe('paste');
  });

  it('ignores a stored value that is not one of the two modes', async () => {
    backend.get.mockResolvedValue('middle-click');
    const { terminalRightClick } = await fresh();
    await terminalRightClick.hydrate();
    expect(get(terminalRightClick)).toBe('menu');
  });

  it('hydrate does not clobber a change the user already made', async () => {
    backend.get.mockResolvedValue('menu');
    const { terminalRightClick } = await fresh();
    terminalRightClick.set('paste');
    await terminalRightClick.hydrate();
    expect(get(terminalRightClick)).toBe('paste');
  });
});

describe('terminalCopyOnSelect', () => {
  beforeEach(() => {
    localStorage.clear();
    backend.get.mockReset();
    backend.set.mockReset().mockResolvedValue(undefined);
  });

  it('defaults to on', async () => {
    const { terminalCopyOnSelect } = await fresh();
    expect(get(terminalCopyOnSelect)).toBe(true);
  });

  it('round-trips through the localStorage mirror, which stores strings', async () => {
    const { terminalCopyOnSelect } = await fresh();
    terminalCopyOnSelect.set(false);
    expect(localStorage.getItem('omnyssh-terminal-copy-on-select')).toBe('false');

    const reloaded = await fresh();
    expect(get(reloaded.terminalCopyOnSelect)).toBe(false);
  });

  it('hydrate accepts a real boolean from the settings store', async () => {
    backend.get.mockResolvedValue(false);
    const { terminalCopyOnSelect } = await fresh();
    await terminalCopyOnSelect.hydrate();
    expect(get(terminalCopyOnSelect)).toBe(false);
  });
});
