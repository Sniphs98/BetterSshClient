/**
 * Whether this copy of the app can update itself in place (download the new
 * release and install it on restart, via electron-updater), or has to send the
 * user to the release page instead.
 *
 * Kept free of Electron so it's testable: `ipc/update.ts` gathers the facts
 * from the running app and passes them in.
 */

export interface InstallFacts {
  platform: NodeJS.Platform;
  /** `app.isPackaged` — false when run from source (`npm run dev:electron`). */
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  /** The NSIS installer leaves an uninstaller next to the executable; an
   *  unzipped copy of the app has none. */
  hasNsisUninstaller: boolean;
}

export type SelfUpdateSupport = { supported: true } | { supported: false; reason: string };

export function selfUpdateSupport(facts: InstallFacts): SelfUpdateSupport {
  if (!facts.isPackaged) return { supported: false, reason: 'a development build' };

  switch (facts.platform) {
    case 'win32':
      // The portable .exe unpacks itself to a temp folder on every start;
      // there is nothing installed to replace.
      if (facts.env.PORTABLE_EXECUTABLE_DIR) return { supported: false, reason: 'the portable version' };
      // Updates are delivered as the NSIS installer, which would install a
      // second copy next to an unzipped one rather than replace it.
      if (!facts.hasNsisUninstaller) return { supported: false, reason: 'a copy that was not installed with the installer' };
      return { supported: true };

    case 'linux':
      // An AppImage replaces itself. .deb/.rpm installs belong to the system
      // package manager, which needs root to update them.
      if (facts.env.APPIMAGE) return { supported: true };
      return { supported: false, reason: 'a .deb/.rpm install — update it with your package manager' };

    case 'darwin':
      // macOS only installs updates into a code-signed app, and these builds
      // aren't signed yet.
      return { supported: false, reason: 'macOS, until the builds are code-signed' };

    default:
      return { supported: false, reason: `${facts.platform}` };
  }
}
