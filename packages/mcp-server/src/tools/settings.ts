import type { MeshToolContext } from '../context.js';

export const meshSettingsTool = {
  name: 'collective_settings',
  description:
    'Open the HiveMind Collective settings dashboard in the browser, or return a config summary if the portal is unavailable. ' +
    'Shows wallet balance, spending limits, identity, network config, and agent discovery.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

export async function runMeshSettings(
  _params: Record<string, never>,
  context: MeshToolContext,
): Promise<{ url: string; opened: boolean; message: string; config?: Record<string, unknown> }> {
  if (!context.portalUrl) {
    // Return a config summary when the portal isn't available (headless mode)
    const config: Record<string, unknown> = {
      did: context.did,
      network: {
        rpcUrl: context.networkConfig.rpcUrl,
        packageId: context.networkConfig.packageId || '(not set)',
        registryId: context.networkConfig.registryId || '(not set)',
      },
      encryption: context.encryption ?? { enabled: false },
    };
    if (context.providerConfig) {
      const provider = context.providerConfig.get();
      config.provider = {
        enabled: provider.enabled,
        capabilities: provider.capabilities.length,
      };
    }
    return {
      url: '',
      opened: false,
      message: 'Portal is not running. Here is the current daemon configuration summary.',
      config,
    };
  }

  let opened = false;
  if (context.openUrl) {
    try {
      opened = await context.openUrl(context.portalUrl);
    } catch {
      // Browser open failed — user can open URL manually
    }
  }

  return {
    url: context.portalUrl,
    opened,
    message: opened
      ? `Settings dashboard opened at ${context.portalUrl}`
      : `Open the settings dashboard in your browser: ${context.portalUrl}`,
  };
}
