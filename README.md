# OpenWA CORE

> Pre-release software. Do not use it for production customer data until Cloudflare/Meta integration and Cloudflare Access provisioning have been validated in a dedicated test account.

OpenWA CORE is a self-deployable WhatsApp Business API for a customer-owned Cloudflare account. It connects directly to the customer’s Meta Cloud API credentials; it does not broker messages or add a charge to Meta message costs.

This repository provides signed Meta webhook ingress, D1 contact/conversation/message storage, queue-backed outbound dispatch, per-phone rate coordination through Durable Objects, text/template send APIs, template synchronization, local API tokens, a self-hosted dashboard, and guided WhatsApp connection onboarding.

## Data flow

```text
Meta webhook -> signed Worker endpoint -> Queue -> D1
CORE API -> D1 outbox -> Queue -> phone Durable Object -> Meta API
Meta status webhook -> Queue -> D1 status-event history
```

CORE intentionally uses at-least-once processing. Incoming webhook deliveries are deduplicated. Outbound sends are not claimed to be exactly once: a network failure after Meta receives a request is stored as `send_unknown` rather than blindly retransmitted.

## One-click customer deployment

Publish this repository to a public GitHub or GitLab location and put a **Deploy to Cloudflare** button on the OpenWA website. Cloudflare creates a copy in the customer’s Git account, provisions the D1/R2/Queues/Durable Objects in the selected Cloudflare account, and deploys the Worker. The customer does not download the repository or run a terminal command.

After the public repository URL is known, replace `<owner>` below and use this button on the project site:

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<owner>/OpenWA)
```

The Deploy screen must collect only these installation settings:

- `CREDENTIAL_ENCRYPTION_KEY`: a unique random value of at least 32 characters. It is a Cloudflare Worker secret used only to encrypt Meta credentials in the customer’s D1 database.
- `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN`: the values for the Cloudflare Access application that protects the OpenWA dashboard.

After deployment, the customer opens the Worker URL. The first authenticated Cloudflare Access identity claims the `super_admin` role. The dashboard then guides the customer through entering and validating their Meta WABA, phone-number ID, access token, and app secret. Those Meta credentials are encrypted locally before D1 storage and are not sent to OpenWA-operated infrastructure.

The dashboard displays the callback URL and verification token for Meta. The customer completes the remaining Meta-owned action: register the callback, enter the verification token, and subscribe the app to the WABA. If the saved connection is already valid, the setup checklist is replaced with a Connected view.

> Cloudflare Access provisioning is still a release gate. A standard Deploy Button provisions Workers resources but does not currently prove automatic creation of an Access policy or hand the deployer identity to Worker code. Do not market the flow as fully one-click identity provisioning until it has been validated in a fresh Cloudflare account.

## Advanced operator deployment

For development or advanced operators only, Wrangler can still provision and deploy from a terminal:

```bash
npm install
npm run setup
```

Do not put Meta tokens in Git, Terraform state, plaintext variables, or vendor-operated setup services.

## Local development and validation

```bash
cp .dev.vars.example .dev.vars
npm install
npm run check
npm test
npm run dev
```

The Worker needs remote Cloudflare bindings for integration tests. Local tests should cover pure validation/auth/signature behavior; a Cloudflare test account verifies queues, D1, R2, and Durable Objects together.

GitHub Actions runs the same type check, unit tests, and a Wrangler dry-run on every pull request and push to `main`.

It also runs for pushes to `master` while the repository is being initialized.

## Preparing a test push

```bash
git add .
git status
git commit -m "Initial OpenWA CORE test release"
git branch -M main
git remote add origin <your-github-repository-url>
git push -u origin main
```

Before committing, confirm that `.dev.vars`, `.env`, private keys, Cloudflare tokens, Meta access tokens, and customer webhook payloads are absent from `git status`. The included `.gitignore` protects common local secret and build files, but it cannot remove a secret that was already committed.

## API

All `/v1` endpoints require `Authorization: Bearer <token>`. Initially use `BOOTSTRAP_ADMIN_TOKEN`, then mint scoped tokens via `POST /v1/admin/tokens`.

| Endpoint | Scope | Purpose |
|---|---|---|
| `GET /health`, `GET /ready`, `GET /version` | none | Liveness, dependency readiness, version |
| `GET /v1/capabilities` | none | Supported CORE capabilities and explicit Phase 1 limits |
| `POST /v1/messages` | `messages:send` | Queue a text or template message |
| `GET /v1/messages`, `GET /v1/messages/:id` | `messages:read` | Inspect messages/status events |
| `GET /v1/contacts`, `GET /v1/contacts/:id` | `messages:read` | Inspect locally stored contacts |
| `GET /v1/conversations` | `messages:read` | List local conversations |
| `GET /v1/templates` | `templates:read` | List locally synchronized templates |
| `POST /v1/templates/sync` | `templates:write` | Queue Meta template synchronization |
| `POST /v1/admin/tokens` | `admin` | Mint a scoped token |
| `GET /v1/admin/export` | `admin` | Download a bounded local JSON export |
| `DELETE /v1/admin/data` | `admin` | Delete D1/R2 customer data; requires an explicit confirmation header |
| `GET /v1/dashboard/state` | Cloudflare Access | Read dashboard installation and connection state |
| `PUT /v1/dashboard/connection` | Cloudflare Access admin | Validate Meta credentials and store encrypted local connection settings |

Example text send:

```bash
curl -X POST "https://<core-host>/v1/messages" \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: order-10042-confirmation" \
  -H "Content-Type: application/json" \
  --data '{
    "phone_number_id": "<meta-phone-number-id>",
    "to": "15551234567",
    "type": "text",
    "text": { "body": "Your order is confirmed." }
  }'
```

## Operational notes

- Workers Queues and D1 have hard free-tier quota failures. Monitor usage and use a paid plan for production.
- D1 is the system of record and has a 10 GB per-database paid-tier limit. The current default is indefinite content retention, so capacity controls, export, and archival are required before large-scale operation.
- The current rate defaults are conservative: 60 ms between sends per phone number and one second per recipient. They are intentionally not a substitute for reading current Meta rate-limit behavior.
- Message content remains in the customer Cloudflare account. It still travels through Meta and Cloudflare; do not claim absolute data locality without separately configuring and validating Cloudflare data-localization controls.
- To erase the installation's retained customer data, call `DELETE /v1/admin/data` with `X-Confirm-Installation-Deletion: DELETE`. This does not delete Cloudflare resources or Worker secrets; the account owner controls those separately.

## Phase 1 gaps still requiring implementation/validation

- R2 media ingestion and upload API.
- Outbox sweep deduplication and exponential schedule persistence.
- Template pagination and mutation endpoints.
- Event subscriptions, export/delete jobs, quota telemetry, API-key management UI, and full team-user management.
- Full automated Worker integration test suite against a Cloudflare test account.
- Meta end-to-end webhook and outbound delivery validation.

See [whatsapp-platform-architecture.md](./whatsapp-platform-architecture.md) for the approved architecture and roadmap. Read [CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md), and [LICENSE.md](./LICENSE.md) before contributing or redistributing the project.

Use [the Phase 1 acceptance runbook](./docs/phase-1-acceptance.md) for the required Cloudflare/Meta test-account validation before treating an installation as deployable.
