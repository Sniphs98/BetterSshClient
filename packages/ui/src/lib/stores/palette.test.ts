import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { AutomationDto, ConnectionStatusDto, HostDto } from '$lib/bindings';
import type { Session } from './sessions';
import { palette, paletteItems, paletteSignature, nextIndex, hostStatusDot } from './palette';

function host(name: string, extra: Partial<HostDto> = {}): HostDto {
  return {
    name,
    hostname: `${name}.example.com`,
    user: 'deploy',
    port: 22,
    tags: [],
    source: 'manual',
    hasKey: false,
    monitoring: 'ssh',
    ...extra
  };
}

function session(id: number, hostName: string, kind: Session['kind'] = 'terminal'): Session {
  return { id, kind, hostName, status: 'connecting' };
}

function automation(name: string, extra: Partial<AutomationDto> = {}): AutomationDto {
  return { id: name, name, kind: 'local', command: 'echo hi', timeoutSecs: 300, ...extra };
}

describe('paletteItems — filter & sections', () => {
  const hosts = [host('web-1', { tags: ['prod'] }), host('db-1', { user: 'root' }), host('web-2')];
  const sessions = [session(1, 'web-1', 'terminal'), session(2, 'db-1', 'sftp')];

  it('navigator lists sessions first, then hosts', () => {
    const items = paletteItems('navigate', hosts, sessions, [], '');
    expect(items.map((i) => i.kind)).toEqual(['session', 'session', 'host', 'host', 'host']);
  });

  it('host picker lists only hosts', () => {
    const items = paletteItems('pickHost', hosts, sessions, [], '');
    expect(items.every((i) => i.kind === 'host')).toBe(true);
    expect(items).toHaveLength(3);
  });

  it('filters hosts by name, hostname, user and tags', () => {
    expect(paletteItems('pickHost', hosts, [], [], 'web').map((i) => i.kind === 'host' && i.host.name))
      .toEqual(['web-1', 'web-2']);
    expect(paletteItems('pickHost', hosts, [], [], 'root')).toHaveLength(1); // db-1 by user
    expect(paletteItems('pickHost', hosts, [], [], 'prod')).toHaveLength(1); // web-1 by tag
    expect(paletteItems('pickHost', hosts, [], [], 'example.com')).toHaveLength(3); // hostname
  });

  it('requires every whitespace-separated token to match (AND)', () => {
    expect(paletteItems('pickHost', hosts, [], [], 'web prod').map((i) => i.kind === 'host' && i.host.name))
      .toEqual(['web-1']);
    expect(paletteItems('pickHost', hosts, [], [], 'web root')).toHaveLength(0);
  });

  it('filters sessions by host name and kind in the navigator', () => {
    expect(paletteItems('navigate', [], sessions, [], 'sftp').map((i) => i.kind === 'session' && i.session.id))
      .toEqual([2]);
    expect(paletteItems('navigate', [], sessions, [], 'web')).toHaveLength(1);
  });

  it('an empty query keeps everything', () => {
    expect(paletteItems('navigate', hosts, sessions, [], '   ')).toHaveLength(5);
  });

  it('automation picker always leads with the pinned "new" row, then matching automations', () => {
    const automations = [automation('Build'), automation('Deploy', { kind: 'remote' })];
    const items = paletteItems('pickAutomation', [], [], automations, '');
    expect(items.map((i) => i.kind)).toEqual(['newAutomation', 'automation', 'automation']);
  });

  it('automation picker filters by name and kind, but the "new" row always survives', () => {
    const automations = [automation('Build'), automation('Deploy', { kind: 'remote' })];
    const items = paletteItems('pickAutomation', [], [], automations, 'remote');
    expect(items.map((i) => i.kind)).toEqual(['newAutomation', 'automation']);
    expect(items[1]).toMatchObject({ kind: 'automation', automation: { name: 'Deploy' } });
  });
});

