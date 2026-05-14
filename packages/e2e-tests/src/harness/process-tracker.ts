import { spawn } from 'node:child_process';

interface TrackedProcess {
  pid: number;
  name: string;
}

export class ProcessTracker {
  private readonly processes = new Map<number, TrackedProcess>();

  track(pid: number, name: string): void {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Cannot track invalid process id: ${pid}`);
    }

    this.processes.set(pid, { pid, name });
  }

  async stopAll(): Promise<void> {
    const errors: Error[] = [];
    const tracked = [...this.processes.values()].reverse();

    for (const processInfo of tracked) {
      try {
        await this.killProcessTree(processInfo.pid);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? new Error(`${processInfo.name} (${processInfo.pid}): ${error.message}`)
            : new Error(`${processInfo.name} (${processInfo.pid}): Unknown process termination error.`),
        );
      } finally {
        this.processes.delete(processInfo.pid);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to terminate one or more tracked processes.');
    }
  }

  async cleanup(): Promise<void> {
    await this.stopAll();
  }

  private async killProcessTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      await this.runCommand('taskkill', ['/T', '/F', '/PID', String(pid)]);
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (isMissingProcessError(error)) {
        return;
      }

      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (isMissingProcessError(error)) {
        return;
      }

      throw error;
    }
  }

  private async runCommand(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'ignore' });

      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0 || code === 128) {
          resolve();
          return;
        }

        reject(new Error(`${command} exited with code ${code ?? 'unknown'}.`));
      });
    });
  }
}

function isMissingProcessError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
