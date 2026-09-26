import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localUploadPath, runLocalCommand } from './localExec.js';

// Shells out via child_process.exec (real shell semantics — pipes, &&, …), so these
// tests run real (tiny, fast, cross-platform) commands rather than mocking anything.
// Node scripts run through the same `node` binary executing this test, invoked from a
// temp .js file rather than an inline `-e` string, to sidestep cmd.exe/POSIX shell
// quoting differences entirely.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'better-ssh-client-localexec-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function nodeCommand(script: string): Promise<string> {
  const scriptPath = join(dir, 'script.js');
  await writeFile(scriptPath, script, 'utf-8');
  return `"${process.execPath}" "${scriptPath}"`;
}

describe('runLocalCommand', () => {
  it('captures stdout and stderr combined, and reports ok on a zero exit', async () => {
    const cmd = await nodeCommand("console.log('from stdout'); console.error('from stderr');");
    const result = await runLocalCommand(cmd, 5000);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('from stdout');
    expect(result.output).toContain('from stderr');
    expect(result.error).toBeUndefined();
  });

  it('reports ok:false on a non-zero exit, with the output still captured', async () => {
    const cmd = await nodeCommand("console.log('before exit'); process.exit(3);");
    const result = await runLocalCommand(cmd, 5000);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('before exit');
    expect(result.error).toBeTruthy();
  });

  it('kills a command that outlives its timeout, and reports it as a timeout', async () => {
    const cmd = await nodeCommand('setTimeout(() => {}, 30000);'); // would hang for 30s if not killed
    const start = Date.now();
    const result = await runLocalCommand(cmd, 300);
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    // Resolved promptly — proof the process was actually killed, not just abandoned.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('localUploadPath', () => {
  it('reads a relative path and ~ from the home folder, keeps an absolute one', () => {
    const home = join('/', 'home', 'me');
    expect(localUploadPath('image.tar.gz', home)).toBe(join(home, 'image.tar.gz'));
    expect(localUploadPath(' ~/build/app.tgz ', home)).toBe(join(home, 'build', 'app.tgz'));
    const absolute = resolve('/data/app.tgz');
    expect(localUploadPath(absolute, home)).toBe(absolute);
  });
});
