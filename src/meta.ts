import type { Env } from './types';

export const verifyMetaSignature = async (payload: string, signature: string | null, secret: string): Promise<boolean> => {
  if (!signature?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = `sha256=${[...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return difference === 0;
};

export const graphUrl = (env: Env, path: string): string => `https://graph.facebook.com/${env.META_GRAPH_VERSION ?? 'v24.0'}/${path}`;

export const appSecretProof = async (accessToken: string, appSecret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(accessToken));
  return [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
