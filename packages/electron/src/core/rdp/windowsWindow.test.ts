import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { loadWindowApi, maximizeWhenConnected, MSTSC_SESSION_CLASS, type WindowApi } from './windowsWindow.js';

function fakeWindows(foundAfter: number): WindowApi & { maximized: unknown[]; looks: number } {
  const fake = {
    maximized: [] as unknown[],
    looks: 0,
    findWindow(pid: number, className: string) {
      expect(className).toBe(MSTSC_SESSION_CLASS);
      fake.looks++;
      return fake.looks > foundAfter ? { hwnd: pid } : null;
    },
    maximize(window: unknown) {
      fake.maximized.push(window);
    }
  };
  return fake;
}

describe('maximizeWhenConnected', () => {
  const sleep = vi.fn(async () => {});

  it('waits for the session window, then maximises it', async () => {
    const win = fakeWindows(3);
    await maximizeWhenConnected(4242, { windows: () => win, alive: () => true, sleep, tries: 10 });
    expect(win.looks).toBe(4);
    expect(win.maximized).toEqual([{ hwnd: 4242 }]);
  });

  it('stops when mstsc has exited', async () => {
    const win = fakeWindows(0);
    await maximizeWhenConnected(4242, { windows: () => win, alive: () => false, sleep, tries: 10 });
    expect(win.looks).toBe(0);
    expect(win.maximized).toEqual([]);
  });

  it('gives up after its tries', async () => {
    const win = fakeWindows(Infinity);
    await maximizeWhenConnected(4242, { windows: () => win, alive: () => true, sleep, tries: 5 });
    expect(win.looks).toBe(5);
    expect(win.maximized).toEqual([]);
  });

  it('refuses a bad pid', async () => {
    await expect(maximizeWhenConnected(0, { windows: () => fakeWindows(0) })).rejects.toThrow(/bad pid/);
  });
});

// The real user32 calls: the taskbar is a visible window of class Shell_TrayWnd that
// belongs to explorer.exe. Only on a Windows desktop where Explorer runs.
function explorerPid(): number | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('tasklist', ['/fi', 'imagename eq explorer.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
    const pid = Number(out.split('\n')[0]?.split('","')[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
const explorer = explorerPid();

describe.skipIf(explorer === undefined)('loadWindowApi (Windows)', () => {
  it("finds a process's window by class, and nothing for another process", () => {
    const win32 = loadWindowApi();
    expect(win32.findWindow(explorer!, 'Shell_TrayWnd')).toBeTruthy();
    expect(win32.findWindow(process.pid, 'Shell_TrayWnd')).toBeNull();
    expect(win32.findWindow(explorer!, 'NoSuchWindowClass_Remoty')).toBeNull();
  });
});
