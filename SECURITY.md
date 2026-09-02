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

OpenWA CORE is designed to run in the customer’s Cloudflare account and call Meta directly. Customers remain responsible for Cloudflare account access, Meta permissions, and the Cloudflare Access policy protecting the dashboard. OpenWA must not claim absolute data locality: data is processed by Cloudflare and Meta as part of normal operation.
