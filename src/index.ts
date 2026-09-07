import { requirePrincipal } from './auth';
import { accessIdentity } from './access';
import { activeMetaCredentials, encryptCredentials } from './credentials';
import { dashboardHtml } from './dashboard';
import { appSecretProof, verifyMetaSignature, graphUrl } from './meta';
import { PhoneDispatcher } from './phone-dispatcher';
import { InstallationSecrets } from './installation-secrets';
import { createLocalOwner, installationInitialized, LOCAL_PASSWORD_ITERATIONS, localLoginParameters, localSessionUser, loginLocalOwner, logoutLocalSession } from './local-auth';
import type { Env, Principal, QueueJob } from './types';
import { error, id, json, now, safeJson, sha256 } from './util';

export { PhoneDispatcher, InstallationSecrets };

type MessageInput = {
  phone_number_id: string;
  to: string;
  type: 'text' | 'template';
  text?: { body: string };
  template?: { name: string; language: { code: string }; components?: unknown[] };
};

const statusRank: Record<string, number> = { queued: 0, submitted: 1, sent: 2, delivered: 3, read: 4 };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/webhooks/meta') return handleMetaWebhook(request, env);
    if (url.pathname === '/mcp') return handleMcp(request, env);
    if (url.pathname === '/' && request.method === 'GET') return dashboardResponse();
    if (url.pathname === '/favicon.ico' && request.method === 'GET') return new Response(null, { status: 204 });
    if (url.pathname === '/health') return json({ status: 'ok', service: 'openwa-core' });
    if (url.pathname === '/ready') return ready(env);
    if (url.pathname === '/version') return json({ api: 'v1', core: '0.1.0' });
    if (url.pathname === '/v1/capabilities' && request.method === 'GET') return json({
      api: 'v1',
      message_types: ['text', 'template'],
      template_sync: true,
      media_storage: false,
      event_subscriptions: false,
      retention: 'indefinite',
      mcp: { endpoint: '/mcp', transport: 'streamable-http' },
      sandbox: true,
    });
    if (!url.pathname.startsWith('/v1/')) return error(404, 'not_found', 'Route not found');
    return handleApi(request, env, url);
  },

  async queue(batch: MessageBatch<QueueJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.type === 'inbound_webhook') await processWebhook(message.body, env);
        if (message.body.type === 'outbound_dispatch') {
          const retryAfterSeconds = await dispatchOutbound(message.body, env);
          if (retryAfterSeconds !== null) {
            message.retry({ delaySeconds: retryAfterSeconds });
            continue;
          }
        }
        if (message.body.type === 'template_sync') await syncTemplates(env);
        message.ack();
      } catch (cause) {
        console.error('queue_processing_failed', { type: message.body.type, error: String(cause) });
        message.retry();
      }
    }
  },

  async scheduled(_: ScheduledController, env: Env): Promise<void> {
    const due = await env.DB.prepare(
      `SELECT id, phone_number_id FROM outbound_jobs
       WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT 100`
    ).bind(now()).all<{ id: string; phone_number_id: string }>();
    if (due.results.length) {
      await env.JOBS_QUEUE.sendBatch(due.results.map((job) => ({ body: { type: 'outbound_dispatch', jobId: job.id, phoneNumberId: job.phone_number_id } })));
    }
  },
} satisfies ExportedHandler<Env, QueueJob>;

async function ready(env: Env): Promise<Response> {
  try {
    await env.DB.prepare('SELECT 1').first();
    return json({ status: 'ready' });
  } catch {
    return error(503, 'not_ready', 'Database unavailable');
  }
}

