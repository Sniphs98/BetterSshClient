import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitHubClient, dispatchInputs } from './client.js';
import { describeProgress, downloadAsset, matchesPattern, releaseOfRun, runWorkflow } from './steps.js';

// A stand-in for GitHub that behaves like Enable-Energy-Solutions/Frontend's release.yml:
// a dispatch starts a run that goes queued → in_progress (jobs one by one) → completed,
// makes a release with the image's .tar.gz, whose download redirects to file storage.
interface FakeOptions {
  /** Newer API: the dispatch answers with the run's id. */
  returnsRunId?: boolean;
  conclusion?: 'success' | 'failure';
  makesRelease?: boolean;
}

function fakeGitHub(opts: FakeOptions = {}) {
  const calls: Array<{ method: string; url: string; auth: string | null; body?: unknown }> = [];
  const jobs = ['generate_tag', 'create_release', 'build-frontend-docker', 'deploy-to-dev'];
  let polls = 0;
  let dispatched: { ref: string; inputs: Record<string, string> } | undefined;
  const start = Date.parse('2026-09-27T10:00:00Z');
  const run = () => {
    const status = polls <= 1 ? 'queued' : polls <= 6 ? 'in_progress' : 'completed';
    return {
      id: 4242,
      status,
      conclusion: status === 'completed' ? (opts.conclusion ?? 'success') : null,
      html_url: 'https://github.com/o/r/actions/runs/4242',
      run_number: 57,
      head_sha: 'abc1234',
      head_branch: dispatched?.ref,
      created_at: new Date(start).toISOString(),
      run_started_at: new Date(start).toISOString(),
      updated_at: new Date(start + 5 * 60_000).toISOString(),
      triggering_actor: { login: 'lukas' }
    };
  };
  const tag = () => (dispatched?.ref === 'main' ? 'v1.4.2' : 'v1.4.2-pre-release.57');
  const release = () => ({
    tag_name: tag(),
    html_url: `https://github.com/o/r/releases/tag/${tag()}`,
    prerelease: dispatched?.ref !== 'main',
    created_at: new Date(start + 60_000).toISOString(),
    assets: [{ id: 9, name: `frontend-docker-image-${tag()}.tar.gz`, size: 11 }]
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ method, url, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.replace('https://api.github.com', '');
    if (url.startsWith('https://objects.example/')) return new Response('IMAGE BYTES', { status: 200, headers: { 'content-length': '11' } });
    if (path === '/user') return json({ login: 'lukas' });
    if (path.endsWith('/dispatches') && method === 'POST') {
      dispatched = JSON.parse(String(init?.body));
      return opts.returnsRunId ? json({ workflow_run_id: 4242 }) : new Response(null, { status: 204 });
    }
    if (path.includes('/runs?event=workflow_dispatch')) return json({ workflow_runs: dispatched ? [run()] : [] });
    if (path === '/repos/o/r/actions/runs/4242') {
      polls += 1;
      return json(run());
    }
    if (path.startsWith('/repos/o/r/actions/runs/4242/jobs')) {
      const done = Math.max(0, polls - 2);
      return json({
        jobs: jobs.map((name, i) => ({
          name,
          status: i < done ? 'completed' : i === done ? 'in_progress' : 'queued',
          conclusion: i < done ? (opts.conclusion === 'failure' && i === 2 ? 'failure' : 'success') : null
        }))
      });
    }
    if (path.startsWith('/repos/o/r/releases?')) return json(opts.makesRelease === false ? [] : [release()]);
    if (path.startsWith('/repos/o/r/releases/tags/')) return json(release());
    if (path === '/repos/o/r/releases/assets/9') {
      return new Response(null, { status: 302, headers: { location: 'https://objects.example/asset-9?signed=1' } });
    }
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;

  return { fetchImpl, calls, dispatched: () => dispatched };
}

const fast = { sleep: async () => {}, pollMs: 1 };

describe('runWorkflow', () => {
  it('starts the workflow, follows it to the end, and answers with the tag of its release', async () => {
    const gh = fakeGitHub({ returnsRunId: true });
    const lines: string[] = [];
    const tag = await runWorkflow(
      new GitHubClient('tok', gh.fetchImpl),
      { action: 'runWorkflow', repo: 'o/r', workflow: 'release.yml', ref: 'main', inputs: { release_type: 'patch' } },
      (l) => lines.push(l),
      fast
    );
    expect(tag).toBe('v1.4.2');
    expect(gh.dispatched()).toEqual({ ref: 'main', inputs: { release_type: 'patch' }, return_run_details: true });
    expect(lines).toContain('run #57: https://github.com/o/r/actions/runs/4242');
    expect(lines).toContain('queued');
    expect(lines.some((l) => /build-frontend-docker \(2\/4 jobs done\)/.test(l))).toBe(true);
    expect(lines.at(-1)).toBe('released v1.4.2: https://github.com/o/r/releases/tag/v1.4.2');
  });

  it("finds the run itself when GitHub doesn't say which one the dispatch started, and a branch gives a pre-release", async () => {
    const gh = fakeGitHub({ returnsRunId: false });
    const tag = await runWorkflow(
      new GitHubClient('tok', gh.fetchImpl),
      { action: 'runWorkflow', repo: 'o/r', workflow: 'release.yml', ref: 'feature/x', inputs: { release_type: 'minor' } },
      () => {},
      { ...fast, now: () => Date.parse('2026-09-27T10:00:01Z') }
    );
    expect(tag).toBe('v1.4.2-pre-release.57');
    expect(gh.calls.some((c) => c.url.includes('runs?event=workflow_dispatch&branch=feature%2Fx'))).toBe(true);
  });

  it('fails with the failed jobs and the link when the run fails', async () => {
    const gh = fakeGitHub({ returnsRunId: true, conclusion: 'failure' });
    await expect(
      runWorkflow(new GitHubClient('tok', gh.fetchImpl), { action: 'runWorkflow', repo: 'o/r', workflow: 'release.yml', ref: 'main', inputs: {} }, () => {}, fast)
    ).rejects.toThrow('the run ended failure (build-frontend-docker): https://github.com/o/r/actions/runs/4242');
  });

  it('answers with the commit when the run made no release', async () => {
    const gh = fakeGitHub({ returnsRunId: true, makesRelease: false });
    const out = await runWorkflow(
      new GitHubClient('tok', gh.fetchImpl),
      { action: 'runWorkflow', repo: 'o/r', workflow: 'test.yml', ref: 'main', inputs: {} },
      () => {},
      fast
    );
    expect(out).toBe('abc1234');
  });

  it('gives up after the timeout, saying the run goes on', async () => {
    const gh = fakeGitHub({ returnsRunId: true });
    let t = 0;
    await expect(
      runWorkflow(
        new GitHubClient('tok', gh.fetchImpl),
        { action: 'runWorkflow', repo: 'o/r', workflow: 'release.yml', ref: 'main', inputs: {} },
        () => {},
        { ...fast, timeoutMs: 1, now: () => (t += 10) }
      )
    ).rejects.toThrow(/gave up waiting — the run is still going on GitHub/);
  });
});

describe('downloadAsset', () => {
  let dir: string;
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'bssh-gh-'))));
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("downloads the matching file, following GitHub's redirect without the token", async () => {
    const gh = fakeGitHub();
    const lines: string[] = [];
    const path = await downloadAsset(
      new GitHubClient('tok', gh.fetchImpl),
      { action: 'downloadAsset', repo: 'o/r', tag: 'v1.4.2', pattern: '*.tar.gz' },
      (l) => lines.push(l),
      { downloadDir: dir }
    );
    expect(path).toBe(join(dir, 'frontend-docker-image-v1.4.2-pre-release.57.tar.gz'));
    expect(await readFile(path, 'utf-8')).toBe('IMAGE BYTES');
    const storage = gh.calls.find((c) => c.url.startsWith('https://objects.example/'));
    expect(storage?.auth).toBeNull();
    expect(gh.calls.find((c) => c.url.endsWith('/releases/assets/9'))?.auth).toBe('Bearer tok');
  });

  it('names the files there are when none matches', async () => {
    const gh = fakeGitHub();
    await expect(
      downloadAsset(new GitHubClient('tok', gh.fetchImpl), { action: 'downloadAsset', repo: 'o/r', tag: 'v1.4.2', pattern: '*.zip' }, () => {}, {
        downloadDir: dir
      })
    ).rejects.toThrow(/has no file matching "\*\.zip" \(it has: frontend-docker-image-.*\.tar\.gz\)/);
  });
});

