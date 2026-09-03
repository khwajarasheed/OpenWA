# Cloudflare-Native WhatsApp Business Platform Architecture

## Executive summary

Build CORE as a single-tenant, customer-owned Cloudflare application using one Worker for the public API and Meta webhooks, D1 as the authoritative relational store, Cloudflare Queues for durable asynchronous work, a Durable Object per WhatsApp phone number for dispatch/rate control, R2 for media, and KV only for stale-tolerant cache/configuration.

The recommended architecture is a queue-backed D1 design. It is suited to the agreed SMB baseline: sustained tens of messages per second plus bursts. CORE remains standalone, fully open source under AGPL-3.0. Future PREMIUM capabilities use a hybrid extension: managed identity/licensing/UI control plane, but a separately licensed Worker extension running in the customer’s own Cloudflare account. Messaging, contacts, CRM, workflow state, integration credentials, and AI inputs remain in that account.

The sovereignty claim must be precise:

> We do not receive, proxy, persist, or process your WhatsApp message and contact data on infrastructure operated by us. Message data travels directly between Meta, your Cloudflare account, and authorized user devices or customer-configured destinations.

Do not say that data “never leaves your infrastructure”: Meta necessarily handles it, and Cloudflare executes and stores it in the customer’s account.

Cloudflare figures in this document are a snapshot as of 2 September 2026 and must be revalidated before marketing or contracting.

---

## 1. CORE architecture options

### Option A — Queue-backed D1 with per-number Durable Objects

**Recommended.**

```text
Meta ──webhook──> Worker ──> shared jobs Queue ──> D1/R2
                         200 immediately

Client ──send API──> Worker ──> D1 outbox ──> shared jobs Queue
                                                   │
                                      Phone-number DO
                                      rate/order control
                                                │
                                                v
                                           Meta API
                                                │
                                status webhook ──> D1
```

| Cloudflare primitive | Responsibility |
|---|---|
| Worker | Webhook verification, API, authorization, validation, Meta adapter, queue consumer, health endpoints, repair jobs |
| D1 | Contacts, conversations, messages, status history, templates, API principals, idempotency records, outbox, delivery attempts, audit records |
| Queues | A shared v1 jobs queue for validated inbound events, outbound dispatch, media retrieval, and template sync; a separate DLQ for exhausted retries. Split workloads at higher volume. |
| Durable Objects | One object per phone number for token-bucket control, backoff, recipient pacing, and dispatch serialization |
| R2 | Media, exports, and optionally short-lived raw webhook archives |
| KV | Optional capability/public-key/config cache; never correctness-critical state |

Meta webhook POSTs are authenticated using `X-Hub-Signature-256` and the customer’s Meta app secret. A valid payload is queued before returning `200`. Treat webhook and queue delivery as at-least-once: deduplicate inbound messages by Meta message ID; retain status-event history separately and only advance the projected state through allowed, timestamp-aware transitions.

Outbound requests create a message and transactional D1 outbox record, then return `202 Accepted`. Queueing happens after commit. A scheduled sweeper repairs the non-atomic D1-to-Queue handoff.

The Durable Object maintains configurable per-number and per-recipient limits, responds to Meta throttle responses, and applies jittered backoff. Permanent policy/template/recipient errors go terminal; transient failures retry.

Do not promise exactly-once outbound delivery. If an outbound request reaches Meta but the response is lost, retrying can duplicate a customer message unless Meta provides a documented idempotency guarantee. Mark this as `send_unknown`, wait for a status webhook, and only retry under an explicit customer policy.

Stream media between Meta and R2 instead of buffering it in Worker memory. Use opaque R2 keys and authenticated, short-lived CORE download URLs.

**Strengths**

- Fast, reliable webhook acknowledgement.
- Queue retries and DLQs isolate outages.
- D1 enables straightforward conversation and CRM-style queries.
- Per-phone Durable Objects fit Meta’s per-number throttling model.
- A single Worker project supports guided deployment.

**Risks**

- D1, Queues, and Durable Objects each have independent billing meters.
- D1 and Queues have no shared transaction, requiring the repairable outbox.
- One D1 database is a write and size boundary.
- One phone-number Durable Object is a coordination point; validate burst headroom before promising high-throughput operation.
- Local owner PBKDF2 runs in the first-party browser and the Worker stores/compares only a digest of the derived verifier. This avoids spending the Workers Free CPU allowance on password stretching, while preserving an offline work factor if D1 is copied. Treat the verifier as password-equivalent authentication material and validate the complete browser/TLS/session flow before production release.

