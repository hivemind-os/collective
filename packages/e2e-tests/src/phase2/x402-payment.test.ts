import { spawn, spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import { EvmWallet, X402Client, deriveEvmKey } from '@agentic-mesh/core';
import { PaymentGate } from '@agentic-mesh/relay';
import { PaymentRail } from '@agentic-mesh/types';

import { PortAllocator } from '../harness/index.js';
import { createArtifactRoot, removeDirectoryWithRetries, waitForCondition } from '../phase1/test-helpers.js';
import {
  connectTestProvider,
  createProviderSession,
  createTestIdentity,
  postRelayExecute,
  startTestRelay,
} from './test-helpers.js';

let artifactRoot: string;

const runAnvilTests =
  Boolean(process.env.RUN_ANVIL_TESTS) && spawnSync('where', ['anvil'], { stdio: 'ignore' }).status === 0;
const anvilIt = runAnvilTests ? it : it.skip;

afterAll(async () => {
  if (artifactRoot) {
    await removeDirectoryWithRetries(artifactRoot);
  }
}, 30_000);

describe('Phase 2 E2E: x402 Payment Flow', () => {
  it('EVM wallet created from an HKDF-derived key is deterministic', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-x402');
    const identityKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

    const firstKey = deriveEvmKey(identityKey, 'mesh-user-salt', 'oauth-user-123');
    const secondKey = deriveEvmKey(identityKey, 'mesh-user-salt', 'oauth-user-123');
    const firstWallet = new EvmWallet(firstKey, { network: 'base-sepolia' });
    const secondWallet = new EvmWallet(secondKey, { network: 'base-sepolia' });

    expect(firstWallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(firstWallet.address).toBe(secondWallet.address);
    expect(Buffer.from(firstKey).toString('hex')).toBe(Buffer.from(secondKey).toString('hex'));
  });

  it('x402 client parses a relay 402 response correctly', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-x402');
    const wallet = new EvmWallet(deriveEvmKey(new Uint8Array(32).fill(7), 'salt', 'subject'), { network: 'base-sepolia' });
    const client = new X402Client(wallet);
    const provider = createTestIdentity();
    const gate = new PaymentGate({
      relayDid: 'did:mesh:relay:test',
      feeSchedule: {
        basePercentage: 5,
        minimumMist: 1n,
      },
      basePriceResolver: () => 25n,
    });

    const challenge = gate.generate402Challenge(PaymentRail.X402_BASE, 'echo', createProviderSession(provider.did, ['echo']));
    const request = client.parse402Response(
      { 'payment-required': challenge.extra?.['payment-required'] ?? '' },
      { payment: challenge },
    );

    expect(request.paymentAddress).toBe(challenge.paymentAddress);
    expect(request.amount).toBe(challenge.amount);
    expect(request.currency).toBe('USDC');
    expect(request.network).toBe('base-sepolia');
    expect(request.nonce).toBe(challenge.nonce);
    expect(request.expiresAt).toBe(challenge.expiresAt);
  });

  it('x402 client signs payment authorization', async () => {
    const wallet = new EvmWallet(deriveEvmKey(new Uint8Array(32).fill(11), 'salt', 'subject'), { network: 'base-sepolia' });
    const client = new X402Client(wallet);
    const request = {
      paymentAddress: '0x0000000000000000000000000000000000000abc',
      amount: '25',
      currency: 'USDC',
      network: 'base-sepolia',
      nonce: 'nonce-1',
      expiresAt: Date.now() + 60_000,
    };

    const signature = await client.signPayment(request);
    const verified = await client.verifyPayment(signature, request);

    expect(signature.signature).toMatch(/^0x[a-fA-F0-9]+$/);
    expect(signature.payerAddress).toBe(wallet.address);
    expect(signature.network).toBe('base-sepolia');
    expect(verified).toBe(true);
  });

  it('completes a 402 challenge-response cycle against the relay', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-x402');
    const wallet = new EvmWallet(deriveEvmKey(new Uint8Array(32).fill(13), 'salt', 'subject'), { network: 'base-sepolia' });
    const relayServer = await startTestRelay({
      artifactRoot,
      name: 'x402-relay',
      verifyPayment: async (paymentHeader) => ({
        accepted: paymentHeader.length > 0,
        payer: wallet.address,
        settlementReference: 'mock-x402-receipt',
      }),
    });
    const provider = await connectTestProvider({
      wsUrl: relayServer.wsUrl,
      capabilities: ['echo'],
      onTaskRequest: async (message, connection) => {
        await connection.sendResult(message.taskId, { ok: true, rail: 'x402', input: message.input });
      },
    });
    const requester = createTestIdentity();
    const x402Client = new X402Client(wallet);

    try {
      const challengeResponse = await postRelayExecute({
        httpUrl: relayServer.httpUrl,
        providerDid: provider.identity.did,
        capability: 'echo',
        requesterDid: requester.did,
        paymentRail: PaymentRail.X402_BASE,
        input: { message: 'pay via x402' },
      });
      expect(challengeResponse.status).toBe(402);

      const challengeBody = (await challengeResponse.json()) as { payment: Parameters<X402Client['createPaymentHeader']>[0] & { nonce: string } };
      const paymentHeader = await x402Client.createPaymentHeader(
        x402Client.parse402Response({}, challengeBody),
      );
      const paidResponse = await postRelayExecute({
        httpUrl: relayServer.httpUrl,
        providerDid: provider.identity.did,
        capability: 'echo',
        requesterDid: requester.did,
        paymentRail: PaymentRail.X402_BASE,
        input: { message: 'pay via x402' },
        headers: {
          'payment-signature': paymentHeader,
          'x-mesh-payment-nonce': challengeBody.payment.nonce,
        },
      });

      expect(paidResponse.status).toBe(200);
      expect(paidResponse.headers.get('payment-response')).toBe('mock-x402-receipt');
      await expect(paidResponse.json()).resolves.toEqual({
        ok: true,
        rail: 'x402',
        input: { message: 'pay via x402' },
      });
    } finally {
      await provider.close().catch(() => undefined);
      await relayServer.stop();
    }
  });

  anvilIt('EVM wallet can send a transaction on local Anvil', async () => {
    artifactRoot ??= await createArtifactRoot('phase2-x402');
    const allocator = new PortAllocator();
    const [port] = await allocator.allocate(1);
    const rpcUrl = `http://127.0.0.1:${port}`;
    const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337'], {
      stdio: 'ignore',
    });

    try {
      await waitForCondition(async () => {
        try {
          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          });
          return response.ok ? true : undefined;
        } catch {
          return undefined;
        }
      }, 10_000, 'Anvil RPC did not become ready.');

      const sender = new EvmWallet(hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'), {
        network: 'localhost',
        rpcUrl,
      });
      const receiver = new EvmWallet(hexToBytes('0x59c6995e998f97a5a0044966f0945386f047b9d0f2c3f2a40c7e46787fba5c27'), {
        network: 'localhost',
        rpcUrl,
      });

      const beforeBalance = await receiver.getBalance();
      const txHash = await sender.sendTransaction(receiver.address, 1_000_000_000_000_000n);
      await sender.getPublicClient().waitForTransactionReceipt({ hash: txHash as `0x${string}` });
      const afterBalance = await receiver.getBalance();

      expect(afterBalance).toBeGreaterThan(beforeBalance);
    } finally {
      anvil.kill();
      await allocator.release([port]);
    }
  }, 30_000);
});

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replace(/^0x/i, ''), 'hex'));
}