describe('helpers', () => {
  it('reads the inputs of a workflow_dispatch trigger, choices included', () => {
    const yaml = `name: Release Frontend
on:
  workflow_dispatch:
    inputs:
      release_type:
        description: 'Release type (major, minor, patch)'
        required: true
        default: 'patch'
        type: choice
        options: [major, minor, patch]
jobs: {}
`;
    expect(dispatchInputs(yaml)).toEqual([
      { name: 'release_type', description: 'Release type (major, minor, patch)', type: 'choice', required: true, default: 'patch', options: ['major', 'minor', 'patch'] }
    ]);
    expect(dispatchInputs('on: workflow_dispatch\n')).toEqual([]);
    expect(() => dispatchInputs('on: [push]\n')).toThrow('no workflow_dispatch trigger');
  });

  it('matches file patterns and describes progress', () => {
    expect(matchesPattern('image-v1.tar.gz', '*.tar.gz')).toBe(true);
    expect(matchesPattern('image-v1.zip', '*.tar.gz')).toBe(false);
    const run = { status: 'in_progress' } as never;
    expect(describeProgress(run, [{ name: 'a', status: 'completed' }, { name: 'b', status: 'in_progress' }])).toBe('b (1/2 jobs done)');
  });

  it('picks the release a run made, not an older one', () => {
    const run = { createdAt: '2026-09-27T10:00:00Z', runStartedAt: '2026-09-27T10:00:00Z', updatedAt: '2026-09-27T10:05:00Z' } as never;
    const rel = (tag: string, at: string) => ({ tag, htmlUrl: '', prerelease: false, createdAt: at, assets: [] });
    expect(releaseOfRun([rel('v1.4.1', '2026-09-20T10:00:00Z'), rel('v1.4.2', '2026-09-27T10:01:00Z')], run)?.tag).toBe('v1.4.2');
  });
});
