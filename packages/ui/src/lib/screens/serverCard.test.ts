import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { ConnectionStatusDto, HostDto, MetricsDto } from '$lib/bindings';
import type { HostServices } from '$lib/stores/services';
import { deriveCard, formatLastSeen, metricStatus, onlineCards, QUICK_ACTIONS, filterHosts } from './serverCard';

function host(name = 'web-1'): HostDto {
  return { name, hostname: '10.0.0.1', user: 'root', port: 22, tags: [], source: 'manual', hasKey: false, monitoring: 'ssh' };
}

function tcpHost(name = 'fw-1'): HostDto {
  return { ...host(name), monitoring: 'tcpPort', monitorPort: 8443 };
}

function metrics(partial: Partial<MetricsDto>): MetricsDto {
  return { topProcesses: [], ageSeconds: 0, ...partial };
}

const CONNECTED: ConnectionStatusDto = { kind: 'connected' };

describe('metricStatus — mirrors metrics::threshold_level', () => {
  it('classifies against the 60 / 85 boundaries', () => {
    expect(metricStatus(0)).toBe('ok');
    expect(metricStatus(59.9)).toBe('ok');
    expect(metricStatus(60)).toBe('warn');
    expect(metricStatus(85)).toBe('warn');
    expect(metricStatus(85.1)).toBe('crit');
    expect(metricStatus(100)).toBe('crit');
  });
});

