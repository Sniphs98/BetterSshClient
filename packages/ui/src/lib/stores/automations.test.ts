import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { NodeResultDto } from '$lib/bindings';
import {
  activeRuns,
  endActiveRun,
  beginAutomationRun,
  dismissAutomationRun,
  formatDuration,
  automationRun,
  reduceAutomationCompleted,
  reduceAutomationFailed,
  reduceNodeResult,
  reduceNodeStarted,
  type AutomationRun
} from './automations';

function result(nodeId: string, status: NodeResultDto['status'] = 'success', output = ''): NodeResultDto {
  return { nodeId, label: nodeId, status, output, durationMs: 5 };
}

describe('automation-run lifecycle', () => {
  beforeEach(() => dismissAutomationRun());

  it('beginAutomationRun opens a running panel with no nodes yet', () => {
    beginAutomationRun('deploy', 1000);
    expect(get(automationRun)).toEqual({ automationName: 'deploy', phase: { kind: 'running', nodes: new Map() }, startedAt: 1000 });
  });

  it('dismiss clears the panel', () => {
    beginAutomationRun('deploy');
    dismissAutomationRun();
    expect(get(automationRun)).toBeNull();
  });
});

describe('reduceNodeStarted', () => {
  const running: AutomationRun = { automationName: 'deploy', phase: { kind: 'running', nodes: new Map() } };

  it('adds the node as running', () => {
    const next = reduceNodeStarted(running, 'deploy', 'n1', 'build', 2000);
    expect(next?.phase.kind).toBe('running');
    if (next?.phase.kind === 'running') {
      expect(next.phase.nodes.get('n1')).toEqual({ status: 'running', label: 'build', startedAt: 2000 });
    }
  });

  it('ignores an event for a different automation (single active run)', () => {
    expect(reduceNodeStarted(running, 'other-automation', 'n1', 'build')).toBe(running);
  });

  it('ignores an event when no run is active', () => {
    expect(reduceNodeStarted(null, 'deploy', 'n1', 'build')).toBeNull();
  });

  it('ignores an event once the run has reached a terminal phase', () => {
    const done: AutomationRun = { automationName: 'deploy', phase: { kind: 'completed', results: [] } };
    expect(reduceNodeStarted(done, 'deploy', 'n1', 'build')).toBe(done);
  });
});

describe('reduceNodeResult', () => {
  it('marks a running node done with its result', () => {
    const running: AutomationRun = { automationName: 'deploy', phase: { kind: 'running', nodes: new Map([['n1', { status: 'running', label: 'build', startedAt: 0 }]]) } };
    const next = reduceNodeResult(running, 'deploy', result('n1'));
    if (next?.phase.kind === 'running') {
      expect(next.phase.nodes.get('n1')).toEqual({ status: 'done', result: result('n1') });
    } else {
      throw new Error('expected running phase');
    }
  });

  it('adds a result directly even with no prior nodeStarted (a skipped node)', () => {
    const running: AutomationRun = { automationName: 'deploy', phase: { kind: 'running', nodes: new Map() } };
    const next = reduceNodeResult(running, 'deploy', result('n2', 'skipped'));
    if (next?.phase.kind === 'running') {
      expect(next.phase.nodes.get('n2')).toEqual({ status: 'done', result: result('n2', 'skipped') });
    } else {
      throw new Error('expected running phase');
    }
  });

  it('preserves node arrival order (topo order, since nodeStarted fires in that order)', () => {
    let run: AutomationRun | null = { automationName: 'deploy', phase: { kind: 'running', nodes: new Map() } };
    run = reduceNodeResult(run, 'deploy', result('first'));
    run = reduceNodeResult(run, 'deploy', result('second'));
    if (run?.phase.kind === 'running') {
      expect([...run.phase.nodes.keys()]).toEqual(['first', 'second']);
    } else {
      throw new Error('expected running phase');
    }
  });

  it('ignores an event for a different automation', () => {
    const running: AutomationRun = { automationName: 'deploy', phase: { kind: 'running', nodes: new Map() } };
    expect(reduceNodeResult(running, 'other-automation', result('n1'))).toBe(running);
  });
});

describe('terminal reducers', () => {
  it('reduceAutomationCompleted carries every result', () => {
    const results = [result('n1'), result('n2', 'skipped')];
    expect(reduceAutomationCompleted('deploy', results)).toEqual({ automationName: 'deploy', phase: { kind: 'completed', results } });
  });

  it('reduceAutomationCompleted ends the clock of the run this window started', () => {
    const running: AutomationRun = { automationName: 'deploy', phase: { kind: 'running', nodes: new Map() }, startedAt: 1000 };
    expect(reduceAutomationCompleted('deploy', [], running, 61_000)).toEqual({
      automationName: 'deploy',
      phase: { kind: 'completed', results: [] },
      startedAt: 1000,
      finishedAt: 61_000
    });
  });

  it('reduceAutomationFailed carries the error', () => {
    expect(reduceAutomationFailed('deploy', 'automation no longer exists')).toEqual({
      automationName: 'deploy',
      phase: { kind: 'failed', error: 'automation no longer exists' }
    });
  });
});

describe('formatDuration', () => {
  it('reads like a stopwatch at every scale', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(420)).toBe('0.4s');
    expect(formatDuration(9_990)).toBe('9.9s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
    expect(formatDuration(-5)).toBe('0.0s');
  });
});

describe('activeRuns', () => {
  it('knows an automation is running even with the panel closed, until its run ends', () => {
    beginAutomationRun('deploy');
    dismissAutomationRun();
    expect(get(activeRuns)).toEqual({ deploy: { stopping: false } });
    endActiveRun('deploy');
    expect(get(activeRuns)).toEqual({});
  });
});
