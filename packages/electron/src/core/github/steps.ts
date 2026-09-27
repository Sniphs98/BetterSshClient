import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { GitHubStep } from '../automation/types.js';
import { GitHubError, type GitHubClient, type Release, type WorkflowRun } from './client.js';

/**
 * The automation's GitHub steps, on top of `GitHubClient`:
 *
 * - run a workflow: start it, follow the run until it ends, and answer with the tag of
 *   the release it made (so `{{nodes.<label>.output}}` is e.g. `v1.4.2`);
 * - download a release file: to the home folder, where local nodes run and an upload
 *   node's relative path points, answering with its path.
 *
 * GitHub can't call a desktop app back, so a run is followed by asking every few
 * seconds — well inside the 5000 requests an hour a token gets.
 */

export type RunWorkflowStep = Extract<GitHubStep, { action: 'runWorkflow' }>;
export type DownloadAssetStep = Extract<GitHubStep, { action: 'downloadAsset' }>;

export interface StepOptions {
  pollMs?: number;
  /** How long a run may take before the step gives up (it keeps running on GitHub). */
  timeoutMs?: number;
  /** How long to look for the run a dispatch started, when GitHub didn't say which. */
  findRunMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Where downloads go; the home folder by default. */
  downloadDir?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "queued", "build-frontend-docker (2/4 jobs done)", … — one line for the run dialog. */
export function describeProgress(run: WorkflowRun, jobs: Array<{ name: string; status: string }>): string {
  if (run.status !== 'in_progress' || jobs.length === 0) return run.status.replace(/_/g, ' ');
  const done = jobs.filter((j) => j.status === 'completed').length;
  const current = jobs.find((j) => j.status === 'in_progress');
  return `${current ? current.name : 'in progress'} (${done}/${jobs.length} jobs done)`;
}

/** The release a run made: created while it ran — the earliest such, as a workflow
 *  makes one release per run. */
export function releaseOfRun(releases: Release[], run: WorkflowRun): Release | undefined {
  const start = Date.parse(run.runStartedAt ?? run.createdAt) - 5_000;
  const end = Date.parse(run.updatedAt) + 60_000;
  return releases
    .filter((r) => {
      const t = Date.parse(r.createdAt);
      return t >= start && t <= end;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
}

export async function runWorkflow(
  client: GitHubClient,
  step: RunWorkflowStep,
  report: (message: string) => void,
  opts: StepOptions = {}
): Promise<string> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 10_000;
  const ref = step.ref.trim();
  if (!ref) throw new GitHubError('which branch to run the workflow on is missing');

  const actor = await client.viewer();
  const since = new Date(now());
  report(`starting ${step.workflow} on ${ref}…`);
  let runId = await client.dispatch(step.repo, step.workflow, ref, step.inputs);

  // Older API: the dispatch doesn't say which run it started, so look for it.
  const findUntil = now() + (opts.findRunMs ?? 60_000);
  while (runId === undefined) {
    const found = await client.findDispatchedRun(step.repo, step.workflow, ref, actor, since);
    if (found) runId = found.id;
    else if (now() > findUntil) throw new GitHubError('the workflow was started, but its run did not show up on GitHub');
    else await sleep(Math.min(pollMs, 3_000));
  }

  const deadline = now() + (opts.timeoutMs ?? 60 * 60_000);
  let run = await client.run(step.repo, runId);
  report(`run #${run.runNumber}: ${run.htmlUrl}`);
  let last = '';
  while (run.status !== 'completed') {
    if (now() > deadline) throw new GitHubError(`gave up waiting — the run is still going on GitHub: ${run.htmlUrl}`);
    const jobs = run.status === 'in_progress' ? await client.jobs(step.repo, runId) : [];
    const line = describeProgress(run, jobs);
    if (line !== last) report(line);
    last = line;
    await sleep(pollMs);
    run = await client.run(step.repo, runId);
  }

  if (run.conclusion !== 'success') {
    const failed = (await client.jobs(step.repo, runId).catch(() => [])).filter((j) => j.conclusion === 'failure').map((j) => j.name);
    throw new GitHubError(
      `the run ended ${run.conclusion ?? 'without a result'}${failed.length ? ` (${failed.join(', ')})` : ''}: ${run.htmlUrl}`
    );
  }

  const release = releaseOfRun(await client.releases(step.repo), run);
  if (release) {
    report(`released ${release.tag}${release.prerelease ? ' (pre-release)' : ''}: ${release.htmlUrl}`);
    return release.tag;
  }
  // A workflow that makes no release: the commit it ran on is what there is to go on.
  report('the run made no release — output is the commit it ran on');
  return run.headSha;
}

/** `name` against a pattern with `*` (any run of characters) and `?` (one). */
export function matchesPattern(name: string, pattern: string): boolean {
  const re = pattern
    .trim()
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}$`, 'i').test(name);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function downloadAsset(
  client: GitHubClient,
  step: DownloadAssetStep,
  report: (message: string) => void,
  opts: StepOptions = {}
): Promise<string> {
  const tag = step.tag.trim();
  if (!tag) throw new GitHubError('which release (tag) to download from is missing');
  const release = await client.releaseByTag(step.repo, tag);
  const asset = release.assets.find((a) => matchesPattern(a.name, step.pattern || '*'));
  if (!asset) {
    const names = release.assets.map((a) => a.name).join(', ') || 'none';
    throw new GitHubError(`release ${tag} has no file matching "${step.pattern}" (it has: ${names})`);
  }
  if (/[\\/]/.test(asset.name) || asset.name === '..' || asset.name === '.') {
    throw new GitHubError(`refusing a release file named "${asset.name}"`);
  }

  const dest = join(opts.downloadDir ?? homedir(), asset.name);
  if (existsSync(dest)) report(`replacing ${dest}`);
  report(`downloading ${asset.name} (${megabytes(asset.size)})…`);
  let lastTenth = -1;
  await client.downloadAsset(step.repo, asset.id, dest, (done, total) => {
    const size = total || asset.size;
    const tenth = size ? Math.floor((done / size) * 10) : -1;
    if (tenth > lastTenth) {
      lastTenth = tenth;
      report(`${megabytes(done)} of ${megabytes(size)}`);
    }
  });
  return dest;
}
