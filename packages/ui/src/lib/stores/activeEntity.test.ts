import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { activeEntity } from './activeEntity';

// The exactly-one-active invariant (tech-gui.md §2): Content shows one selector or
// one session, never both. Because activeEntity is a single tagged value, exclusivity
// is structural — these assert the transitions a user drives.
describe('activeEntity — exactly one active', () => {
  beforeEach(() => activeEntity.selectDashboard());

  it('defaults to the dashboard selector', () => {
    expect(get(activeEntity)).toEqual({ kind: 'dashboard' });
  });

  it('activating a session deactivates the selectors', () => {
    activeEntity.selectAutomations();
    activeEntity.activateSession(7);
    expect(get(activeEntity)).toEqual({ kind: 'session', id: 7 });
  });

  it('selecting a selector deactivates the active session', () => {
    activeEntity.activateSession(7);
    activeEntity.selectDashboard();
    expect(get(activeEntity)).toEqual({ kind: 'dashboard' });
  });

  it('the selectors are mutually exclusive', () => {
    activeEntity.selectRemoteDesktop();
    expect(get(activeEntity)).toEqual({ kind: 'remoteDesktop' });
    activeEntity.selectDashboard();
    expect(get(activeEntity)).toEqual({ kind: 'dashboard' });
  });

  it('selectAutomations activates the automations selector', () => {
    activeEntity.activateSession(7);
    activeEntity.selectAutomations();
    expect(get(activeEntity)).toEqual({ kind: 'automations' });
  });

  it('selectAutomation(null) opens a new, unsaved automation', () => {
    activeEntity.selectAutomation(null);
    expect(get(activeEntity)).toEqual({ kind: 'automation', automationName: null });
  });

  it('selectAutomation(name) opens that automation, deactivating a session', () => {
    activeEntity.activateSession(7);
    activeEntity.selectAutomation('release');
    expect(get(activeEntity)).toEqual({ kind: 'automation', automationName: 'release' });
  });

  it('remembers the automations one was opened from, for the way back', () => {
    activeEntity.selectAutomation('build', ['ship', 'release']);
    expect(get(activeEntity)).toEqual({ kind: 'automation', automationName: 'build', trail: ['ship', 'release'] });
  });
});

describe('activeEntity — leave guard', () => {
  beforeEach(() => activeEntity.selectDashboard());

  it('holds a switch the guard intercepts, and lets it through when the guard says so', () => {
    activeEntity.selectAutomation('deploy');
    let held: (() => void) | undefined;
    const remove = activeEntity.setLeaveGuard((leave) => {
      held = leave;
      return true;
    });
    activeEntity.selectSettings();
    expect(get(activeEntity)).toEqual({ kind: 'automation', automationName: 'deploy' });
    held?.();
    expect(get(activeEntity)).toEqual({ kind: 'settings' });
    remove();
  });

  it('lets every switch through once removed, or when the guard declines', () => {
    const remove = activeEntity.setLeaveGuard(() => false);
    activeEntity.selectSettings();
    expect(get(activeEntity)).toEqual({ kind: 'settings' });
    remove();
    const removeHolding = activeEntity.setLeaveGuard(() => true);
    removeHolding();
    activeEntity.selectAutomations();
    expect(get(activeEntity)).toEqual({ kind: 'automations' });
  });
});
