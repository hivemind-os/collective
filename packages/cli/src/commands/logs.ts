import { createReadStream, existsSync, readFileSync, watchFile } from 'node:fs';

import { loadMeshConfig } from './config.js';
import { info } from '../utils/output.js';

export async function handleLogs(args: string[]): Promise<number> {
  const lines = Number.parseInt(readFlag(args, '--lines') ?? '50', 10);
  const follow = args.includes('--follow');
  const config = loadMeshConfig();
  const logFile = config.daemon.logFile;
  if (!logFile || !existsSync(logFile)) {
    throw new Error('Daemon log file does not exist yet. Start the daemon first.');
  }

  const contents = readFileSync(logFile, 'utf8');
  const selected = contents
    .split(/\r?\n/)
    .slice(-Math.max(1, lines))
    .join('\n')
    .trim();
  if (selected) {
    console.log(selected);
  }

  if (!follow) {
    return 0;
  }

  info(`Following ${logFile}`);
  watchFile(logFile, { interval: 500 }, (current, previous) => {
    if (current.size <= previous.size) {
      return;
    }

    const stream = createReadStream(logFile, {
      encoding: 'utf8',
      start: previous.size,
      end: current.size,
    });
    stream.on('data', (chunk) => {
      process.stdout.write(chunk);
    });
  });

  await new Promise(() => undefined);
  return 0;
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
