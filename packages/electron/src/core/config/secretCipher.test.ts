import { afterEach, describe, expect, it } from 'vitest';
import { getSecretCipher, setSecretCipher, type SecretCipher } from './secretCipher.js';

afterEach(() => {
  // Never leak an installed cipher into another test file that assumes the default.
  setSecretCipher({
    available: false,
    encrypt: () => {
      throw new Error('encryption unavailable');
    },
    decrypt: () => {
      throw new Error('decryption unavailable');
    }
  });
});

describe('secretCipher', () => {
  it('defaults to an unavailable, throwing cipher', () => {
    const cipher = getSecretCipher();
    expect(cipher.available).toBe(false);
    expect(() => cipher.encrypt('x')).toThrow();
    expect(() => cipher.decrypt(Buffer.from('x'))).toThrow();
  });

  it('setSecretCipher installs whatever getSecretCipher returns afterward', () => {
    const installed: SecretCipher = {
      available: true,
      encrypt: (plainText) => Buffer.from(plainText, 'utf-8'),
      decrypt: (ciphertext) => ciphertext.toString('utf-8')
    };
    setSecretCipher(installed);
    expect(getSecretCipher()).toBe(installed);
    expect(getSecretCipher().decrypt(getSecretCipher().encrypt('hello'))).toBe('hello');
  });
});
