import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { SnippetDto, ConnectionStatusDto, HostDto } from '$lib/bindings';
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

function snippet(name: string, extra: Partial<SnippetDto> = {}): SnippetDto {
  return { id: name, name, command: 'echo hi', timeoutSecs: 300, ...extra };
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

  it('snippet picker always leads with the pinned "new" row, then matching snippets', () => {
    const snippets = [snippet('Build'), snippet('Deploy')];
    const items = paletteItems('pickSnippet', [], [], snippets, '');
    expect(items.map((i) => i.kind)).toEqual(['newSnippet', 'snippet', 'snippet']);
  });

  it('snippet picker filters by name, but the "new" row always survives', () => {
    const snippets = [snippet('Build'), snippet('Deploy')];
    const items = paletteItems('pickSnippet', [], [], snippets, 'deploy');
    expect(items.map((i) => i.kind)).toEqual(['newSnippet', 'snippet']);
    expect(items[1]).toMatchObject({ kind: 'snippet', snippet: { name: 'Deploy' } });
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

  it('pickSnippet() resolves with the chosen snippet and closes', async () => {
    const pending = palette.pickSnippet();
    expect(get(palette)).toEqual({ open: true, mode: 'pickSnippet' });
    const chosen = snippet('Build');
    palette.chooseSnippet(chosen);
    await expect(pending).resolves.toEqual(chosen);
    expect(get(palette)).toEqual({ open: false, mode: 'navigate' });
  });

  it('pickSnippet() resolves "new" when the pinned row is chosen', async () => {
    const pending = palette.pickSnippet();
    palette.chooseSnippet('new');
    await expect(pending).resolves.toBe('new');
  });

  it('closing a pending snippet pick resolves null', async () => {
    const pending = palette.pickSnippet();
    palette.close();
    await expect(pending).resolves.toBeNull();
  });

  it('starting a host pick cancels a pending snippet pick, and vice versa', async () => {
    const pendingSnippet = palette.pickSnippet();
    const pendingHost = palette.pickHost();
    await expect(pendingSnippet).resolves.toBeNull();
    expect(get(palette)).toEqual({ open: true, mode: 'pickHost' });

    palette.chooseSnippet(snippet('Build'));
    await expect(pendingHost).resolves.toBeNull();
  });
});

describe('paletteItems — plugin commands', () => {
  const command = (commandId: string, title: string, pluginName = 'Docker containers') => ({
    pluginId: 'docker-containers',
    pluginName,
    commandId,
    title,
    needsHost: true
  });
  const commands = [command('containers', 'Docker: containers on host…'), command('prune', 'Docker: prune images')];

  it('lists plugin commands after sessions and hosts in the navigator', () => {
    const items = paletteItems('navigate', [host('web-1')], [session(1, 'web-1')], [], '', commands);
    expect(items.map((i) => i.kind)).toEqual(['session', 'host', 'pluginCommand', 'pluginCommand']);
  });

  it('filters them by title or plugin name', () => {
    const byTitle = paletteItems('navigate', [], [], [], 'prune', commands);
    expect(byTitle.map((i) => i.kind === 'pluginCommand' && i.command.commandId)).toEqual(['prune']);
    expect(paletteItems('navigate', [], [], [], 'docker containers', commands)).toHaveLength(2);
  });

  it('keeps them out of the pickers', () => {
    expect(paletteItems('pickHost', [host('web-1')], [], [], '', commands).every((i) => i.kind === 'host')).toBe(true);
    expect(paletteItems('pickSnippet', [], [], [snippet('s')], '', commands).some((i) => i.kind === 'pluginCommand')).toBe(false);
  });

  it('gives each command a stable signature', () => {
    const items = paletteItems('navigate', [], [], [], '', commands);
    expect(paletteSignature(items)).toBe(paletteSignature(paletteItems('navigate', [], [], [], '', commands.map((c) => ({ ...c })))));
  });
});
