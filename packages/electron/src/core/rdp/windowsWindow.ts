/**
 * mstsc opens its session window at whatever size it last had — for `display: 'fit'`
 * that would be a small window with scrollbars around a desktop sized for the whole
 * screen. This waits for the session window of mstsc process `pid` to appear — i.e.
 * until after Windows' prompts and the sign-in — and maximises it. Gives up after five
 * minutes, or when mstsc exits.
 *
 * The window calls go straight to `user32.dll` through koffi (as the credential store
 * does): no PowerShell, no helper process — a hidden PowerShell with an encoded script
 * is what endpoint protection takes for malware.
 */

/** The class of mstsc's session window (the one with the remote desktop in it). */
export const MSTSC_SESSION_CLASS = 'TscShellContainerClass';
const SW_MAXIMIZE = 3;

/** The few window calls this needs, as an interface so the waiting can be tested
 *  without Windows. */
export interface WindowApi {
  /** A visible top-level window of class `className` belonging to process `pid`, or null. */
  findWindow(pid: number, className: string): unknown;
  maximize(window: unknown): void;
}

type Koffi = typeof import('koffi');
let api: WindowApi | undefined;

/** The user32 calls, loaded on first use (Windows only). */
export function loadWindowApi(): WindowApi {
  if (api) return api;
  const koffi = require('koffi') as Koffi;
  const user32 = koffi.load('user32.dll');
  const HWND = koffi.pointer('REMOTY_HWND', koffi.opaque());
  const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', HWND, [HWND, HWND, 'str16', 'str16']);
  const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', [
    HWND,
    koffi.out(koffi.pointer('uint32_t'))
  ]);
  const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', [HWND]);
  const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'bool', [HWND, 'int']);

  api = {
    findWindow(pid, className) {
      // Every top-level window of the class, one after the other — no callback needed.
      let window: unknown = null;
      for (let i = 0; i < 1000; i++) {
        window = FindWindowExW(null, window, className, null);
        if (!window) return null;
        const owner = [0];
        GetWindowThreadProcessId(window, owner);
        if (owner[0] === pid && IsWindowVisible(window)) return window;
      }
      return null;
    },
    maximize(window) {
      ShowWindow(window, SW_MAXIMIZE);
    }
  };
  return api;
}

/** Whether process `pid` still runs. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it runs, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface MaximizeDeps {
  windows: () => WindowApi;
  alive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /** How often to look, a second apart. */
  tries: number;
}

const defaults: MaximizeDeps = {
  windows: loadWindowApi,
  alive: running,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tries: 300
};

export async function maximizeWhenConnected(pid: number, deps: Partial<MaximizeDeps> = {}): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid ${pid}`);
  const { windows, alive, sleep, tries } = { ...defaults, ...deps };
  const win32 = windows();
  for (let i = 0; i < tries; i++) {
    if (!alive(pid)) return;
    const window = win32.findWindow(pid, MSTSC_SESSION_CLASS);
    if (window) {
      // Let mstsc finish laying the window out first, or it sizes it back.
      await sleep(500);
      win32.maximize(window);
      return;
    }
    await sleep(1000);
  }
}
