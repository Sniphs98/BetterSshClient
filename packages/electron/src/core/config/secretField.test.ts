import { afterEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, ENCRYPTED_PREFIX } from './secretField.js';
import { getSecretCipher, setSecretCipher, type SecretCipher } from './secretCipher.js';

function fakeCipher(available = true): SecretCipher {
  return {
    available,
    encrypt: (plainText) => Buffer.from(`fake:${plainText}`, 'utf-8'),
    decrypt: (ciphertext) => {
      const s = ciphertext.toString('utf-8');
      if (!s.startsWith('fake:')) throw new Error('not fake-encrypted');
      return s.slice('fake:'.length);
    }
  };
}

afterEach(() => {
  setSecretCipher(fakeCipher(false));
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a value through an available cipher', () => {
    const cipher = fakeCipher();
    const encrypted = encryptSecret('hunter2', cipher);
    expect(encrypted).toContain(ENCRYPTED_PREFIX);
    expect(decryptSecret(encrypted, cipher)).toBe('hunter2');
  });

  it('leaves a value as plaintext when the cipher is unavailable', () => {
    const cipher = fakeCipher(false);
    expect(encryptSecret('hunter2', cipher)).toBe('hunter2');
  });

  it('passes undefined through unchanged in both directions', () => {
    const cipher = fakeCipher();
    expect(encryptSecret(undefined, cipher)).toBeUndefined();
    expect(decryptSecret(undefined, cipher)).toBeUndefined();
  });

  it('leaves an unprefixed (legacy plaintext) value alone on decrypt', () => {
    expect(decryptSecret('plaintext-secret', fakeCipher())).toBe('plaintext-secret');
  });

  it('drops a value that fails to decrypt rather than throwing', () => {
    const badCipher: SecretCipher = { ...fakeCipher(), decrypt: () => { throw new Error('wrong key'); } };
    const encrypted = encryptSecret('hunter2', fakeCipher());
    expect(decryptSecret(encrypted, badCipher)).toBeUndefined();
  });

  it('reads the installed cipher via getSecretCipher/setSecretCipher', () => {
    setSecretCipher(fakeCipher());
    const encrypted = encryptSecret('hunter2', getSecretCipher());
    expect(decryptSecret(encrypted, getSecretCipher())).toBe('hunter2');
  });
});
