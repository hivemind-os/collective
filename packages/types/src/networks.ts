import type { NetworkConfig } from './config.js';

export type NetworkName = 'testnet' | 'mainnet' | 'devnet' | 'local';

export interface NetworkPreset extends NetworkConfig {
  name: NetworkName;
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
    packageId: '0xad62fa133e2ad67889f6452fb8b8303a369be1c762e94f18896307202229c61f',
    registryId: '0x1d595fe6ac6be0d86ca233b2029ecaf3e1aed110ff947f3335aaddef7a7fec9d',
    explorerUrl: 'https://suiscan.xyz/testnet',
  },
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://fullnode.mainnet.sui.io:443',
    faucetUrl: '',
    packageId: '',
    registryId: '',
    explorerUrl: 'https://suiscan.xyz/mainnet',
  },
  devnet: {
    name: 'devnet',
    rpcUrl: 'https://fullnode.devnet.sui.io:443',
    faucetUrl: 'https://faucet.devnet.sui.io',
    packageId: '',
    registryId: '',
    explorerUrl: 'https://suiscan.xyz/devnet',
  },
  local: {
    name: 'local',
    rpcUrl: 'http://127.0.0.1:9000',
    faucetUrl: 'http://127.0.0.1:9123',
    packageId: '',
    registryId: '',
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