### Option B — Minimal Worker, D1, R2, and Cron

```text
Meta/client ──> Worker ──> D1/R2 ──> Meta
                          │
                       Cron retry
```

The Worker validates and persists webhooks synchronously. D1 contains due jobs and a scheduled trigger polls them. R2 stores media; KV is optional.

**Strengths:** least infrastructure and appropriate for constrained development/test installations.

**Risks:** webhook availability is tied to D1; Cron is poor for fine-grained retries; concurrency-safe rate control is awkward; D1 polling consumes writes/reads; and `waitUntil()` is not durable work—Cloudflare caps it at 30 seconds and recommends Queues for durable asynchronous processing. This should be a development/lite profile only, not the production default.

### Option C — Durable Object actor model with distributed storage

Each phone number or conversation is a SQLite-backed Durable Object holding sequencing, state, and alarms. D1 becomes a directory/eventual read projection; R2 holds media.

**Strengths:** local strong consistency, horizontal write isolation, natural sequencing.

**Risks:** cross-conversation inbox/search/reporting requires eventual projections; dual state requires replay and repair; object storage/requests/duration are separately billed; each object is single-threaded; and upgrades/backups are substantially more complex.

Use this only if measured D1 write limits are the actual bottleneck. It is too complex for the initial standalone release.

### Recommendation and prototypes

Adopt Option A. Keep D1 authoritative and Durable Objects limited to ephemeral coordination. Validate before commitment:

1. D1 write amplification under realistic messages, statuses, and indexes.
2. Per-number DO burst performance and cost.
3. Meta ambiguous-send behavior and the `send_unknown` policy.
4. Guided deployment of Worker, D1, R2, Queues, DLQ, DO migrations, secrets, and D1 migrations.

---

## 2. Cloudflare limits and honest cost boundary

### Free-tier boundary

Current relevant allowances include:

- Workers: 100,000 requests/day, 10 ms CPU/request, 128 MB memory.
- D1: 5 million rows read/day, 100,000 rows written/day, 500 MB/database, 5 GB/account.
- Queues: 10,000 operations/day and 24-hour retention.
- Durable Objects: 100,000 requests/day, 13,000 GB-seconds/day, 5 million row reads/day, and 100,000 row writes/day.
- R2 Standard: 10 GB-month storage, 1 million Class A operations/month, 10 million Class B operations/month, no egress charge.
- KV: 100,000 reads/day but only 1,000 writes/day; reads are eventually consistent.

A successfully consumed Queue message normally costs write, read, and delete: three operations. The free Queue allowance therefore represents fewer than 3,334 queue messages/day before retries, while a full WhatsApp lifecycle can create several queued items. D1 writes likewise amplify through message rows, status rows, indexes, outbox state, and audit events.

Therefore:

- “Near-zero infrastructure cost” is defensible for evaluation and light production use.
- “Free at any SMB scale” is not defensible.
- Production documentation should recommend Workers Paid before an exhausted quota can interrupt support.
- CORE must expose quota telemetry and warning thresholds.

### Paid-tier boundary

Workers Paid currently starts at $5/month and includes 10 million Worker requests and 30 million CPU milliseconds. Important current overage rates:

| Product | Included on Paid | Overage |
|---|---:|---:|
| Workers requests | 10m/month | $0.30/million |
| Workers CPU | 30m CPU-ms/month | $0.02/million CPU-ms |
| D1 reads | 25bn rows/month | $0.001/million |
| D1 writes | 50m rows/month | $1.00/million |
| D1 storage | 5 GB | $0.75/GB-month |
| Queues | 1m operations/month | $0.40/million |
| DO requests | 1m/month | $0.15/million |
| DO duration | 400,000 GB-s/month | $12.50/million GB-s |
| DO SQLite storage | 5 GB-month | $0.20/GB-month |
| R2 Standard storage | 10 GB-month free allocation | $0.015/GB-month |
| R2 Class A/B | 1m/10m free allocation | $4.50/$0.36 per million |

Estimate cost from observed amplification, not just messages:

```text
Worker requests = client API + Meta webhooks + media/API retrieval + reads
Queue operations = queued items × (write + delivery/retries + delete/DLQ)
D1 writes = message rows + status events + indexes + outbox/attempts + audit
R2 = retained media GB-month + PUT/GET operations
```

