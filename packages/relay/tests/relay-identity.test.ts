import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RelayIdentity } from '../src/identity/relay-identity.js';

const createdPaths: string[] = [];

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createTestDir(): Promise<string> {
  const dir = resolve(process.cwd(), '.test-data', randomUUID());
  createdPaths.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('RelayIdentity', () => {
  it.each(['', 'xyz-not-hex'])('throws a descriptive error for invalid key file content: %j', async (content) => {
    const dir = await createTestDir();
    const keyPath = resolve(dir, 'relay.key');
    await writeFile(keyPath, content, 'utf8');

    expect(() => RelayIdentity.load(keyPath)).toThrowError(
      `Invalid relay identity key at ${keyPath}: expected 64-character hex string (32 bytes ed25519 secret key).`,
    );
  });
});
