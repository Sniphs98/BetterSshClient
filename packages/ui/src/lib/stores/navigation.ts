import { get } from 'svelte/store';
import { activeEntity } from './activeEntity';
import { sessions, type Session, type SessionKind } from './sessions';
import { sidebarMode } from './sidebarMode';

// Composed navigation actions that keep the sessions list and the active entity in
// step (tech-gui.md §2). A spawn appends a session and makes it active (both spawn
// paths do this); closing the active session falls back to the current mode's home
// screen (Dashboard or Remote Desktop) so Content is never left pointing at a closed tab.
export function spawnSession(kind: SessionKind, hostName: string): Session {
  const session = sessions.spawn(kind, hostName);
  activeEntity.activateSession(session.id);
  return session;
}

/** Opens a remote desktop connection as a tab (the embedded viewer). */
export function spawnRdpSession(connectionId: string, name: string): Session {
  const session = sessions.spawn('rdp', name, { rdpConnectionId: connectionId });
  activeEntity.activateSession(session.id);
  return session;
}

/** Opens a local terminal tab — a shell on this machine — for `profile`. */
export function spawnLocalTerminal(profile: { id: string; label: string }): Session {
  const session = sessions.spawn('terminal', profile.label, { localProfileId: profile.id });
  activeEntity.activateSession(session.id);
  return session;
}

export function closeSession(id: number): void {
  const active = get(activeEntity);
  if (active.kind === 'session' && active.id === id) {
    if (get(sidebarMode) === 'remoteDesktop') activeEntity.selectRemoteDesktop();
    else activeEntity.selectDashboard();
  }
  sessions.close(id);
}

/**
 * Keeps the selector screen in step with the SSH / Remote Desktop switch. The switch
 * comes back from the last run, but the content always starts on the Dashboard — so
 * after closing the app in Remote Desktop it showed the SSH dashboard under a switch
 * saying Remote Desktop. A screen that doesn't belong to the mode now goes to that
 * mode's own: at startup, and when the saved mode is read back a moment later.
 * Settings belong to both modes and open sessions are never touched. Returns the
 * unsubscribe.
 */
export function followSidebarMode(): () => void {
  return sidebarMode.subscribe((mode) => {
    const active = get(activeEntity);
    if (mode === 'remoteDesktop' && (active.kind === 'dashboard' || active.kind === 'automations' || active.kind === 'automation')) {
      activeEntity.selectRemoteDesktop();
    } else if (mode === 'ssh' && active.kind === 'remoteDesktop') {
      activeEntity.selectDashboard();
    }
  });
}
