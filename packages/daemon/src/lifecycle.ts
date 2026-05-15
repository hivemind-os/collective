import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class DaemonLifecycle {
  constructor(private readonly pidFilePath: string) {}

  async acquireLock(): Promise<void> {
    await mkdir(dirname(this.pidFilePath), { recursive: true, mode: 0o700 });

    try {
      await writePrivateFile(this.pidFilePath, `${process.pid}\n`);
      return;
    } catch (error) {
      if (!isErrnoException(error, 'EEXIST')) {
        throw error;
      }
    }

    if (await this.isRunning()) {
      throw new Error(`Daemon is already running (pid file: ${this.pidFilePath}).`);
    }

    await rm(this.pidFilePath, { force: true });
    await writePrivateFile(this.pidFilePath, `${process.pid}\n`);
  }

  async isRunning(): Promise<boolean> {
    try {
      const contents = await readFile(this.pidFilePath, 'utf8');
      const pid = Number.parseInt(contents.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        return false;
      }

      if (isProcessRunning(pid)) {
        return true;
      }

      await rm(this.pidFilePath, { force: true });
      return false;
    } catch (error) {
      if (isErrnoException(error, 'ENOENT')) {
        return false;
      }

      throw error;
    }
  }

  async releaseLock(): Promise<void> {
    await rm(this.pidFilePath, { force: true });
  }

  setupSignalHandlers(onShutdown: () => Promise<void>): void {
    let shuttingDown = false;

    const handleSignal = (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      void (async () => {
        try {
          await onShutdown();
          process.exit(0);
        } catch (error) {
          console.error(`Failed to shut down cleanly after ${signal}:`, error);
          process.exit(1);
        }
      })();
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        handleSignal(signal);
      });
    }
  }
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrnoException(error, 'ESRCH');
  }
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
