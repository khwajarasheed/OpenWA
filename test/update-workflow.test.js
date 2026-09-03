import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('customer-owned update workflow', () => {
  it('keeps this pre-release review-only and guards automatic updates', () => {
    const manifest = JSON.parse(readFileSync(new URL('../openwa-release.json', import.meta.url), 'utf8'));
    const workflow = readFileSync(new URL('../.github/workflows/openwa-update.yml', import.meta.url), 'utf8');

    expect(manifest).toMatchObject({
      schema_version: 1,
      compatibility: 'manual_review_required',
      auto_update: false,
    });
    expect(workflow).toContain("OPENWA_UPDATE_MODE: ${{ inputs.mode || vars.OPENWA_UPDATE_MODE || 'auto' }}");
    expect(workflow).toContain('.compatibility == "patch" and .auto_update == true');
    expect(workflow).toContain('cp wrangler.jsonc /tmp/customer-wrangler.jsonc');
    expect(workflow).toContain('gh pr create');
  });
});