async function handleMetaWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === await webhookVerifyToken(env)) {
      try {
        const timestamp = now();
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO webhook_endpoint_verification (id, verified_at) VALUES ('default', ?)
             ON CONFLICT(id) DO UPDATE SET verified_at = excluded.verified_at`
          ).bind(timestamp),
          env.DB.prepare(
            `UPDATE whatsapp_connections SET status = 'connected', webhook_verified_at = ?, updated_at = ?
             WHERE id = (SELECT id FROM whatsapp_connections WHERE status = 'validated' ORDER BY updated_at DESC LIMIT 1)`
          ).bind(timestamp, timestamp),
        ]);
      } catch {
        // Legacy installations and webhook verification itself must not fail due
        // to an absent dashboard migration.
      }
      return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
    }
    return error(403, 'verification_failed', 'Invalid verification token');
  }
  if (request.method !== 'POST') return error(405, 'method_not_allowed', 'Use GET or POST');

  const raw = await request.text();
  const credentials = await activeMetaCredentials(env);
  const valid = credentials && await verifyMetaSignature(raw, request.headers.get('x-hub-signature-256'), credentials.appSecret);
  if (!valid) return error(401, 'invalid_signature', 'Webhook signature is invalid');

  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return error(400, 'invalid_json', 'Webhook payload is not JSON'); }
  const fingerprint = await sha256(raw);
  // Cloudflare Queue messages are capped at 128 KB. Preserve the raw event in the
  // customer's R2 bucket when it would not fit, then queue only its local pointer.
  if (raw.length > 110_000) {
    const r2Key = `webhooks/${fingerprint}.json`;
    await env.MEDIA.put(r2Key, raw, { httpMetadata: { contentType: 'application/json' } });
    await env.JOBS_QUEUE.send({ type: 'inbound_webhook', fingerprint, r2Key });
  } else {
    await env.JOBS_QUEUE.send({ type: 'inbound_webhook', fingerprint, payload });
  }
  return new Response(null, { status: 200 });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname.startsWith('/v1/dashboard/')) return handleDashboardApi(request, env, url);
  const scope = scopeFor(request.method, url.pathname);
  const principal = await requirePrincipal(request, env, scope);
  if (!principal) return error(401, 'unauthorized', 'A valid bearer token with the required scope is required');

  if (request.method === 'POST' && url.pathname === '/v1/messages') return createMessage(request, env, principal);
  if (request.method === 'GET' && url.pathname === '/v1/messages') return listMessages(url, env);
  if (request.method === 'GET' && /^\/v1\/messages\/[^/]+$/.test(url.pathname)) return getMessage(url.pathname.split('/').at(-1)!, env);
  if (request.method === 'GET' && url.pathname === '/v1/contacts') return listContacts(url, env);
  if (request.method === 'GET' && /^\/v1\/contacts\/[^/]+$/.test(url.pathname)) return getContact(url.pathname.split('/').at(-1)!, env);
  if (request.method === 'GET' && url.pathname === '/v1/conversations') return listConversations(url, env);
  if (request.method === 'GET' && url.pathname === '/v1/templates') return listTemplates(env);
  if (request.method === 'POST' && url.pathname === '/v1/templates/sync') return queueTemplateSync(env, principal);
  if (request.method === 'POST' && url.pathname === '/v1/admin/tokens') return createApiToken(request, env, principal);
  if (request.method === 'GET' && url.pathname === '/v1/admin/tokens') return listApiTokens(env);
  if (request.method === 'DELETE' && /^\/v1\/admin\/tokens\/[^/]+$/.test(url.pathname)) return revokeApiToken(url.pathname.split('/').at(-1)!, env, principal);
  if (request.method === 'GET' && url.pathname === '/v1/logs/audit') return listAuditEvents(env);
  if (request.method === 'GET' && url.pathname === '/v1/logs/jobs') return listOutboundJobs(env);
  if (request.method === 'GET' && url.pathname === '/v1/webhooks/receipts') return listWebhookReceipts(env);
  if (request.method === 'GET' && url.pathname === '/v1/admin/export') return exportData(env);
  if (request.method === 'DELETE' && url.pathname === '/v1/admin/data') return deleteInstallationData(request, env, principal);
  return error(404, 'not_found', 'Route not found');
}

type DashboardUser = { id: string; access_subject?: string; email: string | null; role: 'super_admin' | 'admin' | 'viewer' };

async function handleDashboardApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method) && !validDashboardMutation(request, url)) {
    return error(403, 'invalid_request_origin', 'Dashboard changes must come from this ForgeScale Relay installation');
  }
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/bootstrap') {
    const localUser = await localSessionUser(request, env);
    const accessUser = localUser ? null : await accessIdentity(request, env);
    return json({
      initialized: await installationInitialized(env),
      authenticated: Boolean(localUser || accessUser),
    }, 200, { 'cache-control': 'no-store' });
  }
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/login-parameters') {
    const parameters = await localLoginParameters(env);
    return parameters ? json(parameters, 200, { 'cache-control': 'no-store' }) : error(409, 'not_initialized', 'Create the owner account first');
  }
  if (request.method === 'POST' && url.pathname === '/v1/dashboard/setup') return setupLocalOwner(request, env);
  if (request.method === 'POST' && url.pathname === '/v1/dashboard/login') return loginDashboard(request, env);
  if (request.method === 'POST' && url.pathname === '/v1/dashboard/logout') {
    return json({ status: 'signed_out' }, 200, { 'set-cookie': await logoutLocalSession(request, env) });
  }

  let user: DashboardUser | null = await localSessionUser(request, env);
  if (!user) {
    const identity = await accessIdentity(request, env);
    if (identity) user = await dashboardUser(identity.subject, identity.email, env);
  }
  if (!user) return error(401, 'dashboard_login_required', 'Sign in to access the ForgeScale Relay dashboard');
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/state') return dashboardState(user, env);
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/messages') return listMessages(url, env);
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/contacts') return listContacts(url, env);
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/conversations') return listConversations(url, env);
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/templates') return listTemplates(env);
  if (request.method === 'POST' && url.pathname === '/v1/dashboard/phone-numbers') return discoverPhoneNumbers(request, user, env);
  if (request.method === 'PUT' && url.pathname === '/v1/dashboard/connection') return saveConnection(request, user, env);
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/tokens') return listApiTokens(env);
  if (request.method === 'POST' && url.pathname === '/v1/dashboard/tokens') return createDashboardApiToken(request, user, env);
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/team') return listDashboardUsers(user, env);
  if (request.method === 'POST' && url.pathname === '/v1/dashboard/team') return createDashboardUser(request, user, env);
  if (request.method === 'DELETE' && /^\/v1\/dashboard\/team\/[^/]+$/.test(url.pathname)) return revokeDashboardUser(url.pathname.split('/').at(-1)!, user, env);
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/logs') return developerLogs(env);
  if (request.method === 'GET' && url.pathname === '/v1/dashboard/webhooks') return listWebhookReceipts(env);
  if (request.method === 'POST' && url.pathname === '/v1/dashboard/sandbox/messages') return dashboardSandboxMessage(request, user, env);
  return error(404, 'not_found', 'Route not found');
}

function dashboardResponse(): Response {
  return new Response(dashboardHtml(), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });
}

function validDashboardMutation(request: Request, url: URL): boolean {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  return request.headers.get('sec-fetch-site') !== 'cross-site';
}

async function setupLocalOwner(request: Request, env: Env): Promise<Response> {
  let input: { email?: string; password_verifier?: string; password_salt?: string; password_iterations?: number };
  try { input = await request.json(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  const validation = validateOwnerCredentials(input);
  if (validation) return error(422, 'validation_error', validation);
  const created = await createLocalOwner(input.email!, input.password_verifier!, input.password_salt!, input.password_iterations!, env);
  if (!created) return error(409, 'already_initialized', 'The owner account has already been created');
  await ensureSandboxFixtures(env);
  return json({ user: created.user }, 201, { 'set-cookie': created.cookie, 'cache-control': 'no-store' });
}

async function loginDashboard(request: Request, env: Env): Promise<Response> {
  let input: { password_verifier?: string };
  try { input = await request.json(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  if (typeof input.password_verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.password_verifier)) {
    return error(401, 'invalid_credentials', 'Password is incorrect');
  }
  const session = await loginLocalOwner(input.password_verifier, request, env);
  if (!session) return error(401, 'invalid_credentials', 'Password is incorrect');
  return json({ user: session.user }, 200, { 'set-cookie': session.cookie, 'cache-control': 'no-store' });
}

function validateOwnerCredentials(input: { email?: string; password_verifier?: string; password_salt?: string; password_iterations?: number }): string | null {
  if (typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return 'Enter a valid owner email address';
  if (typeof input.password_verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.password_verifier)
    || typeof input.password_salt !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(input.password_salt)
    || input.password_iterations !== LOCAL_PASSWORD_ITERATIONS) return 'The password verifier is invalid';
  return null;
}

async function dashboardUser(subject: string, email: string | null, env: Env): Promise<DashboardUser | null> {
  const existing = await env.DB.prepare(`SELECT id, access_subject, email, role FROM dashboard_users WHERE access_subject = ?`).bind(subject).first<DashboardUser>();
  if (existing) {
    await env.DB.prepare(`UPDATE dashboard_users SET email = ?, last_seen_at = ? WHERE id = ?`).bind(email, now(), existing.id).run();
    return { ...existing, email };
  }
  // The singleton row prevents concurrent first launches from creating two owners.
  await env.DB.prepare(`INSERT OR IGNORE INTO dashboard_installation (id, owner_access_subject) VALUES ('default', ?)`).bind(subject).run();
  const owner = await env.DB.prepare(`SELECT owner_access_subject FROM dashboard_installation WHERE id = 'default'`).first<{ owner_access_subject: string }>();
  if (owner?.owner_access_subject !== subject) return null;
  const user: DashboardUser = { id: id(), access_subject: subject, email, role: 'super_admin' };
  await env.DB.prepare(
    `INSERT OR IGNORE INTO dashboard_users (id, access_subject, email, role, last_seen_at) VALUES (?, ?, ?, 'super_admin', ?)`
  ).bind(user.id, subject, email, now()).run();
  return (await env.DB.prepare(`SELECT id, access_subject, email, role FROM dashboard_users WHERE access_subject = ?`).bind(subject).first<DashboardUser>()) ?? null;
}

async function dashboardState(user: DashboardUser, env: Env): Promise<Response> {
  await ensureSandboxFixtures(env);
  const [connection, webhookEndpoint, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT id, waba_id, phone_number_id, display_phone_number, status, last_validated_at, webhook_verified_at, last_error, updated_at
       FROM whatsapp_connections ORDER BY updated_at DESC LIMIT 1`
    ).first(),
    env.DB.prepare(`SELECT verified_at FROM webhook_endpoint_verification WHERE id = 'default'`).first<{ verified_at: string }>(),
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM contacts) contacts, (SELECT COUNT(*) FROM conversations) conversations, (SELECT COUNT(*) FROM messages) messages, (SELECT COUNT(*) FROM templates) templates, (SELECT COUNT(*) FROM webhook_receipts) webhooks, (SELECT COUNT(*) FROM audit_events) audit`).first(),
  ]);
  return json({
    user: { id: user.id, email: user.email, role: user.role },
    connection: connection ?? null,
    webhook_endpoint_verified_at: webhookEndpoint?.verified_at ?? null,
    webhook_verify_token: user.role === 'super_admin' ? await webhookVerifyToken(env) : undefined,
    sandbox: await sandboxActive(env),
    counts,
  });
}

async function webhookVerifyToken(env: Env): Promise<string> {
  if (env.WEBHOOK_VERIFY_TOKEN) return env.WEBHOOK_VERIFY_TOKEN;
  const vault = env.INSTALLATION_SECRETS.get(env.INSTALLATION_SECRETS.idFromName('primary'));
  const response = await vault.fetch('https://installation-secrets/webhook-token');
  if (!response.ok) throw new Error('Webhook verification token is unavailable');
  return response.text();
}

async function saveConnection(request: Request, user: DashboardUser, env: Env): Promise<Response> {
  if (!['super_admin', 'admin'].includes(user.role)) return error(403, 'forbidden', 'Only administrators can change connections');
  let input: { waba_id?: string; phone_number_id?: string; access_token?: string; app_secret?: string };
  try { input = await request.json(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  if (typeof input.waba_id !== 'string' || !/^\d{3,30}$/.test(input.waba_id)
    || typeof input.phone_number_id !== 'string' || !/^\d{3,30}$/.test(input.phone_number_id)
    || typeof input.access_token !== 'string' || !input.access_token || input.access_token.length > 4096
    || typeof input.app_secret !== 'string' || !input.app_secret || input.app_secret.length > 512) {
    return error(422, 'validation_error', 'WABA ID, phone number ID, access token, and app secret are required');
  }
  let displayPhoneNumber: string | null = null;
  try {
    const proof = await appSecretProof(input.access_token, input.app_secret);
    const response = await fetch(graphUrl(env, `${input.phone_number_id}?fields=id,display_phone_number&appsecret_proof=${proof}`), { headers: { authorization: `Bearer ${input.access_token}` } });
    if (!response.ok) return error(422, 'meta_validation_failed', 'Meta rejected the phone number ID or access token');
    const meta = await response.json<{ display_phone_number?: string; id?: string }>();
    if (meta.id && meta.id !== input.phone_number_id) return error(422, 'meta_validation_failed', 'Meta returned a different phone number');
    displayPhoneNumber = meta.display_phone_number ?? null;
    // The owner has already verified this Worker's URL as the Meta app callback.
    // A plain WABA subscription is sufficient for the single-WABA v1 model.
    const subscription = await fetch(graphUrl(env, `${input.waba_id}/subscribed_apps?appsecret_proof=${proof}`), {
      method: 'POST',
      headers: { authorization: `Bearer ${input.access_token}` },
    });
    if (!subscription.ok) return error(422, 'meta_subscription_failed', 'The number is valid, but Meta could not subscribe this app to the WABA. Check the token permissions');
  } catch { return error(502, 'meta_unavailable', 'Could not validate credentials with Meta'); }
  let stored: { ciphertext: string; nonce: string };
  try { stored = await encryptCredentials({ accessToken: input.access_token, appSecret: input.app_secret }, env); }
  catch (cause) { return error(503, 'credential_storage_unavailable', String(cause)); }
  const timestamp = now();
  const webhookEndpoint = await env.DB.prepare(
    `SELECT verified_at FROM webhook_endpoint_verification WHERE id = 'default'`
  ).first<{ verified_at: string }>();
  const connectionStatus = webhookEndpoint ? 'connected' : 'validated';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO whatsapp_connections (id, waba_id, phone_number_id, display_phone_number, credentials_ciphertext, credentials_nonce, status, last_validated_at, webhook_verified_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(phone_number_id) DO UPDATE SET waba_id = excluded.waba_id, display_phone_number = excluded.display_phone_number, credentials_ciphertext = excluded.credentials_ciphertext, credentials_nonce = excluded.credentials_nonce,
         status = CASE WHEN excluded.webhook_verified_at IS NOT NULL OR whatsapp_connections.webhook_verified_at IS NOT NULL THEN 'connected' ELSE 'validated' END,
         last_validated_at = excluded.last_validated_at, webhook_verified_at = COALESCE(excluded.webhook_verified_at, whatsapp_connections.webhook_verified_at), last_error = NULL, updated_at = excluded.updated_at`
    ).bind(id(), input.waba_id, input.phone_number_id, displayPhoneNumber, stored.ciphertext, stored.nonce, connectionStatus, timestamp, webhookEndpoint?.verified_at ?? null, timestamp),
    audit(env, user.email ?? user.access_subject ?? user.id, 'whatsapp_connection.saved', 'whatsapp_connection', input.phone_number_id, { waba_id: input.waba_id }),
  ]);
  const saved = await env.DB.prepare(
    `SELECT status, phone_number_id, display_phone_number FROM whatsapp_connections WHERE phone_number_id = ?`
  ).bind(input.phone_number_id).first<{ status: string; phone_number_id: string; display_phone_number: string | null }>();
  return json(saved ?? { status: connectionStatus, phone_number_id: input.phone_number_id, display_phone_number: displayPhoneNumber });
}

