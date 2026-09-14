import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { NodeResultDto } from '$lib/bindings';
import {
  beginFlowRun,
  dismissFlowRun,
  flowRun,
  reduceFlowCompleted,
  reduceFlowFailed,
  reduceNodeResult,
  reduceNodeStarted,
  type FlowRun
} from './automations';

function result(nodeId: string, status: NodeResultDto['status'] = 'success', output = ''): NodeResultDto {
  return { nodeId, label: nodeId, status, output, durationMs: 5 };
}

describe('flow-run lifecycle', () => {
  beforeEach(() => dismissFlowRun());

  it('beginFlowRun opens a running panel with no nodes yet', () => {
    beginFlowRun('deploy');
    expect(get(flowRun)).toEqual({ flowName: 'deploy', phase: { kind: 'running', nodes: new Map() } });
  });

  it('dismiss clears the panel', () => {
    beginFlowRun('deploy');
    dismissFlowRun();
    expect(get(flowRun)).toBeNull();
  });
});

describe('reduceNodeStarted', () => {
  const running: FlowRun = { flowName: 'deploy', phase: { kind: 'running', nodes: new Map() } };

  it('adds the node as running', () => {
    const next = reduceNodeStarted(running, 'deploy', 'n1', 'build');
    expect(next?.phase.kind).toBe('running');
    if (next?.phase.kind === 'running') {
      expect(next.phase.nodes.get('n1')).toEqual({ status: 'running', label: 'build' });
    }
  });

  it('ignores an event for a different flow (single active run)', () => {
    expect(reduceNodeStarted(running, 'other-flow', 'n1', 'build')).toBe(running);
  });

  it('ignores an event when no run is active', () => {
    expect(reduceNodeStarted(null, 'deploy', 'n1', 'build')).toBeNull();
  });

  it('ignores an event once the run has reached a terminal phase', () => {
    const done: FlowRun = { flowName: 'deploy', phase: { kind: 'completed', results: [] } };
    expect(reduceNodeStarted(done, 'deploy', 'n1', 'build')).toBe(done);
  });
});

describe('reduceNodeResult', () => {
  it('marks a running node done with its result', () => {
    const running: FlowRun = { flowName: 'deploy', phase: { kind: 'running', nodes: new Map([['n1', { status: 'running', label: 'build' }]]) } };
    const next = reduceNodeResult(running, 'deploy', result('n1'));
    if (next?.phase.kind === 'running') {
      expect(next.phase.nodes.get('n1')).toEqual({ status: 'done', result: result('n1') });
    } else {
      throw new Error('expected running phase');
    }
  });

  it('adds a result directly even with no prior nodeStarted (a skipped node)', () => {
    const running: FlowRun = { flowName: 'deploy', phase: { kind: 'running', nodes: new Map() } };
    const next = reduceNodeResult(running, 'deploy', result('n2', 'skipped'));
    if (next?.phase.kind === 'running') {
      expect(next.phase.nodes.get('n2')).toEqual({ status: 'done', result: result('n2', 'skipped') });
    } else {
      throw new Error('expected running phase');
    }
  });

  it('preserves node arrival order (topo order, since nodeStarted fires in that order)', () => {
    let run: FlowRun | null = { flowName: 'deploy', phase: { kind: 'running', nodes: new Map() } };
    run = reduceNodeResult(run, 'deploy', result('first'));
    run = reduceNodeResult(run, 'deploy', result('second'));
    if (run?.phase.kind === 'running') {
      expect([...run.phase.nodes.keys()]).toEqual(['first', 'second']);
    } else {
      throw new Error('expected running phase');
    }
  });

  it('ignores an event for a different flow', () => {
    const running: FlowRun = { flowName: 'deploy', phase: { kind: 'running', nodes: new Map() } };
    expect(reduceNodeResult(running, 'other-flow', result('n1'))).toBe(running);
  });
});

describe('terminal reducers', () => {
  it('reduceFlowCompleted carries every result', () => {
    const results = [result('n1'), result('n2', 'skipped')];
    expect(reduceFlowCompleted('deploy', results)).toEqual({ flowName: 'deploy', phase: { kind: 'completed', results } });
  });

  it('reduceFlowFailed carries the error', () => {
    expect(reduceFlowFailed('deploy', 'flow no longer exists')).toEqual({
      flowName: 'deploy',
      phase: { kind: 'failed', error: 'flow no longer exists' }
    });
  });
});
