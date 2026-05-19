import { createDID, loadOrCreateKeypair, MeshSuiClient } from '@hivemind-os/collective-core';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { loadMeshConfig } from './config.js';
import { info, success, warn } from '../utils/output.js';

export async function handleWallet(subcommand?: string, args: string[] = []): Promise<number> {
  void args;
  switch (subcommand) {
    case 'balance':
      return await showBalance();
    case 'fund':
      return await fundWallet();
    case 'address':
      return await showAddress();
    default:
      throw new Error('Usage: mesh wallet <balance|fund|address>');
  }
}

export function formatMistToSui(balanceMist: bigint): string {
  const whole = balanceMist / 1_000_000_000n;
  const fraction = balanceMist % 1_000_000_000n;
  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionText = fraction.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}

export function parseSuiToMist(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(trimmed)) {
    throw new Error(`Invalid SUI amount: ${input}`);
  }

  const [whole, fraction = ''] = trimmed.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}

async function showBalance(): Promise<number> {
  const { config, address } = await loadWalletContext();
  const suiClient = new MeshSuiClient(config.network);
  const balanceMist = await suiClient.getBalance(address);
  success(`Wallet balance for ${address}`);
  console.log(`MIST: ${balanceMist.toString()}`);
  console.log(`SUI: ${formatMistToSui(balanceMist)}`);
  return 0;
}

async function fundWallet(): Promise<number> {
  const { config, address, did } = await loadWalletContext();
  info(`Requesting faucet funds for ${address}`);
  const faucetUrls = [config.network.faucetUrl, `${config.network.faucetUrl.replace(/\/$/, '')}/gas`].filter(Boolean);

  let funded = false;
  for (const faucetUrl of faucetUrls) {
    try {
      const response = await fetch(faucetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          FixedAmountRequest: {
            recipient: address,
          },
        }),
      });
      if (response.ok) {
        funded = true;
        break;
      }
    } catch {
      // Try the next faucet endpoint shape.
    }
  }

  if (funded) {
    success('Faucet request submitted.');
  } else {
    warn('Automatic faucet request failed. Use your configured faucet or wallet UI to fund this address manually.');
  }
  console.log(`DID: ${did}`);
  console.log(`Address: ${address}`);
  console.log(`Faucet: ${config.network.faucetUrl}`);
  return funded ? 0 : 1;
}

async function showAddress(): Promise<number> {
  const { address } = await loadWalletContext();
  console.log(address);
  return 0;
}

async function loadWalletContext(): Promise<{ config: ReturnType<typeof loadMeshConfig>; did: string; address: string }> {
  const config = loadMeshConfig();
  const identity = await loadOrCreateKeypair(config.identity.dataDir, { allowInsecureFileStorage: true });
  const did = createDID(identity.publicKey);
  const keypair = Ed25519Keypair.fromSecretKey(identity.secretKey);
  return {
    config,
    did,
    address: keypair.getPublicKey().toSuiAddress(),
  };
}
