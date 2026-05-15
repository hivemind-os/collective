import { createHash } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

export interface MockWalrusRequestCounts {
  put: number;
  get: number;
}

export class MockWalrusServer {
  private readonly server: FastifyInstance;
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly objectIds = new Map<string, string>();
  private readonly counts: MockWalrusRequestCounts = { put: 0, get: 0 };
  private baseUrl = '';

  constructor() {
    this.server = Fastify({ logger: false });
    this.server.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    this.registerRoutes();
  }

  get publisherUrl(): string {
    return this.baseUrl;
  }

  get aggregatorUrl(): string {
    return this.baseUrl;
  }

  async start(port?: number): Promise<string> {
    const address = await this.server.listen({ host: '127.0.0.1', port: port ?? 0 });
    this.baseUrl = address;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await this.server.close().catch(() => undefined);
  }

  corruptBlob(storageBlobId: string, data: Uint8Array): void {
    this.blobs.set(storageBlobId, new Uint8Array(data));
  }

  getRequestCounts(): MockWalrusRequestCounts {
    return { ...this.counts };
  }

  hasBlob(storageBlobId: string): boolean {
    return this.blobs.has(storageBlobId);
  }

  private registerRoutes(): void {
    this.server.put('/v1/blobs', async (request) => {
      this.counts.put += 1;
      const body = request.body;
      const data = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array();
      const storageBlobId = Buffer.from(createHash('sha256').update(data).digest()).toString('base64url');
      const objectId = `0x${createHash('sha256').update(`object:${storageBlobId}`).digest('hex')}`;

      if (this.blobs.has(storageBlobId)) {
        return {
          alreadyCertified: {
            blobId: storageBlobId,
            endEpoch: 99,
          },
        };
      }

      this.blobs.set(storageBlobId, data);
      this.objectIds.set(storageBlobId, objectId);
      return {
        newlyCreated: {
          blobObject: {
            id: objectId,
            blobId: storageBlobId,
            size: data.byteLength,
            deletable: false,
            storage: {
              endEpoch: 99,
            },
          },
        },
      };
    });

    this.server.get('/v1/blobs/:blobId', async (request, reply) => {
      this.counts.get += 1;
      const { blobId } = request.params as { blobId: string };
      const data = this.blobs.get(blobId);
      if (!data) {
        reply.code(404);
        return 'not found';
      }

      const range = request.headers.range;
      if (range === 'bytes=0-0') {
        reply
          .code(206)
          .header('content-type', 'application/octet-stream')
          .header('content-length', '1')
          .header('content-range', `bytes 0-0/${data.byteLength}`)
          .send(Buffer.from(data.slice(0, 1)));
        return;
      }

      reply.header('content-type', 'application/octet-stream').send(Buffer.from(data));
    });
  }
}
