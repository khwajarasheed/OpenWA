import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/util';

describe('sha256', () => {
  it('produces a stable lowercase digest', async () => {
    await expect(sha256('openwa')).resolves.toBe('e78d4aa93849c0177ca833a6c0dc685f96be7072818467efe3f3f55210a30eec');
  });
});
