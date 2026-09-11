import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';

import { APP_ORIGIN, registerAppProtocolHandler, registerAppScheme } from './appProtocol.js';
import { registerHostsIpc } from './ipc/hosts.js';
import { registerKeySetupIpc } from './ipc/keysetup.js';
import { registerSettingsIpc } from './ipc/settings.js';
import { registerSftpIpc } from './ipc/sftp.js';
import { registerSnippetsIpc } from './ipc/snippets.js';
import { registerSystemIpc } from './ipc/system.js';
import { registerTerminalIpc } from './ipc/terminal.js';
import { registerUpdateIpc } from './ipc/update.js';
import { loadAllHosts } from './core/config/hosts.js';
import { GuiState } from './state/guiState.js';
import { loadWindowGeometry, trackWindowGeometry } from './windowState.js';

/**
 * OmnySSH Desktop entry point. Ports the startup contract from
 * crates/omnyssh-gui/src/main.rs: a hidden window revealed only once the
 * renderer has actually painted, so launch never flashes a blank/wrong-color
 * frame, with a fallback reveal for a renderer that never loads (the app has
 * no tray icon, so a window nobody can see or reach must not linger).
 */

// Same value as tauri.conf.json's window `backgroundColor` — the dark theme's
// `--bg` token (packages/ui/src/app.css).
const BACKGROUND_COLOR = '#171717';

/** How long the hidden window may wait for the page before it is revealed anyway. */
const REVEAL_FALLBACK_MS = 3000;

let mainWindow: BrowserWindow | undefined;
const state = new GuiState(() => mainWindow);

// Must run before `app.whenReady()`.
registerAppScheme();

function createWindow(): BrowserWindow {
  const geometry = loadWindowGeometry();

  const win = new BrowserWindow({
    title: 'OmnySSH',
    width: geometry.width,
    height: geometry.height,
    x: geometry.x,
    y: geometry.y,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: BACKGROUND_COLOR,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  trackWindowGeometry(win);

  let revealed = false;
  const reveal = (): void => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    win.show();
    win.focus();
  };

  // Reveal once the document (stylesheet included) is up. A later reload
  // must not raise the window over whatever the user is doing.
  win.webContents.once('did-finish-load', reveal);

  // A renderer that never loads must not leave an invisible, unreachable
  // process running — there is no tray icon to recover it from.
  setTimeout(reveal, REVEAL_FALLBACK_MS);

  if (process.env.OMNYSSH_DEV_SERVER_URL) {
    void win.loadURL(process.env.OMNYSSH_DEV_SERVER_URL);
  } else {
    void win.loadURL(`${APP_ORIGIN}/`);
  }

  return win;
}

app.whenReady().then(async () => {
  registerAppProtocolHandler(join(__dirname, '..', '..', 'ui', 'build'));

  registerHostsIpc(ipcMain, state);
  registerSnippetsIpc(ipcMain);
  registerSettingsIpc(ipcMain);
  registerSystemIpc(ipcMain);
  registerTerminalIpc(ipcMain, state);
  registerSftpIpc(ipcMain, state);
  registerKeySetupIpc(ipcMain, state);
  registerUpdateIpc(ipcMain);

  // Pre-load the shared host config so the first `list_hosts` paints
  // immediately, before the renderer's own `reload_hosts` call. A load
  // failure here is non-fatal — the frontend re-attempts and surfaces the error.
  try {
    state.setHosts(await loadAllHosts());
  } catch {
    // Left empty; `reload_hosts` will retry and surface the error.
  }

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  state.shutdown();
});