describe('paletteSignature — stable across volatile updates', () => {
  it('is identical when only a session status changes (no spurious highlight reset)', () => {
    const connecting = paletteItems('navigate', [host('web-1')], [session(1, 'web-1')], [], '');
    const connected = paletteItems(
      'navigate',
      [host('web-1')],
      [{ ...session(1, 'web-1'), status: 'connected' }],
      [],
      ''
    );
    expect(paletteSignature(connecting)).toBe(paletteSignature(connected));
  });

  it('changes when a row is added, removed, or reordered', () => {
    const base = paletteItems('navigate', [host('web-1'), host('web-2')], [], [], '');
    expect(paletteSignature(base)).not.toBe(
      paletteSignature(paletteItems('navigate', [host('web-1')], [], [], ''))
    );
    expect(paletteSignature(base)).not.toBe(
      paletteSignature(paletteItems('navigate', [host('web-2'), host('web-1')], [], [], ''))
    );
  });

  it('changes when a session row appears', () => {
    const withoutSession = paletteItems('navigate', [host('web-1')], [], [], '');
    const withSession = paletteItems('navigate', [host('web-1')], [session(1, 'web-1')], [], '');
    expect(paletteSignature(withoutSession)).not.toBe(paletteSignature(withSession));
  });
});

describe('nextIndex — wrapping selection', () => {
  it('moves forward and wraps past the end', () => {
    expect(nextIndex(0, 1, 3)).toBe(1);
    expect(nextIndex(2, 1, 3)).toBe(0);
  });

  it('moves back and wraps past the start', () => {
    expect(nextIndex(0, -1, 3)).toBe(2);
    expect(nextIndex(1, -1, 3)).toBe(0);
  });

  it('stays at 0 for an empty list', () => {
    expect(nextIndex(0, 1, 0)).toBe(0);
    expect(nextIndex(0, -1, 0)).toBe(0);
  });
});

describe('hostStatusDot — connection state → dot', () => {
  const dot = (status: ConnectionStatusDto | undefined) => hostStatusDot(status);
  it('connected is ok, failed is offline, everything else neutral', () => {
    expect(dot({ kind: 'connected' })).toBe('ok');
    expect(dot({ kind: 'failed', message: 'x' })).toBe('off');
    expect(dot({ kind: 'connecting' })).toBe('unknown');
    expect(dot({ kind: 'unknown' })).toBe('unknown');
    expect(dot(undefined)).toBe('unknown');
  });
});

describe('palette store — modes & picker resolution', () => {
  beforeEach(() => palette.close());

  it('open() shows the navigator', () => {
    palette.open();
    expect(get(palette)).toEqual({ open: true, mode: 'navigate' });
  });

  it('pickHost() resolves with the chosen host and closes', async () => {
    const pending = palette.pickHost();
    expect(get(palette)).toEqual({ open: true, mode: 'pickHost' });
    const chosen = host('web-1');
    palette.choose(chosen);
    await expect(pending).resolves.toEqual(chosen);
    expect(get(palette)).toEqual({ open: false, mode: 'navigate' });
  });

  it('closing a pending picker resolves null', async () => {
    const pending = palette.pickHost();
    palette.close();
    await expect(pending).resolves.toBeNull();
  });

  it('opening the navigator cancels a pending picker (resolves null)', async () => {
    const pending = palette.pickHost();
    palette.open();
    await expect(pending).resolves.toBeNull();
    expect(get(palette)).toEqual({ open: true, mode: 'navigate' });
  });

  it('pickAutomation() resolves with the chosen automation and closes', async () => {
    const pending = palette.pickAutomation();
    expect(get(palette)).toEqual({ open: true, mode: 'pickAutomation' });
    const chosen = automation('Build');
    palette.chooseAutomation(chosen);
    await expect(pending).resolves.toEqual(chosen);
    expect(get(palette)).toEqual({ open: false, mode: 'navigate' });
  });

  it('pickAutomation() resolves "new" when the pinned row is chosen', async () => {
    const pending = palette.pickAutomation();
    palette.chooseAutomation('new');
    await expect(pending).resolves.toBe('new');
  });

  it('closing a pending automation pick resolves null', async () => {
    const pending = palette.pickAutomation();
    palette.close();
    await expect(pending).resolves.toBeNull();
  });

  it('starting a host pick cancels a pending automation pick, and vice versa', async () => {
    const pendingAutomation = palette.pickAutomation();
    const pendingHost = palette.pickHost();
    await expect(pendingAutomation).resolves.toBeNull();
    expect(get(palette)).toEqual({ open: true, mode: 'pickHost' });

    palette.chooseAutomation(automation('Build'));
    await expect(pendingHost).resolves.toBeNull();
  });
});
