import { afterEach, describe, expect, it, vi } from 'vitest';
import { hexToBytes, recoverMessageAddress, verifyTypedData } from 'viem';

import { EvmWallet } from '../../src/index.js';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TOKEN_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EvmWallet', () => {
  it('creates a wallet from a private key with the expected address', () => {
    const wallet = new EvmWallet(hexToBytes(PRIVATE_KEY), { network: 'base' });

    expect(wallet.address).toBe(ADDRESS);
  });

  it('signs messages with a recoverable signature', async () => {
    const wallet = new EvmWallet(hexToBytes(PRIVATE_KEY), { network: 'base' });

    const signature = await wallet.signMessage('hello x402');
    const recovered = await recoverMessageAddress({ message: 'hello x402', signature: signature as `0x${string}` });

    expect(recovered).toBe(ADDRESS);
  });

  it('signs typed data that verifies against the wallet address', async () => {
    const wallet = new EvmWallet(hexToBytes(PRIVATE_KEY), { network: 'base-sepolia' });
    const typedData = {
      domain: {
        name: 'AgenticMeshTest',
        version: '1',
        chainId: 84_532,
        verifyingContract: '0x0000000000000000000000000000000000000001',
      },
      types: {
        PaymentAuthorization: [
          { name: 'paymentAddress', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'nonce', type: 'string' },
        ],
      },
      primaryType: 'PaymentAuthorization',
      message: {
        paymentAddress: '0x0000000000000000000000000000000000000002',
        amount: 123n,
        nonce: 'nonce-1',
      },
    } as const;

    const signature = await wallet.signTypedData(typedData);
    const verified = await verifyTypedData({
      address: ADDRESS,
      ...typedData,
      signature: signature as `0x${string}`,
    });

    expect(verified).toBe(true);
  });

  it('queries balances through RPC calls', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === 'eth_getBalance') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5af3107a4000' }));
      }

      if (body.method === 'eth_call') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: '0x00000000000000000000000000000000000000000000000000000000000004d2',
          }),
        );
      }

      throw new Error(`Unexpected RPC method: ${body.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const wallet = new EvmWallet(hexToBytes(PRIVATE_KEY), {
      network: 'base-sepolia',
      rpcUrl: 'https://example.com/rpc',
    });

    await expect(wallet.getBalance()).resolves.toBe(100_000_000_000_000n);
    await expect(wallet.getTokenBalance(TOKEN_ADDRESS)).resolves.toBe(1_234n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the expected chain ids for supported networks', () => {
    expect(new EvmWallet(hexToBytes(PRIVATE_KEY), { network: 'base' }).chain.id).toBe(8453);
    expect(new EvmWallet(hexToBytes(PRIVATE_KEY), { network: 'base-sepolia' }).chain.id).toBe(84_532);
    expect(new EvmWallet(hexToBytes(PRIVATE_KEY), { network: 'localhost' }).chain.id).toBe(31_337);
  });
});
