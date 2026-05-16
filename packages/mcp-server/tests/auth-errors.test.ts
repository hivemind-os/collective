import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { SessionExpiredError } from '@agentic-mesh/core';

import { registerMeshTools, type MeshToolContext } from '../src/index.js';

function createContext(): MeshToolContext {
  return {
    did: 'did:mesh:test' as MeshToolContext['did'],
    keypair: {
      getPublicKey: () => {
        throw new SessionExpiredError();
      },
    } as MeshToolContext['keypair'],
    suiClient: {
      getBalance: vi.fn().mockResolvedValue(0n),
      queryEvents: vi.fn(),
    } as unknown as MeshToolContext['suiClient'],
    registryClient: {
      discoverByCapability: vi.fn().mockResolvedValue([]),
      getAgentCard: vi.fn(),
    } as unknown as MeshToolContext['registryClient'],
    taskClient: {} as MeshToolContext['taskClient'],
    agentCache: {
      searchByCapability: vi.fn().mockReturnValue([]),
      getAgentByDID: vi.fn(),
      getAllActive: vi.fn().mockReturnValue([]),
      upsertAgent: vi.fn(),
      removeAgent: vi.fn(),
    } as unknown as MeshToolContext['agentCache'],
    blobStore: {} as MeshToolContext['blobStore'],
    spendingPolicy: {
      getSpent: vi.fn().mockReturnValue(0n),
    } as unknown as MeshToolContext['spendingPolicy'],
    networkConfig: {
      rpcUrl: 'http://127.0.0.1:9000',
      faucetUrl: 'http://127.0.0.1:9123',
      packageId: '0x1',
      registryId: '0x2',
    },
    authProvider: {
      getSessionState: vi.fn().mockResolvedValue('reauth_required'),
    } as never,
  };
}

describe('MCP auth errors', () => {
  it('returns a clear reauth message for expired sessions', async () => {
    const handlers = new Map<unknown, (request: { params: { name: string; arguments?: unknown } }) => Promise<unknown>>();
    const server = {
      setRequestHandler: vi.fn((schema: unknown, handler: (request: { params: { name: string; arguments?: unknown } }) => Promise<unknown>) => {
        handlers.set(schema, handler);
      }),
    } as unknown as Server;

    registerMeshTools(server, createContext());

    const callTool = handlers.get(CallToolRequestSchema);
    const result = await callTool?.({
      params: {
        name: 'mesh_balance',
        arguments: {},
      },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining('Authentication expired. Please re-authenticate via the daemon portal.'),
        },
      ],
    });
    expect(result).toMatchObject({
      content: [
        {
          text: expect.stringContaining('"session_state": "reauth_required"'),
        },
      ],
    });
  });
});
