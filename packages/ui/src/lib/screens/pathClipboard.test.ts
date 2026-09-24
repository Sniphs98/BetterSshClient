import { describe, expect, it } from 'vitest';
import { pastedPath } from './pathClipboard';

describe('pastedPath', () => {
  it('takes a plain path as it is', () => {
    expect(pastedPath('/var/www')).toBe('/var/www');
  });

  it('trims whitespace and a trailing newline from a terminal copy', () => {
    expect(pastedPath('  /var/log/nginx \n')).toBe('/var/log/nginx');
  });

  it("strips the quotes Windows Explorer's Copy as path adds", () => {
    expect(pastedPath('"C:\Users\me\Documents"')).toBe('C:\Users\me\Documents');
    expect(pastedPath("'/srv/my app'")).toBe('/srv/my app');
  });

  it('keeps quotes that are not a matching pair around the whole path', () => {
    expect(pastedPath('/srv/it\'s here')).toBe("/srv/it's here");
    expect(pastedPath('"/srv/a\'')).toBe('"/srv/a\'');
  });

  it('uses only the first non-blank line', () => {
    expect(pastedPath('\n/etc/nginx\n/etc/ssh\n')).toBe('/etc/nginx');
  });

  it('gives nothing for blank text or empty quotes', () => {
    expect(pastedPath('   \n ')).toBeUndefined();
    expect(pastedPath('""')).toBeUndefined();
  });
});
