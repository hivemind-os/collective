import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PerformanceTracker } from '../../src/index.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDbPath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'performance.sqlite');
}

describe('PerformanceTracker', () => {
  it('records completions and returns estimated latency', async () => {
    const tracker = new PerformanceTracker({ dbPath: await createDbPath() });

    tracker.recordCompletion('did:mesh:provider', 'echo', 120, true);
    tracker.recordCompletion('did:mesh:provider', 'echo', 240, true);
    tracker.recordCompletion('did:mesh:provider', 'echo', 360, false);

    expect(tracker.getEstimatedLatency('did:mesh:provider', 'echo')).toBe(240);
    tracker.close();
  });

  it('returns aggregated provider stats across capabilities', async () => {
    const tracker = new PerformanceTracker({ dbPath: await createDbPath() });

    tracker.recordCompletion('did:mesh:provider', 'echo', 100, true);
    tracker.recordCompletion('did:mesh:provider', 'summarize', 200, false);

    const stats = tracker.getProviderStats('did:mesh:provider');

    expect(stats.providerDid).toBe('did:mesh:provider');
    expect(stats.successCount).toBe(1);
    expect(stats.failureCount).toBe(1);
    expect(stats.capabilities).toHaveLength(2);
    expect(stats.capabilities.map((entry) => entry.capability)).toEqual(['echo', 'summarize']);
    tracker.close();
  });
});