Meta charges are billed directly between Meta and the customer. CORE adds no surcharge and must never rebill them.

### Platform safeguards

- D1 has a hard 10 GB/database ceiling on Paid; indefinite history requires capacity alerts, export/archive, and eventual database rotation.
- Each D1 database is single-threaded. Index all list/filter paths and instrument `rows_read`/`rows_written`.
- Queue messages are limited to 128 KB: queue compact identifiers, not large raw content.
- Workers have 128 MB memory and six simultaneous outgoing connections per request: stream media and cap fan-out.
- KV must not hold idempotency, message state, or rate counters.
- D1 read replicas are asynchronous and require Session semantics for read-after-write paths.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

---

## 3. Deployment and secret handling

### Meaning of “one-click deploy”

One-click infrastructure deployment is achievable, but complete WhatsApp activation is not: customers must still authorize Cloudflare, supply their own Meta assets/credentials after deployment, and register the callback URL with Meta. The honest promise is one-click infrastructure followed by guided in-dashboard Meta onboarding.

Cloudflare’s Deploy Button can clone a public GitHub/GitLab repository, configure a Worker, provision declared bindings, build, deploy, and run D1 migrations. Keep the distributable as one isolated Worker project because Deploy Button support for monorepos and multiple Worker apps is limited.

### Deployment paths

1. **Deploy Button:** default community path; the customer authenticates directly with Cloudflare, keeps the preselected resources, and deploys without entering OpenWA or Meta variables.
2. **Wrangler installer:** advanced operator path using Cloudflare OAuth where possible; creates resources, applies migrations, deploys, and directs the operator to the same first-run dashboard.
3. **Terraform plus Wrangler:** enterprise path; Terraform owns durable resource configuration, Wrangler deploys Worker/migrations. Secrets must come from customer CI secrets or interactive input, never Terraform state.

### Least-privilege Cloudflare access

