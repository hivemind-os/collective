import { spawn } from 'node:child_process';

import type { ExecutionAdapter } from './interface.js';

export interface SubprocessAdapterConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

export class SubprocessAdapter implements ExecutionAdapter {
  readonly name = 'subprocess';
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(config: SubprocessAdapterConfig) {
    if (!config.command || config.command.trim().length === 0) {
      throw new Error('Subprocess adapter requires a non-empty command');
    }

    this.command = config.command;
    this.args = config.args ?? [];
    this.cwd = config.cwd;
    this.env = { ...config.env };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async execute(params: {
    taskId: string;
    capability: string;
    inputData: Uint8Array;
    metadata?: Record<string, string>;
  }): Promise<{ resultData: Uint8Array; metadata?: Record<string, string> }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...this.env,
          COLLECTIVE_TASK_ID: params.taskId,
          COLLECTIVE_CAPABILITY: params.capability,
        },
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let settled = false;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn();
        }
      };

      const timer = setTimeout(() => {
        settle(() => {
          child.kill('SIGKILL');
          reject(new Error(`Subprocess timed out after ${this.timeoutMs}ms`));
        });
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutSize += chunk.length;
        if (stdoutSize > this.maxOutputBytes) {
          settle(() => {
            child.kill('SIGKILL');
            reject(new Error(`Subprocess stdout exceeded ${this.maxOutputBytes} byte limit`));
          });
          return;
        }
        stdout.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrSize += chunk.length;
        if (stderrSize <= 64 * 1024) {
          stderr.push(chunk);
        }
      });

      child.on('error', (error) => {
        settle(() => reject(new Error(`Subprocess failed to start: ${error.message}`)));
      });

      child.on('close', (code) => {
        settle(() => {
          if (code !== 0) {
            const stderrText = Buffer.concat(stderr).toString('utf-8').trim();
            const truncated = stderrText.length > 1024 ? stderrText.slice(0, 1024) + '...' : stderrText;
            reject(new Error(`Subprocess exited with code ${code ?? 'null'}${truncated ? `: ${truncated}` : ''}`));
            return;
          }

          resolve({
            resultData: new Uint8Array(Buffer.concat(stdout)),
          });
        });
      });

      child.stdin.on('error', (error) => {
        settle(() => reject(new Error(`Subprocess stdin error: ${error.message}`)));
      });
      child.stdin.end(Buffer.from(params.inputData));
    });
  }
}
