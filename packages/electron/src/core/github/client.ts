import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse as parseYaml } from 'yaml';

/**
 * The slice of GitHub's REST API the automation's GitHub steps use: start a workflow,
 * follow its run, find the release it made, download a release's file. `fetch` is
 * injected so tests run it against a fake GitHub.
 */

// Overridable for end-to-end tests against a stand-in GitHub, the way the SSH tests
// point at their test server (testSupport/sshTestTarget.ts).
const API = process.env.BSSH_GITHUB_API || 'https://api.github.com';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export interface WorkflowInput {
  name: string;
  description?: string;
  type: string;
  required: boolean;
  default?: string;
  /** For `type: choice`. */
  options?: string[];
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  runNumber: number;
  headSha: string;
  headBranch: string;
  createdAt: string;
  updatedAt: string;
  runStartedAt?: string;
  actor?: string;
}

export interface Job {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
}

export interface Release {
  tag: string;
  htmlUrl: string;
  prerelease: boolean;
  createdAt: string;
  assets: ReleaseAsset[];
}

type Fetch = typeof fetch;

/** "owner/name", checked, so it can't reshape an API path. */
export function checkRepo(repo: string): string {
  const r = repo.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)) throw new GitHubError(`"${repo}" is not a repository (expected owner/name)`);
  return r;
}

/** A workflow file name ("release.yml"), or its path in the repository. */
export function workflowFile(workflow: string): string {
  const name = workflow.trim().replace(/^\.github\/workflows\//, '');
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(name)) throw new GitHubError(`"${workflow}" is not a workflow file (expected e.g. release.yml)`);
  return name;
}

