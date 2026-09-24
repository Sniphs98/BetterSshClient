import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFromFile, parseSshConfig } from './sshConfig.js';

// Ported from crates/omnyssh-core/src/config/ssh_config.rs's unit tests.
describe('parseSshConfig', () => {
  it('empty input', () => {
    expect(parseSshConfig('')).toEqual([]);
    expect(parseSshConfig('   \n  \n')).toEqual([]);
  });

  it('comments only', () => {
    expect(parseSshConfig('# comment\n# another\n')).toEqual([]);
  });

  it('minimal config', () => {
    const hosts = parseSshConfig('Host myserver\n    HostName 192.168.1.100\n');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('myserver');
    expect(hosts[0].hostname).toBe('192.168.1.100');
    expect(hosts[0].port).toBe(22);
  });

  it('HostName fallback to the alias', () => {
    const hosts = parseSshConfig('Host myalias\n    User admin\n');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('myalias');
  });

  it('a full config with every field', () => {
    const hosts = parseSshConfig(
      'Host web-prod-1\n' +
        '    HostName 192.168.1.10\n' +
        '    User deploy\n' +
        '    Port 2222\n' +
        '    IdentityFile ~/.ssh/id_ed25519\n' +
        '    ProxyJump bastion\n'
    );
    expect(hosts).toHaveLength(1);
    const h = hosts[0];
    expect(h.name).toBe('web-prod-1');
    expect(h.hostname).toBe('192.168.1.10');
    expect(h.user).toBe('deploy');
    expect(h.port).toBe(2222);
    expect(h.identityFile ?? '').toContain('id_ed25519');
    expect(h.proxyJump).toBe('bastion');
  });

  it('multiple hosts', () => {
    const hosts = parseSshConfig(
      'Host web\n    HostName 10.0.0.1\n    User ubuntu\n\nHost db\n    HostName 10.0.0.2\n    User postgres\n    Port 5432\n'
    );
    expect(hosts).toHaveLength(2);
    expect(hosts[0].name).toBe('web');
    expect(hosts[1].name).toBe('db');
    expect(hosts[1].port).toBe(5432);
  });

  it('a wildcard Host block is skipped and never leaks defaults', () => {
    const hosts = parseSshConfig(
      'Host *\n    User ubuntu\n    ServerAliveInterval 60\n\nHost realhost\n    HostName 10.0.0.1\n'
    );
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('realhost');
  });

  it('ProxyJump', () => {
    const hosts = parseSshConfig(
      'Host bastion\n    HostName jump.example.com\n    User ops\n\nHost internal\n    HostName 192.168.100.50\n    User admin\n    ProxyJump bastion\n'
    );
    expect(hosts).toHaveLength(2);
    const internal = hosts.find((h) => h.name === 'internal');
    expect(internal?.proxyJump).toBe('bastion');
  });

  it('a non-standard port', () => {
    const hosts = parseSshConfig('Host custom\n    HostName 1.2.3.4\n    Port 22022\n');
    expect(hosts[0].port).toBe(22022);
  });

  it('keywords are case-insensitive', () => {
    const hosts = parseSshConfig('host server1\n    hostname 10.0.0.1\n    user admin\n    port 2222\n');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('10.0.0.1');
    expect(hosts[0].user).toBe('admin');
    expect(hosts[0].port).toBe(2222);
  });

  it('an inline comment is stripped, including from the Host name', () => {
    const hosts = parseSshConfig('Host srv # this is a comment\n    HostName 1.2.3.4\n');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('srv');
  });

  it('imported hosts are tagged ssh_config', () => {
    const hosts = parseSshConfig('Host test\n    HostName 1.2.3.4\n');
    expect(hosts[0].source).toBe('ssh_config');
  });

  it('the "=" separator is accepted', () => {
    const hosts = parseSshConfig('Host=myhost\n    HostName=10.0.0.1\n    User=admin\n');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('10.0.0.1');
    expect(hosts[0].user).toBe('admin');
  });
});

