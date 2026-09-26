import { describe, expect, it } from 'vitest';
import { decodeWslOutput, parseDistroList, wslArgs } from './wslExec.js';

describe('wslExec', () => {
  it('reads wsl.exe output whether it came as UTF-16 or UTF-8', () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu\r\ndocker-desktop\r\n', 'utf16le'))).toBe('Ubuntu\r\ndocker-desktop\r\n');
    expect(decodeWslOutput(Buffer.from('Loaded image: nginx:1.27\n', 'utf8'))).toBe('Loaded image: nginx:1.27\n');
  });

  it("lists the distributions, without Docker Desktop's internal ones", () => {
    expect(parseDistroList('Ubuntu\r\ndocker-desktop-data\r\ndocker-desktop\r\nDebian\r\n\r\n')).toEqual(['Ubuntu', 'Debian']);
  });

  it('runs bash in the chosen distribution, the command never on the command line', () => {
    expect(wslArgs('Ubuntu')).toEqual(['-d', 'Ubuntu', '--exec', 'bash', '-lc', 'eval "$BSSH_COMMAND"']);
    expect(wslArgs(undefined)).toEqual(['--exec', 'bash', '-lc', 'eval "$BSSH_COMMAND"']);
  });
});
