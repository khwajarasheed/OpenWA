import { describe, expect, it } from 'vitest';
import { decryptCredentials, encryptCredentials } from '../src/credentials';
import type { Env } from '../src/types';

const env = { CREDENTIAL_ENCRYPTION_KEY: 'a-unique-test-installation-key-with-32-bytes' } as Env;

describe('dashboard Meta credential storage', () => {
  it('encrypts credentials with a fresh nonce and decrypts only with the installation key', async () => {
    const input = { accessToken: 'meta-access-token', appSecret: 'meta-app-secret' };
    const stored = await encryptCredentials(input, env);
    expect(stored.ciphertext).not.toContain(input.accessToken);
    expect(stored.ciphertext).not.toContain(input.appSecret);
    await expect(decryptCredentials(stored.ciphertext, stored.nonce, env)).resolves.toEqual(input);
  });

  it('cannot decrypt values with a different installation key', async () => {
    const stored = await encryptCredentials({ accessToken: 'token', appSecret: 'secret' }, env);
    const wrongEnv = { CREDENTIAL_ENCRYPTION_KEY: 'a-different-test-installation-key-32-bytes' } as Env;
    await expect(decryptCredentials(stored.ciphertext, stored.nonce, wrongEnv)).rejects.toBeDefined();
  });
});
