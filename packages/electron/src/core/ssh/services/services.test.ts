import { describe, expect, it } from 'vitest';

import { ProbeOutput } from '../probe.js';
import { dockerProvider } from './docker.js';
import { nginxProvider } from './nginx.js';
import { nodejsProvider } from './nodejs.js';
import { postgresqlProvider } from './postgresql.js';
import { redisProvider } from './redis.js';
import { detectServices, getProvider } from './registry.js';

// Ported from crates/omnyssh-core/src/ssh/services/{mod,docker,nginx,nodejs,postgresql,redis}.rs's tests.

describe('registry', () => {
  it('has exactly the 5 supported providers', () => {
    const probe = ProbeOutput.parse('');
    // Nothing detected against empty input; this just confirms the registry
    // doesn't throw and every kind is reachable via getProvider.
    expect(detectServices(probe)).toEqual([]);
    for (const kind of ['docker', 'nginx', 'postgresql', 'redis', 'nodejs'] as const) {
      expect(getProvider(kind)).toBeDefined();
    }
  });
});

describe('dockerProvider', () => {
  it('detects from a non-empty DOCKER section', () => {
    const probe = ProbeOutput.parse('===BSSH:DOCKER===\nabc123\tnginx\tUp 2 hours\tnginx:latest\n');
    expect(dockerProvider.detect(probe)).toBe(true);
  });

  it('is not detected when the section is absent', () => {
    const probe = ProbeOutput.parse('===BSSH:OS===\nUbuntu\n');
    expect(dockerProvider.detect(probe)).toBe(false);
  });

  it('quickMetrics counts total and running containers', () => {
    const probe = ProbeOutput.parse(
      '===BSSH:DOCKER===\nabc\tweb\tUp 2 hours\tnginx:latest\ndef\tdb\tExited (0) 3 days ago\tpostgres:15\n'
    );
    const metrics = dockerProvider.quickMetrics(probe);
    expect(metrics).toContainEqual({ name: 'containers_total', value: 2 });
    expect(metrics).toContainEqual({ name: 'containers_running', value: 1 });
  });
});

describe('nginxProvider', () => {
  it('detects from a process line', () => {
    const probe = ProbeOutput.parse('===BSSH:PROCESS===\nroot 1234 nginx: master process\n');
    expect(nginxProvider.detect(probe)).toBe(true);
  });
});

describe('nodejsProvider', () => {
  it('detects a node process', () => {
    const probe = ProbeOutput.parse('===BSSH:PROCESS===\nuser 1234 /usr/bin/node server.js\n');
    expect(nodejsProvider.detect(probe)).toBe(true);
  });

  it('is not detected without a node process', () => {
    const probe = ProbeOutput.parse('===BSSH:SERVICES===\nsshd.service\n');
    expect(nodejsProvider.detect(probe)).toBe(false);
  });
});

describe('postgresqlProvider', () => {
  it('detects from systemd', () => {
    const probe = ProbeOutput.parse('===BSSH:SERVICES===\npostgresql.service\nsshd.service\n');
    expect(postgresqlProvider.detect(probe)).toBe(true);
  });

  it('detects from the listening port', () => {
    const probe = ProbeOutput.parse('===BSSH:LISTEN===\n0.0.0.0:5432\tLISTEN\n');
    expect(postgresqlProvider.detect(probe)).toBe(true);
  });
});

describe('redisProvider', () => {
  it('detects from the listening port', () => {
    const probe = ProbeOutput.parse('===BSSH:LISTEN===\n0.0.0.0:6379\tLISTEN\n');
    expect(redisProvider.detect(probe)).toBe(true);
  });

  it('detects from the process list', () => {
    const probe = ProbeOutput.parse('===BSSH:PROCESS===\nredis 1234 redis-server\n');
    expect(redisProvider.detect(probe)).toBe(true);
  });

  it('is not detected without a match', () => {
    const probe = ProbeOutput.parse('===BSSH:SERVICES===\nsshd.service\n');
    expect(redisProvider.detect(probe)).toBe(false);
  });
});
