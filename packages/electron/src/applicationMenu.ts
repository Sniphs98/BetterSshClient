import { Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * The application menu.
 *
 * Electron installs a default menu when an app never sets one, and its Edit submenu
 * claims Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z and Ctrl+A. A menu accelerator is handled
 * before the page sees the key, so in a terminal app those bindings quietly steal the
 * shell's interrupt (Ctrl+C), suspend (Ctrl+Z) and start-of-line (Ctrl+A). Hence an
 * explicit menu with no Edit submenu on Windows/Linux — Chromium still handles copy
 * and paste inside ordinary text inputs there without any menu entry.
 *
 * macOS is the exception: there those roles are what make copy/paste work in inputs at
 * all, so the submenu stays. Cmd+C is then unavailable to the terminal, which is why
 * the terminal's own chord is Ctrl+Shift+C/V on every platform (see the renderer's
 * `terminalClipboard.ts`).
 */
export function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }]
  };

  const template: MenuItemConstructorOptions[] = isMac
    ? [
        { role: 'appMenu' },
        // Kept only because Chromium needs it for copy/paste in text inputs on macOS.
        { role: 'editMenu' },
        viewMenu,
        windowMenu
      ]
    : [{ label: 'File', submenu: [{ role: 'quit' }] }, viewMenu, windowMenu];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
