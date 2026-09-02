import type { Env, Principal } from './types';
import { sha256 } from './util';

export const requirePrincipal = async (request: Request, env: Env, requiredScope: string): Promise<Principal | null> => {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) return null;

  if (token === env.BOOTSTRAP_ADMIN_TOKEN) {
    return { id: 'bootstrap-admin', name: 'bootstrap-admin', scopes: ['*'] };
  }

  const digest = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT id, name, scopes_json FROM api_principals
     WHERE token_digest = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`
  ).bind(digest, new Date().toISOString()).first<{ id: string; name: string; scopes_json: string }>();
  if (!row) return null;
  const scopes = JSON.parse(row.scopes_json) as string[];
  if (!scopes.includes('*') && !scopes.includes(requiredScope)) return null;
  return { id: row.id, name: row.name, scopes };
};
