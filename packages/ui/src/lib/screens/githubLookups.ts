// What the GitHub step editors offer as suggestions — repositories, a repository's
// workflows and branches, a workflow's inputs — asked of GitHub once per editor visit
// and remembered, so typing in a field doesn't send a request per keystroke. A field
// holding a template ({{params.…}}) is only known when the automation runs: nothing to
// look up then.

import type { GitHubWorkflowDto, GitHubWorkflowInputDto } from '$lib/bindings';
import { githubBranches, githubRepositories, githubWorkflowInputs, githubWorkflows } from '$lib/ipc/commands';

const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    // A failure isn't remembered: fixing the token and trying again should work.
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Whether `value` is known before the run: not blank, no template in it. */
export function lookupable(value: string): boolean {
  return value.trim() !== '' && !value.includes('{{');
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const repositories = (): Promise<string[]> => cached('repos', githubRepositories);

export function workflows(repo: string): Promise<GitHubWorkflowDto[]> {
  return REPO.test(repo.trim()) ? cached(`wf:${repo.trim()}`, () => githubWorkflows(repo.trim())) : Promise.resolve([]);
}

export function branches(repo: string): Promise<string[]> {
  return REPO.test(repo.trim()) ? cached(`br:${repo.trim()}`, () => githubBranches(repo.trim())) : Promise.resolve([]);
}

export function workflowInputs(repo: string, workflow: string): Promise<GitHubWorkflowInputDto[]> {
  if (!REPO.test(repo.trim()) || !lookupable(workflow)) return Promise.resolve([]);
  return cached(`in:${repo.trim()}:${workflow.trim()}`, () => githubWorkflowInputs(repo.trim(), workflow.trim()));
}

/** Forgets everything (tests, or after the token changed). */
export function clearGitHubLookups(): void {
  cache.clear();
}
