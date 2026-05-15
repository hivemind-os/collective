# Getting Started with Agentic Mesh

## Prerequisites

- Node.js 22+
- pnpm 11+
- Sui CLI for local chain and package deployment workflows
- An MCP-capable client such as Claude Desktop or VS Code

## Installation

From the repository root:

```bash
pnpm install
pnpm run build
```

If you want the CLI available on your PATH during development, you can use `pnpm --filter @agentic-mesh/cli exec mesh ...` for all commands below.

## First-time setup

Initialize your local profile:

```bash
pnpm --filter @agentic-mesh/cli exec mesh init
```

This command:

- creates `~/.agentic-mesh/`
- generates an Ed25519 identity key
- derives your mesh DID and Sui address
- writes a default `config.yaml`

Inspect the generated config at any time with:

```bash
pnpm --filter @agentic-mesh/cli exec mesh config
```

## Funding your wallet

For testnet or a local faucet-enabled network:

```bash
pnpm --filter @agentic-mesh/cli exec mesh wallet fund
```

To confirm the result:

```bash
pnpm --filter @agentic-mesh/cli exec mesh wallet balance
```

If automatic funding fails, the CLI prints the wallet address and configured faucet URL so you can fund it manually.

## Start the daemon

```bash
pnpm --filter @agentic-mesh/cli exec mesh daemon start
```

Check health at any time:

```bash
pnpm --filter @agentic-mesh/cli exec mesh daemon status
```

## Configure Claude Desktop / VS Code

Use the CLI shim entrypoint in your MCP client configuration:

```json
{
  "command": "mesh",
  "args": ["connect"]
}
```

If the shim package is not installed yet, start with `mesh daemon start` and install the shim once it is available in your environment.

## Your first task execution

1. Discover a provider:
   ```bash
   pnpm --filter @agentic-mesh/cli exec mesh discover echo
   ```
2. If you are running provider mode yourself, register a capability first:
   ```bash
   pnpm --filter @agentic-mesh/cli exec mesh register --name echo --capability "echo:Echo service:1.0.0:1000000"
   ```
3. Use your MCP client to call into the mesh-connected tools or inspect task progress from the CLI:
   ```bash
   pnpm --filter @agentic-mesh/cli exec mesh task status <task-id>
   ```

## Troubleshooting

### `mesh connect` says the shim is unavailable

Install or build `@agentic-mesh/shim`, then retry. Until then, the daemon lifecycle and provider workflows still work from the CLI.

### `mesh register` fails because package or registry IDs are empty

Update `network.packageId` and `network.registryId` in `~/.agentic-mesh/config.yaml` after deploying the contracts for your target Sui network.

### `mesh daemon status` says the daemon is not running

Start it explicitly:

```bash
pnpm --filter @agentic-mesh/cli exec mesh daemon start
```

### I need the current config path

```bash
pnpm --filter @agentic-mesh/cli exec mesh config path
```

### I want to inspect daemon logs

```bash
pnpm --filter @agentic-mesh/cli exec mesh logs --follow
```
