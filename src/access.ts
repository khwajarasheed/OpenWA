import type { Env } from './types';
import { ownedArrayBuffer } from './util';

export interface AccessIdentity {
  subject: string;
  email: string | null;
}

interface AccessPayload { sub?: string; email?: string; aud?: string[] | string; iss?: string; exp?: number }

const decode = (part: string): Uint8Array => {
  const padded = part.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - part.length % 4) % 4);
  return Uint8Array.from(atob(padded), (value) => value.charCodeAt(0));
};

export const accessIdentity = async (request: Request, env: Env): Promise<AccessIdentity | null> => {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.CF_ACCESS_AUD || !env.CF_ACCESS_TEAM_DOMAIN) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string }; let payload: AccessPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(decode(parts[1])));
  } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid || !payload.sub || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const issuer = `https://${env.CF_ACCESS_TEAM_DOMAIN}`;
  if (!audience.includes(env.CF_ACCESS_AUD) || payload.iss !== issuer) return null;
  try {
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`);
    const keys = await response.json<{ keys?: Array<JsonWebKey & { kid?: string }> }>();
    const jwk = keys.keys?.find((key) => key.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signature = decode(parts[2]);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, ownedArrayBuffer(signature), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return valid ? { subject: payload.sub, email: payload.email ?? null } : null;
  } catch { return null; }
};
