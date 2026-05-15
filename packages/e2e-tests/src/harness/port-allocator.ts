import { createServer } from 'node:net';

export class PortAllocator {
  private readonly allocated = new Set<number>();

  /**
   * Find `count` free ports by briefly binding a server to port 0,
   * recording the OS-assigned port, then immediately closing the server.
   * This leaves a small race window, but the ports are free for Sui/Anvil
   * to bind immediately after.
   */
  async allocate(count: number): Promise<number[]> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`Port allocation count must be a positive integer. Received: ${count}`);
    }

    const ports: number[] = [];

    for (let index = 0; index < count; index += 1) {
      const port = await findFreePort();
      this.allocated.add(port);
      ports.push(port);
    }

    return ports;
  }

  async release(ports: number[]): Promise<void> {
    for (const port of ports) {
      this.allocated.delete(port);
    }
  }

  async cleanup(): Promise<void> {
    this.allocated.clear();
  }
}

function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to determine allocated port.'));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