async function ensureDemoWorkspace(env: Env): Promise<void> {
  const existing = await env.DB.prepare(`SELECT id FROM demo_workspace WHERE id = 'default'`).first();
  if (existing) return;
  const batch = 'initial-demo';
  const timestamp = now();
  const contacts = [
    ['demo-contact-1', '971501234567', 'Aisha Rahman', 'Can I move order SO-10482 to tomorrow afternoon?', 'Your delivery slot is reserved for tomorrow, 14:00–17:00.'],
    ['demo-contact-2', '971509876543', 'Omar Al Mansoori', 'Is the Dune lounge chair available in sand?', 'Yes — the sand finish is in stock and can reach Dubai tomorrow.'],
    ['demo-contact-3', '971551112233', 'Maya Patel', 'I need to return the Safa side table from SO-10421.', 'I have opened your return and sent the pickup Flow.'],
    ['demo-contact-4', '971582209811', 'Noah Martin', 'The payment link for my Alba lamp is not opening.', 'I have created a fresh secure payment link for AED 320.'],
    ['demo-contact-5', '971507645230', 'Fatima Al Hashimi', 'Do you offer a VAT invoice for company purchases?', 'Yes — your VAT invoice is attached to the order confirmation.'],
    ['demo-contact-6', '971564281907', 'Khalid Saeed', 'Please let me know when the Palm weave rug is back in stock.', 'You are on the priority waitlist and will receive the first restock notice.'],
    ['demo-contact-7', '971522918460', 'Leila Haddad', 'Can I see the rug in a larger room?', 'Here are styled room photos and the 240 × 340 cm size guide.'],
    ['demo-contact-8', '971555102938', 'Sara Al Farsi', 'My delivery arrived with a damaged lamp shade.', 'I am sorry about that. A replacement shade is being dispatched today.'],
    ['demo-contact-9', '971581763042', 'Hamad Al Qasimi', 'Can I pay cash on delivery?', 'Cash on delivery is available for this order within the UAE.'],
    ['demo-contact-10', '971503491827', 'Noura Ibrahim', 'Please cancel my duplicate order.', 'The duplicate order has been cancelled and no payment was captured.'],
    ['demo-contact-11', '971565920184', 'Yousef Darwish', 'When will my order leave the warehouse?', 'Your order is packed and scheduled for courier collection this evening.'],
    ['demo-contact-12', '971527314965', 'Rania Osman', 'Can you recommend a side table for this chair?', 'The Safa side table complements the Dune lounge chair in both finishes.'],
    ['demo-contact-13', '971558247610', 'Zayed Al Nahyan', 'I would like the VIP Eid early-access link.', 'You are eligible; I have sent the approved early-access template.'],
    ['demo-contact-14', '971509352781', 'Mariam Noor', 'Can I change the delivery address?', 'Please confirm the new Dubai address in the secure delivery Flow.'],
    ['demo-contact-15', '971564730219', 'Tariq Mahmoud', 'The courier missed me today.', 'I have requested a redelivery window for tomorrow.'],
    ['demo-contact-16', '971521840376', 'Hana Saleh', 'How do I care for the palm weave rug?', 'Vacuum gently without a beater bar and blot spills immediately.'],
    ['demo-contact-17', '971554162893', 'Bilal Khan', 'Can I use two cards to pay?', 'We can send separate payment links for split payments.'],
    ['demo-contact-18', '971508731654', 'Reem Al Suwaidi', 'Please stop promotional messages.', 'You have been opted out of marketing; order updates remain available.'],
  ];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO demo_workspace (id, mode, created_at, updated_at) VALUES ('default', 'demo', ?, ?)`).bind(timestamp, timestamp),
  ];
  let messageNumber = 1;
  for (const [contactIndex, [contactId, waId, name, question, reply]] of contacts.entries()) {
    const conversationId = `${contactId}-conversation`;
    statements.push(
      env.DB.prepare(`INSERT INTO contacts (id, wa_id, display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)`).bind(contactId, waId, name, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO conversations (id, contact_id, phone_number_id, last_message_at, created_at, updated_at) VALUES (?, ?, 'demo-phone', ?, ?, ?)`).bind(conversationId, contactId, timestamp, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO demo_seed_records (batch_id, record_type, record_id) VALUES (?, 'contact', ?), (?, 'conversation', ?)`).bind(batch, contactId, batch, conversationId),
    );
    const messages = [
      ['inbound', 'text', 'read', question],
      ['outbound', contactIndex % 3 === 0 ? 'template' : 'text', 'delivered', reply],
      ...(contactIndex < 6 ? [['inbound', 'text', 'read', ['Thank you — that works perfectly.', 'Could you share a product photo?', 'When will the courier collect it?', 'I have completed the payment.', 'That invoice is exactly what I needed.', 'Please notify me first.'][contactIndex]]] : []),
    ];
    for (const [direction, type, status, body] of messages) {
      const messageId = `demo-message-${messageNumber++}`;
      statements.push(
        env.DB.prepare(`INSERT INTO messages (id, conversation_id, phone_number_id, direction, type, body_json, status, created_at, updated_at) VALUES (?, ?, 'demo-phone', ?, ?, ?, ?, ?, ?)`).bind(messageId, conversationId, direction, type, JSON.stringify({ body }), status, timestamp, timestamp),
        env.DB.prepare(`INSERT INTO demo_seed_records (batch_id, record_type, record_id) VALUES (?, 'message', ?)`).bind(batch, messageId),
      );
    }
  }
  for (const [templateId, name, category] of [
    ['demo-template-1', 'order_update', 'UTILITY'], ['demo-template-2', 'delivery_slot', 'UTILITY'],
    ['demo-template-3', 'eid_home_refresh', 'MARKETING'], ['demo-template-4', 'return_received', 'UTILITY'],
    ['demo-template-5', 'payment_link', 'UTILITY'], ['demo-template-6', 'back_in_stock', 'MARKETING'],
  ]) statements.push(
    env.DB.prepare(`INSERT INTO templates (id, meta_template_id, name, language, category, status, quality_score, components_json, updated_at) VALUES (?, ?, ?, 'en_US', ?, 'APPROVED', 'GREEN', '[]', ?)`).bind(templateId, templateId, name, category, timestamp),
    env.DB.prepare(`INSERT INTO demo_seed_records (batch_id, record_type, record_id) VALUES (?, 'template', ?)`).bind(batch, templateId),
  );
  await env.DB.batch(statements);
}

type DemoAction = {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  response: Record<string, unknown>;
  events: Array<{ type: string; after_ms: number; detail: string }>;
  effects?: Record<string, unknown>;
};

const demoActions: Record<string, DemoAction> = {
  send_message: { method: 'POST', path: '/v1/messages', response: { id: 'msg_demo_7f3a', status: 'queued', accepted: true }, events: [{ type: 'message.queued', after_ms: 0, detail: 'Stored in the local outbox' }, { type: 'message.submitted', after_ms: 900, detail: 'Scripted WhatsApp acceptance' }, { type: 'message.delivered', after_ms: 2200, detail: 'Delivered to Aisha Rahman' }], effects: { counts: { messages: 1 }, message: { id: 'msg_demo_7f3a', direction: 'Outbound', type: 'Text', status: 'Delivered', created_at: 'Just now' } } },
  sync_templates: { method: 'POST', path: '/v1/templates/sync', response: { status: 'queued', templates_updated: 3 }, events: [{ type: 'template.sync.requested', after_ms: 0, detail: 'Template sync queued' }, { type: 'template.updated', after_ms: 1200, detail: 'Three approved templates reconciled' }], effects: { counts: { templates: 3 } } },
  create_token: { method: 'POST', path: '/v1/admin/tokens', response: { id: 'tok_demo_24c1', token: 'rly_demo_••••••••••••••••', scopes: ['messages:read', 'messages:send'] }, events: [{ type: 'token.created', after_ms: 0, detail: 'One-time demo token displayed' }], effects: { token_created: true } },
  assign_conversation: { method: 'PUT', path: '/v1/conversations/con_demo_aisha/assignment', response: { status: 'assigned', assignee: 'Layla Hassan' }, events: [{ type: 'conversation.assigned', after_ms: 0, detail: 'Ownership updated for the support queue' }] },
  add_note: { method: 'POST', path: '/v1/conversations/con_demo_aisha/notes', response: { id: 'note_demo_019', status: 'created' }, events: [{ type: 'conversation.note_added', after_ms: 0, detail: 'Internal note saved' }] },
  create_campaign: { method: 'POST', path: '/v1/campaigns', response: { id: 'cmp_demo_eid', status: 'draft', audience_count: 248 }, events: [{ type: 'campaign.draft_created', after_ms: 0, detail: 'Eligible opted-in customers calculated' }] },
  launch_campaign: { method: 'POST', path: '/v1/campaigns/cmp_demo_eid/launch', response: { status: 'scheduled', recipient_count: 248 }, events: [{ type: 'campaign.approved', after_ms: 0, detail: 'Supervisor approval recorded' }, { type: 'campaign.dispatched', after_ms: 1800, detail: 'First 25 template sends accepted' }] },
  publish_flow: { method: 'POST', path: '/v1/flows/delivery-slot/publish', response: { version: 3, status: 'published' }, events: [{ type: 'flow.published', after_ms: 0, detail: 'Delivery-slot flow v3 is now active' }] },
  submit_flow: { method: 'POST', path: '/v1/flows/delivery-slot/sessions/demo/submit', response: { status: 'completed', delivery_slot: 'Tomorrow, 14:00–17:00' }, events: [{ type: 'flow.completed', after_ms: 0, detail: 'Order SO-10482 delivery window updated' }] },
  create_refund: { method: 'POST', path: '/v1/orders/SO-10421/refunds', response: { id: 're_demo_018', status: 'pending', amount: 189 }, events: [{ type: 'refund.requested', after_ms: 0, detail: 'Refund sent to the payment adapter' }, { type: 'refund.succeeded', after_ms: 1500, detail: 'AED 189.00 return approved' }] },
  run_workflow: { method: 'POST', path: '/v1/workflows/return-resolution/test', response: { run_id: 'run_demo_9c21', status: 'running' }, events: [{ type: 'workflow.started', after_ms: 0, detail: 'Return-resolution workflow started' }, { type: 'workflow.waiting_for_approval', after_ms: 800, detail: 'Human refund approval requested' }] },
  approve_ai_draft: { method: 'POST', path: '/v1/ai/drafts/ai_demo_017/approve', response: { status: 'approved', message_id: 'msg_demo_ai17' }, events: [{ type: 'ai.draft_approved', after_ms: 0, detail: 'Human approval captured' }, { type: 'message.queued', after_ms: 100, detail: 'Approved draft queued for sending' }] },
  sync_shopify: { method: 'POST', path: '/v1/integrations/shopify/sync', response: { status: 'queued', cursor: 'orders_2026_09_07' }, events: [{ type: 'integration.sync_started', after_ms: 0, detail: 'Shopify order sync started' }, { type: 'integration.sync_completed', after_ms: 1400, detail: '12 orders and 4 fulfilments reconciled' }] },
  test_webhook: { method: 'POST', path: '/v1/webhooks/subscriptions/demo/test', response: { status: 'delivered', response_code: 202 }, events: [{ type: 'webhook.delivery_succeeded', after_ms: 0, detail: 'Signed test event accepted by destination' }] },
  invite_user: { method: 'POST', path: '/v1/admin/invitations', response: { id: 'invite_demo_44a', status: 'pending', email: 'sara@noorhome.ae' }, events: [{ type: 'team.invited', after_ms: 0, detail: 'Invitation link generated locally' }] },
  export_data: { method: 'POST', path: '/v1/admin/exports', response: { id: 'exp_demo_002', status: 'ready', file: 'noor-home-demo-export.json' }, events: [{ type: 'export.ready', after_ms: 0, detail: 'Bounded local export prepared' }] },
  simulate_provider_failure: { method: 'POST', path: '/v1/integrations/twilio/test-failure', response: { status: 'retry_scheduled', retry_in_seconds: 60 }, events: [{ type: 'integration.delivery_failed', after_ms: 0, detail: 'Prescribed 429 response received' }, { type: 'integration.retry_scheduled', after_ms: 0, detail: 'Retry queued with safe backoff' }] },
  preview_connection: { method: 'POST', path: '/v1/channels/whatsapp/preview', response: { waba_id: '102938475610293', phone_numbers: [{ id: '109283746510293', display_phone_number: '+971 58 555 0147', quality_rating: 'GREEN' }] }, events: [{ type: 'channel.discovery_completed', after_ms: 0, detail: 'Scripted Meta discovery completed without network access' }] },
};

const demoRecipientNames: Record<string, string> = {
  '971501234567': 'Aisha Rahman',
  '971551112233': 'Maya Patel',
  '971582209811': 'Noah Martin',
};

function redactDemoRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const redacted = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(redacted)) if (/token|secret|password|authorization/i.test(key)) redacted[key] = '[redacted]';
  return redacted;
}

async function simulateDemoAction(request: Request, user: DashboardUser, env: Env): Promise<Response> {
  const workspace = await env.DB.prepare(`SELECT mode FROM demo_workspace WHERE id = 'default'`).first<{ mode: string }>();
  if (workspace?.mode !== 'demo') return error(409, 'live_workspace', 'Simulated actions are available only in the demo workspace');
  let input: { action?: string; request?: unknown }; try { input = await request.json(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  const action = input.action ? demoActions[input.action] : undefined;
  if (!action) return error(422, 'validation_error', 'Unsupported demo action');
  const requestBody = redactDemoRequest(input.request);
  const recipient = input.action === 'send_message' && typeof requestBody.to === 'string'
    ? demoRecipientNames[requestBody.to] ?? 'the selected demo customer'
    : null;
  const events = recipient
    ? action.events.map((event) => event.type === 'message.delivered' ? { ...event, detail: `Delivered to ${recipient}` } : event)
    : action.events;
  const effects = action.effects ? JSON.parse(JSON.stringify(action.effects)) as Record<string, unknown> : {};
  if (recipient && effects.message && typeof effects.message === 'object') {
    (effects.message as Record<string, unknown>).recipient = recipient;
  }
  const receipt = { id: id(), action: input.action!, request: { method: action.method, path: action.path, body: requestBody }, response: action.response, events, effects, created_at: now() };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO demo_action_runs (id, action, request_json, response_json, events_json, effects_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(receipt.id, receipt.action, JSON.stringify(receipt.request), JSON.stringify(receipt.response), JSON.stringify(receipt.events), JSON.stringify(receipt.effects), receipt.created_at),
    audit(env, user.email ?? user.id, `demo.${input.action}`, 'demo_workspace', 'default', { simulated: true, receipt_id: receipt.id }),
  ]);
  return json({ status: 'simulated', receipt });
}

async function listDemoReceipts(env: Env): Promise<Response> {
  const workspace = await env.DB.prepare(`SELECT mode FROM demo_workspace WHERE id = 'default'`).first<{ mode: string }>();
  if (workspace?.mode !== 'demo') return error(409, 'live_workspace', 'Sample action receipts are available only in the demo workspace');
  const results = await env.DB.prepare(
    `SELECT id, action, request_json, response_json, events_json, effects_json, created_at FROM demo_action_runs ORDER BY created_at DESC LIMIT 30`
  ).all<{ id: string; action: string; request_json: string; response_json: string; events_json: string; effects_json: string; created_at: string }>();
  return json({ data: results.results.map((item) => ({
    id: item.id, action: item.action, request: safeJson(item.request_json), response: safeJson(item.response_json), events: safeJson(item.events_json), effects: safeJson(item.effects_json), created_at: item.created_at,
  })) });
}

async function resetDemoActions(user: DashboardUser, env: Env): Promise<Response> {
  const workspace = await env.DB.prepare(`SELECT mode FROM demo_workspace WHERE id = 'default'`).first<{ mode: string }>();
  if (workspace?.mode !== 'demo') return error(409, 'live_workspace', 'The sample scenario can be reset only while this is a demo workspace');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM demo_action_runs`),
    env.DB.prepare(`DELETE FROM audit_events WHERE action LIKE 'demo.%' AND target_type = 'demo_workspace'`),
    audit(env, user.email ?? user.id, 'demo.reset', 'demo_workspace', 'default', { simulated: true }),
  ]);
  return json({ status: 'reset', message: 'The Noor Home scenario is restored and previous demo receipts were removed.' });
}