describe('deriveCard — health state', () => {
  it('a connected, healthy host is ok and not offline', () => {
    const card = deriveCard(host(), CONNECTED, metrics({ cpuPercent: 10, ramPercent: 20, diskPercent: 30 }), undefined);
    expect(card.overall).toBe('ok');
    expect(card.offline).toBe(false);
    expect(card.metricRows.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('a connected host takes the worst metric severity as its overall state', () => {
    const warn = deriveCard(host(), CONNECTED, metrics({ cpuPercent: 10, ramPercent: 70, diskPercent: 10 }), undefined);
    expect(warn.overall).toBe('warn');
    const crit = deriveCard(host(), CONNECTED, metrics({ cpuPercent: 95, ramPercent: 70, diskPercent: 10 }), undefined);
    expect(crit.overall).toBe('crit');
  });

  it('a connected host with no metrics yet is ok and not offline', () => {
    const card = deriveCard(host(), CONNECTED, undefined, undefined);
    expect(card.overall).toBe('ok');
    expect(card.offline).toBe(false);
    expect(card.metricRows.map((r) => r.percent)).toEqual([null, null, null]);
    expect(card.metricRows.map((r) => r.status)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('a failed host with no metrics is off and offline', () => {
    const card = deriveCard(host(), { kind: 'failed', message: 'refused' }, undefined, undefined);
    expect(card.overall).toBe('off');
    expect(card.offline).toBe(true);
  });

  it('a failed host keeps showing its last metrics rather than an offline state', () => {
    const card = deriveCard(host(), { kind: 'failed', message: 'refused' }, metrics({ cpuPercent: 40 }), undefined);
    expect(card.overall).toBe('off');
    expect(card.offline).toBe(false);
  });

  it('a failed host with only os-info renders (not offline), mirroring the TUI', () => {
    // Discovery emits an os-info-only sample; a down host still shows what it knows.
    const card = deriveCard(host(), { kind: 'failed', message: 'refused' }, metrics({ osInfo: 'Ubuntu 22.04' }), undefined);
    expect(card.offline).toBe(false);
    expect(card.osInfo).toBe('Ubuntu 22.04');
    expect(card.overall).toBe('off');
  });

  it('a connecting host is neutral and not offline', () => {
    const card = deriveCard(host(), { kind: 'connecting' }, undefined, undefined);
    expect(card.overall).toBe('unknown');
    expect(card.offline).toBe(false);
  });

  it('an unprobed host with no status is neutral and offline', () => {
    const card = deriveCard(host(), undefined, undefined, undefined);
    expect(card.overall).toBe('unknown');
    expect(card.offline).toBe(true);
  });

  it('a single reported metric drives severity while the others stay unknown', () => {
    const card = deriveCard(host(), CONNECTED, metrics({ diskPercent: 90 }), undefined);
    expect(card.overall).toBe('crit');
    expect(card.metricRows).toEqual([
      { label: 'CPU', percent: null, status: 'unknown' },
      { label: 'RAM', percent: null, status: 'unknown' },
      { label: 'Disk', percent: 90, status: 'crit' }
    ]);
  });

  it('carries uptime, os info and top processes through', () => {
    const card = deriveCard(
      host(),
      CONNECTED,
      metrics({ uptime: '3 days', osInfo: 'Ubuntu 22.04', topProcesses: [{ name: 'pg', cpuPercent: 30, memPercent: 12 }] }),
      undefined
    );
    expect(card.uptime).toBe('3 days');
    expect(card.osInfo).toBe('Ubuntu 22.04');
    expect(card.topProcesses).toHaveLength(1);
  });
});

describe('deriveCard — detected services', () => {
  it('names each kind and summarises the docker quick-scan container counts', () => {
    // The quick-scan emits containers_total + containers_running for docker, and no
    // metrics for the other kinds (they render name-only).
    const svc: HostServices = {
      kind: 'detected',
      services: [
        { kind: 'docker', metrics: [{ name: 'containers_total', value: 7 }, { name: 'containers_running', value: 6 }] },
        { kind: 'postgresql', metrics: [] }
      ]
    };
    const card = deriveCard(host(), CONNECTED, undefined, svc);
    expect(card.detectedServices).toEqual([
      { kind: 'docker', name: 'Docker', detail: '6/7 running' },
      { kind: 'postgresql', name: 'PostgreSQL', detail: '' }
    ]);
    expect(card.servicesError).toBeUndefined();
  });

  it('reads a docker host with containers present but none running', () => {
    const svc: HostServices = {
      kind: 'detected',
      services: [{ kind: 'docker', metrics: [{ name: 'containers_total', value: 3 }, { name: 'containers_running', value: 0 }] }]
    };
    expect(deriveCard(host(), CONNECTED, undefined, svc).detectedServices[0].detail).toBe('0/3 running');
  });

  it('shows no docker detail until its quick-scan metrics arrive', () => {
    const svc: HostServices = { kind: 'detected', services: [{ kind: 'docker', metrics: [] }] };
    expect(deriveCard(host(), CONNECTED, undefined, svc).detectedServices[0].detail).toBe('');
  });

  it('surfaces a discovery failure and shows no service chips', () => {
    const svc: HostServices = { kind: 'failed', message: 'scan timed out' };
    const card = deriveCard(host(), CONNECTED, undefined, svc);
    expect(card.detectedServices).toEqual([]);
    expect(card.servicesError).toBe('scan timed out');
  });
});

describe('filterHosts — mirrors the TUI host search', () => {
  const card = (o: Partial<HostDto>) => deriveCard({ ...host(), ...o }, CONNECTED, undefined, undefined);
  const cards = [
    card({ name: 'web-prod', hostname: '10.0.0.1', tags: ['production'], notes: 'billing frontend' }),
    card({ name: 'db-staging', hostname: '10.0.0.2', tags: ['staging', 'db'] }),
    card({ name: 'cache', hostname: '192.168.1.5', tags: [] })
  ];
  const names = (q: string) => filterHosts(cards, q).map((c) => c.host.name);

  it('keeps every card for an empty or whitespace query', () => {
    expect(filterHosts(cards, '')).toHaveLength(3);
    expect(filterHosts(cards, '   ')).toHaveLength(3);
  });

  it('matches name, hostname, tags and notes, case-insensitively', () => {
    expect(names('WEB')).toEqual(['web-prod']);
    expect(names('192.168')).toEqual(['cache']);
    expect(names('staging')).toEqual(['db-staging']);
    expect(names('BILLING')).toEqual(['web-prod']);
  });

  it('returns nothing when no card matches', () => {
    expect(filterHosts(cards, 'nope')).toEqual([]);
  });
});

// --- Quick-action dispatch: the card's sh/files buttons use the shared spawn path. ---

async function freshNav() {
  vi.resetModules();
  const { QUICK_ACTIONS: actions } = await import('./serverCard');
  const { spawnSession } = await import('$lib/stores/navigation');
  const { sessions } = await import('$lib/stores/sessions');
  const { activeEntity } = await import('$lib/stores/activeEntity');
  return { actions, spawnSession, sessions, activeEntity };
}

describe('quick actions', () => {
  it('map sh to a terminal and files to an SFTP session', () => {
    expect(QUICK_ACTIONS.map((a) => [a.id, a.kind])).toEqual([
      ['sh', 'terminal'],
      ['files', 'sftp']
    ]);
  });

  it('dispatch through the shared spawn path, appending an active session of the right kind', async () => {
    const { actions, spawnSession, sessions, activeEntity } = await freshNav();
    for (const action of actions) {
      const s = spawnSession(action.kind, 'web-1');
      expect(s.kind).toBe(action.kind);
      expect(get(activeEntity)).toEqual({ kind: 'session', id: s.id });
    }
    expect(get(sessions).map((s) => s.kind)).toEqual(['terminal', 'sftp']);
  });
});

describe('deriveCard — reachability hosts', () => {
  it('shows the probe result instead of metric tiles', () => {
    const card = deriveCard(tcpHost(), { kind: 'connected' }, undefined, undefined);
    expect(card.reachability).toBe('reachable');
    expect(card.metricRows).toEqual([]);
    expect(card.overall).toBe('ok');
    expect(card.offline).toBe(false);
  });

  it('reports a failed probe as unreachable and offline', () => {
    const card = deriveCard(tcpHost(), { kind: 'failed', message: 'refused' }, undefined, undefined);
    expect(card.reachability).toBe('unreachable');
    expect(card.offline).toBe(true);
    expect(card.overall).toBe('off');
  });

  it('is still checking before the first probe answers', () => {
    expect(deriveCard(tcpHost(), { kind: 'connecting' }, undefined, undefined).reachability).toBe('checking');
    expect(deriveCard(tcpHost(), undefined, undefined, undefined).reachability).toBe('checking');
  });

  it('never claims metrics an ssh host would have reported', () => {
    const card = deriveCard(tcpHost(), { kind: 'connected' }, metrics({ cpuPercent: 90 }), undefined);
    expect(card.metricRows).toEqual([]);
    expect(card.uptime).toBeUndefined();
  });

  it('leaves an ssh host on the metric path', () => {
    const card = deriveCard(host(), { kind: 'connected' }, metrics({ cpuPercent: 10 }), undefined);
    expect(card.reachability).toBeUndefined();
    expect(card.metricRows).toHaveLength(3);
  });
});

describe('deriveCard — cached info on an offline card', () => {
  const FAILED: ConnectionStatusDto = { kind: 'failed', message: 'timeout' };
  const cached = { osInfo: 'Ubuntu 24.04.3 LTS', lastSeen: 1_000 };

  it('shows the last known OS and when the host was last seen, with empty metric bars', () => {
    const card = deriveCard(host(), FAILED, undefined, undefined, cached);
    expect(card.offline).toBe(true);
    expect(card.osInfo).toBe('Ubuntu 24.04.3 LTS');
    expect(card.lastSeen).toBe(1_000);
    expect(card.metricRows.map((r) => r.percent)).toEqual([null, null, null]);
  });

  it('ignores the cache while the host reports live metrics', () => {
    const card = deriveCard(host(), CONNECTED, metrics({ osInfo: 'Debian 12' }), undefined, cached);
    expect(card.osInfo).toBe('Debian 12');
    expect(card.lastSeen).toBeUndefined();
  });
});

describe('formatLastSeen', () => {
  const now = 10 * 24 * 3_600_000;
  it('rounds down to the coarsest fitting unit', () => {
    expect(formatLastSeen(now - 30_000, now)).toBe('last seen just now');
    expect(formatLastSeen(now - 5 * 60_000, now)).toBe('last seen 5m ago');
    expect(formatLastSeen(now - 3 * 3_600_000, now)).toBe('last seen 3h ago');
    expect(formatLastSeen(now - 2 * 24 * 3_600_000, now)).toBe('last seen 2d ago');
  });
});

describe('onlineCards', () => {
  it('keeps the connected hosts — healthy or in alert — and drops the rest', () => {
    const card = (name: string) => ({ host: { name } });
    const statuses = new Map([
      ['up', { kind: 'connected' }],
      ['down', { kind: 'failed' }],
      ['coming', { kind: 'connecting' }]
    ]);
    expect(onlineCards([card('up'), card('down'), card('coming'), card('never')], statuses).map((c) => c.host.name)).toEqual(['up']);
  });
});