/** The inputs a workflow's `workflow_dispatch` trigger asks for, from its YAML. */
export function dispatchInputs(yamlText: string): WorkflowInput[] {
  const doc = parseYaml(yamlText) as { on?: unknown } | null;
  const on = doc?.on;
  if (on === 'workflow_dispatch' || (Array.isArray(on) && on.includes('workflow_dispatch'))) return [];
  const trigger = on && typeof on === 'object' && !Array.isArray(on) ? (on as Record<string, unknown>).workflow_dispatch : undefined;
  if (trigger === undefined) throw new GitHubError('this workflow cannot be started from outside: it has no workflow_dispatch trigger');
  const inputs = trigger && typeof trigger === 'object' ? (trigger as { inputs?: unknown }).inputs : undefined;
  if (!inputs || typeof inputs !== 'object') return [];
  return Object.entries(inputs as Record<string, Record<string, unknown>>).map(([name, spec]) => ({
    name,
    description: typeof spec?.description === 'string' ? spec.description : undefined,
    type: typeof spec?.type === 'string' ? spec.type : 'string',
    required: spec?.required === true,
    default: spec?.default === undefined || spec?.default === null ? undefined : String(spec.default),
    options: Array.isArray(spec?.options) ? spec.options.map(String) : undefined
  }));
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly api: string = API
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.api}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'BetterSshClient',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers as Record<string, string> | undefined)
        }
      });
    } catch (err) {
      throw new GitHubError(`could not reach GitHub: ${(err as Error).message}`);
    }
    if (res.ok || (res.status >= 300 && res.status < 400)) return res;
    const body = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
    const detail = body?.message ? `: ${body.message}` : '';
    if (res.status === 401) throw new GitHubError(`GitHub rejected the token${detail}`, 401);
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubError('GitHub rate limit reached — try again in a while', 403);
    }
    if (res.status === 404) throw new GitHubError(`not found on GitHub (or the token can't see it): ${path}`, 404);
    throw new GitHubError(`GitHub answered ${res.status}${detail}`, res.status);
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  /** Who the token belongs to. */
  async viewer(): Promise<string> {
    return (await this.json<{ login: string }>('/user')).login;
  }

  async repository(repo: string): Promise<{ fullName: string; private: boolean; defaultBranch: string }> {
    const r = await this.json<{ full_name: string; private: boolean; default_branch: string }>(`/repos/${checkRepo(repo)}`);
    return { fullName: r.full_name, private: r.private, defaultBranch: r.default_branch };
  }

  /** The repositories the token can see, most recently pushed first. */
  async repositories(): Promise<string[]> {
    const list = await this.json<Array<{ full_name: string }>>('/user/repos?per_page=100&sort=pushed');
    return list.map((r) => r.full_name);
  }

  async workflows(repo: string): Promise<Array<{ name: string; file: string }>> {
    const r = await this.json<{ workflows: Array<{ name: string; path: string; state: string }> }>(
      `/repos/${checkRepo(repo)}/actions/workflows?per_page=100`
    );
    return r.workflows
      .filter((w) => w.state === 'active' && w.path.startsWith('.github/workflows/'))
      .map((w) => ({ name: w.name, file: w.path.slice('.github/workflows/'.length) }));
  }

  async branches(repo: string): Promise<string[]> {
    const list = await this.json<Array<{ name: string }>>(`/repos/${checkRepo(repo)}/branches?per_page=100`);
    return list.map((b) => b.name);
  }

  /** The inputs `workflow` asks for when started, read from its file (on `ref`). */
  async workflowInputs(repo: string, workflow: string, ref?: string): Promise<WorkflowInput[]> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const file = await this.json<{ content: string; encoding: string }>(
      `/repos/${checkRepo(repo)}/contents/.github/workflows/${workflowFile(workflow)}${query}`
    );
    return dispatchInputs(Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'));
  }

  /** Starts `workflow` on `ref`. Resolves with the run's id when GitHub says it (newer
   *  API), else undefined — then `findDispatchedRun` finds it. */
  async dispatch(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<number | undefined> {
    const res = await this.request(`/repos/${checkRepo(repo)}/actions/workflows/${workflowFile(workflow)}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref, inputs, return_run_details: true })
    });
    if (res.status === 204) return undefined;
    const body = (await res.json().catch(() => undefined)) as { workflow_run_id?: number } | undefined;
    return typeof body?.workflow_run_id === 'number' ? body.workflow_run_id : undefined;
  }

  /** The run a dispatch just started: the newest workflow_dispatch run of `workflow` on
   *  `ref` by `actor`, created no earlier than `since`. */
  async findDispatchedRun(repo: string, workflow: string, ref: string, actor: string, since: Date): Promise<WorkflowRun | undefined> {
    const r = await this.json<{ workflow_runs: RawRun[] }>(
      `/repos/${checkRepo(repo)}/actions/workflows/${workflowFile(workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=10`
    );
    const earliest = since.getTime() - 10_000;
    return r.workflow_runs
      .map(toRun)
      .filter((run) => Date.parse(run.createdAt) >= earliest && (!run.actor || run.actor === actor))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  }

  async run(repo: string, id: number): Promise<WorkflowRun> {
    return toRun(await this.json<RawRun>(`/repos/${checkRepo(repo)}/actions/runs/${id}`));
  }

  async jobs(repo: string, runId: number): Promise<Job[]> {
    const r = await this.json<{ jobs: Array<{ name: string; status: string; conclusion: string | null }> }>(
      `/repos/${checkRepo(repo)}/actions/runs/${runId}/jobs?per_page=100`
    );
    return r.jobs.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion }));
  }

  async releases(repo: string): Promise<Release[]> {
    return (await this.json<RawRelease[]>(`/repos/${checkRepo(repo)}/releases?per_page=30`)).map(toRelease);
  }

  async releaseByTag(repo: string, tag: string): Promise<Release> {
    return toRelease(await this.json<RawRelease>(`/repos/${checkRepo(repo)}/releases/tags/${encodeURIComponent(tag)}`));
  }

  /** Downloads a release file to `dest` (via a temporary file, so a broken download
   *  never looks finished). GitHub answers with a redirect to its file storage, which
   *  must not get the token — so the redirect is followed here, without it. */
  async downloadAsset(repo: string, assetId: number, dest: string, onProgress?: (done: number, total: number) => void): Promise<void> {
    const first = await this.request(`/repos/${checkRepo(repo)}/releases/assets/${assetId}`, {
      headers: { Accept: 'application/octet-stream' },
      redirect: 'manual'
    });
    let res = first;
    const location = first.headers.get('location');
    if (first.status >= 300 && first.status < 400 && location) {
      try {
        res = await this.fetchImpl(location, { headers: { 'User-Agent': 'BetterSshClient' } });
      } catch (err) {
        throw new GitHubError(`could not download the release file: ${(err as Error).message}`);
      }
      if (!res.ok) throw new GitHubError(`the release file's download answered ${res.status}`);
    }
    if (!res.body) throw new GitHubError('the release file came back empty');
    const total = Number(res.headers.get('content-length') ?? 0);
    let done = 0;
    const counted = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    counted.on('data', (chunk: Buffer) => {
      done += chunk.length;
      onProgress?.(done, total);
    });
    const partial = `${dest}.part`;
    try {
      await pipeline(counted, createWriteStream(partial));
      await rename(partial, dest);
    } catch (err) {
      await rm(partial, { force: true });
      throw new GitHubError(`could not save the release file: ${(err as Error).message}`);
    }
  }
}

interface RawRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_number: number;
  head_sha: string;
  head_branch: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  actor?: { login: string };
  triggering_actor?: { login: string };
}

function toRun(r: RawRun): WorkflowRun {
  return {
    id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    htmlUrl: r.html_url,
    runNumber: r.run_number,
    headSha: r.head_sha,
    headBranch: r.head_branch,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    runStartedAt: r.run_started_at,
    actor: r.triggering_actor?.login ?? r.actor?.login
  };
}

interface RawRelease {
  tag_name: string;
  html_url: string;
  prerelease: boolean;
  created_at: string;
  assets?: Array<{ id: number; name: string; size: number }>;
}

function toRelease(r: RawRelease): Release {
  return {
    tag: r.tag_name,
    htmlUrl: r.html_url,
    prerelease: r.prerelease,
    createdAt: r.created_at,
    assets: (r.assets ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size }))
  };
}