async function clearDemoWorkspace(request: Request, user: DashboardUser, env: Env): Promise<Response> {
  if (request.headers.get('x-confirm-demo-cleanup') !== 'START_FRESH') return error(428, 'confirmation_required', 'Set X-Confirm-Demo-Cleanup: START_FRESH to remove supplied demo data');
  const workspace = await env.DB.prepare(`SELECT mode FROM demo_workspace WHERE id = 'default'`).first<{ mode: string }>();
  if (workspace?.mode !== 'demo') return error(409, 'already_live', 'The workspace is already clean');
  const hasConnection = await env.DB.prepare(`SELECT 1 FROM whatsapp_connections WHERE status = 'connected' LIMIT 1`).first();
  if (!hasConnection) return error(409, 'connection_required', 'Connect WhatsApp before starting fresh');
  const ids = async (type: string) => (await env.DB.prepare(`SELECT record_id FROM demo_seed_records WHERE batch_id = 'initial-demo' AND record_type = ?`).bind(type).all<{ record_id: string }>()).results.map((row) => row.record_id);
  const messageIds = await ids('message'); const conversationIds = await ids('conversation'); const contactIds = await ids('contact'); const templateIds = await ids('template');
  const remove = (table: string, values: string[]) => values.length ? env.DB.prepare(`DELETE FROM ${table} WHERE id IN (${values.map(() => '?').join(',')})`).bind(...values) : null;
  await env.DB.batch([remove('messages', messageIds), remove('conversations', conversationIds), remove('contacts', contactIds), remove('templates', templateIds)].filter(Boolean) as D1PreparedStatement[]);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM demo_seed_records WHERE batch_id = 'initial-demo'`),
    env.DB.prepare(`DELETE FROM demo_action_runs`),
    env.DB.prepare(`UPDATE demo_workspace SET mode = 'live', cleanup_prompted_at = ?, updated_at = ? WHERE id = 'default'`).bind(now(), now()),
  ]);
  await audit(env, user.email ?? user.id, 'demo.cleared', 'demo_workspace', 'default', {});
  return json({ status: 'live' });
}

async function discoverPhoneNumbers(request: Request, user: DashboardUser, env: Env): Promise<Response> {
  if (!['super_admin', 'admin'].includes(user.role)) return error(403, 'forbidden', 'Only administrators can discover phone numbers');
  let input: { waba_id?: string; access_token?: string; app_secret?: string };
  try { input = await request.json(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  if (typeof input.waba_id !== 'string' || !/^\d{3,30}$/.test(input.waba_id)
    || typeof input.access_token !== 'string' || !input.access_token || input.access_token.length > 4096
    || typeof input.app_secret !== 'string' || !input.app_secret || input.app_secret.length > 512) {
    return error(422, 'validation_error', 'Enter a valid WABA ID, system-user access token, and Meta app secret');
  }
  try {
    const proof = await appSecretProof(input.access_token, input.app_secret);
    const response = await fetch(
      graphUrl(env, `${input.waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=100&appsecret_proof=${proof}`),
      { headers: { authorization: `Bearer ${input.access_token}` } },
    );
    if (!response.ok) return error(422, 'meta_validation_failed', 'Meta could not list phone numbers. Check the WABA ID, token, and token permissions');
    const body = await response.json<{ data?: Array<{ id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }> }>();
    const phoneNumbers = (body.data ?? []).filter((item) => typeof item.id === 'string' && /^\d{3,30}$/.test(item.id)).map((item) => ({
      id: item.id!,
      display_phone_number: item.display_phone_number ?? null,
      verified_name: item.verified_name ?? null,
      quality_rating: item.quality_rating ?? null,
    }));
    return json({ phone_numbers: phoneNumbers }, 200, { 'cache-control': 'no-store' });
  } catch {
    return error(502, 'meta_unavailable', 'Could not reach Meta to list phone numbers');
  }
}

async function createDashboardApiToken(request: Request, user: DashboardUser, env: Env): Promise<Response> {
  if (!['super_admin', 'admin'].includes(user.role)) return error(403, 'forbidden', 'Only administrators can create API tokens');
  let input: { name?: string; scopes?: string[]; expires_at?: string };
  try { input = await request.json(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  if (!input.name || !Array.isArray(input.scopes) || !input.scopes.length) return error(422, 'validation_error', 'name and a non-empty scopes array are required');
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const principalId = id();
  const scopes = input.scopes;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO api_principals (id, name, token_digest, scopes_json) VALUES (?, ?, ?, ?)`
    ).bind(principalId, input.name, await sha256(token), JSON.stringify(scopes)),
    audit(env, user.email ?? user.access_subject ?? user.id, 'token.create', 'api_principal', principalId, { scopes }),
  ]);
  return json({ id: principalId, token, scopes }, 201, { 'cache-control': 'no-store' });
}

