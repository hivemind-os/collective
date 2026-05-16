import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { SessionState } from '@hivemind-os/collective-core';

import { registerMeshTools, type MeshToolContext } from '../src/index.js';

function createContext(): MeshToolContext {
  return {
    did: 'did:mesh:test' as MeshToolContext['did'],
    keypair: {
      getPublicKey: () => ({
        toSuiAddress: () => '0xabc',
      }),
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
  };
}

describe('MeshToolContext and registration', () => {
  it('constructs a tool context with mocked dependencies', () => {
    const context = createContext();

    expect(context.did).toBe('did:mesh:test');
    expect(context.networkConfig.packageId).toBe('0x1');
  });

  it('registers the expected tools and resources', async () => {
    const handlers = new Map<unknown, (request?: unknown) => Promise<unknown>>();
    const server = {
      setRequestHandler: vi.fn((schema: unknown, handler: (request?: unknown) => Promise<unknown>) => {
        handlers.set(schema, handler);
      }),
    } as unknown as Server;

    registerMeshTools(server, createContext());

    const listTools = await handlers.get(ListToolsRequestSchema)?.();
    const listResources = await handlers.get(ListResourcesRequestSchema)?.();
    const listTemplates = await handlers.get(ListResourceTemplatesRequestSchema)?.();

    expect(listTools.tools).toHaveLength(20);
    expect(listTools.tools.map((tool: { name: string }) => tool.name)).toContain('collective_relay_registry');
    expect(listResources.resources).toHaveLength(2);
    expect(listTemplates.resourceTemplates).toHaveLength(2);
  });

  it('includes auth session state in tool errors', async () => {
    const handlers = new Map<unknown, (request?: unknown) => Promise<unknown>>();
    const server = {
      setRequestHandler: vi.fn((schema: unknown, handler: (request?: unknown) => Promise<unknown>) => {
        handlers.set(schema, handler);
      }),
    } as unknown as Server;
    const context = createContext();
    context.suiClient = {
      ...context.suiClient,
      getBalance: vi.fn(async () => {
        throw new Error('wallet unavailable');
      }),
    } as MeshToolContext['suiClient'];
    context.authProvider = {
      getSessionState: () => SessionState.NEEDS_REAUTH,
    } as MeshToolContext['authProvider'];

    registerMeshTools(server, context);

    const callTool = await handlers.get(CallToolRequestSchema)?.({
      params: {
        name: 'collective_balance',
        arguments: {},
      },
    });
    const payload = JSON.parse(callTool.content[0].text) as Record<string, unknown>;

    expect(callTool.isError).toBe(true);
    expect(payload.error).toBe('wallet unavailable (session state: needs_reauth)');
    expect(payload.session_state).toBe('needs_reauth');
    expect(payload.reauth_required).toBe(false);
  });
});
