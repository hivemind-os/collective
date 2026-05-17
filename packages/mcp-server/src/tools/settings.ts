import type { MeshToolContext } from '../context.js';

export const meshSettingsTool = {
  name: 'collective_settings',
  description:
    'Open the HiveMind Collective settings dashboard in the browser. ' +
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
): Promise<{ url: string; opened: boolean; message: string }> {
  if (!context.portalUrl) {
    return {
      url: '',
      opened: false,
      message: 'Settings dashboard is not available. The daemon portal server may not be running.',
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
