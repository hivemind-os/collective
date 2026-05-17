/**
 * Integration test that simulates the real `npx @hivemind-os/collective-shim` flow.
 *
 * It packs ALL workspace packages into tarballs (using `pnpm pack` to resolve
 * workspace:* → real version numbers), installs them into an isolated temp
 * directory via plain `npm install`, and runs the shim from there — verifying
 * the daemon starts and the full MCP round-trip works.
 *
 * This catches issues that only surface after npm publish:
 *  - Missing `files` entries in package.json
 *  - Broken require.resolve / import resolution outside the monorepo
 *  - Daemon startup failures (crashes, missing deps, module errors)
 *  - IPC path mismatches between shim and daemon
 */
import { ChildProcess, execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_TIMEOUT = 120_000;
const SETUP_TIMEOUT = 180_000;
const workDir = join(tmpdir(), `hm-npx-sim-${randomUUID().slice(0, 8)}`);
const tarballDir = join(workDir, 'tarballs');
const installDir = join(workDir, 'install');
const dataDir = join(workDir, 'data');

const repoRoot = resolve(__dirname, '../../../..');

let shimProcess: ChildProcess | undefined;
let stdout = '';
let shimStderr = '';

function sendJsonRpc(proc: ChildProcess, message: object): void {
  proc.stdin!.write(`${JSON.stringify(message)}\n`);
}

function waitForResponse(id: string | number, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const deadline = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for response id=${id}.\nstdout: ${stdout.slice(-2000)}\nstderr: ${shimStderr.slice(-2000)}`,
        ),
      );
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
          // not JSON — skip
        }
      }
      setTimeout(check, 100);
    };
    check();
  });
}

describe('NPX simulation: install from tarballs and run shim', () => {
  beforeAll(async () => {
    await mkdir(dataDir, { recursive: true });
    await mkdir(tarballDir, { recursive: true });
    await mkdir(installDir, { recursive: true });

    // Step 1: Pack all workspace packages using pnpm (resolves workspace:*)
    const packageNames = ['types', 'core', 'mcp-server', 'relay', 'indexer', 'daemon', 'shim'];
    for (const name of packageNames) {
      const pkgDir = join(repoRoot, 'packages', name);
      if (!existsSync(join(pkgDir, 'package.json'))) continue;
      execSync(`pnpm pack --pack-destination ${JSON.stringify(tarballDir)}`, {
        cwd: pkgDir,
        stdio: 'pipe',
      });
    }

    // Step 2: Install each tarball one at a time via npm
    await writeFile(
      join(installDir, 'package.json'),
      JSON.stringify({ name: 'npx-sim-test', version: '1.0.0', private: true, type: 'module' }),
    );

    const tarballs = await readdir(tarballDir);
    for (const tb of tarballs.filter((f) => f.endsWith('.tgz'))) {
      execSync(`npm install ${JSON.stringify(join(tarballDir, tb))} --no-fund --no-audit`, {
        cwd: installDir,
        stdio: 'pipe',
      });
    }

    // Step 3: Verify installed structure
    const shimEntry = join(installDir, 'node_modules/@hivemind-os/collective-shim/dist/index.js');
    const daemonEntry = join(installDir, 'node_modules/@hivemind-os/collective-daemon/dist/index.js');
    expect(existsSync(shimEntry), `shim entry not found: ${shimEntry}`).toBe(true);
    expect(existsSync(daemonEntry), `daemon entry not found: ${daemonEntry}`).toBe(true);

    // Step 4: Launch the shim from the installed location
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      COLLECTIVE_DATA_DIR: dataDir,
      COLLECTIVE_LOG_LEVEL: 'warn',
      COLLECTIVE_NETWORK: 'testnet',
      COLLECTIVE_HEADLESS: '1',
    };

    shimProcess = spawn(process.execPath, [shimEntry], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: installDir,
    });

    shimProcess.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    shimProcess.stderr!.on('data', (chunk: Buffer) => {
      shimStderr += chunk.toString();
    });
    shimProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Shim exited with code ${code}.\nstderr:\n${shimStderr}`);
      }
    });

    // Give the shim + daemon time to start
    await new Promise((r) => setTimeout(r, 2000));
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    if (shimProcess && !shimProcess.killed) {
      shimProcess.kill();
      await new Promise<void>((r) => {
        shimProcess!.once('exit', () => r());
        setTimeout(r, 5000);
      });
    }

    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('resolves daemon binary and starts MCP session', async () => {
    // If the shim already exited, fail fast with the stderr output
    if (shimProcess!.exitCode !== null) {
      throw new Error(`Shim exited early with code ${shimProcess!.exitCode}.\nstderr:\n${shimStderr}`);
    }

    sendJsonRpc(shimProcess!, {
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'npx-sim-test', version: '1.0.0' },
      },
    });

    const initResponse = await waitForResponse('init-1', 60_000);
    expect(initResponse.result).toBeDefined();
    expect(initResponse.result.protocolVersion).toBeDefined();
    expect(initResponse.result.serverInfo.name).toBe('@hivemind-os/collective-daemon');
  }, TEST_TIMEOUT);

  it('lists MCP tools', async () => {
    sendJsonRpc(shimProcess!, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    await new Promise((r) => setTimeout(r, 500));

    sendJsonRpc(shimProcess!, {
      jsonrpc: '2.0',
      id: 'tools-1',
      method: 'tools/list',
      params: {},
    });

    const toolsResponse = await waitForResponse('tools-1', 15_000);
    const toolNames: string[] = toolsResponse.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('collective_discover');
    expect(toolNames).toContain('collective_execute');
    expect(toolNames).toContain('collective_balance');
    expect(toolNames).toContain('collective_settings');
    // Total: 2 daemon-specific (balance, status) + mcp-server tools (minus 1 overlap for balance)
    // If this count changes, update it intentionally — never silently drop tools.
    expect(toolNames.length).toBeGreaterThanOrEqual(22);
  }, TEST_TIMEOUT);

});
