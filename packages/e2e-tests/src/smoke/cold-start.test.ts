/**
 * Cold-start E2E test: verifies the "zero-config" flow where the shim
 * spawns the daemon from scratch in a clean directory, auto-initializes
 * identity/config, and exposes MCP tools.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_TIMEOUT = 60_000;
const dataDir = join(tmpdir(), `hm-coldstart-${randomUUID().slice(0, 8)}`);

// The daemon derives its IPC path from the data dir.
// On Windows it uses a username-based named pipe regardless; on Unix it's <dataDir>/mesh.sock.
const ipcPath =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\hm-coldstart-${randomUUID().slice(0, 8)}`
    : join(dataDir, 'mesh.sock');
const pidFile = join(dataDir, 'daemon.pid');

const shimBin = resolve(__dirname, '../../../shim/dist/index.js');
const daemonBin = resolve(__dirname, '../../../daemon/dist/index.js');

let shimProcess: ChildProcess | undefined;
let stdout = '';
let stderr = '';

function sendJsonRpc(proc: ChildProcess, message: object): void {
  proc.stdin!.write(`${JSON.stringify(message)}\n`);
}

function waitForResponse(id: string | number, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`Timed out waiting for response id=${id}. stdout so far: ${stdout}`));
    }, timeoutMs);

    const check = () => {
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            clearTimeout(deadline);
            resolvePromise(msg);
            return;
          }
        } catch {
          // not JSON, skip
        }
      }
      setTimeout(check, 100);
    };
    check();
  });
}

describe('Cold-start: shim auto-initializes and exposes tools', () => {
  beforeAll(async () => {
    await mkdir(dataDir, { recursive: true });

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      COLLECTIVE_DATA_DIR: dataDir,
      COLLECTIVE_IPC_PATH: ipcPath,
      COLLECTIVE_PID_FILE: pidFile,
      COLLECTIVE_DAEMON_BIN: daemonBin,
      COLLECTIVE_LOG_LEVEL: 'warn',
      COLLECTIVE_NETWORK: 'testnet',
      // Disable zkLogin portal to avoid blocking on auth
      COLLECTIVE_HEADLESS: '1',
    };

    shimProcess = spawn(process.execPath, [shimBin], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    shimProcess.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    shimProcess.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Wait for the shim to be ready (it sends nothing proactively, but we
    // can start the MCP handshake immediately)
    await new Promise((r) => setTimeout(r, 2000));
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (shimProcess && !shimProcess.killed) {
      shimProcess.kill();
      await new Promise<void>((r) => {
        shimProcess!.once('exit', () => r());
        setTimeout(r, 3000);
      });
    }

    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('initializes MCP session and lists tools', async () => {
    // Send MCP initialize request
    sendJsonRpc(shimProcess!, {
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cold-start-test', version: '1.0.0' },
      },
    });

    const initResponse = await waitForResponse('init-1', 45_000);
    expect(initResponse.result).toBeDefined();
    expect(initResponse.result.protocolVersion).toBeDefined();
    expect(initResponse.result.capabilities).toBeDefined();

    // Send initialized notification
    sendJsonRpc(shimProcess!, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    // Small delay for the notification to process
    await new Promise((r) => setTimeout(r, 500));

    // List tools
    sendJsonRpc(shimProcess!, {
      jsonrpc: '2.0',
      id: 'tools-1',
      method: 'tools/list',
      params: {},
    });

    const toolsResponse = await waitForResponse('tools-1', 15_000);
    expect(toolsResponse.result).toBeDefined();
    expect(toolsResponse.result.tools).toBeInstanceOf(Array);
    expect(toolsResponse.result.tools.length).toBeGreaterThan(5);

    // Verify key tools are present
    const toolNames = toolsResponse.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('collective_discover');
    expect(toolNames).toContain('collective_execute');
    expect(toolNames).toContain('collective_balance');
  }, TEST_TIMEOUT);

  it('creates identity and config automatically', async () => {
    // The daemon should have auto-created these
    expect(existsSync(join(dataDir, 'config.yaml'))).toBe(true);
    expect(existsSync(join(dataDir, 'identity'))).toBe(true);
  });

  it('can call collective_balance without errors', async () => {
    sendJsonRpc(shimProcess!, {
      jsonrpc: '2.0',
      id: 'balance-1',
      method: 'tools/call',
      params: {
        name: 'collective_balance',
        arguments: {},
      },
    });

    const response = await waitForResponse('balance-1', 15_000);
    expect(response.result).toBeDefined();
    // The result should have content with the wallet address
    expect(response.result.content).toBeInstanceOf(Array);
    expect(response.result.content[0].text).toContain('0x');
  }, TEST_TIMEOUT);
});
