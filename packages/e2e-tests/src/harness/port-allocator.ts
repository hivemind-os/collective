import { createServer, type Server } from 'node:net';

export class PortAllocator {
  private readonly reservations = new Map<number, Server>();

  async allocate(count: number): Promise<number[]> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`Port allocation count must be a positive integer. Received: ${count}`);
    }

    const ports: number[] = [];

    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Failed to determine allocated port.'));
            return;
          }

          resolve(address.port);
        });
      });

      this.reservations.set(port, server);
      ports.push(port);
    }

    return ports;
  }

  async release(ports: number[]): Promise<void> {
    await Promise.all(
      ports.map(async (port) => {
        const server = this.reservations.get(port);
        if (!server) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });

        this.reservations.delete(port);
      }),
    );
  }

  async cleanup(): Promise<void> {
    await this.release([...this.reservations.keys()]);
  }
}
