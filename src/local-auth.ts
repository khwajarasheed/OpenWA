import type { Env } from './types';
import { id, now, sha256 } from './util';

export interface LocalDashboardUser {
  id: string;
  email: string;
  role: 'super_admin';
}

export const LOCAL_PASSWORD_ITERATIONS = 600_000;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

const sessionCookie = (token: string, maxAge = SESSION_SECONDS): string =>
  `__Host-openwa_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

const sessionToken = (request: Request): string | undefined =>
  request.headers.get('cookie')?.split(';').map((item) => item.trim())
    .find((item) => item.startsWith('__Host-openwa_session='))?.slice('__Host-openwa_session='.length);

export const installationInitialized = async (env: Env): Promise<boolean> =>
  Boolean(await env.DB.prepare(`SELECT 1 FROM local_owner WHERE id = 'default'`).first());

export const localLoginParameters = async (env: Env): Promise<{ salt: string; iterations: number } | null> => {
  const owner = await env.DB.prepare(
    `SELECT password_salt, password_iterations FROM local_owner WHERE id = 'default'`
  ).first<{ password_salt: string; password_iterations: number }>();
  return owner ? { salt: owner.password_salt, iterations: owner.password_iterations } : null;
};

export const createLocalOwner = async (
  email: string,
  verifier: string,
  salt: string,
  iterations: number,
  env: Env,
): Promise<{ user: LocalDashboardUser; cookie: string } | null> => {
  const normalizedEmail = email.trim().toLowerCase();
  const userId = id();
  const digest = await sha256(verifier);
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO local_owner (id, user_id, email, password_salt, password_digest, password_iterations, last_login_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?)`
  ).bind(userId, normalizedEmail, salt, digest, iterations, now()).run();
  if (!result.meta.changes) return null;
  const session = await createSession(userId, env);
  return { user: { id: userId, email: normalizedEmail, role: 'super_admin' }, cookie: session.cookie };
};

export const loginLocalOwner = async (verifier: string, request: Request, env: Env): Promise<{ user: LocalDashboardUser; cookie: string } | null> => {
  const attemptKey = await loginAttemptKey(request);
  const attempt = await env.DB.prepare(
    `SELECT failures, window_started_at, blocked_until FROM dashboard_login_attempts WHERE key_digest = ?`
  ).bind(attemptKey).first<{ failures: number; window_started_at: string; blocked_until: string | null }>();
  if (attempt?.blocked_until && Date.parse(attempt.blocked_until) > Date.now()) return null;
  const owner = await env.DB.prepare(
    `SELECT user_id, email, password_digest FROM local_owner WHERE id = 'default'`
  ).first<{ user_id: string; email: string; password_digest: string }>();
  if (!owner) {
    await recordLoginFailure(attemptKey, attempt, env);
    return null;
  }
  const candidate = await sha256(verifier);
  if (!constantTimeEqual(candidate, owner.password_digest)) {
    await recordLoginFailure(attemptKey, attempt, env);
    return null;
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM dashboard_login_attempts WHERE key_digest = ?`).bind(attemptKey),
    env.DB.prepare(`UPDATE local_owner SET last_login_at = ? WHERE id = 'default'`).bind(now()),
  ]);
  const session = await createSession(owner.user_id, env);
  return { user: { id: owner.user_id, email: owner.email, role: 'super_admin' }, cookie: session.cookie };
};

const loginAttemptKey = async (request: Request): Promise<string> =>
  sha256(`default|${request.headers.get('cf-connecting-ip') ?? 'unknown'}`);

async function recordLoginFailure(
  keyDigest: string,
  previous: { failures: number; window_started_at: string; blocked_until: string | null } | null,
  env: Env,
): Promise<void> {
  const timestamp = Date.now();
  let failures: number;
  let windowStartedAt: string;
  if (!previous || Date.parse(previous.window_started_at) <= timestamp - LOGIN_WINDOW_MS) {
    failures = 1;
    windowStartedAt = new Date(timestamp).toISOString();
  } else {
    failures = previous.failures + 1;
    windowStartedAt = previous.window_started_at;
  }
  const blockedUntil = failures >= MAX_LOGIN_FAILURES ? new Date(timestamp + LOGIN_BLOCK_MS).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO dashboard_login_attempts (key_digest, failures, window_started_at, blocked_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key_digest) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at,
       blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`
  ).bind(keyDigest, failures, windowStartedAt, blockedUntil, new Date(timestamp).toISOString()).run();
}

export const localSessionUser = async (request: Request, env: Env): Promise<LocalDashboardUser | null> => {
  const token = sessionToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT o.user_id, o.email FROM dashboard_sessions s JOIN local_owner o ON o.user_id = s.user_id
     WHERE s.token_digest = ? AND s.expires_at > ?`
  ).bind(await sha256(token), now()).first<{ user_id: string; email: string }>();
  return row ? { id: row.user_id, email: row.email, role: 'super_admin' } : null;
};

export const logoutLocalSession = async (request: Request, env: Env): Promise<string> => {
  const token = sessionToken(request);
  if (token) await env.DB.prepare(`DELETE FROM dashboard_sessions WHERE token_digest = ?`).bind(await sha256(token)).run();
  return sessionCookie('', 0);
};

async function createSession(userId: string, env: Env): Promise<{ cookie: string }> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM dashboard_sessions WHERE expires_at <= ?`).bind(now()),
    env.DB.prepare(`INSERT INTO dashboard_sessions (id, user_id, token_digest, expires_at) VALUES (?, ?, ?, ?)`).bind(id(), userId, await sha256(token), expiresAt),
  ]);
  return { cookie: sessionCookie(token) };
}
