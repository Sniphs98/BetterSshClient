import type { IpcMain } from 'electron';

import { cliVersion, installHint } from '../core/secrets/onePassword.js';
import type { OnePasswordStatusDto } from '../dto.js';

/** `onepassword_status`: whether the 1Password CLI is there, and how to get it. Asked
 *  by the host and remote desktop forms once a 1Password reference is entered. */
export function registerOnePasswordIpc(ipcMain: IpcMain): void {
  ipcMain.handle('onepassword_status', async (): Promise<OnePasswordStatusDto> => {
    const version = await cliVersion();
    return { installed: version !== undefined, version, ...installHint(process.platform) };
  });
}
