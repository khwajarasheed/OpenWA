# Relay — AI Coder Implementation Guide

**Attention AI/Codex:** You are executing a UI/UX and copy redesign for the Relay project. 
The goal is an enterprise-grade, bold, clean aesthetic using a cooler blue-green (teal) palette.
DO NOT introduce external dependencies, build tools, or frameworks. The architecture must remain zero-dependency inline HTML/CSS/JS.

## 1. Files in Scope
1. `landing/index.html` (Full rewrite)
2. `src/dashboard.ts` (CSS variable & brand string updates only)
3. `landing/favicon.svg` (Color update only)

---

## 2. Global Design System (Apply to both index.html & dashboard.ts)
Update all CSS variables to this new Teal/Blue-Green palette:
- `--night: #040f13;`
- `--night-2: #081a20;`
- `--panel-dark: #0b242c;`
- `--accent: #14b8a6;` (Primary Teal)
- `--accent-bright: #2dd4bf;`
- `--accent-dim: #0f766e;`
- `--mint: #ccfbf1;`

---

## 3. Implementation: `landing/index.html`

Rewrite `landing/index.html` entirely. 

### Constraints:
- Use inline `<style>` and `<script>`. No external CSS/JS files.
- Add a lightweight `IntersectionObserver` script at the bottom to apply an `.animate-up` class (fade-in + translate up) to sections as they scroll into view.

### Structure & Exact Copy (7 Sections):

**Section 1: Nav (Sticky, dark, blurred background)**
- Brand: `[↗ mark] Relay`
- Links: `Platform` (anchor), `GitHub` (external to repo)
- CTA Button: `Deploy now →` (Links to Cloudflare deploy URL)

**Section 2: Hero**
- Badge: `Open source · Self-hosted · AGPL-3.0`
- H1: `Your WhatsApp<br>infrastructure.<br>Not theirs.`
- Subtext: `Self-hosted WhatsApp Business API. Full ownership. Zero markup.`
- Buttons: `Deploy now →` (Primary), `View source` (Secondary)
- Fine print: `Free to deploy · No vendor account · Ships with sample data to explore immediately`
- Visual (Right side): Browser mockup of the dashboard. Flat border, subtle outer glow (`box-shadow: 0 0 80px #14b8a620`). URL bar says `your-relay.example.com`.

**Section 3: Trust Strip (Horizontal, 4 items)**
- `Zero message markup`: You connect directly to Meta. No per-message fees added.
- `Single-tenant by design`: One deployment, one database, one owner. No shared tenancy.
- `Credentials stay with you`: Meta tokens encrypted inside your deployment. Never sent externally.
- `Auditable open source`: AGPL-3.0 licensed. Read, audit, and extend the entire codebase.

**Section 4: Platform**
- Kicker: `PLATFORM`
- H2: `Everything to run WhatsApp Business. One deployment.`
- Cards (Need simple geometric SVG icons in #14b8a6 on #ccfbf1 bg):
  1. `Operations console`: Self-hosted dashboard for conversations, contacts, messages, and templates. Browse everything on first login with safe sample data.
  2. `REST API`: Scoped bearer tokens, idempotent sends, structured JSON errors, and status tracking. Integrate from any language.
  3. `Queue-backed delivery`: Outbound messages dispatched with per-phone rate control, automatic retries, and dead-letter safety for failed jobs.
  4. `Template sync`: Pull approved WhatsApp message templates directly from your Meta Business account.
  5. `Contact storage`: Customer records stored in your own database. No sync delays, no vendor copies, no third-party access.
  6. `Data controls`: Export records, review activity, and delete data deliberately. Every destructive action requires explicit owner authorization.

**Section 5: Get Started**
- Kicker: `GET STARTED`
- H2: `Deploy. Explore. Connect.`
- Cards:
  1. `01 / Deploy in one click`: Hit the deploy button to provision Relay on Cloudflare. Your API, dashboard, database, message queue, and media storage are ready automatically.
  2. `02 / Explore the workspace`: Create the owner account and land in a complete sample workspace. Conversations, messages, contacts, templates, API access — all explorable immediately. Nothing contacts Meta.
  3. `03 / Connect your number`: Enter your Meta Business credentials in the dashboard. Relay validates the connection, discovers your phone numbers, and offers a clean production workspace.

**Section 6: Security**
- Kicker: `SECURITY`
- H2: `Ownership by architecture.`
- Rows:
  - `Local authentication`: Password derived in the browser with PBKDF2-SHA-256. The server never receives the plaintext password. Only a digest of the derived verifier is stored.
  - `Encrypted credentials`: Meta access tokens and app secrets encrypted with an installation-scoped key that never leaves your deployment.
  - `Signed webhooks`: Every inbound Meta event verified with X-Hub-Signature-256 using your app secret before processing.
  - `Explicit data lifecycle`: Export and deletion require authenticated owner action with a confirmation header. No silent collection, no telemetry, no external callbacks.

**Section 7: CTA + Footer**
- Kicker: `RELAY`
- H2: `Deploy and explore.`
- Buttons: `Deploy now →`, `View source on GitHub`
- Footer: `© 2026 ForgeScale Relay contributors · AGPL-3.0-or-later` | Links: `GitHub`, `Security`, `License`

---

## 4. Implementation: `src/dashboard.ts`

Modify the CSS within the template literal:
- Replace `--nav`, `--nav2`, `--green`, `--green-dark`, `--mint` with the new palette defined in Section 2.
- Update `.brand-mark` background to `#14b8a6`.
- Update sidebar width from `246px` to `260px`.
- Update `.panel` border-radius to `14px`.

Modify the Brand Strings in the UI:
- Change `<title>ForgeScale Relay Console</title>` to `<title>Relay Console</title>`.
- Change `ForgeScale Relay` to `Relay` in the `.brand`, `.side-logo`, `.auth-copy`, `#breadcrumb`, and login/setup copy.
- Do NOT change `ForgeScale Relay` in the footer copyright string or system/API strings.

---

## 5. Implementation: `landing/favicon.svg`
Update the `fill` attributes. Change the bright green to `#14b8a6` and the dark text/inner shapes to `#040f13`.
