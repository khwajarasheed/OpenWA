import { describe, expect, it } from 'vitest';
import { encodeObjectKey, isTargetWorkerConsumer, parseArguments, targetsFromConfig } from '../scripts/cleanup.mjs';

describe('cleanup script safeguards', () => {
  it('requires an explicit --yes flag before destructive mode', () => {
    expect(parseArguments([]).yes).toBe(false);
    expect(parseArguments(['--yes']).yes).toBe(true);
    expect(() => parseArguments(['--all'])).toThrow('Unknown option');
  });

  it('accepts only an explicit, valid GitHub repository deletion target', () => {
    expect(parseArguments(['--yes', '--delete-github-repo', 'owner/test-repo']).githubRepository).toBe('owner/test-repo');
    expect(() => parseArguments(['--delete-github-repo', 'https://github.com/owner/test-repo'])).toThrow('exact GitHub owner/repository');
  });

  it('selects only the known ForgeScale Relay bindings from Wrangler config', () => {
    const targets = targetsFromConfig({
      name: 'customer-core',
      d1_databases: [
        { binding: 'UNRELATED', database_name: 'keep-me' },
        { binding: 'DB', database_name: 'customer-core' },
      ],
      r2_buckets: [
        { binding: 'UNRELATED', bucket_name: 'keep-me-too' },
        { binding: 'MEDIA', bucket_name: 'customer-media' },
      ],
      queues: {
        producers: [
          { binding: 'JOBS_QUEUE', queue: 'customer-jobs' },
          { binding: 'DEAD_LETTER_QUEUE', queue: 'customer-dlq' },
          { binding: 'UNRELATED', queue: 'keep-this-queue' },
        ],
      },
      durable_objects: { bindings: [{ name: 'TEST', class_name: 'InstallationSecrets' }] },
    });

    expect(targets).toMatchObject({
      worker: 'customer-core',
      database: 'customer-core',
      bucket: 'customer-media',
      jobsQueue: 'customer-jobs',
      queues: ['customer-jobs', 'customer-dlq'],
      durableObjectClasses: ['InstallationSecrets'],
    });
  });

  it('preserves slashes but escapes other reserved characters in R2 keys', () => {
    expect(encodeObjectKey('media/folder/a b?#.jpg')).toBe('media/folder/a%20b%3F%23.jpg');
  });

  it('does not infer a deletion target from an unrelated queue consumer', () => {
    const targets = targetsFromConfig({
      name: 'customer-core',
      queues: { consumers: [{ queue: 'keep-this-queue', dead_letter_queue: 'keep-this-dlq' }] },
    });

    expect(targets.queues).toEqual([]);
  });

  it('matches a queue consumer only when its Worker name is the deployed Worker', () => {
    expect(isTargetWorkerConsumer({ type: 'worker', script_name: 'customer-core' }, 'customer-core')).toBe(true);
    expect(isTargetWorkerConsumer({ type: 'worker', service: 'customer-core' }, 'customer-core')).toBe(true);
    expect(isTargetWorkerConsumer({ type: 'worker', script: 'another-project' }, 'customer-core')).toBe(false);
    expect(isTargetWorkerConsumer({ type: 'http_pull', script: 'customer-core' }, 'customer-core')).toBe(false);
  });
});
