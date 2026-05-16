# HiveMind Collective

HiveMind Collective is a local-first runtime and protocol for discovering, paying, and coordinating AI capabilities across a shared network. A developer runs a small daemon and CLI on their own machine; that local runtime manages identity, wallet state, discovery, spending policy, and the bridge into MCP-compatible apps.

The project is designed so an agent can connect through a familiar MCP interface while the mesh handles identity, task lifecycle, provider registration, and on-chain settlement. In practice, that means a Claude Desktop, VS Code, or custom MCP client can treat the mesh like another local tool source, while the daemon handles the network-facing work in the background.

## Quick start

Add this to your MCP client config (Claude Desktop, VS Code, Cursor, etc.) and restart:

```json
{
  "mcpServers": {
    "hivemind-collective": {
      "command": "npx",
      "args": ["-y", "@hivemind-os/collective-shim"]
    }
  }
}
```

Everything else is automatic — identity, config, and daemon start on first use.

To execute paid tasks, fund your testnet wallet:

```bash
npx @hivemind-os/collective-cli wallet fund
```

See [docs/getting-started.md](docs/getting-started.md) for details, [docs/setup-claude-desktop.md](docs/setup-claude-desktop.md) for Claude Desktop, [docs/setup-vscode.md](docs/setup-vscode.md) for VS Code, [docs/provider-guide.md](docs/provider-guide.md) for provider operations, [docs/relay-operator-guide.md](docs/relay-operator-guide.md) for community relays, and [docs/mcp-tool-reference.md](docs/mcp-tool-reference.md) for the MCP surface.

## Architecture overview

The monorepo is split into shared protocol types, a reusable core SDK, the daemon runtime, MCP tooling, and the CLI entrypoint. The CLI focuses on developer ergonomics: initialization, daemon lifecycle, registration, wallet helpers, policy editing, and logs.

For a deeper technical walkthrough, see [ARCHITECTURE.md](ARCHITECTURE.md).

## For providers

Providers expose capabilities to the mesh and register an agent card on Sui. A minimal provider definition looks like this:

```yaml
name: Echo Provider
description: Simple test provider
capabilities:
  - name: echo
    description: Returns the input verbatim
    version: 1.0.0
    price_mist: 1000000
```

Register it with:

```bash
pnpm --filter @hivemind-os/collective-cli exec collective register --config capabilities.yaml
```

An inline version is also supported:

```bash
pnpm --filter @hivemind-os/collective-cli exec collective register --name echo --capability "echo:Echo service:1.0.0:1000000"
```

See [docs/provider-guide.md](docs/provider-guide.md) for provider workflows, monitoring, and pricing guidance.

## CLI reference

- `collective init`  create the local data directory, identity key, and default config.
- `collective connect`  launch the MCP shim when available.
- `collective daemon start|stop|status`  manage the background daemon process.
- `collective register`  register the current identity as a provider.
- `collective config`  print the current config.
- `collective config path`  print the resolved config file path.
- `collective config set <key> <value>`  update a config value.
- `collective policy set --daily <amount_sui>`  set the daily SUI budget.
- `collective policy set --per-task <amount_sui>`  set the per-task SUI budget.
- `collective wallet balance`  show the configured wallet balance.
- `collective wallet fund`  request faucet funds or print manual funding info.
- `collective wallet address`  print the wallet address.
- `collective discover <capability>`  search for providers by capability.
- `collective task status <id>`  inspect a task object on Sui.
- `collective relay register|list|heartbeat|deactivate`  manage community relay registrations.
- `collective logs [--follow]`  print daemon logs and optionally follow updates.

## Development

### Monorepo setup

```bash
pnpm install
pnpm run build
pnpm run test
```

Run CLI tests directly:

```bash
cd packages/cli
pnpm run test -- --run
```

### Local Sui

The repo includes a helper for local Sui development:

```bash
pnpm run dev:sui
```

Once your local RPC and faucet are running, update `~/.hivemind-os/collective/config.yaml` so `network.rpcUrl`, `network.faucetUrl`, `network.packageId`, and `network.registryId` point at your deployment.
