# Phase 1 acceptance runbook

Run this only in a dedicated customer-owned Cloudflare test account and Meta test WABA. Do not use a production phone number or token while validating the walking skeleton.

## Deployment gate

1. Install dependencies and run `npm run check`, `npm test`, and `npx wrangler deploy --dry-run`.
2. Create D1, R2, the three work queues, and DLQ as described in the root README.
3. Apply the migration, configure the WABA ID/phone-number allowlist, set all four Worker secrets, and deploy.
4. Confirm `GET /health`, `GET /ready`, and `GET /version` each return `200`.
5. Register the deployed `/webhooks/meta` URL in Meta. A valid `hub.challenge` must return `200`; a wrong verification token must return `403`.

## Security gate

1. Send a synthetic POST with no `X-Hub-Signature-256`; expect `401`.
2. Send a payload signed with a different app secret; expect `401`.
3. Call `GET /v1/messages` with no bearer token; expect `401`.
4. Use the bootstrap admin token to create a `messages:read` principal. Confirm it can read messages but receives `401` for `POST /v1/messages`.
5. Confirm the one-time response containing a newly minted API token is not logged by the deployment or CI system.

## Inbound-message gate

1. Send a WhatsApp message from an allowed test contact to the Meta test number.
2. Confirm Meta receives a `200` acknowledgement.
3. Confirm one Queue delivery is processed and D1 contains one contact, one conversation, and one inbound message.
4. Replay the identical signed webhook. Confirm there is still one message for the Meta message ID.
5. Send a delivery/status payload twice and out of order. Confirm the event ledger deduplicates it and a late `failed` state cannot replace `delivered` or `read`.

## Outbound-message gate

1. Submit a text message through `POST /v1/messages` with a unique `Idempotency-Key`; expect `202` and `queued`.
2. Repeat exactly the same request/key; expect the same message ID and `idempotent: true`.
3. Confirm an outbound job is queued, dispatched through the phone Durable Object, and becomes `submitted` after Meta accepts it.
4. Confirm Meta status webhooks advance the stored message through sent/delivered/read.
5. Submit a request with an unconfigured phone number, invalid recipient ID, no key, and an oversized text; each must fail with `422`.
6. Create a controlled transient Meta failure and confirm Queue retry/DLQ behavior. Create an ambiguous network outcome and confirm the message is `send_unknown`, not automatically duplicated.

## Template and retention gate

1. Call `POST /v1/templates/sync` with a `templates:write` principal.
2. Confirm templates from the customer WABA appear in `GET /v1/templates`.
3. Call `GET /v1/admin/export` as admin and inspect the local JSON response for contacts, conversations, messages, and templates.
4. In the disposable environment only, call `DELETE /v1/admin/data` without the confirmation header; expect `428`.
5. Repeat with `X-Confirm-Installation-Deletion: DELETE`; confirm D1 customer records and objects in the dedicated R2 bucket are removed. Confirm Worker secrets and Cloudflare resources remain for operator-controlled teardown.

## Operational gate

1. Record Worker requests, D1 rows read/written, Queue operations/backlog, Durable Object requests/duration, and R2 operations/storage for the test lifecycle.
2. Force or simulate free-tier quota exhaustion and confirm readiness/operational monitoring identifies it before message loss.
3. Record p50/p95/p99 webhook acknowledgement latency and outbound submission latency.
4. Confirm all observed outbound network traffic is Meta, customer Cloudflare resources, or deliberately configured destinations; CORE must not call vendor infrastructure.

Phase 1 is deployable only after every applicable gate passes in a real customer-owned Cloudflare/Meta test account.
