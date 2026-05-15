import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DaemonLifecycle } from '../src/lifecycle.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createPidFilePath(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return resolve(dir, 'daemon.pid');
}

describe('daemon lifecycle', () => {
  it('creates a pid file when lock is acquired', async () => {
    const pidFilePath = await createPidFilePath();
    const lifecycle = new DaemonLifecycle(pidFilePath);

    await lifecycle.acquireLock();
    const contents = await readFile(pidFilePath, 'utf8');

    expect(contents.trim()).toBe(String(process.pid));
    await lifecycle.releaseLock();
  });

  it('reports running when the current process owns the pid file', async () => {
    const pidFilePath = await createPidFilePath();
    const lifecycle = new DaemonLifecycle(pidFilePath);

    await lifecycle.acquireLock();
    await expect(lifecycle.isRunning()).resolves.toBe(true);
    await lifecycle.releaseLock();
  });

  it('throws on duplicate lock acquisition', async () => {
    const pidFilePath = await createPidFilePath();
    const lifecycle = new DaemonLifecycle(pidFilePath);
    const second = new DaemonLifecycle(pidFilePath);

    await lifecycle.acquireLock();
    await expect(second.acquireLock()).rejects.toThrow(/already running/i);
    await lifecycle.releaseLock();
  });

  it('removes the pid file on release', async () => {
    const pidFilePath = await createPidFilePath();
    const lifecycle = new DaemonLifecycle(pidFilePath);

    await lifecycle.acquireLock();
    await lifecycle.releaseLock();

    await expect(access(pidFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
