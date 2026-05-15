# Agentic Mesh

Agentic Mesh is a local-first runtime and protocol for discovering, paying, and coordinating AI capabilities across a shared network. A developer runs a small daemon and CLI on their own machine; that local runtime manages identity, wallet state, discovery, spending policy, and the bridge into MCP-compatible apps.

The project is designed so an agent can connect through a familiar MCP interface while the mesh handles identity, task lifecycle, provider registration, and on-chain settlement. In practice, that means a Claude Desktop, VS Code, or custom MCP client can treat the mesh like another local tool source, while the daemon handles the network-facing work in the background.

## Quick start

1. Install dependencies and build the monorepo:
   ```bash
   pnpm install
   pnpm run build
   ```
2. Initialize your local mesh profile:
   ```bash
   pnpm --filter @agentic-mesh/cli exec mesh init
   ```
3. Fund your wallet:
   ```bash
   pnpm --filter @agentic-mesh/cli exec mesh wallet fund
   ```
4. Start the daemon:
   ```bash
   pnpm --filter @agentic-mesh/cli exec mesh daemon start
   ```
5. Point your MCP-capable app at the CLI shim entrypoint:
   ```json
   {
     "command": "mesh",
     "args": ["connect"]
   }
   ```
6. Try your first lookup:
   ```bash
   pnpm --filter @agentic-mesh/cli exec mesh discover echo
   ```

See [docs/getting-started.md](docs/getting-started.md) for a full walkthrough.

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
pnpm --filter @agentic-mesh/cli exec mesh register --config capabilities.yaml
```

An inline version is also supported:

```bash
pnpm --filter @agentic-mesh/cli exec mesh register --name echo --capability "echo:Echo service:1.0.0:1000000"
```

See [docs/provider-guide.md](docs/provider-guide.md) for provider workflows, monitoring, and pricing guidance.

## CLI reference

- `mesh init`  create the local data directory, identity key, and default config.
- `mesh connect`  launch the MCP shim when available.
- `mesh daemon start|stop|status`  manage the background daemon process.
- `mesh register`  register the current identity as a provider.
- `mesh config`  print the current config.
- `mesh config path`  print the resolved config file path.
- `mesh config set <key> <value>`  update a config value.
- `mesh policy set --daily <amount_sui>`  set the daily SUI budget.
- `mesh policy set --per-task <amount_sui>`  set the per-task SUI budget.
- `mesh wallet balance`  show the configured wallet balance.
- `mesh wallet fund`  request faucet funds or print manual funding info.
- `mesh wallet address`  print the wallet address.
- `mesh discover <capability>`  search for providers by capability.
- `mesh task status <id>`  inspect a task object on Sui.
- `mesh logs [--follow]`  print daemon logs and optionally follow updates.

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

Once your local RPC and faucet are running, update `~/.agentic-mesh/config.yaml` so `network.rpcUrl`, `network.faucetUrl`, `network.packageId`, and `network.registryId` point at your deployment.
