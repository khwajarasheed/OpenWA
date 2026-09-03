# Phase 1 acceptance runbook

Run this only in a dedicated customer-owned Cloudflare test account and Meta test WABA. Do not use a production phone number or token while validating the walking skeleton.

## Deployment gate

1. In the source repository, run `npm run check`, `npm test`, and `npm run deploy -- --dry-run`.
2. From a fresh GitHub and Cloudflare test account, use the README's Deploy to Cloudflare button. Do not clone the repository or pre-create resources.
3. Confirm the deployment screen requests no OpenWA variable, encryption key, Meta credential, WABA ID, or phone-number ID.
4. Keep the generated D1 database, R2 bucket, jobs queue, dead-letter queue, and Durable Object bindings selected. Leave whole-Worker Cloudflare Access protection off so Meta can reach `/webhooks/meta`. Confirm all three D1 migrations run and the Worker deploys without a partially updated trigger error.
5. Confirm the deployment result presents a clickable Worker URL. Confirm `GET /health`, `GET /ready`, and `GET /version` each return `200`.
6. Open the Worker URL, create the local owner, and enter the dashboard without setting up Cloudflare Access or running a command.
7. Register the displayed `/webhooks/meta` URL and verification token in Meta and select the `messages` field. A valid `hub.challenge` must return `200`; a wrong verification token must return `403`. Confirm the dashboard detects successful endpoint verification.
8. Enter a WABA ID, system-user token, and app secret in the dashboard. Confirm OpenWA lists the WABA's phone numbers, selects the sole result automatically or asks only when there are multiple, and subscribes the app to the WABA with the single connection action.
9. Confirm the dashboard reaches Connected without a refresh, hides onboarding, and leaves a working **Manage connection** action.

## Security gate

1. Before owner creation, confirm `GET /v1/dashboard/bootstrap` returns `initialized: false`; create the owner once and confirm a second setup request returns `409`.
2. Confirm the owner session cookie is `Secure`, `HttpOnly`, and `SameSite=Strict`. Log out and confirm that session can no longer read `/v1/dashboard/state`.
3. Confirm browser-side password derivation sends a 32-byte verifier rather than the plaintext password. Confirm D1 stores neither the password nor the verifier, only the verifier digest, random salt, and configured work factor.
4. Attempt login with an incorrect password; it must return a generic `401` response without revealing owner details.
5. Exceed the local failed-login threshold from one test address; confirm further attempts are blocked for the configured window without accepting another verifier.
6. Send a cross-origin dashboard mutation and a mutation without JSON content type; expect `403`.
7. Send a synthetic webhook POST with no `X-Hub-Signature-256`; expect `401`.
8. Send a webhook payload signed with a different app secret; expect `401`.
9. Call `GET /v1/messages` with no bearer token; expect `401`.
10. As the local owner, create the first API token from the dashboard. Confirm it is displayed once and not recoverable from D1 because only its digest is stored.
11. Use that administrator API token to create a `messages:read` principal. Confirm it can read messages but receives `401` for `POST /v1/messages`.
12. Confirm the one-time response containing a newly minted API token is not logged by the deployment or CI system.

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
