import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, retryDelay } from '../src/phone-dispatcher';

describe('outbound retry policy', () => {
  it('uses the agreed bounded exponential schedule', () => {
    expect(MAX_ATTEMPTS).toBe(10);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(attempt => retryDelay(attempt, null)))
      .toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
  });

  it('honors a longer valid Retry-After value without exceeding the cap', () => {
    expect(retryDelay(1, '90')).toBe(90);
    expect(retryDelay(1, '900')).toBe(300);
    expect(retryDelay(1, 'invalid')).toBe(5);
  });
});
