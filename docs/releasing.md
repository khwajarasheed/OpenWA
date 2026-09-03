# Publishing OpenWA releases

Customer deployment copies update only from published GitHub releases, never directly from `main`. This keeps every update versioned and reviewable.

Before publishing a release, update both `package.json` and `openwa-release.json` with the same version, run the full validation suite, commit the changes, create an annotated tag such as `v0.1.1`, and publish a GitHub release from that tag.

## Compatibility policy

The customer-owned update workflow reads `openwa-release.json` from the release tag.

- `compatibility: "patch"` and `auto_update: true` permits automatic deployment for customers using the default update policy.
- Any other compatibility value, a missing manifest, any Worker binding change, or any D1 migration must use review mode.
- Releases that change `wrangler.jsonc`, add/remove Cloudflare bindings, require an operator action, or include data migration work must set `compatibility: "manual_review_required"` and `auto_update: false`.

Automatic mode is intentionally the default for backward-compatible, no-migration fixes only. A pull request is still created and merged by the customer repository's GitHub Actions workflow, leaving an audit trail before Cloudflare deploys the new default-branch commit. Customers can select review-only mode once through the `OPENWA_UPDATE_MODE=review` repository variable.

## Trust boundary

The update workflow trusts releases published from the configured upstream GitHub repository. Protect the upstream default branch and release/tag creation permissions. Do not mark a release eligible for automatic updates until its changelog, tests, dependency changes, and Cloudflare compatibility have been reviewed.
