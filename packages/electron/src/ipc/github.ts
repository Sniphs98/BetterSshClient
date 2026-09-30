import type { IpcMain } from 'electron';

import { loadGitHubSettings, resolveGitHubToken, saveGitHubSettings } from '../core/config/github.js';
import { GitHubClient } from '../core/github/client.js';
import { isSecretReference } from '../core/secrets/onePassword.js';
import { toCommandError } from '../dto.js';

/**
 * GitHub for the automation's GitHub steps: the sign-in (Settings → GitHub) and what
 * the step editors pick from — repositories, workflows, branches, a workflow's inputs.
 * The token itself never goes to the renderer: only whether there is one.
 */

export interface GitHubSettingsDto {
  hasToken: boolean;
  tokenRef?: string;
}

export interface GitHubSettingsInputDto {
  /** A new token; omitted keeps the stored one. */
  token?: string;
  /** Drop the stored token. */
  clearToken?: boolean;
  /** A 1Password reference to read the token from; '' or omitted means none. */
  tokenRef?: string;
}

async function client(): Promise<GitHubClient> {
  return new GitHubClient(await resolveGitHubToken());
}

/** Wraps a handler so its errors reach the renderer as messages. */
function handle<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (_e: unknown, ...args: A) => Promise<R> {
  return async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw toCommandError(err);
    }
  };
}

export function registerGitHubIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'github_settings',
    handle(async (): Promise<GitHubSettingsDto> => {
      const s = await loadGitHubSettings();
      return { hasToken: Boolean(s.token), tokenRef: s.tokenRef };
    })
  );

  ipcMain.handle(
    'github_save_settings',
    handle(async (input: GitHubSettingsInputDto): Promise<void> => {
      const current = await loadGitHubSettings();
      const tokenRef = input.tokenRef?.trim() || undefined;
      if (tokenRef && !isSecretReference(tokenRef)) throw new Error('1Password reference must look like op://vault/item/field');
      const token = input.clearToken ? undefined : input.token?.trim() || current.token;
      await saveGitHubSettings({ token, tokenRef });
    })
  );

  // Who the token belongs to, and whether it can see `repo` (when given).
  ipcMain.handle(
    'github_test',
    handle(async (repo?: string) => {
      const c = await client();
      const login = await c.viewer();
      const repository = repo?.trim() ? await c.repository(repo) : undefined;
      return { login, repository };
    })
  );

  ipcMain.handle('github_repositories', handle(async () => (await client()).repositories()));
  ipcMain.handle('github_workflows', handle(async (repo: string) => (await client()).workflows(repo)));
  ipcMain.handle('github_branches', handle(async (repo: string) => (await client()).branches(repo)));
  ipcMain.handle(
    'github_workflow_inputs',
    handle(async (repo: string, workflow: string, ref?: string) => (await client()).workflowInputs(repo, workflow, ref))
  );
}
