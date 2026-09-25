import { describe, expect, it } from 'vitest';

import { isAllowedRequest, isFullyGranted, isPermission, parseManifest, PLUGIN_API_VERSION } from './manifest.js';

const valid = {
  id: 'docker-containers',
  name: 'Docker containers',
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION,
  main: 'main.js',
  permissions: ['hosts:read', 'hosts:exec']
};

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const r = parseManifest(valid, 'docker-containers');
    expect(r.ok && r.manifest.permissions).toEqual(['hosts:read', 'hosts:exec']);
  });

  it('refuses an id that does not match its folder', () => {
    expect(parseManifest(valid, 'something-else')).toMatchObject({ ok: false, error: expect.stringContaining('folder') });
  });

  it('refuses another API version', () => {
    expect(parseManifest({ ...valid, apiVersion: 99 }, valid.id)).toMatchObject({ ok: false, error: expect.stringContaining('API 99') });
  });

  it('refuses a main script outside the plugin folder', () => {
    for (const main of ['../evil.js', '/abs/main.js', 'a/../../b.js', 'main.exe', 'C:\\\\x.js']) {
      expect(parseManifest({ ...valid, main }, valid.id).ok, main).toBe(false);
    }
    expect(parseManifest({ ...valid, main: 'dist/main.js' }, valid.id).ok).toBe(true);
  });

  it('refuses an unknown permission', () => {
    expect(parseManifest({ ...valid, permissions: ['hosts:read', 'files:all'] }, valid.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining('files:all')
    });
  });

  it('refuses malformed fields', () => {
    expect(parseManifest(null, 'x').ok).toBe(false);
    expect(parseManifest({ ...valid, id: 'Has Spaces' }, 'Has Spaces').ok).toBe(false);
    expect(parseManifest({ ...valid, version: 'latest' }, valid.id).ok).toBe(false);
    expect(parseManifest({ ...valid, name: '  ' }, valid.id).ok).toBe(false);
  });
});

describe('isPermission', () => {
  it('knows the host permissions and single-hostname network permissions', () => {
    expect(isPermission('hosts:read')).toBe(true);
    expect(isPermission('network:api.github.com')).toBe(true);
    for (const bad of ['network:*', 'network:https://x.com', 'network:x.com:443', 'network:localhost', 'network:']) {
      expect(isPermission(bad), bad).toBe(false);
    }
  });
});

describe('isFullyGranted', () => {
  it('needs every requested permission granted', () => {
    expect(isFullyGranted(['hosts:read'], ['hosts:read', 'hosts:exec'])).toBe(true);
    expect(isFullyGranted(['hosts:read', 'hosts:exec'], ['hosts:read'])).toBe(false);
    expect(isFullyGranted([], [])).toBe(true);
  });
});

describe('isAllowedRequest', () => {
  const perms = ['network:api.github.com'] as const;

  it('allows HTTPS to exactly a granted hostname', () => {
    expect(isAllowedRequest('https://api.github.com/repos/x/y', perms)).toBe(true);
    expect(isAllowedRequest('https://API.GITHUB.COM/', perms)).toBe(true);
  });

  it('refuses other hosts, lookalikes, plain HTTP and junk', () => {
    expect(isAllowedRequest('https://example.com/', perms)).toBe(false);
    expect(isAllowedRequest('https://api.github.com.evil.com/', perms)).toBe(false);
    expect(isAllowedRequest('https://evil.com/?api.github.com', perms)).toBe(false);
    expect(isAllowedRequest('http://api.github.com/', perms)).toBe(false);
    expect(isAllowedRequest('not a url', perms)).toBe(false);
    expect(isAllowedRequest('https://api.github.com/', [])).toBe(false);
  });
});
