import type { Env } from './types';
import { graphUrl } from './meta';
import { id, now } from './util';
import { activeMetaCredentials } from './credentials';

interface DispatchRequest { jobId: string; phoneNumberId: string }

export class PhoneDispatcher implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const input = await request.json<DispatchRequest>();
    const job = await this.env.DB.prepare(
      `SELECT id, message_id, phone_number_id, recipient_wa_id, request_json, attempts
       FROM outbound_jobs WHERE id = ? AND status IN ('queued', 'dispatching')`
    ).bind(input.jobId).first<{ id: string; message_id: string; phone_number_id: string; recipient_wa_id: string; request_json: string; attempts: number }>();
    if (!job) return Response.json({ outcome: 'already-settled' });

    const recipientKey = `recipient:${job.recipient_wa_id}:next`;
    const numberKey = 'number:next';
    const current = Date.now();
    const recipientNext = (await this.state.storage.get<number>(recipientKey)) ?? 0;
    const numberNext = (await this.state.storage.get<number>(numberKey)) ?? 0;
    const retryAt = Math.max(recipientNext, numberNext);
    if (retryAt > current) return Response.json({ outcome: 'rate_limited', retryAt }, { status: 429 });

    // Default posture: 60ms between sends per phone and 1s per recipient. Both are configurable in a future policy table.
    await this.state.storage.put({ [numberKey]: current + 60, [recipientKey]: current + 1000 });
    await this.env.DB.prepare(
      `UPDATE outbound_jobs SET status = 'dispatching', attempts = attempts + 1, updated_at = ? WHERE id = ?`
    ).bind(now(), job.id).run();

    let response: Response;
    try {
      const credentials = await activeMetaCredentials(this.env, job.phone_number_id);
      if (!credentials) throw new Error('No validated Meta credentials are configured for this phone number');
      response = await fetch(graphUrl(this.env, `${job.phone_number_id}/messages`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          'content-type': 'application/json',
        },
        body: job.request_json,
      });
    } catch (cause) {
      await this.record(job.id, 'unknown', null, JSON.stringify({ message: String(cause) }));
      await this.env.DB.prepare(
        `UPDATE outbound_jobs SET status = 'send_unknown', last_error = ?, updated_at = ? WHERE id = ?`
      ).bind('Network failure after dispatch began', now(), job.id).run();
      await this.env.DB.prepare(`UPDATE messages SET status = 'send_unknown', updated_at = ? WHERE id = ?`).bind(now(), job.message_id).run();
      return Response.json({ outcome: 'unknown' }, { status: 202 });
    }

    const responseText = await response.text();
    if (response.ok) {
      const parsed = JSON.parse(responseText) as { messages?: Array<{ id?: string }> };
      const metaMessageId = parsed.messages?.[0]?.id ?? null;
      await this.record(job.id, 'submitted', response.status, responseText);
      await this.env.DB.batch([
        this.env.DB.prepare(`UPDATE outbound_jobs SET status = 'submitted', updated_at = ? WHERE id = ?`).bind(now(), job.id),
        this.env.DB.prepare(`UPDATE messages SET status = 'submitted', meta_message_id = COALESCE(?, meta_message_id), updated_at = ? WHERE id = ?`).bind(metaMessageId, now(), job.message_id),
      ]);
      return Response.json({ outcome: 'submitted' });
    }

    const retryable = response.status === 429 || response.status >= 500;
    await this.record(job.id, retryable ? 'retryable_failure' : 'failed', response.status, responseText);
    if (retryable) {
      await this.env.DB.prepare(`UPDATE outbound_jobs SET status = 'queued', last_error = ?, updated_at = ? WHERE id = ?`).bind(responseText.slice(0, 1000), now(), job.id).run();
      return Response.json({ outcome: 'retryable' }, { status: 503 });
    }
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE outbound_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).bind(responseText.slice(0, 1000), now(), job.id),
      this.env.DB.prepare(`UPDATE messages SET status = 'failed', updated_at = ? WHERE id = ?`).bind(now(), job.message_id),
    ]);
    return Response.json({ outcome: 'failed' });
  }

  private async record(jobId: string, outcome: string, responseStatus: number | null, responseJson: string): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO send_attempts (id, outbound_job_id, outcome, response_status, response_json) VALUES (?, ?, ?, ?, ?)`
    ).bind(id(), jobId, outcome, responseStatus, responseJson.slice(0, 65535)).run();
  }
}
