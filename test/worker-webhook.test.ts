import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env, QueueJob } from '../src/types';

type StatementCall = { sql: string; values: unknown[] };

const sign = async (payload: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const result = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `sha256=${[...new Uint8Array(result)].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
};

const testEnv = (jobs: QueueJob[], calls: StatementCall[] = []): Env => {
  const database = {
    prepare: (sql: string) => {
      const statement: any = {
        first: async () => null,
        run: async () => ({ meta: { changes: 1 } }),
        bind: (...values: unknown[]) => { calls.push({ sql, values }); return statement; },
      };
      return statement;
    },
    batch: async () => [],
  };
  return {
    DB: database,
    META_APP_SECRET: 'test-app-secret',
    WEBHOOK_VERIFY_TOKEN: 'verify-me',
    BOOTSTRAP_ADMIN_TOKEN: 'bootstrap',
    META_ACCESS_TOKEN: 'not-used',
    META_GRAPH_VERSION: 'v24.0',
    PHONE_NUMBER_IDS: '',
    WABA_ID: '',
    JOBS_QUEUE: { send: async (job: QueueJob) => { jobs.push(job); } },
  } as unknown as Env;
};

describe('CORE webhook endpoint', () => {
  it('returns Meta’s challenge only when the verification token matches', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const accepted = await worker.fetch(new Request('https://core.example/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-value'), testEnv(jobs, calls));
    const rejected = await worker.fetch(new Request('https://core.example/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-value'), testEnv(jobs));

    await expect(accepted.text()).resolves.toBe('challenge-value');
    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(403);
    expect(calls.some((call) => call.sql.includes('INSERT INTO webhook_endpoint_verification'))).toBe(true);
  });

  it('validates a signed webhook and queues it without touching the database', async () => {
    const jobs: QueueJob[] = [];
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const response = await worker.fetch(new Request('https://core.example/webhooks/meta', {
      method: 'POST',
      headers: { 'x-hub-signature-256': await sign(payload, 'test-app-secret') },
      body: payload,
    }), testEnv(jobs));

    expect(response.status).toBe(200);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'inbound_webhook', payload: JSON.parse(payload) });
  });

  it('rejects an unsigned webhook without queueing it', async () => {
    const jobs: QueueJob[] = [];
    const response = await worker.fetch(new Request('https://core.example/webhooks/meta', {
      method: 'POST', body: '{}',
    }), testEnv(jobs));

    expect(response.status).toBe(401);
    expect(jobs).toHaveLength(0);
  });
});
