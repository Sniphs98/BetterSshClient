import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { certFingerprint, checkCertificate, forgetCertificate } from './knownCerts.js';

describe('knownCerts (trust on first use)', () => {
  let dir: string;
  const saved = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HOME: process.env.HOME };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bssh-certs-'));
    process.env.APPDATA = dir;
    process.env.XDG_CONFIG_HOME = dir;
    process.env.HOME = dir;
  });

  afterEach(async () => {
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  });

  const certA = Buffer.from('certificate A');
  const certB = Buffer.from('certificate B');

  it('shows fingerprints the way Windows does', () => {
    expect(certFingerprint(certA)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('remembers the first certificate, accepts it again, and refuses a different one', async () => {
    expect(await checkCertificate('pc:3389', certA)).toEqual({ status: 'new', fingerprint: certFingerprint(certA) });
    expect(await checkCertificate('pc:3389', certA)).toEqual({ status: 'known' });
    expect(await checkCertificate('pc:3389', certB)).toEqual({
      status: 'changed',
      fingerprint: certFingerprint(certB),
      expected: certFingerprint(certA)
    });
    // Another target is its own entry.
    expect((await checkCertificate('bastion>pc:3389', certB)).status).toBe('new');
  });

  it('trusts again after forgetting', async () => {
    await checkCertificate('pc:3389', certA);
    await forgetCertificate('pc:3389');
    expect((await checkCertificate('pc:3389', certB)).status).toBe('new');
  });

  it("doesn't lose an entry when two first connections happen at once", async () => {
    await Promise.all([checkCertificate('a:3389', certA), checkCertificate('b:3389', certB)]);
    expect(await checkCertificate('a:3389', certA)).toEqual({ status: 'known' });
    expect(await checkCertificate('b:3389', certB)).toEqual({ status: 'known' });
  });
});
