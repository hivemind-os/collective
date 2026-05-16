import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { createDID, identityKeyExists, loadOrCreateKeypair } from '@agentic-mesh/core';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { buildDefaultConfig, getConfigPath, getMeshDataDir, saveMeshConfig } from './config.js';
import { success } from '../utils/output.js';

export async function handleInit(args: string[]): Promise<number> {
  void args;
  const dataDir = getMeshDataDir();
  const configPath = getConfigPath();
  const configExists = existsSync(configPath);
  const defaultConfig = buildDefaultConfig(dataDir);
  const keyExists = await identityKeyExists(defaultConfig.identity.dataDir);

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(defaultConfig.identity.dataDir, { recursive: true });
  success(`Created data directory: ${displayPath(dataDir)}`);

  const identity = await loadOrCreateKeypair(defaultConfig.identity.dataDir);
  const did = createDID(identity.publicKey);
  const address = Ed25519Keypair.fromSecretKey(identity.secretKey).getPublicKey().toSuiAddress();

  success(keyExists ? 'Loaded identity key' : 'Generated identity key');
  console.log(`  DID: ${did}`);
  console.log(`  Sui Address: ${address}`);

  if (!configExists) {
    saveMeshConfig(defaultConfig, configPath);
  }
  success(`${configExists ? 'Using existing config' : 'Created config'}: ${displayPath(configPath)}`);

  console.log('');
  console.log('Next steps:');
  console.log('  1. Fund your wallet: mesh wallet fund');
  console.log('  2. Start the daemon: mesh daemon start');
  console.log('  3. Configure your MCP app to use: mesh connect');
  return 0;
}

function displayPath(value: string): string {
  const home = homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}
