import type { Chain, PublicClient, WalletClient } from 'viem';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

const LOCALHOST_RPC_URL = 'http://127.0.0.1:8545';
const erc20BalanceOfAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

export interface EvmWalletConfig {
  network: 'base' | 'base-sepolia' | 'localhost';
  rpcUrl?: string;
}

export class EvmWallet {
  private readonly account;
  private readonly chainConfig: Chain;
  private readonly walletClient: WalletClient;
  private readonly publicClient: PublicClient;

  constructor(privateKey: Uint8Array, private readonly config: EvmWalletConfig) {
    if (privateKey.byteLength !== 32) {
      throw new Error('EVM private key must be 32 bytes.');
    }

    this.account = privateKeyToAccount(toHex(privateKey));
    this.chainConfig = resolveChain(config);

    const transport = http(resolveRpcUrl(config));
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chainConfig,
      transport,
    });
    this.publicClient = createPublicClient({
      chain: this.chainConfig,
      transport,
    });
  }

  get address(): string {
    return this.account.address;
  }

  get chain(): Chain {
    return this.chainConfig;
  }

  async getBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  async getTokenBalance(tokenAddress: string): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: getAddress(tokenAddress),
      abi: erc20BalanceOfAbi,
      functionName: 'balanceOf',
      args: [this.account.address],
    })) as bigint;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    return this.walletClient.signMessage({
      account: this.account,
      message: typeof message === 'string' ? message : { raw: toHex(message) },
    });
  }

  async signTypedData(typedData: Omit<Parameters<WalletClient['signTypedData']>[0], 'account'>): Promise<string> {
    return this.walletClient.signTypedData({
      ...typedData,
      account: this.account,
    });
  }

  async sendTransaction(to: string, value: bigint): Promise<string> {
    return this.walletClient.sendTransaction({
      account: this.account,
      chain: this.chainConfig,
      to: getAddress(to),
      value,
    });
  }

  getWalletClient(): WalletClient {
    return this.walletClient;
  }

  getPublicClient(): PublicClient {
    return this.publicClient;
  }
}

function resolveChain(config: EvmWalletConfig): Chain {
  switch (config.network) {
    case 'base':
      return base;
    case 'base-sepolia':
      return baseSepolia;
    case 'localhost':
      return defineChain({
        id: 31_337,
        name: 'Localhost',
        nativeCurrency: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
        rpcUrls: {
          default: {
            http: [config.rpcUrl ?? LOCALHOST_RPC_URL],
          },
        },
        testnet: true,
      });
  }
}

function resolveRpcUrl(config: EvmWalletConfig): string | undefined {
  if (config.rpcUrl) {
    return config.rpcUrl;
  }

  if (config.network === 'localhost') {
    return LOCALHOST_RPC_URL;
  }

  return undefined;
}
