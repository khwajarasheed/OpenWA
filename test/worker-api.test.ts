import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env, QueueJob } from '../src/types';
import { sha256 } from '../src/util';

type StatementCall = { sql: string; values: unknown[] };
const passwordVerifier = 'A'.repeat(43);
const passwordSalt = 'B'.repeat(22);

const apiEnv = (jobs: QueueJob[], calls: StatementCall[], authenticated = false, webhookVerified = false, ownerConfigured = false): Env => {
  const database = {
    prepare: (sql: string) => {
      const statement: any = {
        first: async () => {
          if (authenticated && sql.includes('FROM dashboard_sessions')) return { user_id: 'owner-1', email: 'owner@example.com' };
          if (webhookVerified && sql.includes('FROM webhook_endpoint_verification')) return { verified_at: '2026-09-02T12:00:00.000Z' };
          if (ownerConfigured && sql.includes('SELECT password_salt, password_iterations FROM local_owner')) return { password_salt: passwordSalt, password_iterations: 600_000 };
          if (ownerConfigured && sql.includes('SELECT user_id, email, password_digest FROM local_owner')) return { user_id: 'owner-1', email: 'owner@example.com', password_digest: await sha256(passwordVerifier) };
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
        bind: (...values: unknown[]) => {
        calls.push({ sql, values });
          return statement;
        },
      };
      return statement;
    },
    batch: async () => [],
  };
  return {
    DB: database,
    META_APP_SECRET: 'not-used',
    WEBHOOK_VERIFY_TOKEN: 'not-used',
    BOOTSTRAP_ADMIN_TOKEN: 'bootstrap',
    META_ACCESS_TOKEN: 'not-used',
    META_GRAPH_VERSION: 'v24.0',
    PHONE_NUMBER_IDS: '12345',
    WABA_ID: '',
    JOBS_QUEUE: { send: async (job: QueueJob) => { jobs.push(job); } },
  } as unknown as Env;
};

describe('CORE message API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('serves first-run onboarding and requires a dashboard login for private state', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const page = await worker.fetch(new Request('https://core.example/'), apiEnv(jobs, calls));
    const api = await worker.fetch(new Request('https://core.example/v1/dashboard/state'), apiEnv(jobs, calls));
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain('Connect WhatsApp');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(api.status).toBe(401);
  });

  it('reports an uninitialized installation and creates the first local owner', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const env = apiEnv(jobs, calls);
    const bootstrap = await worker.fetch(new Request('https://core.example/v1/dashboard/bootstrap'), env);
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toEqual({ initialized: false, authenticated: false });

    const setup = await worker.fetch(new Request('https://core.example/v1/dashboard/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password_verifier: passwordVerifier, password_salt: passwordSalt, password_iterations: 600_000 }),
    }), env);
    expect(setup.status).toBe(201);
    expect(setup.headers.get('set-cookie')).toContain('__Host-openwa_session=');
    expect(setup.headers.get('set-cookie')).toContain('HttpOnly');
    const ownerInsert = calls.find((call) => call.sql.includes('INSERT OR IGNORE INTO local_owner'));
    expect(ownerInsert?.values[2]).toBe(passwordSalt);
    expect(ownerInsert?.values[3]).toMatch(/^[a-f0-9]{64}$/);
    expect(ownerInsert?.values).not.toContain(passwordVerifier);
  });

  it('returns only the public browser-side login derivation parameters', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const response = await worker.fetch(new Request('https://core.example/v1/dashboard/login-parameters'), apiEnv(jobs, calls, false, false, true));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ salt: passwordSalt, iterations: 600_000 });
  });

  it('signs the singleton owner in with only the browser-derived verifier', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const response = await worker.fetch(new Request('https://core.example/v1/dashboard/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password_verifier: passwordVerifier }),
    }), apiEnv(jobs, calls, false, false, true));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user: { email: 'owner@example.com', role: 'super_admin' } });
    expect(response.headers.get('set-cookie')).toContain('__Host-openwa_session=');
  });

  it('rejects cross-origin dashboard changes', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const response = await worker.fetch(new Request('https://core.example/v1/dashboard/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ email: 'owner@example.com', password_verifier: passwordVerifier, password_salt: passwordSalt, password_iterations: 600_000 }),
    }), apiEnv(jobs, calls));
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('validates the browser-derived owner verifier before writing to D1', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const response = await worker.fetch(new Request('https://core.example/v1/dashboard/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password_verifier: 'invalid', password_salt: passwordSalt, password_iterations: 600_000 }),
    }), apiEnv(jobs, calls));
    expect(response.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('lets the signed-in owner create the first API token with one click', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const response = await worker.fetch(new Request('https://core.example/v1/dashboard/api-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: '__Host-openwa_session=test-session' },
      body: '{}',
    }), apiEnv(jobs, calls, true));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ scopes: ['*'] });
    expect(calls.some((call) => call.sql.includes('INSERT INTO api_principals'))).toBe(true);
  });

  it('discovers phone numbers from the customer WABA instead of requiring a typed phone ID', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const metaFetch = vi.fn(async () => Response.json({ data: [
      { id: '12345', display_phone_number: '+1 555 123 4567', verified_name: 'Example Business', quality_rating: 'GREEN' },
    ] }));
    vi.stubGlobal('fetch', metaFetch);
    const response = await worker.fetch(new Request('https://core.example/v1/dashboard/phone-numbers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: '__Host-openwa_session=test-session' },
      body: JSON.stringify({ waba_id: '98765', access_token: 'customer-token', app_secret: 'customer-app-secret' }),
    }), apiEnv(jobs, calls, true));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ phone_numbers: [
      { id: '12345', display_phone_number: '+1 555 123 4567', verified_name: 'Example Business', quality_rating: 'GREEN' },
    ] });
    expect(metaFetch).toHaveBeenCalledWith(
      expect.stringContaining('/98765/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=100&appsecret_proof='),
      expect.objectContaining({ headers: { authorization: 'Bearer customer-token' } }),
    );
  });

  it('subscribes the Meta app to the WABA with one connection action', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const env = apiEnv(jobs, calls, true, true);
    env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-at-least-32-characters';
    const metaFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: '12345', display_phone_number: '+1 555 123 4567' }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    vi.stubGlobal('fetch', metaFetch);
    const response = await worker.fetch(new Request('https://core.example/v1/dashboard/connection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: '__Host-openwa_session=test-session' },
      body: JSON.stringify({ waba_id: '98765', phone_number_id: '12345', access_token: 'customer-token', app_secret: 'customer-app-secret' }),
    }), env);
    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toMatchObject({ status: 'connected', phone_number_id: '12345' });
    expect(metaFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/98765/subscribed_apps'),
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer customer-token' },
      }),
    );
    expect(metaFetch.mock.calls[1]?.[1]).not.toHaveProperty('body');
    expect(metaFetch).toHaveBeenCalledTimes(2);
    expect(calls.some((call) => call.sql.includes('INSERT INTO whatsapp_connections'))).toBe(true);
  });

  it('requires an idempotency key and a sender scope', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const base = new Request('https://core.example/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer bootstrap', 'content-type': 'application/json' },
      body: JSON.stringify({ phone_number_id: '12345', to: '15551234567', type: 'text', text: { body: 'hello' } }),
    });
    const response = await worker.fetch(base, apiEnv(jobs, calls));
    expect(response.status).toBe(422);
    expect(jobs).toHaveLength(0);
  });

  it('stores an outbox intent and queues a text message after authorization', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const response = await worker.fetch(new Request('https://core.example/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bootstrap',
        'content-type': 'application/json',
        'idempotency-key': 'test-message-1',
      },
      body: JSON.stringify({ phone_number_id: '12345', to: '15551234567', type: 'text', text: { body: 'hello' } }),
    }), apiEnv(jobs, calls));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'queued' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'outbound_dispatch', phoneNumberId: '12345' });
    expect(calls.some((call) => call.sql.includes('INSERT INTO messages'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('INSERT INTO outbound_jobs'))).toBe(true);
  });

  it('rejects phone numbers outside the customer allowlist before persistence', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const response = await worker.fetch(new Request('https://core.example/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer bootstrap', 'content-type': 'application/json', 'idempotency-key': 'bad-phone' },
      body: JSON.stringify({ phone_number_id: '99999', to: '15551234567', type: 'text', text: { body: 'hello' } }),
    }), apiEnv(jobs, calls));

    expect(response.status).toBe(422);
    expect(jobs).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
