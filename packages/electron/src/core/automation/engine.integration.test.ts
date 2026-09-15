import { describe, expect, it } from 'vitest';
import { runFlow, type RunFlowDeps } from './engine.js';
import { runLocalCommand } from './localExec.js';
import type { Automation, Flow } from './types.js';
import { SshSession } from '../ssh/session.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';

// Runs against the disposable local SSH test container (`docker compose up -d --build`
// at the repo root — see docker/ssh-test-target/README.md). Opt-in only —
// `npm run test:integration`. Everything in engine.test.ts fakes RunFlowDeps; this is
// the one place the engine actually drives a real local process and a real SSH
// connection together.

function deps(): RunFlowDeps {
  return {
    runLocal: runLocalCommand,
    connectHost: async () => {
      const session = await SshSession.connect(testTargetHost());
      return {
        runShell: (cmd, timeoutMs) => session.runShell(cmd, timeoutMs),
        disconnect: () => session.disconnect()
      };
    }
  };
}

describe('automation engine against the test target', () => {
  it('a local node feeds its output into a remote node over a real SSH connection', async () => {
    const local: Automation = { id: 'local', name: 'Local', kind: 'local', command: 'echo build-123', timeoutSecs: 30 };
    const remote: Automation = {
      id: 'remote',
      name: 'Remote',
      kind: 'remote',
      command: 'echo received:{{nodes.build.output}}',
      timeoutSecs: 30
    };
    const flow: Flow = {
      name: 'it-flow',
      params: [{ name: 'host', kind: 'host' }],
      nodes: [
        { id: 'n1', automationId: 'local', label: 'build', continueOnError: false },
        { id: 'n2', automationId: 'remote', label: 'deploy', continueOnError: false }
      ],
      edges: [{ from: 'n1', to: 'n2' }]
    };

    const results = await runFlow(
      flow,
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
    const marker = `/home/omnyssh/it-marker-${Date.now()}`;
    const failing: Automation = { id: 'fail', name: 'Fail', kind: 'local', command: 'exit 1', timeoutSecs: 30 };
    const remote: Automation = {
      id: 'remote',
      name: 'Remote',
      kind: 'remote',
      command: `touch ${marker}`,
      timeoutSecs: 30
    };
    const flow: Flow = {
      name: 'it-flow-skip',
      params: [{ name: 'host', kind: 'host' }],
      nodes: [
        { id: 'n1', automationId: 'fail', label: 'x', continueOnError: false },
        { id: 'n2', automationId: 'remote', label: 'y', continueOnError: false }
      ],
      edges: [{ from: 'n1', to: 'n2' }]
    };

    const results = await runFlow(
      flow,
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