function requireDashboardAdmin(user: DashboardUser): Response | null {
  return ['super_admin', 'admin'].includes(user.role) ? null : error(403, 'forbidden', 'Only administrators can manage access');
}

async function listDashboardUsers(user: DashboardUser, env: Env): Promise<Response> {
  const denied = requireDashboardAdmin(user); if (denied) return denied;
  const result = await env.DB.prepare(`SELECT id, access_subject, email, role, created_at, last_seen_at FROM dashboard_users ORDER BY created_at`).all();
  return json({ data: result.results });
}

async function createDashboardUser(request: Request, user: DashboardUser, env: Env): Promise<Response> {
  const denied = requireDashboardAdmin(user); if (denied) return denied;
  let input: { access_subject?: string; email?: string; role?: 'admin' | 'viewer' };
  try { input = await request.json(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  if (typeof input.access_subject !== 'string' || !input.access_subject.trim() || input.access_subject.length > 512) return error(422, 'validation_error', 'A Cloudflare Access subject is required');
  if (input.email !== undefined && (typeof input.email !== 'string' || input.email.length > 254)) return error(422, 'validation_error', 'email is invalid');
  if (!['admin', 'viewer'].includes(input.role ?? 'viewer')) return error(422, 'validation_error', 'role must be admin or viewer');
  const memberId = id(); const timestamp = now(); const role = input.role ?? 'viewer';
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO dashboard_users (id, access_subject, email, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(access_subject) DO UPDATE SET email = excluded.email, role = excluded.role`)
      .bind(memberId, input.access_subject.trim(), input.email ?? null, role, timestamp, timestamp),
    audit(env, user.email ?? user.access_subject ?? user.id, 'dashboard_user.upsert', 'dashboard_user', input.access_subject.trim(), { role }),
  ]);
  return json({ access_subject: input.access_subject.trim(), email: input.email ?? null, role }, 201);
}

async function revokeDashboardUser(memberId: string, user: DashboardUser, env: Env): Promise<Response> {
  const denied = requireDashboardAdmin(user); if (denied) return denied;
  if (memberId === user.id) return error(409, 'owner_protected', 'Do not remove your own access while signed in');
  const target = await env.DB.prepare(`SELECT role FROM dashboard_users WHERE id = ?`).bind(memberId).first<{ role: string }>();
  if (!target) return error(404, 'not_found', 'Dashboard member not found');
  if (target.role === 'super_admin') return error(409, 'owner_protected', 'The installation owner cannot be removed');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM dashboard_users WHERE id = ?`).bind(memberId),
    audit(env, user.email ?? user.access_subject ?? user.id, 'dashboard_user.revoke', 'dashboard_user', memberId, {}),
  ]);
  return json({ id: memberId, status: 'revoked' });
}

function scopeFor(method: string, path: string): string {
  if (path.startsWith('/v1/admin/')) return 'admin';
  if (path.startsWith('/v1/logs/')) return 'logs:read';
  if (path.startsWith('/v1/webhooks/')) return 'webhooks:read';
  if (path === '/v1/templates/sync') return 'templates:write';
  if (path.startsWith('/v1/templates')) return 'templates:read';
  if (path.startsWith('/v1/contacts')) return 'messages:read';
  if (path.startsWith('/v1/conversations')) return 'messages:read';
  if (method === 'POST' && path === '/v1/messages') return 'messages:send';
  return 'messages:read';
}

