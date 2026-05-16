export type NetworkMode = 'local' | 'devnet' | 'testnet';

export interface RemoteNetworkInfo {
  rpcUrl: string;
  faucetUrl: string;
}

export const REMOTE_NETWORKS: Record<'devnet' | 'testnet', RemoteNetworkInfo> = {
  devnet: {
    rpcUrl: 'https://fullnode.devnet.sui.io:443',
    faucetUrl: 'https://faucet.devnet.sui.io',
  },
  testnet: {
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
    faucetUrl: 'https://faucet.testnet.sui.io',
  },
};

export function resolveNetworkMode(): NetworkMode {
  const env = process.env.SUI_NETWORK?.toLowerCase().trim();
  if (env === 'local' || env === 'devnet' || env === 'testnet') {
    return env;
  }

  return 'devnet';
}
