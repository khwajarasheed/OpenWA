import { describe, expect, it } from 'vitest';
import { verifyMetaSignature } from '../src/meta';

const signatureFor = async (payload: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const value = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `sha256=${[...new Uint8Array(value)].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
};

describe('Meta webhook signature verification', () => {
  it('accepts a valid HMAC-SHA256 signature', async () => {
    const payload = '{"object":"whatsapp_business_account"}';
    await expect(verifyMetaSignature(payload, await signatureFor(payload, 'app-secret'), 'app-secret')).resolves.toBe(true);
  });

  it('rejects a modified payload and an invalid signature shape', async () => {
    const payload = '{"object":"whatsapp_business_account"}';
    const signature = await signatureFor(payload, 'app-secret');
    await expect(verifyMetaSignature(`${payload} `, signature, 'app-secret')).resolves.toBe(false);
    await expect(verifyMetaSignature(payload, 'not-a-meta-signature', 'app-secret')).resolves.toBe(false);
  });
});