If OAuth cannot be used, request only scoped account permissions for Workers Scripts Write, D1 Edit, Queues Edit, R2 Write, required DO deployment permissions, and optional KV Write. Add zone-level DNS/Routes access only for a customer-selected custom domain. Restrict to one account, use expiry/IP conditions where available, and let customers delete the bootstrap token afterward. Verify live permission names during implementation against [Cloudflare’s permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

### Customer secrets

The default deployment has no customer-entered Worker secret. On first use, an installation-scoped Durable Object generates the credential-encryption key and webhook verification token inside the customer’s account. The encryption key is never returned to the browser. After local owner creation, the owner enters the WABA ID, system-user token, and app secret in the self-hosted dashboard. CORE discovers phone numbers from Meta, lets the owner select one, subscribes the app to the WABA, and encrypts the access token and app secret before D1 persistence.

Optional legacy/operator variables may provide Meta credentials, a webhook token, a bootstrap API token, or a pinned Graph version, but they are not part of the Deploy Button path. Credentials never traverse vendor infrastructure, Git, plaintext configuration, logs, or diagnostics.

One installation supports one WABA with multiple phone numbers. The v1 connection uses the Meta app-level callback verified during onboarding plus a plain WABA subscription; per-WABA callback overrides and many-WABA agency tenancy are out of scope.

### Data location

Offer automatic placement or an available jurisdiction at creation time. D1 jurisdictions cannot be changed later. D1 jurisdiction constrains database storage/execution, not every Worker processing location or log destination. Do not make broad residency claims from D1 selection alone. See [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/).

---

## 4. CORE/PREMIUM boundary

### Principles

- CORE is complete and usable without a vendor account, callback, telemetry, or PREMIUM dependency.
- The versioned CORE API is the only supported data-plane contract for PREMIUM and third parties.
- PREMIUM never gets database credentials or authorization bypasses.
- Premium cancellation/outage cannot stop core messaging.
- Customers explicitly authorize every export destination.

### CORE API

Publish a versioned JSON/OpenAPI contract under `/v1`:

| Area | Operations |
|---|---|
| System | health, readiness, version, capabilities, quota/storage status |
| Messages | send supported text/template/interactive/media, get/list, attempts/status history, retry/cancel where safe |
| Contacts | create/update/get/list and consent metadata |
| Conversations | list/get and cursor-paginated messages/window metadata |
| Templates | list/get/sync/create/update/delete where Meta permits |
| Media | authenticated upload, metadata, streamed retrieval, deletion |
| Events | subscriptions, filters, replay, delivery attempts/DLQ |
| Administration | principals, tokens, retention, exports/deletion, audit |

Use cursor pagination, UTC timestamps, stable internal IDs alongside Meta IDs, correlation IDs, structured errors, and `Idempotency-Key` for client submissions. Make additive API changes compatible; introduce new major paths for breaking changes.

Stable events include `message.received`, `message.queued`, `message.submitted`, `message.sent`, `message.delivered`, `message.read`, `message.failed`, `message.send_unknown`, `contact.updated`, `template.updated`, and `conversation.updated`.

Outbound webhooks are disabled by default. Customers choose destination, filters, fields, redaction, and signing secret. Enabling one intentionally transfers selected data outside their Cloudflare account and must be disclosed in the UI.

### Authentication

**Standalone clients:** opaque, random 256-bit bearer tokens. Store SHA-256 digests, scopes, optional IP restrictions, expiry, and revocation. Suggested scopes: `messages:send`, `messages:read`, `contacts:read/write`, `templates:read/write`, `events:manage`, `admin`.

**Premium UI:** browser calls the customer CORE endpoint directly. A managed identity service issues short-lived, audience-bound JWTs; CORE pins issuer/JWKS and maps subjects/groups to local roles. Use Authorization Code + PKCE, short access tokens, narrow CORS, and no browser-held long-lived CORE credential. Disabling managed trust leaves standalone principals working.

**Premium extension:** runs in the customer account and uses a Cloudflare Service Binding plus explicit local service-principal capabilities. It calls the managed control plane only for entitlement/version/identity/billing/payload-free health data. Outbound schemas must prohibit message content, contacts, media, credentials, workflow variables, and arbitrary payloads.

### Hybrid PREMIUM data flow

| Component | Runs where | May store |
|---|---|---|
| Premium static UI | Managed CDN and user browser | Public assets; browser receives authorized CORE data directly |
| Identity/subscription/entitlement | Vendor control plane | Organization/user IDs, roles, billing, plan, endpoint/version |
| Premium Worker extension | Customer Cloudflare account | CRM fields, assignments, workflow state, integration configuration |
| Premium D1/R2 | Customer Cloudflare account | Inbox indexes, CRM/workflow history, local AI data |
| Integrations | Customer extension | Customer data, then only to customer-authorized third parties |

Use a separate premium Worker and D1 database connected through the published API/service binding. Legal counsel must review whether this separation adequately preserves the AGPL/proprietary-extension boundary.

---

## 5. Data model and multi-tenancy

### CORE entities

- `installation`: instance/schema/API version and configuration
- `business_account`: WABA identifiers and sync state
- `phone_number`: Meta ID, display number, quality/capacity metadata
- `contact`: WhatsApp ID, profile fields, consent data
- `conversation`: contact/phone pairing and service-window/activity projection
- `message`: internal/Meta IDs, direction, type, timestamps, current status, context link
- `message_content`: normalized body/template/interactive fields and R2 media references
- `message_status_event`: immutable status history and Meta diagnostic codes
- `send_attempt`, `outbox_job`, `webhook_receipt`
- `template`, `template_version`
- `api_principal`, `api_token`
- `event_subscription`, `delivery_attempt`
- `audit_event`, `export_job`, `deletion_job`, `schema_migration`

Use normalized, indexed identifiers/status/timestamps. Keep unknown Meta fields in versioned JSON extension fields, not as the primary query model.

The agreed default is indefinite message and media retention. Setup and diagnostics must warn that this is not indefinitely free: operators need capacity alerts, export, deletion, archive, and eventual D1 rotation plans. Customers can later select shorter retention or disable selected content storage.

### Standalone and PREMIUM modes

Standalone CORE requires no vendor account, sends no vendor telemetry, syncs templates directly with Meta, and uses only locally managed credentials. Updates come from the public repository; exports/deletes remain local.

With PREMIUM, messaging remains the CORE system of record. Premium-specific records live in separate customer-owned D1/R2 resources and reference CORE IDs. Managed control-plane storage is limited to tenant identity, subscription/entitlements, endpoint/version/capability metadata, and opt-in payload-free health signals. Do not build a shared managed messages/contacts table.

---

## 6. Licensing model

### Recommendation: AGPL-3.0-only for CORE

AGPL is genuine open source and requires a modified network service to offer its corresponding source to its users. It fits a self-hosted API product better than GPL-only. See [GNU’s AGPL explanation](https://www.gnu.org/licenses/why-affero-gpl.html.en).

Apply AGPL to CORE, migrations, deployment scripts, standalone tooling, and core documentation/examples. License PREMIUM under a separate commercial/proprietary license and keep it in separate packages, Worker deployments, schemas, and repositories where practical.

| License | Benefit | Competitive exposure |
|---|---|---|
| AGPL-3.0 | Open source with network reciprocity | Competitors can host/sell compliant forks, including unmodified CORE |
| Apache-2.0 | Maximum adoption and commercial embedding | Competitors can close, rebrand, and resell modifications |
| BSL 1.1 | Can restrict competitive production use | Not open source before conversion; conflicts with the stated promise |

AGPL is not an anti-resale license. Differentiation must be premium execution, integrations, support, brand, and trademark. Add a trademark policy and DCO or narrowly scoped contribution process. Obtain legal review for AGPL interaction with the proprietary extension.

---

## 7. Compliance posture

Self-deployment does not make the customer or product automatically GDPR, HIPAA, SOC 2, ISO 27001, DPDP, PCI, or sector compliant.

### Vendor responsibilities

- Secure SDLC, code review, threat modeling, testing.
- Dependency controls, SBOMs, provenance, vulnerability response.
- Signed/reproducible releases, upgrade/migration documentation.
- Secure defaults for secrets, signature validation, authz, auditability.
- Security policy, disclosure intake, supported-version/CVE process.
- Accurate operations, deletion, backup, and incident documentation.
- No embedded telemetry/vendor callbacks by default.

### Customer responsibilities

- Meta/Cloudflare contracts, account security, IAM, and token rotation.
- Legal basis, notices, opt-in/out, template and WhatsApp policy compliance.
- Retention, deletion, export, legal hold, backup/recovery.
- Jurisdiction choices and regional validation.
- Monitoring, incident response, capacity planning, updates.
- Security review of every configured integration/webhook destination.

### Shared/conditional responsibilities

Vendor support becomes a data-processing event if it receives customer logs or exports. PREMIUM remains responsible for personal/account metadata in its control plane. Meta and Cloudflare remain independent vendors. Custom customer extensions can invalidate reference security assumptions.

No formal compliance claim is currently supportable without facts on operating countries, industries, certifications, support workflow, premium subprocessors, logs/telemetry, and contractual roles. Legal/compliance review is required before launch.

---

## 8. Phased roadmap

### Phase 0 — Risk prototypes

- Signed webhook → Queue → D1 deduplication → outbound Queue → phone DO → Meta → status reconciliation.
- D1 write amplification/query testing with realistic payloads/statuses/indexes.
- Dispatch rate control, Meta throttling, queue retries, unknown outcomes.
- Full guided deployment, migration, secret, failure, and upgrade path.
- Meta-to-R2 streaming under Worker limits.
- Browser-direct premium proof showing vendor backend never receives payloads.

### Phase 1 — Standalone walking skeleton

- Guided Cloudflare deployment and local workflow.
- One WABA, multiple numbers.
- Meta verification/signature validation.
- Inbound text plus outbound text/template.
- D1 contacts/conversations/messages/statuses/idempotency/audit.
- Queue retries/DLQ/outbox repair and per-number rate control.
- Scoped API credentials and health/quota endpoints.
- Template list/sync, export/delete, diagnostics, OpenAPI docs.

Acceptance: a customer deploys without vendor contact, uses its own Meta credentials, exchanges messages, handles duplicate/transient events safely, and can remove/export its data.

### Phase 2 — Complete CORE contract

- Stable API/version policy and contract tests.
- Indexed pagination/query support and agreed media/message types.
- Template mutations and event subscriptions with signing/replay.
- OIDC/JWT trust, local roles, extension service principals.
- Retention, lifecycle, export/delete, capacity warnings.
- Upgrade, migration, backup/restore, rollback, support bundles.
- Security review, SBOM, signing, release process.

### Phase 3 — Premium foundation

- Managed organization/identity/billing/entitlement control plane.
- Customer-deployed premium extension plus premium D1/R2.
- Browser-direct UI; local team inbox, CRM, workflows.
- Opt-in payload-free health/version reporting.
- Premium expiry disables premium features without interrupting CORE.

### Phase 4 — Premium integrations and advanced capabilities

- Customer-authorized commerce/CRM/helpdesk adapters running in the customer account.
- Local encrypted credential storage and customer-account OAuth callbacks.
- Workflow tooling/versioning.
- AI only after separate data-flow, provider, retention, consent, and cost approval.

### Explicitly out of scope for v1

- Managed hosting/proxying of CORE.
- Many-WABA/agency tenancy.
- Team inbox, CRM, workflows, integrations, AI.
- Embedded Signup/BSP operation.
- Bulk campaigns, catalog/payments/Flows/calling/omnichannel.
- Active-active multi-region writes, unlimited storage, automatic transparent sharding.
- Exactly-once delivery and formal compliance certification.

---

## 9. Test and acceptance strategy

### Functional

- Every supported inbound payload, status transition, and outbound error classification.
- Template lifecycle, pagination, multiple phone numbers, API/event compatibility.

### Reliability

- Duplicate, late, reordered, malformed, oversized, forged webhooks.
- Failure between D1 commit and Queue write.
- Queue duplicate/retry exhaustion, Meta 429/5xx/timeouts, D1 overload, queue backlog, R2/DO failures.
- DLQ replay/repair with no duplicate local state.
- Free-tier quota exhaustion produces degraded readiness rather than silent loss.

### Security

- Signature bypass/replay, token brute force, scope escalation, IDOR, injection, pagination abuse.
- Secret/log/support-bundle redaction.
- JWT issuer/audience/key rotation and CORS failures.
- Outbound-webhook SSRF controls, signing, allowlisting, credential rotation.
- Dependency/SBOM/provenance/release checks.

### Capacity and sovereignty

Measure full lifecycle cost, p50/p95/p99 latency, queue backlog age, D1 rows read/written, DO duration, R2 operations/storage, and retry rates at sustained tens of mps plus bursts. Verify standalone CORE contacts only Meta, customer Cloudflare resources, and explicitly enabled destinations; verify PREMIUM browser traffic goes directly to customer CORE and no message/contact fields exist in the managed control-plane schema/logs.

---

## 10. Assumptions, open questions, and confidence

### Established decisions

- SMB baseline: sustained tens of messages/second with burst buffering.
- Single customer installation, one WABA, multiple phone numbers.
- Indefinite message/media retention by default.
- AGPL-3.0 CORE.
- Hybrid premium extension in the customer Cloudflare account.
- No managed persistence or proxying of message/contact data.
- Customer supplies Meta assets/credentials and pays Meta/Cloudflare directly.

### Questions before implementation

1. Target countries, industries, and compliance obligations?
2. Required v1 message types beyond text/templates/basic media?
3. Is WhatsApp Business App coexistence required?
4. Required RPO/RTO and acceptable backup/restore model?
5. Archive/rotation policy as D1 approaches 10 GB?
6. Standalone administrative identity model beyond API tokens?
7. Is a custom domain required, or is `workers.dev` acceptable?
8. Must production run entirely on Free, or may it require Workers Paid?
9. Automatic-retry policy for ambiguous Meta sends?
10. Supported Meta Graph API versions and deprecation policy?
11. Raw webhook retention/debugging policy?
12. Required consent/opt-in records?
13. Permitted telemetry/log exports?
14. Managed identity provider and local role mapping?
15. Offline premium-entitlement grace period?
16. Support policy for customer-modified CORE?
17. Contribution process and trademark policy?

### Confidence

- **High:** Worker + Queue + D1 + R2 is appropriate for the SMB target; KV is not suitable for correctness-critical state.
- **Medium:** per-phone Durable Object dispatch control; requires measured burst/cost validation.
- **Medium:** Deploy Button provisioning is viable but the reduced jobs-queue/DLQ resource mapping, all migrations, and first-owner flow still need a fresh-account spike.
- **Medium:** D1 can meet baseline needs with proper indexes; write amplification and indefinite retention are unmeasured.
- **Low without legal review:** AGPL/proprietary extension separation and contribution terms.
- **Low without organizational facts:** formal privacy/security/regulatory claims.
- **Inherent limitation:** exactly-once outbound delivery cannot be promised without a Meta-supported idempotency guarantee for ambiguous requests.

## Recommended next step

Prototype the complete reliability loop on a customer-owned Cloudflare test account: signed Meta webhook → Queue → deduplicated D1 state → outbound Queue → per-number Durable Object → Meta → status reconciliation. Measure duplicate behavior, ambiguous sends, D1 write amplification, latency, and Cloudflare cost per full message lifecycle before production implementation.