async function createMessage(request: Request, env: Env, principal: Principal): Promise<Response> {
  let input: MessageInput;
  try { input = await request.json<MessageInput>(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  const validation = await validateMessage(input, env);
  if (validation) return error(422, 'validation_error', validation);
  const key = request.headers.get('idempotency-key');
  if (!key || key.length > 255) return error(422, 'idempotency_key_required', 'Provide an Idempotency-Key no longer than 255 characters');

  const existing = await env.DB.prepare(
    `SELECT id, status FROM messages WHERE phone_number_id = ? AND idempotency_key = ?`
  ).bind(input.phone_number_id, key).first<{ id: string; status: string }>();
  if (existing) return json({ id: existing.id, status: existing.status, idempotent: true }, 202);

  if (await sandboxActive(env)) return createSandboxMessage(input, key, env, principal);

  const messageId = id();
  const jobId = id();
  const content = input.type === 'text' ? input.text : input.template;
  const requestJson = JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: input.to, type: input.type, [input.type]: content });
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, phone_number_id, direction, type, body_json, status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'outbound', ?, ?, 'queued', ?, ?, ?)`
    ).bind(messageId, input.phone_number_id, input.type, requestJson, key, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO outbound_jobs (id, message_id, phone_number_id, recipient_wa_id, request_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`
    ).bind(jobId, messageId, input.phone_number_id, input.to, requestJson, timestamp, timestamp),
    audit(env, principal.name, 'message.create', 'message', messageId, { phone_number_id: input.phone_number_id, type: input.type }),
  ]);
  await env.JOBS_QUEUE.send({ type: 'outbound_dispatch', jobId, phoneNumberId: input.phone_number_id });
  return json({ id: messageId, status: 'queued' }, 202);
}

async function validateMessage(input: MessageInput, env: Env): Promise<string | null> {
  if (!input || !input.phone_number_id || !input.to || !input.type) return 'phone_number_id, to, and type are required';
  const allowed = (env.PHONE_NUMBER_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(input.phone_number_id)) return 'phone_number_id is not configured for this installation';
  if (!allowed.length) {
    const connection = await env.DB.prepare(
      `SELECT 1 FROM whatsapp_connections WHERE phone_number_id = ? AND status IN ('validated', 'connected') LIMIT 1`
    ).bind(input.phone_number_id).first().catch(() => null);
    if (!connection) return null; // Sandbox sends are intentionally available before Meta activation.
  }
  if (!/^\d{6,20}$/.test(input.to)) return 'to must be a WhatsApp ID containing 6-20 digits';
  if (input.type === 'text' && (!input.text?.body || input.text.body.length > 4096)) return 'text.body is required and must be no longer than 4096 characters';
  if (input.type === 'template' && (!input.template?.name || !input.template.language?.code)) return 'template.name and template.language.code are required';
  return null;
}

async function listMessages(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50'), 1), 100);
  const before = url.searchParams.get('before');
  const results = await env.DB.prepare(
    `SELECT id, meta_message_id, conversation_id, phone_number_id, direction, type, status, created_at, updated_at
     FROM messages WHERE (? IS NULL OR created_at < ?) ORDER BY created_at DESC LIMIT ?`
  ).bind(before, before, limit).all<{ id: string; meta_message_id: string | null; conversation_id: string | null; phone_number_id: string; direction: string; type: string; status: string; created_at: string; updated_at: string }>();
  return json({ data: results.results, next_before: results.results.at(-1)?.created_at ?? null });
}

async function getMessage(messageId: string, env: Env): Promise<Response> {
  const message = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?`).bind(messageId).first();
  if (!message) return error(404, 'not_found', 'Message not found');
  const statusEvents = await env.DB.prepare(`SELECT status, meta_timestamp, created_at FROM message_status_events WHERE message_id = ? ORDER BY created_at`).bind(messageId).all();
  return json({ data: message, status_events: statusEvents.results });
}

async function listContacts(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50'), 1), 100);
  const results = await env.DB.prepare(
    `SELECT id, wa_id, display_name, profile_json, created_at, updated_at FROM contacts ORDER BY updated_at DESC LIMIT ?`
  ).bind(limit).all();
  return json({ data: results.results });
}

async function getContact(contactId: string, env: Env): Promise<Response> {
  const contact = await env.DB.prepare(
    `SELECT id, wa_id, display_name, profile_json, created_at, updated_at FROM contacts WHERE id = ?`
  ).bind(contactId).first();
  if (!contact) return error(404, 'not_found', 'Contact not found');
  return json({ data: contact });
}

async function listConversations(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '50'), 1), 100);
  const results = await env.DB.prepare(
    `SELECT c.id, c.phone_number_id, c.last_message_at, contact.wa_id, contact.display_name
     FROM conversations c JOIN contacts contact ON contact.id = c.contact_id
     ORDER BY c.last_message_at DESC LIMIT ?`
  ).bind(limit).all();
  return json({ data: results.results });
}

async function listTemplates(env: Env): Promise<Response> {
  const results = await env.DB.prepare(`SELECT meta_template_id, name, language, category, status, quality_score, components_json, updated_at FROM templates ORDER BY name, language`).all<{ meta_template_id: string | null; name: string; language: string; category: string | null; status: string | null; quality_score: string | null; components_json: string; updated_at: string }>();
  return json({ data: results.results.map((item) => ({ ...item, components: safeJson(item.components_json as string), components_json: undefined })) });
}

async function queueTemplateSync(env: Env, principal: Principal): Promise<Response> {
  const configured = await env.DB.prepare(`SELECT 1 FROM whatsapp_connections WHERE status IN ('validated', 'connected') LIMIT 1`).first().catch(() => null);
  if (!env.WABA_ID && !configured) return error(409, 'not_configured', 'No WhatsApp connection is configured');
  await env.JOBS_QUEUE.send({ type: 'template_sync' });
  await audit(env, principal.name, 'template.sync.requested', 'template', null, {});
  return json({ status: 'queued' }, 202);
}

async function createApiToken(request: Request, env: Env, principal: Principal): Promise<Response> {
  let input: { name?: string; scopes?: string[]; expires_at?: string };
  try { input = await request.json(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  if (!input.name || !Array.isArray(input.scopes) || !input.scopes.length) return error(422, 'validation_error', 'name and a non-empty scopes array are required');
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const principalId = id();
  await env.DB.prepare(
    `INSERT INTO api_principals (id, name, token_digest, scopes_json, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(principalId, input.name, await sha256(token), JSON.stringify(input.scopes), input.expires_at ?? null).run();
  await audit(env, principal.name, 'token.create', 'api_principal', principalId, { scopes: input.scopes });
  return json({ id: principalId, token, scopes: input.scopes, expires_at: input.expires_at ?? null }, 201);
}

async function exportData(env: Env): Promise<Response> {
  // This first export is intentionally bounded. Operators can invoke it repeatedly
  // while the production export-job/R2 archive facility is introduced in Phase 2.
  const [contacts, conversations, messages, templates] = await Promise.all([
    env.DB.prepare(`SELECT id, wa_id, display_name, profile_json, created_at, updated_at FROM contacts ORDER BY id LIMIT 10000`).all(),
    env.DB.prepare(`SELECT id, contact_id, phone_number_id, last_message_at, created_at, updated_at FROM conversations ORDER BY id LIMIT 10000`).all(),
    env.DB.prepare(`SELECT id, meta_message_id, conversation_id, phone_number_id, direction, type, body_json, status, created_at, updated_at FROM messages ORDER BY id LIMIT 10000`).all(),
    env.DB.prepare(`SELECT meta_template_id, name, language, category, status, quality_score, components_json, updated_at FROM templates ORDER BY id LIMIT 10000`).all(),
  ]);
  return json({ exported_at: now(), truncated: [contacts, conversations, messages, templates].some((result) => result.results.length === 10000), data: {
    contacts: contacts.results, conversations: conversations.results, messages: messages.results, templates: templates.results,
  } }, 200, { 'content-disposition': 'attachment; filename="openwa-core-export.json"' });
}

async function deleteInstallationData(request: Request, env: Env, principal: Principal): Promise<Response> {
  if (request.headers.get('x-confirm-installation-deletion') !== 'DELETE') {
    return error(428, 'confirmation_required', 'Set X-Confirm-Installation-Deletion: DELETE to erase customer data');
  }
  await deleteR2Objects(env);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM message_status_events`),
    env.DB.prepare(`DELETE FROM send_attempts`),
    env.DB.prepare(`DELETE FROM outbound_jobs`),
    env.DB.prepare(`DELETE FROM messages`),
    env.DB.prepare(`DELETE FROM conversations`),
    env.DB.prepare(`DELETE FROM contacts`),
    env.DB.prepare(`DELETE FROM templates`),
    env.DB.prepare(`DELETE FROM webhook_receipts`),
    env.DB.prepare(`DELETE FROM audit_events`),
    env.DB.prepare(`DELETE FROM api_principals`),
    env.DB.prepare(`DELETE FROM whatsapp_connections`),
    env.DB.prepare(`DELETE FROM webhook_endpoint_verification`),
    env.DB.prepare(`DELETE FROM dashboard_login_attempts`),
    env.DB.prepare(`DELETE FROM dashboard_sessions`),
    env.DB.prepare(`DELETE FROM local_owner`),
    env.DB.prepare(`DELETE FROM dashboard_users`),
    env.DB.prepare(`DELETE FROM dashboard_installation`),
  ]);
  // A wiped installation returns to first-run state so a new local owner can be created.
  await audit(env, principal.name, 'installation.data_deleted', 'installation', 'default', {});
  return json({ status: 'deleted', deleted_at: now() });
}

async function deleteR2Objects(env: Env): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ cursor, limit: 1000 });
    if (page.objects.length) await env.MEDIA.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function processWebhook(job: Extract<QueueJob, { type: 'inbound_webhook' }>, env: Env): Promise<void> {
  let payload = job.payload;
  if (job.r2Key) {
    const object = await env.MEDIA.get(job.r2Key);
    if (!object) throw new Error(`Webhook payload missing from R2: ${job.r2Key}`);
    payload = await object.json();
  }
  if (!payload) throw new Error('Inbound webhook job has no payload');
  const receipt = await env.DB.prepare(`INSERT OR IGNORE INTO webhook_receipts (event_fingerprint, payload_json) VALUES (?, ?)`)
    .bind(job.fingerprint, JSON.stringify(payload)).run();
  if (!receipt.meta.changes) return;
  const webhookPayload = payload as { entry?: Array<{ changes?: Array<{ value?: WebhookValue }> }> };
  for (const entry of webhookPayload.entry ?? []) for (const change of entry.changes ?? []) {
    const value = change.value;
    if (!value) continue;
    for (const message of value.messages ?? []) await persistInboundMessage(message, value, env);
    for (const status of value.statuses ?? []) await persistStatus(status, value, env);
  }
  await env.DB.prepare(`UPDATE webhook_receipts SET processed_at = ? WHERE event_fingerprint = ?`).bind(now(), job.fingerprint).run();
}

interface WebhookValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: Array<{ id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } }>;
  statuses?: Array<{ id?: string; status?: string; timestamp?: string; recipient_id?: string; errors?: unknown[] }>;
}

async function persistInboundMessage(message: NonNullable<WebhookValue['messages']>[number], value: WebhookValue, env: Env): Promise<void> {
  if (!message.id || !message.from || !value.metadata?.phone_number_id) return;
  const contactId = id();
  const conversationId = id();
  const messageId = id();
  const displayName = value.contacts?.find((contact) => contact.wa_id === message.from)?.profile?.name ?? null;
  const body = JSON.stringify(message);
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO contacts (id, wa_id, display_name) VALUES (?, ?, ?)`).bind(contactId, message.from, displayName),
    env.DB.prepare(`INSERT OR IGNORE INTO conversations (id, contact_id, phone_number_id, last_message_at) VALUES (?, (SELECT id FROM contacts WHERE wa_id = ?), ?, ?)`)
      .bind(conversationId, message.from, value.metadata.phone_number_id, now()),
    env.DB.prepare(
      `INSERT OR IGNORE INTO messages (id, meta_message_id, conversation_id, phone_number_id, direction, type, body_json, status)
       VALUES (?, ?, (SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ? AND c.phone_number_id = ?), ?, 'inbound', ?, ?, 'delivered')`
    ).bind(messageId, message.id, message.from, value.metadata.phone_number_id, value.metadata.phone_number_id, message.type ?? 'unknown', body),
    env.DB.prepare(`UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE contact_id = (SELECT id FROM contacts WHERE wa_id = ?) AND phone_number_id = ?`)
      .bind(now(), now(), message.from, value.metadata.phone_number_id),
  ]);
}

