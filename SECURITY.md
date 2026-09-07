# Security policy

## Supported version

Only the latest code on the default branch is supported during this pre-release phase.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability involving authentication, Cloudflare Access, credential encryption, webhook verification, message delivery, or data deletion.

Report it privately to the project maintainer with:

- a concise description and impact;
- affected files/endpoints and reproduction steps;
- a proof of concept that uses synthetic data only; and
- any suggested mitigation.

Never send Meta access tokens, Meta app secrets, Cloudflare API tokens, signed production webhooks, or customer message content.

## Security boundaries

ForgeScale Relay Core is designed to run in the customer’s Cloudflare account and call Meta directly. Customers remain responsible for Cloudflare account access, the local ForgeScale Relay owner password, and Meta permissions. Cloudflare Access may be added as an optional outer layer. ForgeScale Relay must not claim absolute data locality: data is processed by Cloudflare and Meta as part of normal operation.

The first visitor to an uninitialized deployment can create its singleton owner account. Open a new installation immediately and do not distribute its URL before completing that step. Local login attempts are throttled, but password recovery and multi-factor authentication are not yet implemented; these are release blockers for production use, not features that should be implied by the current pre-release UI.

The browser derives a fixed-length verifier from the owner password with PBKDF2-SHA-256 before making a same-origin HTTPS request. The Worker never receives the plaintext password and D1 stores only a digest of the verifier, its random salt, and its work factor. The verifier is password-equivalent authentication material while in transit, so TLS, the same-origin mutation checks, secure session cookies, and avoiding third-party scripts on the dashboard remain part of the security boundary.
