import { describe, expect, it } from 'vitest';
import { isEditableFile, languageForFile } from './fileEdit';

describe('isEditableFile', () => {
  it('accepts recognised text extensions', () => {
    expect(isEditableFile('docker-compose.yml', 100)).toBe(true);
    expect(isEditableFile('config.json', 100)).toBe(true);
    expect(isEditableFile('nginx.conf', 100)).toBe(true);
    expect(isEditableFile('deploy.sh', 100)).toBe(true);
  });

  it('accepts recognised extensionless config filenames, case-insensitively', () => {
    expect(isEditableFile('Dockerfile', 100)).toBe(true);
    expect(isEditableFile('MAKEFILE', 100)).toBe(true);
    expect(isEditableFile('.gitignore', 100)).toBe(true);
  });

  it('rejects an unrecognised extension', () => {
    expect(isEditableFile('photo.png', 100)).toBe(false);
    expect(isEditableFile('archive.tar.gz', 100)).toBe(false);
    expect(isEditableFile('app.bin', 100)).toBe(false);
  });

  it('rejects a file with no extension and no recognised name', () => {
    expect(isEditableFile('README', 100)).toBe(false);
  });

  it('rejects a recognised extension once it is too large to load whole', () => {
    expect(isEditableFile('huge.log', 3 * 1024 * 1024)).toBe(false);
  });

  it('accepts right at the size cap', () => {
    expect(isEditableFile('big.txt', 2 * 1024 * 1024)).toBe(true);
  });
});

describe('languageForFile', () => {
  it('maps common extensions to their Monaco language id', () => {
    expect(languageForFile('a.yml')).toBe('yaml');
    expect(languageForFile('a.yaml')).toBe('yaml');
    expect(languageForFile('a.json')).toBe('json');
    expect(languageForFile('a.sh')).toBe('shell');
    expect(languageForFile('a.md')).toBe('markdown');
  });

  it('matches a few well-known filenames by name rather than extension', () => {
    expect(languageForFile('Dockerfile')).toBe('dockerfile');
    expect(languageForFile('.bashrc')).toBe('shell');
  });

  it('falls back to plaintext for an unmapped or extensionless name', () => {
    expect(languageForFile('Makefile')).toBe('plaintext');
    expect(languageForFile('notes')).toBe('plaintext');
  });
});
