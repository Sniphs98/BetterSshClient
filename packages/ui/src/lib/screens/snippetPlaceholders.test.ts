import { describe, expect, it } from 'vitest';
import { commandInFolder, fillFilePlaceholder, usesFilePlaceholder, FILE_PLACEHOLDER } from './snippetPlaceholders';

describe('fillFilePlaceholder', () => {
  it('substitutes the path, shell-quoted', () => {
    expect(fillFilePlaceholder('unzip {{file}}', '/srv/app.zip')).toBe("unzip '/srv/app.zip'");
  });

  it('replaces every occurrence, not just the first', () => {
    expect(fillFilePlaceholder('cp {{file}} {{file}}.bak', '/srv/a')).toBe("cp '/srv/a' '/srv/a'.bak");
  });

  it('quotes a path with spaces so it stays one argument', () => {
    expect(fillFilePlaceholder('cat {{file}}', '/srv/my file.txt')).toBe("cat '/srv/my file.txt'");
  });

  it("escapes an embedded single quote rather than ending the argument early", () => {
    expect(fillFilePlaceholder('cat {{file}}', "/srv/it's.txt")).toBe("cat '/srv/it'\\''s.txt'");
  });

  it('leaves a command that never mentions the placeholder alone', () => {
    expect(fillFilePlaceholder('docker ps', '/srv/a')).toBe('docker ps');
  });
});

describe('usesFilePlaceholder', () => {
  it('is true only when the placeholder is present', () => {
    expect(usesFilePlaceholder(`tar -xf ${FILE_PLACEHOLDER}`)).toBe(true);
    expect(usesFilePlaceholder('tar -xf archive.tar')).toBe(false);
  });
});

describe('commandInFolder', () => {
  it('runs the command in the folder being browsed, quoted', () => {
    expect(commandInFolder('docker system prune -f', '/srv/my app')).toBe("cd '/srv/my app' && docker system prune -f");
  });

  it('runs it as it is without a folder', () => {
    expect(commandInFolder('uptime', '')).toBe('uptime');
  });
});
