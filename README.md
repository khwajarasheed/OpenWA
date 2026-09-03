# ForgeScale Relay Core

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/khwajarasheed/OpenWA)

> Pre-release software. Do not use it for production customer data until the Deploy Button, local owner authentication, and Meta integration have been validated end to end in a dedicated test account.

ForgeScale Relay Core is a self-deployable WhatsApp Business API for a customer-owned Cloudflare account. It connects directly to the customer’s Meta Cloud API credentials; it does not broker messages or add a charge to Meta message costs.

This repository provides signed Meta webhook ingress, D1 contact/conversation/message storage, queue-backed outbound dispatch, per-phone rate coordination through Durable Objects, text/template send APIs, template synchronization, local API tokens, a self-hosted dashboard, and guided WhatsApp connection onboarding.

## Project website

The ForgeScale Relay project landing page lives in [`landing/`](./landing). It is a separate static Cloudflare Pages site operated by the project owner; customers do not deploy it. See [`landing/README.md`](./landing/README.md) for deployment settings.

## Data flow

```text
Meta webhook -> signed Worker endpoint -> jobs Queue -> D1
CORE API -> D1 outbox -> jobs Queue -> phone Durable Object -> Meta API
Meta status webhook -> jobs Queue -> D1 status-event history
```

CORE intentionally uses at-least-once processing. Incoming webhook deliveries are deduplicated. Outbound sends are not claimed to be exactly once: a network failure after Meta receives a request is stored as `send_unknown` rather than blindly retransmitted.

## One-click customer deployment

Click **Deploy to Cloudflare** above. Cloudflare creates a copy in your GitHub account, provisions D1, R2, Queues, and Durable Objects in your own Cloudflare account, then deploys the Worker. No local download, terminal, ForgeScale Relay secret, WABA ID, or phone-number ID is needed during deployment.

The deployment screen has no ForgeScale Relay variables for the customer to fill. Keep the automatically selected D1 database, R2 bucket, jobs queue, and dead-letter queue, leave **Protect with Cloudflare Access** off, then click deploy. Protecting the whole Worker would also block Meta's public webhook; path-specific Access can be added later. On first use, ForgeScale Relay generates an installation-only encryption key inside a customer-owned Durable Object. The key is not displayed, stored in Git, or sent to ForgeScale Relay infrastructure; it encrypts Meta credentials before they are stored in D1.

After deployment, click the deployed Worker URL, create the installation’s local owner account, and continue directly into the dashboard. A new installation opens with a safe, fully navigable sample workspace so customers can explore messages, contacts, conversations, templates, API access, activity, and data management before connecting WhatsApp. Password verification and sessions remain inside the customer’s Worker and D1 database. Meta credentials are encrypted locally before D1 storage and are not sent to ForgeScale Relay-operated infrastructure.

Create the owner immediately after a new deployment and do not share the uninitialized Worker URL. The first person to complete this one-time screen becomes the installation owner. Password recovery is not yet implemented in this pre-release version.

**Connect WhatsApp** remains available from the dashboard at all times. When real Meta activation is complete, ForgeScale Relay offers a one-time **Start with empty workspace** choice that removes only the supplied demo records and leaves the owner and live connection intact. The dashboard then becomes a normal clean production workspace.

Cloudflare Access can be added later as an optional outer security layer. It is not required for first-run onboarding.

## Updates

The Deploy Button creates a customer-owned copy of this repository and Cloudflare deploys commits pushed to that copy. The copied repository includes a **ForgeScale Relay upstream updates** GitHub Actions workflow, which checks once a day for published ForgeScale Relay releases.

The default **automatic** mode creates and merges an auditable pull request for releases whose `openwa-release.json` explicitly declares `compatibility: "patch"` and `auto_update: true`; Cloudflare then deploys the merge automatically. Customers do not need to use GitHub or a terminal for those safe updates. Major versions, migration-bearing releases, binding changes, or unmarked releases always become a review pull request instead. Customers who prefer approvals for every release can set the repository variable `OPENWA_UPDATE_MODE` to `review` once in GitHub.

Customers may set `OPENWA_UPSTREAM_REPOSITORY` once if they use an approved ForgeScale Relay fork. The workflow preserves the copied installation's `wrangler.jsonc`, so generated D1/R2/Queue bindings are never replaced by the portable source template. It has no access to WhatsApp content or Cloudflare credentials; GitHub Actions changes only the customer's own GitHub copy. Existing installations need this workflow added to their copied repository once; new Deploy Button installations receive it automatically.

Project maintainers publish versioned GitHub releases deliberately; see [the release policy](./docs/releasing.md). No release is eligible for automatic customer deployment unless the release manifest explicitly marks it as a backward-compatible patch with no migration work.

## Advanced operator deployment

For development or advanced operators only, Wrangler can still provision and deploy from a terminal:

```bash
npm install
npm run setup
```

Do not put Meta tokens in Git, Terraform state, plaintext variables, or vendor-operated setup services.

## Remove a test installation

The repository includes a guarded cleanup command for repeatable Deploy Button testing. First preview the exact resources read from `wrangler.jsonc`:

```bash
npm run cleanup
```

After checking the names, permanently remove them:

```bash
npm run cleanup -- --yes
```

