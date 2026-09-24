import { describe, expect, it } from 'vitest';

import { selfUpdateSupport, type InstallFacts } from './selfUpdate.js';

const facts = (over: Partial<InstallFacts>): InstallFacts => ({
  platform: 'win32',
  isPackaged: true,
  env: {},
  hasNsisUninstaller: true,
  ...over
});

describe('selfUpdateSupport', () => {
  it('updates a Windows install made by the installer', () => {
    expect(selfUpdateSupport(facts({}))).toEqual({ supported: true });
  });

  it('does not update the portable .exe or an unzipped copy', () => {
    expect(selfUpdateSupport(facts({ env: { PORTABLE_EXECUTABLE_DIR: 'C:\\apps' } })).supported).toBe(false);
    expect(selfUpdateSupport(facts({ hasNsisUninstaller: false })).supported).toBe(false);
  });

  it('updates a Linux AppImage, but leaves .deb/.rpm to the package manager', () => {
    expect(selfUpdateSupport(facts({ platform: 'linux', env: { APPIMAGE: '/opt/BetterSshClient.AppImage' } }))).toEqual({
      supported: true
    });
    const packaged = selfUpdateSupport(facts({ platform: 'linux', env: {} }));
    expect(packaged).toEqual({ supported: false, reason: expect.stringContaining('package manager') });
  });

  it('does not update unsigned macOS builds', () => {
    expect(selfUpdateSupport(facts({ platform: 'darwin' })).supported).toBe(false);
  });

  it('never updates a development build', () => {
    expect(selfUpdateSupport(facts({ isPackaged: false })).supported).toBe(false);
  });
});
