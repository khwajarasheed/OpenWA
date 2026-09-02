import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env, QueueJob } from '../src/types';

type StatementCall = { sql: string; values: unknown[] };

const apiEnv = (jobs: QueueJob[], calls: StatementCall[]): Env => {
  const database = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => {
        calls.push({ sql, values });
        return {
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
    }),
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
    OUTBOUND_QUEUE: { send: async (job: QueueJob) => { jobs.push(job); } },
  } as unknown as Env;
};

describe('CORE message API', () => {
  it('serves the self-hosted dashboard and requires Cloudflare Access for its API', async () => {
    const jobs: QueueJob[] = [];
    const calls: StatementCall[] = [];
    const page = await worker.fetch(new Request('https://core.example/'), apiEnv(jobs, calls));
    const api = await worker.fetch(new Request('https://core.example/v1/dashboard/state'), apiEnv(jobs, calls));
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain('Connect WhatsApp');
    expect(api.status).toBe(401);
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
