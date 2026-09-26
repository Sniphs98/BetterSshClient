import { describe, expect, it } from 'vitest';
import { runAutomation, type RunAutomationDeps } from './engine.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalCommand } from './localExec.js';
import { uploadOverSession } from './upload.js';
import type { Snippet, Automation } from './types.js';
import { SshSession } from '../ssh/session.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';

// Runs against the disposable local SSH test container (`docker compose up -d --build`
// at the repo root — see docker/ssh-test-target/README.md). Opt-in only —
// `npm run test:integration`. Everything in engine.test.ts fakes RunAutomationDeps; this is
// the one place the engine actually drives a real local process and a real SSH
// connection together.

function deps(): RunAutomationDeps {
  return {
    runLocal: runLocalCommand,
    connectHost: async (hostName) => {
      const session = await SshSession.connect(testTargetHost());
      return {
        runShell: (cmd, timeoutMs) => session.runShell(cmd, timeoutMs),
        upload: (from, to) => uploadOverSession(session, hostName, from, to),
        disconnect: () => session.disconnect()
      };
    }
  };
}

describe('upload node against the test target', () => {
  it('copies a local file to the host, and the next node reads it where it landed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bssh-upload-'));
    const file = join(dir, `payload-${Date.now()}.txt`);
    await writeFile(file, 'hello from the upload node\n');
    try {
      const read: Snippet = { id: 'read', name: 'Read', command: 'cat {{nodes.upload.output}} && rm {{nodes.upload.output}}', timeoutSecs: 30 };
      const automation: Automation = {
        name: 'it-upload',
        params: [{ name: 'host', kind: 'host' }],
        nodes: [
          { id: 'u', snippetId: '', upload: { from: file, to: '/tmp/' }, label: 'upload', continueOnError: false, target: 'remote' },
          { id: 'r', snippetId: 'read', label: 'read', continueOnError: false, target: 'remote' }
        ],
        edges: [{ from: 'u', to: 'r' }]
      };
      const results = await runAutomation(automation, new Map([['read', read]]), { host: 'ssh-test-target' }, deps());
      expect(results.map((r) => r.status)).toEqual(['success', 'success']);
      expect(results[0].output).toMatch(/^\/tmp\/payload-\d+\.txt$/);
      expect(results[1].output).toContain('hello from the upload node');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('says which local file is missing', async () => {
    const automation: Automation = {
      name: 'it-upload-missing',
      params: [{ name: 'host', kind: 'host' }],
      nodes: [{ id: 'u', snippetId: '', upload: { from: join(tmpdir(), 'no-such-file.tar.gz'), to: '/tmp/' }, label: 'upload', continueOnError: false, target: 'remote' }],
      edges: []
    };
    const [result] = await runAutomation(automation, new Map(), { host: 'ssh-test-target' }, deps());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('no such file on this computer');
  });
});

describe('snippet engine against the test target', () => {
  it('a local node feeds its output into a remote node over a real SSH connection', async () => {
    const local: Snippet = { id: 'local', name: 'Local', kind: 'local', command: 'echo build-123', timeoutSecs: 30 };
    const remote: Snippet = {
      id: 'remote',
      name: 'Remote',
      kind: 'remote',
      command: 'echo received:{{nodes.build.output}}',
      timeoutSecs: 30
    };
    const automation: Automation = {
      name: 'it-automation',
      params: [{ name: 'host', kind: 'host' }],
      nodes: [
        { id: 'n1', snippetId: 'local', label: 'build', continueOnError: false },
        { id: 'n2', snippetId: 'remote', label: 'deploy', continueOnError: false }
      ],
      edges: [{ from: 'n1', to: 'n2' }]
    };

    const results = await runAutomation(
      automation,
      new Map([
        ['local', local],
        ['remote', remote]
      ]),
      { host: 'ssh-test-target' },
      deps()
    );

    expect(results.map((r) => r.status)).toEqual(['success', 'success']);
    expect(results[1].output).toContain('received:build-123');
  });

  it('a failing local node (no continueOnError) skips the dependent remote node entirely', async () => {
    const marker = `/home/better-ssh-client/it-marker-${Date.now()}`;
    const failing: Snippet = { id: 'fail', name: 'Fail', kind: 'local', command: 'exit 1', timeoutSecs: 30 };
    const remote: Snippet = {
      id: 'remote',
      name: 'Remote',
      kind: 'remote',
      command: `touch ${marker}`,
      timeoutSecs: 30
    };
    const automation: Automation = {
      name: 'it-automation-skip',
      params: [{ name: 'host', kind: 'host' }],
      nodes: [
        { id: 'n1', snippetId: 'fail', label: 'x', continueOnError: false },
        { id: 'n2', snippetId: 'remote', label: 'y', continueOnError: false }
      ],
      edges: [{ from: 'n1', to: 'n2' }]
    };

    const results = await runAutomation(
      automation,
      new Map([
        ['fail', failing],
        ['remote', remote]
      ]),
      { host: 'ssh-test-target' },
      deps()
    );
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped']);

    // The marker file must never have been created — the remote command genuinely
    // never ran, not just that the reported status says so.
    const verifySession = await SshSession.connect(testTargetHost());
    try {
      await expect(verifySession.runCommandChecked(`test -f ${marker}`)).rejects.toThrow();
    } finally {
      verifySession.disconnect();
    }
  });
});
