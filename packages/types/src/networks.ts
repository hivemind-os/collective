import type { NetworkConfig } from './config.js';

export type NetworkName = 'testnet' | 'mainnet' | 'devnet' | 'local';

export interface NetworkPreset extends NetworkConfig {
  name: NetworkName;
  usdcType?: string;
  explorerUrl: string;
}

/**
 * Well-known contract deployments for each Sui network.
 * Updated after each deploy-contracts.yml run.
 */
export const NETWORK_PRESETS: Record<NetworkName, NetworkPreset> = {
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
    faucetUrl: 'https://faucet.testnet.sui.io',
    packageId: '0xfee2ef1dbe1a360487067166d53fd407b6607cbb6d67416b3fdc29b8cd67617e',
    registryId: '0xf49ca16365ed8b43c91aff7901da254b345cedd8fe6a5d191c10418708471798',
    usdcType: '',
    explorerUrl: 'https://suiscan.xyz/testnet',
  },
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://fullnode.mainnet.sui.io:443',
    faucetUrl: '',
    packageId: '',
    registryId: '',
    usdcType: '',
    explorerUrl: 'https://suiscan.xyz/mainnet',
  },
  devnet: {
    name: 'devnet',
    rpcUrl: 'https://fullnode.devnet.sui.io:443',
    faucetUrl: 'https://faucet.devnet.sui.io',
    packageId: '',
    registryId: '',
    usdcType: '',
    explorerUrl: 'https://suiscan.xyz/devnet',
  },
  local: {
    name: 'local',
    rpcUrl: 'http://127.0.0.1:9000',
    faucetUrl: 'http://127.0.0.1:9123',
    packageId: '',
    registryId: '',
    usdcType: '',
    explorerUrl: '',
  },
};

/**
 * Resolve a network name to its preset configuration.
 * Returns undefined if the name is not recognized.
 */
export function getNetworkPreset(name: string): NetworkPreset | undefined {
  return NETWORK_PRESETS[name as NetworkName];
}

/**
 * List all available network preset names.
 */
export function getNetworkNames(): NetworkName[] {
  return Object.keys(NETWORK_PRESETS) as NetworkName[];
}
