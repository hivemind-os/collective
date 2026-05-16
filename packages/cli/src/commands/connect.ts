import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { error, info, warn } from '../utils/output.js';

const require = createRequire(import.meta.url);

export async function handleConnect(args: string[]): Promise<number> {
  const shimCommand = resolveShimCommand();
  if (!shimCommand) {
    warn('@hivemind-os/collective-shim is not available in this environment.');
    info('Build or install the shim package, then configure your MCP app to run `mesh connect`.');
    info('In the meantime, start the background service with `mesh daemon start`.');
    return 1;
  }

  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(shimCommand.command, [...shimCommand.args, ...args], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolvePromise(code ?? 0);
    });
  }).catch((caught) => {
    error(caught instanceof Error ? caught.message : String(caught));
    return 1;
  });
}

function resolveShimCommand(): { command: string; args: string[] } | undefined {
  try {
    const packageJsonPath = require.resolve('@hivemind-os/collective-shim/package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { bin?: string | Record<string, string> };
    const binField =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.['mesh-shim'] ?? Object.values(packageJson.bin ?? {})[0];
    if (!binField) {
      return undefined;
    }

    const entryPath = resolve(dirname(packageJsonPath), binField);
    return {
      command: process.execPath,
      args: [entryPath],
    };
  } catch {
    const onPath = process.platform === 'win32' ? findOnPath('mesh-shim.cmd') ?? findOnPath('mesh-shim') : findOnPath('mesh-shim');
    return onPath ? { command: onPath, args: [] } : undefined;
  }
}

function findOnPath(command: string): string | undefined {
  const checker = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(checker, [command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    return undefined;
  }

  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
}
