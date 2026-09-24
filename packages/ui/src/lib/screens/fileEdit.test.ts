import { describe, expect, it } from 'vitest';
import { isEditableFile, languageForFile } from './fileEdit';

describe('isEditableFile', () => {
  it('accepts recognised text extensions', () => {
    expect(isEditableFile('docker-compose.yml', 100)).toBe(true);
    expect(isEditableFile('config.json', 100)).toBe(true);
    expect(isEditableFile('nginx.conf', 100)).toBe(true);
    expect(isEditableFile('deploy.sh', 100)).toBe(true);
  });

  it('accepts a broad range of extensions beyond the original short whitelist', () => {
    expect(isEditableFile('main.rs', 100)).toBe(true);
    expect(isEditableFile('App.java', 100)).toBe(true);
    expect(isEditableFile('index.php', 100)).toBe(true);
    expect(isEditableFile('deploy.tf', 100)).toBe(true);
    expect(isEditableFile('script.ps1', 100)).toBe(true);
    expect(isEditableFile('icon.svg', 100)).toBe(true);
    expect(isEditableFile('data.csv', 100)).toBe(true);
  });

  it('accepts recognised extensionless config filenames, case-insensitively', () => {
    expect(isEditableFile('Dockerfile', 100)).toBe(true);
    expect(isEditableFile('MAKEFILE', 100)).toBe(true);
    expect(isEditableFile('.gitignore', 100)).toBe(true);
  });

  it('accepts SSH/server admin files an SSH manager\'s users actually open', () => {
    expect(isEditableFile('sshd_config', 100)).toBe(true);
    expect(isEditableFile('authorized_keys', 100)).toBe(true);
    expect(isEditableFile('known_hosts', 100)).toBe(true);
    expect(isEditableFile('crontab', 100)).toBe(true);
    expect(isEditableFile('fstab', 100)).toBe(true);
  });

  it('accepts an unrecognised extension — opens as plaintext, same as VS Code', () => {
    expect(isEditableFile('notes.xyz', 100)).toBe(true);
  });

  it('accepts a file with no extension and no recognised name — opens as plaintext', () => {
    expect(isEditableFile('README', 100)).toBe(true);
    expect(isEditableFile('CHANGELOG', 100)).toBe(true);
  });

  it('rejects a known-binary extension regardless of name', () => {
    expect(isEditableFile('photo.png', 100)).toBe(false);
    expect(isEditableFile('archive.zip', 100)).toBe(false);
    expect(isEditableFile('app.bin', 100)).toBe(false);
    expect(isEditableFile('report.pdf', 100)).toBe(false);
  });

  it('rejects a recognised extension once it is too large to load whole', () => {
    expect(isEditableFile('huge.log', 3 * 1024 * 1024)).toBe(false);
  });

  it('rejects an unrecognised extension once it is too large to load whole', () => {
    expect(isEditableFile('README', 3 * 1024 * 1024)).toBe(false);
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

  it('maps the extensions newly added beyond the original short whitelist', () => {
    expect(languageForFile('main.rs')).toBe('rust');
    expect(languageForFile('App.java')).toBe('java');
    expect(languageForFile('index.php')).toBe('php');
    expect(languageForFile('deploy.tf')).toBe('hcl');
    expect(languageForFile('script.ps1')).toBe('powershell');
    expect(languageForFile('icon.svg')).toBe('xml');
  });

  it('matches a few well-known filenames by name rather than extension', () => {
    expect(languageForFile('Dockerfile')).toBe('dockerfile');
    expect(languageForFile('.bashrc')).toBe('shell');
    expect(languageForFile('sshd_config')).toBe('ini');
  });

  it('falls back to plaintext for an unmapped or extensionless name', () => {
    expect(languageForFile('Makefile')).toBe('plaintext');
    expect(languageForFile('notes')).toBe('plaintext');
    expect(languageForFile('notes.xyz')).toBe('plaintext');
  });
});
