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

  it('selectFlow(null) opens a new, unsaved flow', () => {
    activeEntity.selectFlow(null);
    expect(get(activeEntity)).toEqual({ kind: 'flow', flowName: null });
  });

  it('selectFlow(name) opens that flow, deactivating a session', () => {
    activeEntity.activateSession(7);
    activeEntity.selectFlow('release');
    expect(get(activeEntity)).toEqual({ kind: 'flow', flowName: 'release' });
  });
});
