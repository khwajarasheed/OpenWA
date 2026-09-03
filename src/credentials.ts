import type { Env } from './types';
import { ownedArrayBuffer } from './util';

export interface MetaCredentials {
  accessToken: string;
  appSecret: string;
}

interface StoredCredentials {
  accessToken: string;
  appSecret: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const encryptionKey = async (env: Env): Promise<CryptoKey> => {
  if (!env.CREDENTIAL_ENCRYPTION_KEY || env.CREDENTIAL_ENCRYPTION_KEY.length < 32) throw new Error('No legacy credential key configured');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.CREDENTIAL_ENCRYPTION_KEY));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

export const encryptCredentials = async (value: MetaCredentials, env: Env): Promise<{ ciphertext: string; nonce: string }> => {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) return credentialOperation('/encrypt', value, env) as Promise<{ ciphertext: string; nonce: string }>;
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, encoder.encode(JSON.stringify(value)));
  return { ciphertext: toBase64Url(new Uint8Array(encrypted)), nonce: toBase64Url(nonce) };
};

export const decryptCredentials = async (ciphertext: string, nonce: string, env: Env): Promise<StoredCredentials> => {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) return credentialOperation('/decrypt', { ciphertext, nonce }, env) as Promise<StoredCredentials>;
  const key = await encryptionKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ownedArrayBuffer(fromBase64Url(nonce)) },
    key,
    ownedArrayBuffer(fromBase64Url(ciphertext)),
  );
  const value = JSON.parse(decoder.decode(plaintext)) as StoredCredentials;
  if (!value.accessToken || !value.appSecret) throw new Error('Stored Meta credentials are invalid');
  return value;
};

async function credentialOperation(path: '/encrypt' | '/decrypt', payload: unknown, env: Env): Promise<unknown> {
  const stub = env.INSTALLATION_SECRETS.get(env.INSTALLATION_SECRETS.idFromName('primary'));
  const response = await stub.fetch(`https://installation-secrets${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Customer-owned credential vault is unavailable');
  return response.json();
}

export const activeMetaCredentials = async (env: Env, phoneNumberId?: string): Promise<MetaCredentials | null> => {
  try {
    const row = await env.DB.prepare(
      `SELECT credentials_ciphertext, credentials_nonce FROM whatsapp_connections
       WHERE status IN ('validated', 'connected') AND (? IS NULL OR phone_number_id = ?)
       ORDER BY updated_at DESC LIMIT 1`
    ).bind(phoneNumberId ?? null, phoneNumberId ?? null).first<{ credentials_ciphertext: string; credentials_nonce: string }>();
    if (row) return decryptCredentials(row.credentials_ciphertext, row.credentials_nonce, env);
  } catch {
    // A pre-dashboard installation may not yet have applied migration 0002.
  }
  if (env.META_ACCESS_TOKEN && env.META_APP_SECRET) return { accessToken: env.META_ACCESS_TOKEN, appSecret: env.META_APP_SECRET };
  return null;
};
