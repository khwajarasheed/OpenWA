import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('customer-owned update release policy', () => {
  it('keeps this pre-release review-only', () => {
    const manifest = JSON.parse(readFileSync(new URL('../openwa-release.json', import.meta.url), 'utf8'));

    expect(manifest).toMatchObject({
      schema_version: 1,
      compatibility: 'manual_review_required',
      auto_update: false,
    });
  });
});