async function persistStatus(status: NonNullable<WebhookValue['statuses']>[number], value: WebhookValue, env: Env): Promise<void> {
  if (!status.id || !status.status) return;
  const fingerprint = await sha256(JSON.stringify(status));
  const message = await env.DB.prepare(`SELECT id, status FROM messages WHERE meta_message_id = ?`).bind(status.id).first<{ id: string; status: string }>();
  if (!message) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO message_status_events (id, message_id, status, meta_timestamp, event_fingerprint, payload_json) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id(), message.id, status.status, status.timestamp ?? null, fingerprint, JSON.stringify(status)).run();
  // `failed` is terminal only before a successful delivery state. Meta status
  // webhooks can arrive late, so a late failed event must not replace read/delivered.
  if (message.status === 'failed') return;
  const currentRank = statusRank[message.status] ?? -1;
  const incomingRank = statusRank[status.status] ?? -1;
  const canApplyFailure = status.status === 'failed' && currentRank < statusRank.delivered;
  const canApplyProgress = status.status !== 'failed' && incomingRank >= currentRank;
  if (canApplyFailure || canApplyProgress) {
    await env.DB.prepare(`UPDATE messages SET status = ?, updated_at = ? WHERE id = ?`).bind(status.status, now(), message.id).run();
  }
}

async function dispatchOutbound(job: Extract<QueueJob, { type: 'outbound_dispatch' }>, env: Env): Promise<number | null> {
  const dispatcher = env.PHONE_DISPATCHER.get(env.PHONE_DISPATCHER.idFromName(job.phoneNumberId));
  const result = await dispatcher.fetch('https://phone-dispatcher/dispatch', { method: 'POST', body: JSON.stringify(job) });
  if (result.status >= 500 || result.status === 429) {
    const body: { retryAfterSeconds?: number } = await result.json<{ retryAfterSeconds?: number }>().catch(() => ({}));
    return Math.max(1, Math.min(300, body.retryAfterSeconds ?? 5));
  }
  return null;
}

async function syncTemplates(env: Env): Promise<void> {
  const connection = await env.DB.prepare(
    `SELECT waba_id FROM whatsapp_connections WHERE status IN ('validated', 'connected') ORDER BY updated_at DESC LIMIT 1`
  ).first<{ waba_id: string }>();
  const wabaId = connection?.waba_id ?? env.WABA_ID;
  const credentials = await activeMetaCredentials(env);
  if (!wabaId || !credentials) throw new Error('No validated WhatsApp connection is configured');
  const response = await fetch(graphUrl(env, `${wabaId}/message_templates?limit=100`), { headers: { authorization: `Bearer ${credentials.accessToken}` } });
  if (!response.ok) throw new Error(`Meta template sync failed: ${response.status}`);
  const body = await response.json<{ data?: Array<{ id?: string; name?: string; language?: string; category?: string; status?: string; quality_score?: { score?: string }; components?: unknown[] }> }>();
  const statements: D1PreparedStatement[] = [];
  for (const template of body.data ?? []) {
    if (!template.name || !template.language) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO templates (id, meta_template_id, name, language, category, status, quality_score, components_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, language) DO UPDATE SET meta_template_id = excluded.meta_template_id, category = excluded.category, status = excluded.status, quality_score = excluded.quality_score, components_json = excluded.components_json, updated_at = excluded.updated_at`
    ).bind(id(), template.id ?? null, template.name, template.language, template.category ?? null, template.status ?? null, template.quality_score?.score ?? null, JSON.stringify(template.components ?? []), now()));
  }
  if (statements.length) await env.DB.batch(statements);
}

function audit(env: Env, actor: string, action: string, targetType: string | null, targetId: string | null, metadata: unknown): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_events (id, actor, action, target_type, target_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id(), actor, action, targetType, targetId, JSON.stringify(metadata));
}

async function sandboxActive(env: Env): Promise<boolean> {
  // Advanced self-hosted installations may configure the Meta credentials as
  // Worker secrets instead of through the browser control plane.
  if (env.META_ACCESS_TOKEN && (env.WABA_ID || env.PHONE_NUMBER_IDS)) return false;
  const connection = await env.DB.prepare(`SELECT 1 FROM whatsapp_connections WHERE status IN ('validated', 'connected') LIMIT 1`).first().catch(() => null);
  return !connection;
}

async function createSandboxMessage(input: MessageInput, key: string, env: Env, principal: Principal): Promise<Response> {
  const messageId = id();
  const jobId = id();
  const timestamp = now();
  const requestJson = JSON.stringify({ messaging_product: 'whatsapp', to: input.to, type: input.type, [input.type]: input.type === 'text' ? input.text : input.template, sandbox: true });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages (id, phone_number_id, direction, type, body_json, status, idempotency_key, created_at, updated_at) VALUES (?, ?, 'outbound', ?, ?, 'delivered', ?, ?, ?)`)
      .bind(messageId, input.phone_number_id, input.type, requestJson, key, timestamp, timestamp),
    env.DB.prepare(`INSERT INTO outbound_jobs (id, message_id, phone_number_id, recipient_wa_id, request_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'submitted', 1, ?, ?)`)
      .bind(jobId, messageId, input.phone_number_id, input.to, requestJson, timestamp, timestamp),
    env.DB.prepare(`INSERT INTO message_status_events (id, message_id, status, event_fingerprint, payload_json) VALUES (?, ?, 'submitted', ?, ?), (?, ?, 'delivered', ?, ?)`)
      .bind(id(), messageId, await sha256(`${messageId}:submitted`), JSON.stringify({ simulated: true }), id(), messageId, await sha256(`${messageId}:delivered`), JSON.stringify({ simulated: true })),
    env.DB.prepare(`INSERT INTO webhook_receipts (event_fingerprint, payload_json, processed_at) VALUES (?, ?, ?)`)
      .bind(await sha256(`${messageId}:webhook`), JSON.stringify({ object: 'whatsapp_business_account', simulated: true, message_id: messageId, status: 'delivered' }), timestamp),
    audit(env, principal.name, 'message.create.simulated', 'message', messageId, { phone_number_id: input.phone_number_id, type: input.type }),
  ]);
  return json({ id: messageId, status: 'delivered', simulated: true, events: ['queued', 'submitted', 'delivered'] }, 202);
}

