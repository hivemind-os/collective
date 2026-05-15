import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import type { StoredZkLoginSession } from './types.js';

interface SessionEnvelopeV1 {
  version: 1;
  metadata: {
    address: string;
    iss: string;
    sub: string;
    maxEpoch: number;
    updatedAt: number;
  };
  iv: string;
  tag: string;
  ciphertext: string;
}

interface SessionEnvelopeV2 {
  version: 2;
  metadata: {
    maxEpoch: number;
    updatedAt: number;
  };
  iv: string;
  tag: string;
  ciphertext: string;
}

type SessionEnvelope = SessionEnvelopeV1 | SessionEnvelopeV2;

interface SerializedSession extends Omit<StoredZkLoginSession, 'ephemeralKeypair'> {
  ephemeralSecretKey: string;
}

const SESSION_ENCRYPTION_INFO = Buffer.from('agentic-mesh:zklogin-session-store:v2', 'utf8');
const SESSION_ENCRYPTION_SALT = Buffer.from('aes-256-gcm', 'utf8');

export class ZkLoginSessionStore {
  private readonly encryptionKey: Buffer;
  private readonly legacyEncryptionKey: Buffer;

  constructor(
    private readonly baseDir: string,
    encryptionKey: Uint8Array,
  ) {
    const keyMaterial = Buffer.from(encryptionKey);
    this.legacyEncryptionKey = Buffer.from(createHash('sha256').update(keyMaterial).digest());
    this.encryptionKey = Buffer.from(hkdfSync('sha256', keyMaterial, SESSION_ENCRYPTION_SALT, SESSION_ENCRYPTION_INFO, 32));
  }

  async save(session: StoredZkLoginSession): Promise<void> {
    await this.ensureBaseDir();

    const payload = this.serializeSession(session);
    const envelope = this.encrypt(payload);
    const path = join(this.baseDir, getSessionFilename(session));

    await writeFile(path, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600);
  }

  async loadLatest(): Promise<StoredZkLoginSession | null> {
    const sessions = await this.loadAll();
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    return sessions[0] ?? null;
  }

  async loadAll(): Promise<StoredZkLoginSession[]> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map(async (entry) => {
            try {
              const contents = await readFile(join(this.baseDir, entry.name), 'utf8');
              return this.decrypt(JSON.parse(contents) as SessionEnvelope);
            } catch {
              return null;
            }
          }),
      );

      return sessions.filter((session): session is StoredZkLoginSession => session !== null);
    } catch (error) {
      if (isErrnoException(error, 'ENOENT')) {
        return [];
      }

      throw error;
    }
  }

  async loadLatestValid(currentEpoch: number): Promise<StoredZkLoginSession | null> {
    const sessions = await this.loadAll();
    sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    return sessions.find((session) => !this.isExpired(session, currentEpoch)) ?? null;
  }

  async hasValidSession(currentEpoch: number): Promise<boolean> {
    return (await this.loadLatestValid(currentEpoch)) !== null;
  }

  isExpired(session: Pick<StoredZkLoginSession, 'maxEpoch'>, currentEpoch: number): boolean {
    return currentEpoch >= session.maxEpoch;
  }

  isNearExpiry(
    session: Pick<StoredZkLoginSession, 'maxEpoch'>,
    currentEpoch: number,
    remainingEpochs = 1,
  ): boolean {
    return currentEpoch + remainingEpochs >= session.maxEpoch;
  }

  async refreshIfNeeded(
    currentEpoch: number,
    refresher: (session: StoredZkLoginSession) => Promise<StoredZkLoginSession | null>,
  ): Promise<StoredZkLoginSession | null> {
    const session = await this.loadLatestValid(currentEpoch);
    if (!session) {
      return null;
    }

    if (!this.isNearExpiry(session, currentEpoch) || !session.refreshToken) {
      return session;
    }

    const refreshed = await refresher(session);
    if (refreshed) {
      await this.save(refreshed);
      return refreshed;
    }

    return session;
  }

  async deleteExpired(currentEpoch: number): Promise<void> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map(async (entry) => {
            const path = join(this.baseDir, entry.name);
            try {
              const contents = await readFile(path, 'utf8');
              const session = this.decrypt(JSON.parse(contents) as SessionEnvelope);
              if (this.isExpired(session, currentEpoch)) {
                await rm(path, { force: true });
              }
            } catch {
              await rm(path, { force: true });
            }
          }),
      );
    } catch (error) {
      if (!isErrnoException(error, 'ENOENT')) {
        throw error;
      }
    }
  }

  private serializeSession(session: StoredZkLoginSession): SerializedSession {
    return {
      ...session,
      ephemeralSecretKey: session.ephemeralKeypair.getSecretKey(),
    };
  }

  private deserializeSession(session: SerializedSession): StoredZkLoginSession {
    return {
      ...session,
      ephemeralKeypair: Ed25519Keypair.fromSecretKey(session.ephemeralSecretKey),
    };
  }

  private encrypt(session: SerializedSession): SessionEnvelope {
    const metadata: SessionEnvelopeV2['metadata'] = {
      maxEpoch: session.maxEpoch,
      updatedAt: session.updatedAt,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(metadata), 'utf8'));
    const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      version: 2,
      metadata,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private decrypt(envelope: SessionEnvelope): StoredZkLoginSession {
    const version = (envelope as { version: number }).version;
    if (version === 1) {
      return this.decryptEnvelope(envelope, this.legacyEncryptionKey);
    }

    if (version !== 2) {
      throw new Error(`Unsupported zkLogin session version: ${String(version)}`);
    }

    return this.decryptEnvelope(envelope, this.encryptionKey, envelope.metadata);
  }

  private decryptEnvelope(
    envelope: SessionEnvelope,
    encryptionKey: Buffer,
    metadata?: SessionEnvelopeV2['metadata'],
  ): StoredZkLoginSession {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(envelope.iv, 'base64'));
    if (metadata) {
      decipher.setAAD(Buffer.from(JSON.stringify(metadata), 'utf8'));
    }
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    return this.deserializeSession(JSON.parse(plaintext) as SerializedSession);
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await chmod(this.baseDir, 0o700);
  }
}

function getSessionFilename(session: Pick<StoredZkLoginSession, 'iss' | 'sub'>): string {
  const digest = createHash('sha256')
    .update(`${session.iss}:${session.sub}`)
    .digest('hex');
  return `${digest}.json`;
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
