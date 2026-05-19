import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createDID, ed25519ToX25519, loadOrCreateKeypair, MeshSuiClient, RegistryClient } from '@hivemind-os/collective-core';
import { PaymentRail, type Capability } from '@hivemind-os/collective-types';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import yaml from 'js-yaml';

import { loadMeshConfig } from './config.js';
import { success } from '../utils/output.js';

interface ProviderDefinition {
  name: string;
  description: string;
  capabilities: Capability[];
}

export async function handleRegister(args: string[]): Promise<number> {
  const definition = loadProviderDefinition(args);
  const config = loadMeshConfig();
  assertNetworkConfigured(config.network);

  const identity = await loadOrCreateKeypair(config.identity.dataDir, { allowInsecureFileStorage: true });
  const did = createDID(identity.publicKey);
  const keypair = Ed25519Keypair.fromSecretKey(identity.secretKey);
  const encryptionKeyPair = ed25519ToX25519(identity.secretKey);
  const suiClient = new MeshSuiClient(config.network);
  const registryClient = new RegistryClient(suiClient, config.network);

  const result = await registryClient.registerAgent({
    name: definition.name,
    did,
    description: definition.description,
    capabilities: definition.capabilities,
    endpoint: `mesh://agent/${did}`,
    encryptionPublicKey: encryptionKeyPair.publicKey,
    keypair,
  });

  success('Provider registered on Agentic Mesh.');
  console.log(`Agent Card ID: ${result.agentCardId}`);
  console.log(`DID: ${did}`);
  console.log(`Tx Digest: ${result.txDigest}`);
  return 0;
}

function loadProviderDefinition(args: string[]): ProviderDefinition {
  const configFlagIndex = args.indexOf('--config');
  if (configFlagIndex >= 0) {
    const configPath = args[configFlagIndex + 1];
    if (!configPath) {
      throw new Error('Usage: mesh register --config <path>');
    }
    return parseProviderConfigFile(resolve(configPath));
  }

  const name = readFlag(args, '--name');
  const description = readFlag(args, '--description') ?? `${name ?? 'Agent'} provider`;
  const capabilityFlags = readFlags(args, '--capability');
  if (!name || capabilityFlags.length === 0) {
    throw new Error('Usage: mesh register --name <name> --capability "name:description:version:price_mist"');
  }

  return {
    name,
    description,
    capabilities: capabilityFlags.map(parseInlineCapability),
  };
}

function parseProviderConfigFile(path: string): ProviderDefinition {
  const loaded = yaml.load(readFileSync(path, 'utf8'));
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error(`Invalid provider config: ${path}`);
  }

  const record = loaded as Record<string, unknown>;
  const name = asString(record.name);
  const description = asString(record.description) ?? `${name ?? 'Agent'} provider`;
  const capabilitiesRaw = Array.isArray(record.capabilities) ? record.capabilities : [];
  const capabilities = capabilitiesRaw.map((entry, index) => parseCapabilityRecord(entry, index));
  if (!name || capabilities.length === 0) {
    throw new Error('Provider config must include name and at least one capability.');
  }

  return { name, description, capabilities };
}

function parseCapabilityRecord(value: unknown, index: number): Capability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`capabilities[${index}] must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const pricing = record.pricing && typeof record.pricing === 'object' && !Array.isArray(record.pricing)
    ? (record.pricing as Record<string, unknown>)
    : undefined;
  const amount =
    pricing?.amount ??
    record.priceMist ??
    record.price_mist ??
    record.price;

  const name = asString(record.name);
  const description = asString(record.description);
  const version = asString(record.version);
  if (!name || !description || !version || amount === undefined) {
    throw new Error(`capabilities[${index}] is missing required fields.`);
  }

  return buildCapability(name, description, version, amount);
}

function parseInlineCapability(value: string): Capability {
  const parts = value.split(':');
  if (parts.length < 4) {
    throw new Error(`Invalid capability format: ${value}`);
  }

  const [name, description, version, ...priceParts] = parts;
  return buildCapability(name, description, version, priceParts.join(':'));
}

function buildCapability(name: string, description: string, version: string, amount: unknown): Capability {
  return {
    name,
    description,
    version,
    pricing: {
      rail: PaymentRail.SUI_ESCROW,
      amount: parseMistAmount(amount),
      currency: 'MIST',
    },
  };
}

function parseMistAmount(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.floor(value));
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`Invalid MIST amount: ${String(value)}`);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readFlags(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1] as string);
    }
  }
  return values;
}

function assertNetworkConfigured(network: { packageId: string; registryId: string }): void {
  if (!network.packageId || !network.registryId) {
    throw new Error('network.packageId and network.registryId must be configured before registering.');
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