async function ensureSandboxFixtures(env: Env): Promise<void> {
  if (!(await sandboxActive(env))) return;
  const existing = await env.DB.prepare(`SELECT 1 FROM contacts WHERE wa_id = '15550001001' LIMIT 1`).first().catch(() => null);
  if (existing) return;
  const timestamp = now();
  const contactId = 'sandbox-contact';
  const conversationId = 'sandbox-conversation';
  const inboundId = 'sandbox-inbound';
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO contacts (id, wa_id, display_name, profile_json, created_at, updated_at) VALUES (?, '15550001001', 'Sandbox user', '{"source":"developer-fixture"}', ?, ?)`)
      .bind(contactId, timestamp, timestamp),
    env.DB.prepare(`INSERT OR IGNORE INTO conversations (id, contact_id, phone_number_id, last_message_at, created_at, updated_at) VALUES (?, ?, 'sandbox-phone', ?, ?, ?)`)
      .bind(conversationId, contactId, timestamp, timestamp, timestamp),
    env.DB.prepare(`INSERT OR IGNORE INTO messages (id, conversation_id, phone_number_id, direction, type, body_json, status, created_at, updated_at) VALUES (?, ?, 'sandbox-phone', 'inbound', 'text', '{"text":{"body":"Sandbox webhook received"}}', 'delivered', ?, ?)`)
      .bind(inboundId, conversationId, timestamp, timestamp),
    env.DB.prepare(`INSERT OR IGNORE INTO webhook_receipts (event_fingerprint, payload_json, processed_at) VALUES ('sandbox-webhook-fixture', '{"simulated":true,"event":"messages"}', ?)`)
      .bind(timestamp),
    audit(env, 'system', 'sandbox.fixtures.seeded', 'sandbox', 'default', { simulated: true }),
  ]);
}

async function listAuditEvents(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, actor, action, target_type, target_id, metadata_json, created_at FROM audit_events ORDER BY created_at DESC LIMIT 100`).all();
  return json({ data: result.results.map((item: any) => ({ ...item, metadata: safeJson(item.metadata_json), metadata_json: undefined })) });
}

async function listOutboundJobs(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, message_id, phone_number_id, status, attempts, next_attempt_at, last_error, created_at, updated_at FROM outbound_jobs ORDER BY created_at DESC LIMIT 100`).all();
  return json({ data: result.results });
}

async function listWebhookReceipts(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`SELECT event_fingerprint, received_at, processed_at, payload_json FROM webhook_receipts ORDER BY received_at DESC LIMIT 100`).all();
  return json({ data: result.results.map((item: any) => ({ ...item, payload: safeJson(item.payload_json), payload_json: undefined })) });
}

async function listApiTokens(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, name, scopes_json, expires_at, revoked_at, created_at FROM api_principals ORDER BY created_at DESC LIMIT 100`).all<any>();
  return json({ data: result.results.map((item) => ({ ...item, scopes: safeJson(item.scopes_json), scopes_json: undefined })) });
}

async function revokeApiToken(tokenId: string, env: Env, principal: Principal): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE api_principals SET revoked_at = ? WHERE id = ?`).bind(now(), tokenId),
    audit(env, principal.name, 'token.revoke', 'api_principal', tokenId, {}),
  ]);
  return json({ id: tokenId, status: 'revoked' });
}

async function developerLogs(env: Env): Promise<Response> {
  const [auditRows, jobRows] = await Promise.all([
    env.DB.prepare(`SELECT actor, action, target_type, created_at FROM audit_events ORDER BY created_at DESC LIMIT 50`).all(),
    env.DB.prepare(`SELECT status, attempts, last_error, created_at FROM outbound_jobs ORDER BY created_at DESC LIMIT 50`).all(),
  ]);
  return json({ audit: auditRows.results, jobs: jobRows.results });
}

async function dashboardSandboxMessage(request: Request, user: DashboardUser, env: Env): Promise<Response> {
  const denied = requireDashboardAdmin(user); if (denied) return denied;
  if (!(await sandboxActive(env))) return error(409, 'sandbox_disabled', 'Sandbox simulation is disabled after WhatsApp is connected');
  let input: MessageInput;
  try { input = await request.json(); } catch { return error(400, 'invalid_json', 'Request body must be JSON'); }
  const validation = await validateMessage(input, env);
  if (validation) return error(422, 'validation_error', validation);
  return createSandboxMessage(input, `dashboard-sandbox-${crypto.randomUUID()}`, env, { id: user.id, name: user.email ?? user.access_subject ?? user.id, scopes: ['messages:send'] });
}

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const mcpToolDefinitions = [
  ['openwa_connection_status', 'Get the WhatsApp connection and sandbox status', {}],
  ['openwa_list_messages', 'List recent inbound and outbound WhatsApp messages', { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 100 } } }],
  ['openwa_list_conversations', 'List recent WhatsApp conversations', { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 100 } } }],
  ['openwa_list_templates', 'List available WhatsApp templates', {}],
  ['openwa_list_logs', 'Inspect local audit and outbound job logs', {}],
  ['openwa_list_webhook_receipts', 'Inspect received webhook receipts', {}],
  ['openwa_send_message', 'Send a WhatsApp text or template message; writes data and may deliver externally when connected', { type: 'object', properties: { phone_number_id: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' } }, required: ['phone_number_id', 'to', 'text'] }],
] as const;

function mcpResponse(idValue: JsonRpcRequest['id'], result?: unknown, errorValue?: { code: number; message: string }): Response {
  return json(errorValue ? { jsonrpc: '2.0', id: idValue ?? null, error: errorValue } : { jsonrpc: '2.0', id: idValue ?? null, result }, 200, { 'content-type': 'application/json' });
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') return error(405, 'method_not_allowed', 'MCP notifications are not enabled');
  if (request.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return error(403, 'invalid_origin', 'MCP Origin is not allowed');
  let body: JsonRpcRequest;
  try { body = await request.json(); } catch { return mcpResponse(null, undefined, { code: -32700, message: 'Parse error' }); }
  if (body.jsonrpc !== '2.0' || !body.method) return mcpResponse(body.id, undefined, { code: -32600, message: 'Invalid Request' });
  const isWrite = body.method === 'tools/call' && body.params?.name === 'openwa_send_message';
  const principal = await requirePrincipal(request, env, isWrite ? 'messages:send' : 'messages:read');
  if (!principal) return mcpResponse(body.id, undefined, { code: -32001, message: 'Unauthorized or insufficient scope' });
  if (body.method === 'initialize') return mcpResponse(body.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'openwa', version: '0.2.0' } });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (body.method === 'tools/list') return mcpResponse(body.id, { tools: mcpToolDefinitions.map(([name, description, inputSchema]) => ({ name, description, inputSchema })) });
  if (body.method !== 'tools/call') return mcpResponse(body.id, undefined, { code: -32601, message: 'Method not found' });
  try {
    const value = await callMcpTool(String(body.params?.name ?? ''), body.params?.arguments ?? {}, env, principal);
    return mcpResponse(body.id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  } catch (cause) {
    return mcpResponse(body.id, { content: [{ type: 'text', text: String(cause) }], isError: true });
  }
}

async function callMcpTool(name: string, args: any, env: Env, principal: Principal): Promise<any> {
  if (name === 'openwa_connection_status') return { sandbox: await sandboxActive(env), connection: await env.DB.prepare(`SELECT phone_number_id, display_phone_number, status, updated_at FROM whatsapp_connections ORDER BY updated_at DESC LIMIT 1`).first() };
  if (name === 'openwa_list_messages') return (await listMessages(new URL(`https://mcp.local/?limit=${args.limit ?? 50}`), env)).json();
  if (name === 'openwa_list_conversations') return (await listConversations(new URL(`https://mcp.local/?limit=${args.limit ?? 50}`), env)).json();
  if (name === 'openwa_list_templates') return (await listTemplates(env)).json();
  if (name === 'openwa_list_logs') return developerLogs(env).then((response) => response.json());
  if (name === 'openwa_list_webhook_receipts') return listWebhookReceipts(env).then((response) => response.json());
  if (name === 'openwa_send_message') {
    const payload: MessageInput = { phone_number_id: args.phone_number_id, to: args.to, type: 'text', text: { body: args.text } };
    const request = new Request('https://mcp.local/v1/messages', { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(payload) });
    return (await createMessage(request, env, principal)).json();
  }
  throw new Error('Unknown tool');
}