// Ported from crates/omnyssh-core/tests/ssh_config_parser.rs — Include-directive
// integration tests, which need a real directory tree.
describe('Include directive (integration)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'better-ssh-client-sshconfig-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeFixture(root: string): Promise<void> {
    const confD = join(root, '.ssh', 'conf.d');
    await mkdir(confD, { recursive: true });
    await writeFile(join(confD, '10-vps.conf'), 'Host vps\n    HostName 1.2.3.4\n    User root\n');
    await writeFile(join(confD, '20-work-test.conf'), 'Host work-test\n    HostName 10.0.0.2\n');
    await writeFile(join(confD, '30-work-stage.conf'), 'Host work-stage\n    HostName 10.0.0.3\n');
  }

  async function hostsFor(root: string, body: string): Promise<string[]> {
    const config = join(root, '.ssh', 'config');
    await writeFile(config, `${body}\n\nHost local-direct\n    HostName 127.0.0.1\n`);
    return loadFromFile(config).map((h) => h.name);
  }

  it('a relative Include resolves against the config directory', async () => {
    await writeFixture(tmp);
    const names = await hostsFor(tmp, 'Include conf.d/*.conf');
    expect(names).toEqual(['vps', 'work-test', 'work-stage', 'local-direct']);
  });

  it('a relative Include ignores the process working directory', async () => {
    await writeFixture(tmp);
    const decoy = await mkdtemp(join(tmpdir(), 'better-ssh-client-decoy-'));
    await mkdir(join(decoy, 'conf.d'), { recursive: true });
    await writeFile(join(decoy, 'conf.d', '99-decoy.conf'), 'Host decoy\n    HostName 6.6.6.6\n');

    const cwd = process.cwd();
    process.chdir(decoy);
    let names: string[];
    try {
      names = await hostsFor(tmp, 'Include conf.d/*.conf');
    } finally {
      process.chdir(cwd);
      await rm(decoy, { recursive: true, force: true });
    }
    expect(names).toEqual(['vps', 'work-test', 'work-stage', 'local-direct']);
  });

  it('absolute and glob(7) Include patterns resolve', async () => {
    await writeFixture(tmp);
    const confD = join(tmp, '.ssh', 'conf.d');
    const cases = [
      `Include ${confD.replace(/\\/g, '/')}/*.conf`,
      'Include conf.d/?0-*.conf',
      'Include conf.d/[123]0-*.conf',
      'Include con*/*.conf'
    ];
    for (const body of cases) {
      const names = await hostsFor(tmp, body);
      expect(names, `pattern did not match: ${body}`).toEqual(['vps', 'work-test', 'work-stage', 'local-direct']);
    }
  });

  it('a base directory containing glob metacharacters still resolves', async () => {
    const awkward = join(tmp, 'us[er]');
    await mkdir(awkward, { recursive: true });
    await writeFixture(awkward);
    const names = await hostsFor(awkward, 'Include conf.d/*.conf');
    expect(names).toEqual(['vps', 'work-test', 'work-stage', 'local-direct']);
  });

  it('a second wildcard in one filename matches', async () => {
    await writeFixture(tmp);
    const names = await hostsFor(tmp, 'Include conf.d/*-work-*.conf');
    expect(names).toEqual(['work-test', 'work-stage', 'local-direct']);
  });

  it('several pathnames on one Include line are all read', async () => {
    await writeFixture(tmp);
    const names = await hostsFor(tmp, 'Include conf.d/10-vps.conf conf.d/20-work-test.conf');
    expect(names).toEqual(['vps', 'work-test', 'local-direct']);
  });

  it('a quoted pathname keeps its spaces', async () => {
    await writeFixture(tmp);
    await writeFile(join(tmp, '.ssh', 'conf.d', 'with space.conf'), 'Host spaced\n    HostName 10.0.0.4\n');
    const names = await hostsFor(tmp, 'Include "conf.d/with space.conf"');
    expect(names).toEqual(['spaced', 'local-direct']);
  });

  it('an Include inside a Host block keeps the enclosing host', async () => {
    await writeFixture(tmp);
    const config = join(tmp, '.ssh', 'config');
    await writeFile(config, 'Host gate\n    Include conf.d/10-vps.conf\n    HostName 10.0.0.9\n    User ops\n');
    const hosts = loadFromFile(config);
    const gate = hosts.find((h) => h.name === 'gate');
    expect(gate?.hostname).toBe('10.0.0.9');
    expect(gate?.user).toBe('ops');
    expect(hosts.some((h) => h.name === 'vps')).toBe(true);
  });

  it('an Include matching nothing is a no-op', async () => {
    await writeFixture(tmp);
    for (const body of ['Include conf.d/nope*.conf', 'Include conf.d/absent.conf']) {
      expect(await hostsFor(tmp, body)).toEqual(['local-direct']);
    }
  });

  it('a directory matching the pattern is skipped', async () => {
    await writeFixture(tmp);
    await mkdir(join(tmp, '.ssh', 'conf.d', '40-dir.conf'), { recursive: true });
    const names = await hostsFor(tmp, 'Include conf.d/*.conf');
    expect(names).toEqual(['vps', 'work-test', 'work-stage', 'local-direct']);
  });

  it('a nested relative Include resolves against the same base', async () => {
    await writeFixture(tmp);
    const confD = join(tmp, '.ssh', 'conf.d');
    await writeFile(join(confD, '10-vps.conf'), 'Host vps\n    HostName 1.2.3.4\nInclude conf.d/40-deep.conf\n');
    await writeFile(join(confD, '40-deep.conf'), 'Host deep\n    HostName 10.0.0.5\n');
    const names = await hostsFor(tmp, 'Include conf.d/10-vps.conf');
    expect(names).toEqual(['vps', 'deep', 'local-direct']);
  });

  it('an Include cycle terminates', async () => {
    await writeFixture(tmp);
    const confD = join(tmp, '.ssh', 'conf.d');
    await writeFile(join(confD, 'a.conf'), 'Host a\n    HostName 10.0.0.6\nInclude conf.d/b.conf\n');
    await writeFile(join(confD, 'b.conf'), 'Host b\n    HostName 10.0.0.7\nInclude conf.d/a.conf\n');
    const names = await hostsFor(tmp, 'Include conf.d/a.conf');
    expect(names).toEqual(['a', 'b', 'local-direct']);
  });
});
