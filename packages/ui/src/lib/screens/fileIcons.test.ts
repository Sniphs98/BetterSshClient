import { describe, expect, it } from 'vitest';
import { fileIconName, fileIconUrl } from './fileIcons';

describe('fileIconName', () => {
  it('picks an icon by extension', () => {
    expect(fileIconName('main.py', false)).toBe('file_type_python');
    expect(fileIconName('index.ts', false)).toBe('file_type_typescript');
  });

  it('is case-insensitive', () => {
    expect(fileIconName('README.MD', false)).toBe(fileIconName('readme.md', false));
  });

  it('prefers an exact filename over its extension — dockerfile is not just a text file', () => {
    expect(fileIconName('dockerfile', false)).toBe('file_type_docker');
    expect(fileIconName('package.json', false)).toBe('file_type_npm');
    // ...while a plain .json still gets the generic json icon
    expect(fileIconName('settings.json', false)).toBe('file_type_json');
  });

  it('matches the longest suffix that the set actually defines', () => {
    // `.d.ts` is its own entry; `.tar.gz` is not, so it resolves to the gzip icon just
    // as it does in VS Code.
    expect(fileIconName('types.d.ts', false)).not.toBe(fileIconName('index.ts', false));
    expect(fileIconName('backup.tar.gz', false)).toBe(fileIconName('plain.gz', false));
  });

  it('swaps in the light-theme twin for icons that would vanish on a light background', () => {
    expect(fileIconName('config.yml', false, 'dark')).toBe('file_type_yaml');
    expect(fileIconName('config.yml', false, 'light')).toBe('file_type_light_yaml');
  });

  it('leaves an icon alone in light theme when it has no twin', () => {
    expect(fileIconName('main.py', false, 'light')).toBe(fileIconName('main.py', false, 'dark'));
  });

  it('falls back to the default file icon for something unknown', () => {
    expect(fileIconName('mystery.qqqzzz', false)).toBe('default_file');
    expect(fileIconName('no-extension-at-all', false)).toBe('default_file');
  });

  it('uses folder icons for directories, including the named ones', () => {
    expect(fileIconName('some-random-dir', true)).toBe('default_folder');
    expect(fileIconName('.git', true)).not.toBe('default_folder');
  });

  it("a directory never picks up a file icon from its name's extension", () => {
    expect(fileIconName('assets.js', true)).toBe('default_folder');
  });

  it('handles a dotfile whose name is all extension', () => {
    expect(fileIconName('.gitignore', false)).toBe('file_type_git');
  });
});

describe('fileIconUrl', () => {
  it('builds a path under the served icon directory', () => {
    expect(fileIconUrl('main.py', false)).toBe('/file-icons/file_type_python.svg');
  });
});
