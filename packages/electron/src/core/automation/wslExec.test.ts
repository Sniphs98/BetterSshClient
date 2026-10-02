import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeWslOutput, parseDistroList, wslArgs, wslUploadPathScript, wslUploadSource } from './wslExec.js';

describe('wslExec', () => {
  it('reads wsl.exe output whether it came as UTF-16 or UTF-8', () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu\r\ndocker-desktop\r\n', 'utf16le'))).toBe('Ubuntu\r\ndocker-desktop\r\n');
    expect(decodeWslOutput(Buffer.from('Loaded image: nginx:1.27\n', 'utf8'))).toBe('Loaded image: nginx:1.27\n');
  });

  it("lists the distributions, without Docker Desktop's internal ones", () => {
    expect(parseDistroList('Ubuntu\r\ndocker-desktop-data\r\ndocker-desktop\r\nDebian\r\n\r\n')).toEqual(['Ubuntu', 'Debian']);
  });

  it('runs bash in the chosen distribution, the command never on the command line', () => {
    expect(wslArgs('Ubuntu')).toEqual(['-d', 'Ubuntu', '--exec', 'bash', '-lc', 'eval "$REMOTY_COMMAND"']);
    expect(wslArgs(undefined)).toEqual(['--exec', 'bash', '-lc', 'eval "$REMOTY_COMMAND"']);
  });
});

// The script runs inside WSL, i.e. Linux — so it is run here in this machine's bash, which
// Windows runners don't have (theirs is WSL's own launcher).
describe.skipIf(process.platform === 'win32')('wslUploadPathScript', () => {
  // A stand-in `wslpath` that marks the absolute path it was given, as WSL's own would
  // turn it into a Windows one.
  let dir = '';
  let bin = '';
  let home = '';
  let cwd = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'remoty-wslpath-'));
    bin = join(dir, 'bin');
    home = join(dir, 'home');
    cwd = join(dir, 'cwd');
    mkdirSync(bin);
    mkdirSync(home);
    mkdirSync(cwd);
    writeFileSync(join(bin, 'wslpath'), '#!/bin/sh\necho "WIN:$2"\n');
    chmodSync(join(bin, 'wslpath'), 0o755);
    writeFileSync(join(home, "it's.tar.gz"), 'x');
    writeFileSync(join(cwd, 'frontend.tar.gz'), 'x');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(path: string): { out: string; ok: boolean } {
    try {
      const out = execFileSync('bash', ['-c', wslUploadPathScript(path)], {
        cwd,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return { out: out.toString().trim(), ok: true };
    } catch (e) {
      return { out: String((e as { stderr: Buffer }).stderr).trim(), ok: false };
    }
  }

  it('gives the Windows path of an absolute, ~ or relative WSL path', () => {
    expect(run(join(cwd, 'frontend.tar.gz'))).toEqual({ out: `WIN:${join(cwd, 'frontend.tar.gz')}`, ok: true });
    expect(run("~/it's.tar.gz")).toEqual({ out: `WIN:${join(home, "it's.tar.gz")}`, ok: true });
    expect(run(' frontend.tar.gz ')).toEqual({ out: `WIN:${join(cwd, 'frontend.tar.gz')}`, ok: true });
  });

  it("fails with the WSL path when there's no such file", () => {
    expect(run('/tmp/remoty-no-such-file.tar.gz')).toEqual({ out: 'no such file in WSL: /tmp/remoty-no-such-file.tar.gz', ok: false });
    expect(run(cwd)).toEqual({ out: `not a file in WSL: ${cwd}`, ok: false });
  });
});

describe('wslUploadSource', () => {
  it("takes the path from the output's last line, after anything a login profile printed", async () => {
    const path = await wslUploadSource('Ubuntu', '/tmp/frontend.tar.gz', async () => ({
      output: 'welcome!\n\\\\wsl.localhost\\Ubuntu\\tmp\\frontend.tar.gz\n',
      ok: true
    }));
    expect(path).toBe('\\\\wsl.localhost\\Ubuntu\\tmp\\frontend.tar.gz');
  });

  it("fails with WSL's own reason", async () => {
    await expect(
      wslUploadSource(undefined, '/tmp/x', async () => ({ output: 'no such file in WSL: /tmp/x\n', ok: false, error: 'exited with code 1' }))
    ).rejects.toThrow('no such file in WSL: /tmp/x');
  });
});
