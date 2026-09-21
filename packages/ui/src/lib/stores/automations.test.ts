import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { NodeResultDto } from '$lib/bindings';
import {
  beginAutomationRun,
  dismissAutomationRun,
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
    beginAutomationRun('deploy');
    expect(get(automationRun)).toEqual({ automationName: 'deploy', phase: { kind: 'running', nodes: new Map() } });
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
    const next = reduceNodeStarted(running, 'deploy', 'n1', 'build');
    expect(next?.phase.kind).toBe('running');
    if (next?.phase.kind === 'running') {
      expect(next.phase.nodes.get('n1')).toEqual({ status: 'running', label: 'build' });
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
    const running: AutomationRun = { automationName: 'deploy', phase: { kind: 'running', nodes: new Map([['n1', { status: 'running', label: 'build' }]]) } };
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

  it('reduceAutomationFailed carries the error', () => {
    expect(reduceAutomationFailed('deploy', 'automation no longer exists')).toEqual({
      automationName: 'deploy',
      phase: { kind: 'failed', error: 'automation no longer exists' }
    });
  });
});
