import type { MeshToolContext, ProviderConfigSnapshot } from '../context.js';

export const meshProviderConfigTool = {
  name: 'collective_provider_config',
  description:
    'Manage the local provider configuration. ' +
    'Actions: "get" returns the current provider config; ' +
    '"set_enabled" enables or disables provider mode; ' +
    '"add_capability" adds a new capability; ' +
    '"update_capability" updates an existing capability by name; ' +
    '"remove_capability" removes a capability by name. ' +
    'Changes are persisted and the provider runtime is restarted automatically.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set_enabled', 'add_capability', 'update_capability', 'remove_capability'],
        description: 'The action to perform.',
      },
      enabled: {
        type: 'boolean',
        description: 'For set_enabled: whether to enable or disable provider mode.',
      },
      autoRegister: {
        type: 'boolean',
        description: 'For set_enabled: whether to auto-register the agent card on start.',
      },
      capability: {
        type: 'object',
        description:
          'For add_capability/update_capability: the capability definition. ' +
          'Fields: name (string), description (string), version (string), priceMist (integer), ' +
          'adapter (job-queue|echo|webhook|mcp-sampling|subprocess), adapterConfig (object, optional).',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          version: { type: 'string' },
          priceMist: { type: 'number' },
          currency: { type: 'string' },
          adapter: { type: 'string' },
          adapterConfig: { type: 'object' },
        },
      },
      name: {
        type: 'string',
        description: 'For remove_capability/update_capability: the name of the capability to target.',
      },
    },
    required: ['action'],
  },
};

interface ProviderConfigParams {
  action: 'get' | 'set_enabled' | 'add_capability' | 'update_capability' | 'remove_capability';
  enabled?: boolean;
  autoRegister?: boolean;
  capability?: {
    name?: string;
    description?: string;
    version?: string;
    priceMist?: number;
    currency?: string;
    adapter?: string;
    adapterConfig?: Record<string, unknown>;
  };
  name?: string;
}

const VALID_ADAPTERS = new Set(['job-queue', 'echo', 'webhook', 'mcp-sampling', 'subprocess']);

export async function runMeshProviderConfig(
  params: ProviderConfigParams,
  context: MeshToolContext,
): Promise<unknown> {
  if (!context.providerConfig) {
    throw new Error('Provider configuration is not available. The daemon may not support this feature.');
  }

  const { action } = params;

  if (action === 'get') {
    return context.providerConfig.get();
  }

  if (action === 'set_enabled') {
    if (typeof params.enabled !== 'boolean') {
      throw new Error('"enabled" must be a boolean for set_enabled action.');
    }

    const current = context.providerConfig.get();
    const next: ProviderConfigSnapshot = {
      ...current,
      enabled: params.enabled,
      ...(typeof params.autoRegister === 'boolean' ? { autoRegister: params.autoRegister } : {}),
    };

    return await context.providerConfig.set(next);
  }

  if (action === 'add_capability') {
    const cap = params.capability;
    if (!cap) {
      throw new Error('"capability" object is required for add_capability action.');
    }

    const validationError = validateCapability(cap);
    if (validationError) {
      throw new Error(validationError);
    }

    const current = context.providerConfig.get();
    const normalized = normalizeCapability(cap);

    // Check for duplicate name
    const existingIndex = current.capabilities.findIndex(
      (c) => c.name.toLowerCase().trim() === normalized.name.toLowerCase().trim(),
    );
    if (existingIndex >= 0) {
      throw new Error(`A capability named "${normalized.name}" already exists. Use update_capability instead.`);
    }

    const next: ProviderConfigSnapshot = {
      ...current,
      capabilities: [...current.capabilities, normalized],
    };

    return await context.providerConfig.set(next);
  }

  if (action === 'update_capability') {
    const targetName = params.name ?? params.capability?.name;
    if (!targetName) {
      throw new Error('"name" is required for update_capability action (identifies which capability to update).');
    }

    const cap = params.capability;
    if (!cap) {
      throw new Error('"capability" object is required for update_capability action.');
    }

    const validationError = validateCapability(cap);
    if (validationError) {
      throw new Error(validationError);
    }

    const current = context.providerConfig.get();
    const existingIndex = current.capabilities.findIndex(
      (c) => c.name.toLowerCase().trim() === targetName.toLowerCase().trim(),
    );
    if (existingIndex < 0) {
      throw new Error(`No capability named "${targetName}" found. Use add_capability to create it.`);
    }

    const normalized = normalizeCapability(cap);
    const updatedCapabilities = [...current.capabilities];
    updatedCapabilities[existingIndex] = normalized;

    const next: ProviderConfigSnapshot = {
      ...current,
      capabilities: updatedCapabilities,
    };

    return await context.providerConfig.set(next);
  }

  if (action === 'remove_capability') {
    const targetName = params.name;
    if (!targetName) {
      throw new Error('"name" is required for remove_capability action.');
    }

    const current = context.providerConfig.get();
    const existingIndex = current.capabilities.findIndex(
      (c) => c.name.toLowerCase().trim() === targetName.toLowerCase().trim(),
    );
    if (existingIndex < 0) {
      throw new Error(`No capability named "${targetName}" found.`);
    }

    const updatedCapabilities = current.capabilities.filter((_, i) => i !== existingIndex);
    const next: ProviderConfigSnapshot = {
      ...current,
      capabilities: updatedCapabilities,
    };

    return await context.providerConfig.set(next);
  }

  throw new Error(`Unknown action: ${action}. Valid actions: get, set_enabled, add_capability, update_capability, remove_capability.`);
}

