import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env, QueueJob } from '../src/types';

const env = (): Env => {
  const statement: any = { bind: () => statement, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 1 } }) };
  return {
    DB: { prepare: () => statement, batch: async () => [] },
    BOOTSTRAP_ADMIN_TOKEN: 'bootstrap', PHONE_NUMBER_IDS: '12345', JOBS_QUEUE: { send: async (_: QueueJob) => {} },
  } as unknown as Env;
};

describe('developer control plane API', () => {
  it('keeps dashboard state private while serving the control plane', async () => {
    const page = await worker.fetch(new Request('https://core.example/'), env());
    const state = await worker.fetch(new Request('https://core.example/v1/dashboard/state'), env());
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain('OpenWA Control Plane');
    expect(state.status).toBe(401);
  });

  it('returns prescribed sandbox delivery without a WhatsApp connection', async () => {
    const response = await worker.fetch(new Request('https://core.example/v1/messages', {
      method: 'POST', headers: { authorization: 'Bearer bootstrap', 'content-type': 'application/json', 'idempotency-key': 'sandbox-message' },
      body: JSON.stringify({ phone_number_id: '12345', to: '15551234567', type: 'text', text: { body: 'hello' } }),
    }), env());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: 'delivered', simulated: true, events: ['queued', 'submitted', 'delivered'] });
  });

  it('keeps direct secret-based installations on the live dispatch path', async () => {
    const configured = env();
    configured.META_ACCESS_TOKEN = 'configured-secret';
    configured.WABA_ID = '12345';
    const response = await worker.fetch(new Request('https://core.example/v1/messages', {
      method: 'POST', headers: { authorization: 'Bearer bootstrap', 'content-type': 'application/json', 'idempotency-key': 'live-message' },
      body: JSON.stringify({ phone_number_id: '12345', to: '15551234567', type: 'text', text: { body: 'hello' } }),
    }), configured);
    await expect(response.json()).resolves.toMatchObject({ status: 'queued' });
  });

  it('exposes a secured MCP tool catalog', async () => {
    const response = await worker.fetch(new Request('https://core.example/mcp', {
      method: 'POST', headers: { authorization: 'Bearer bootstrap', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'openwa_send_message' })]) } });
  });

  it('rejects cross-origin and unauthenticated MCP requests', async () => {
    const crossOrigin = await worker.fetch(new Request('https://core.example/mcp', {
      method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), env());
    expect(crossOrigin.status).toBe(403);
    const unauthenticated = await worker.fetch(new Request('https://core.example/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), env());
    await expect(unauthenticated.json()).resolves.toMatchObject({ error: { code: -32001 } });
  });
});
