import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Leftovers of the old "Updating…" window. Versions up to this one showed it while a
 * Windows update installed: a hidden PowerShell started with an encoded script, which
 * endpoint protection (WithSecure DeepGuard, AMSI) reasonably takes for a malware
 * stager and kills. The installer now shows its own progress window instead (see
 * `build/installer.nsh`), so nothing here starts a process any more.
 *
 * An update from one of those versions still leaves the window's flag file behind;
 * the window closes once the new version removes it at startup (`clearUpdateSplash`).
 */

/** The flag file: there while an old version's update is being installed. */
export function updateFlagPath(dir: string = tmpdir()): string {
  return join(dir, 'remoty-updating');
}

/** At startup: the update (if one was running) is done — its window can close. */
export function clearUpdateSplash(dir?: string): boolean {
  const flag = updateFlagPath(dir);
  if (!existsSync(flag)) return false;
  rmSync(flag, { force: true });
  return true;
}