function validateCapability(cap: NonNullable<ProviderConfigParams['capability']>): string | null {
  if (!cap.name || typeof cap.name !== 'string' || cap.name.trim().length === 0) {
    return 'Capability "name" is required.';
  }
  if (!cap.description || typeof cap.description !== 'string' || cap.description.trim().length === 0) {
    return 'Capability "description" is required.';
  }
  if (!cap.version || typeof cap.version !== 'string' || cap.version.trim().length === 0) {
    return 'Capability "version" is required.';
  }
  if (!Number.isInteger(cap.priceMist) || (cap.priceMist as number) <= 0) {
    return 'Capability "priceMist" must be a positive integer.';
  }
  if (!cap.adapter || !VALID_ADAPTERS.has(cap.adapter)) {
    return `Capability "adapter" must be one of: ${[...VALID_ADAPTERS].join(', ')}.`;
  }

  // Adapter-specific validation
  const config = cap.adapterConfig ?? {};
  if (cap.adapter === 'webhook') {
    if (!config.url || typeof config.url !== 'string') {
      return 'Webhook adapter requires "adapterConfig.url".';
    }
  } else if (cap.adapter === 'mcp-sampling') {
    if (!config.appName || typeof config.appName !== 'string') {
      return 'mcp-sampling adapter requires "adapterConfig.appName".';
    }
    if (!config.systemPrompt || typeof config.systemPrompt !== 'string') {
      return 'mcp-sampling adapter requires "adapterConfig.systemPrompt".';
    }
  } else if (cap.adapter === 'subprocess') {
    if (!config.command || typeof config.command !== 'string') {
      return 'Subprocess adapter requires "adapterConfig.command".';
    }
  }

  return null;
}

function normalizeCapability(cap: NonNullable<ProviderConfigParams['capability']>): ProviderConfigSnapshot['capabilities'][number] {
  return {
    name: (cap.name as string).trim(),
    description: (cap.description as string).trim(),
    version: (cap.version as string).trim(),
    priceMist: cap.priceMist as number,
    currency: cap.currency?.trim() || undefined,
    adapter: cap.adapter as string,
    adapterConfig: cap.adapterConfig && Object.keys(cap.adapterConfig).length > 0 ? cap.adapterConfig : undefined,
  };
}