The destructive command first asks Cloudflare for queues whose consumer or producer is the configured Worker, then removes only consumer IDs Cloudflare identifies as that Worker. It deletes those discovered Queue bindings together with the queues declared in `wrangler.jsonc`, then deletes the Worker (including its deployed bindings and Worker-owned Durable Objects), every object in the configured R2 bucket and the bucket itself, and the configured D1 database. Cloudflare requires an R2 bucket to be empty before it can be deleted, so the script handles that automatically with the current Wrangler credentials.

Only the Worker named by this deployment's `wrangler.jsonc`, queues Cloudflare directly identifies as bound to that same Worker, and its specific `DB`, `MEDIA`, `JOBS_QUEUE`, and `DEAD_LETTER_QUEUE` bindings are resolved; it does not search for resources by prefix. The script refuses to force-delete a Worker if Cloudflare reports that another project depends on it. The Git repository, the project-owner landing page, domains, and unrelated Cloudflare resources are not touched. The declarations in `wrangler.jsonc` intentionally remain because they are needed by the next deployment.

Deletion is irreversible. If the logged-in Wrangler user can access multiple accounts, add `--account-id <ACCOUNT_ID>`. For a jurisdictional R2 bucket, add `--jurisdiction eu`, `us`, or `fedramp` if it is not already recorded in `wrangler.jsonc`.

The cleanup command resolves the D1 database by its configured name from Cloudflare before deletion. This is intentional: the portable repository keeps a placeholder D1 ID, while each deployed installation has its own real D1 UUID.

### Also delete the Deploy Button GitHub copy

Cloudflare cleanup intentionally does not delete a GitHub repository by default. To delete the private GitHub copy created for one installation, provide its exact name explicitly:

```bash
npm run cleanup -- --yes --delete-github-repo <owner>/<repository>
```

This permanently deletes only the named GitHub.com repository after Cloudflare cleanup succeeds; it does not infer a repository from Git remotes and does not delete local files. It requires the [GitHub CLI](https://cli.github.com/) to be installed and authenticated with repository deletion permission. If GitHub reports a missing permission, run `gh auth refresh -s delete_repo` and try again.

## Local development and validation

```bash
cp .dev.vars.example .dev.vars
npm install
npm run check
npm test
npm run dev
```

The Worker needs remote Cloudflare bindings for integration tests. Local tests should cover pure validation/auth/signature behavior; a Cloudflare test account verifies queues, D1, R2, and Durable Objects together.

## API

Non-dashboard `/v1` endpoints require `Authorization: Bearer <token>`. After signing in as the local owner, create the installation's first full-access API token from the dashboard. `BOOTSTRAP_ADMIN_TOKEN` remains an optional legacy/operator path; a one-click installation does not require it.

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
| `GET /v1/dashboard/bootstrap` | none | Check whether the local owner has been created |
| `GET /v1/dashboard/login-parameters` | none | Return the non-secret salt/work factor used for browser-side password derivation |
| `POST /v1/dashboard/setup`, `POST /v1/dashboard/login` | local auth | Create the first owner or sign in |
| `POST /v1/dashboard/logout` | owner session | Revoke the current local session |
| `GET /v1/dashboard/state` | owner session | Read dashboard installation and connection state |
| `POST /v1/dashboard/phone-numbers` | owner session | Discover selectable phone numbers directly from Meta |
| `PUT /v1/dashboard/connection` | owner session | Validate Meta credentials and store encrypted local connection settings |
| `POST /v1/dashboard/api-tokens` | owner session | Create and return a full-access API token once |

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
- Owner setup/login performs PBKDF2-SHA-256 in the browser, so the password is never sent to the Worker and the expensive derivation does not consume Worker CPU. D1 stores only a SHA-256 digest of the derived verifier plus its non-secret salt and work factor. Browser compatibility and end-to-end authentication still require validation before production use.
- The initial release shares one jobs queue for inbound, outbound, and maintenance work to keep one-click deployment small. Split workloads into separate queues before operating at a volume where one workload could starve another.
- D1 is the system of record and has a 10 GB per-database paid-tier limit. The current default is indefinite content retention, so capacity controls, export, and archival are required before large-scale operation.
- The current rate defaults are conservative: 60 ms between sends per phone number and one second per recipient. They are intentionally not a substitute for reading current Meta rate-limit behavior.
- Message content remains in the customer Cloudflare account. It still travels through Meta and Cloudflare; do not claim absolute data locality without separately configuring and validating Cloudflare data-localization controls.
- To erase the installation's retained customer data, call `DELETE /v1/admin/data` with `X-Confirm-Installation-Deletion: DELETE`. This does not delete Cloudflare resources or Worker secrets; the account owner controls those separately.

## Phase 1 gaps still requiring implementation/validation

- R2 media ingestion and upload API.
- Outbox sweep deduplication and exponential schedule persistence.
- Template pagination and mutation endpoints.
- Event subscriptions, export/delete jobs, quota telemetry, API-token listing/revocation, and full team-user management.
- Full automated Worker integration test suite against a Cloudflare test account.
- Meta end-to-end webhook and outbound delivery validation.

See [whatsapp-platform-architecture.md](./whatsapp-platform-architecture.md) for the approved architecture and roadmap. Read [CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md), and [LICENSE.md](./LICENSE.md) before contributing or redistributing the project.

Use [the Phase 1 acceptance runbook](./docs/phase-1-acceptance.md) for the required Cloudflare/Meta test-account validation before treating an installation as deployable.
