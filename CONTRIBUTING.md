# Contributing to OpenWA

## Before opening a pull request

1. Do not commit credentials, webhook payloads, Cloudflare account IDs, or customer data.
2. Add or update tests for behavior changes.
3. Run the repository checks locally:

   ```bash
   npm ci
   npm run check
   npm test
   npm run deploy -- --dry-run
   ```

4. Keep Meta calls direct from the customer-owned Worker. Do not add a vendor-operated message proxy to CORE.

## Changes that need extra review

- Authentication, authorization, encryption, secret handling, and webhook verification.
- Database migrations and deletion/export behavior.
- Any change that could expose message content, contacts, or Meta credentials outside the customer’s Cloudflare account.

## Reporting bugs

Use a GitHub issue for reproducible bugs. Do not include production access tokens, app secrets, signed webhook bodies, phone numbers, or customer message content.
