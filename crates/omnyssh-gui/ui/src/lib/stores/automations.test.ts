import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { AutomationStepResult } from '$lib/bindings';
import {
  automationRun,
  beginAutomationRun,
  clearAutomationRun,
  failPendingAutomationRun,
  reduceStepResult,
  reduceStepStarted,
  type AutomationRun
} from './automations';

function result(partial: Partial<AutomationStepResult>): AutomationStepResult {
  return { automationName: 'deploy', stepIndex: 0, ok: true, output: 'done', ...partial };
}

describe('automation run lifecycle', () => {
  beforeEach(() => clearAutomationRun());

  it('beginAutomationRun seeds one queued entry per step, in order', () => {
    beginAutomationRun('deploy', ['Local: a', 'Upload: b -> c']);
    const run = get(automationRun);
    expect(run?.automationName).toBe('deploy');
    expect(run?.entries).toEqual([
      { description: 'Local: a', started: false, pending: true, ok: false, output: '' },
      { description: 'Upload: b -> c', started: false, pending: true, ok: false, output: '' }
    ]);
  });

  it('clearAutomationRun dismisses the panel', () => {
    beginAutomationRun('deploy', ['Local: a']);
    clearAutomationRun();
    expect(get(automationRun)).toBeNull();
  });

  it('failPendingAutomationRun fails only the still-pending entries', () => {
    beginAutomationRun('deploy', ['Local: a', 'Local: b']);
    reduceResultInto(result({ stepIndex: 0, ok: true, output: 'done' }));
    failPendingAutomationRun('automation failed');

    const run = get(automationRun);
    expect(run?.entries[0]).toEqual({
      description: 'Local: a',
      started: true,
      pending: false,
      ok: true,
      output: 'done'
    });
    expect(run?.entries[1]).toEqual({
      description: 'Local: b',
      started: true,
      pending: false,
      ok: false,
      output: 'automation failed'
    });
  });

  it('failPendingAutomationRun is a no-op with no active run', () => {
    clearAutomationRun();
    failPendingAutomationRun('boom');
    expect(get(automationRun)).toBeNull();
  });
});

function reduceResultInto(payload: AutomationStepResult): void {
  automationRun.update((run) => reduceStepResult(run, payload));
}

describe('reduceStepStarted', () => {
  const base: AutomationRun = {
    automationName: 'deploy',
    entries: [
      { description: 'Local: a', started: false, pending: true, ok: false, output: '' },
      { description: 'Local: b', started: false, pending: true, ok: false, output: '' }
    ]
  };

  it('marks the matching step started', () => {
    const next = reduceStepStarted(base, { automationName: 'deploy', stepIndex: 1 });
    expect(next?.entries[0].started).toBe(false);
    expect(next?.entries[1].started).toBe(true);
  });

  it('ignores an event for a different automation', () => {
    const next = reduceStepStarted(base, { automationName: 'other', stepIndex: 0 });
    expect(next).toBe(base);
  });

  it('is a no-op when no run is active', () => {
    expect(reduceStepStarted(null, { automationName: 'deploy', stepIndex: 0 })).toBeNull();
  });
});

describe('reduceStepResult', () => {
  const base: AutomationRun = {
    automationName: 'deploy',
    entries: [
      { description: 'Local: a', started: true, pending: true, ok: false, output: '' },
      { description: 'Local: b', started: false, pending: true, ok: false, output: '' }
    ]
  };

  it('fills the matching step entry and clears its pending flag', () => {
    const next = reduceStepResult(base, result({ stepIndex: 0, ok: true, output: 'hi' }));
    expect(next?.entries[0]).toEqual({
      description: 'Local: a',
      started: true,
      pending: false,
      ok: true,
      output: 'hi'
    });
    // The other step is untouched.
    expect(next?.entries[1].pending).toBe(true);
  });

  it('records a failure output', () => {
    const next = reduceStepResult(base, result({ stepIndex: 1, ok: false, output: 'boom' }));
    expect(next?.entries[1]).toEqual({
      description: 'Local: b',
      started: true,
      pending: false,
      ok: false,
      output: 'boom'
    });
  });

  it('ignores a result for a different automation (stale run)', () => {
    const next = reduceStepResult(base, result({ automationName: 'other', stepIndex: 0 }));
    expect(next).toBe(base);
  });

  it('is a no-op when no run is active', () => {
    expect(reduceStepResult(null, result({}))).toBeNull();
  });
});
