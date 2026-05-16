# Two-agent task demo

This standalone example publishes the HiveMind Collective contracts, funds two wallets, and shows an end-to-end task flow:

1. Agent A registers on-chain as an `echo` provider
2. Agent B discovers Agent A by capability lookup
3. Agent B escrows SUI and posts a task
4. Agent A detects the task, accepts it, and completes it
5. Agent B verifies the result and releases payment
6. The script prints balances before and after release to prove the payment moved

## Prerequisites

- Node.js 22+
- `pnpm`
- Sui CLI installed
  - On Windows the script checks `%LOCALAPPDATA%\bin\sui.exe` first
  - Otherwise it falls back to `sui` on your `PATH`

## Network modes

The demo supports three network modes, controlled by the `SUI_NETWORK` environment variable:

| Mode | Description |
|------|-------------|
| `devnet` (default) | Uses Sui devnet — no local Sui process needed |
| `testnet` | Uses Sui testnet — no local Sui process needed |
| `local` | Starts a local Sui network (requires `sui start` support) |

### Remote mode (devnet / testnet)

Remote mode compiles contracts locally with `sui move build` and publishes them via the `@mysten/sui` TypeScript SDK. Wallet funding uses the public faucet. This avoids the need for `sui start`, which may not work on all hardware.

### Local mode

Local mode launches `sui start` as a child process with a dedicated genesis config directory. This requires a Sui CLI binary that fully supports your CPU instruction set.

> **Note:** Some pre-built Sui binaries crash with `STATUS_ILLEGAL_INSTRUCTION` on older CPUs (e.g., Haswell-era processors). If you encounter this, use `devnet` or `testnet` mode instead.

### Reusing a previous deployment

To skip contract redeployment on subsequent runs, set:

```bash
export SUI_PACKAGE_ID=0x...   # Package ID from a previous run
export SUI_REGISTRY_ID=0x...  # Registry object ID from a previous run
```

## Run it

```bash
cd examples/two-agent-task
pnpm install

# Default (devnet):
pnpm start

# Or specify a network:
SUI_NETWORK=devnet pnpm start
SUI_NETWORK=testnet pnpm start
SUI_NETWORK=local pnpm start
```

On Windows (PowerShell):

```powershell
$env:SUI_NETWORK="devnet"; pnpm start
```

The `start` script builds the local `@hivemind-os/collective-types` and `@hivemind-os/collective-core` workspace packages first, then runs the demo with `tsx`.

## What it demonstrates

- Contract deployment (local compilation + SDK-based publishing or local network)
- Two funded wallets with separate agent roles
- On-chain provider registration and capability discovery
- Task posting with SUI escrow
- Event-driven provider execution using `EventSubscription`
- Result verification and escrow release
- Graceful cleanup on success or `Ctrl+C`

## Expected output

```text
========================================================================
🤖 HiveMind Collective two-agent demo
Agent A discovers work. Agent B discovers Agent A. SUI moves on-chain.
    Network: devnet (set SUI_NETWORK=local|devnet|testnet to change)
========================================================================
[1/8] 🚀 Connecting to Sui devnet network...
    RPC: https://fullnode.devnet.sui.io:443
    Faucet: https://faucet.devnet.sui.io
    Package: 0x...
    Registry: 0x...
[2/8] 💰 Creating funded wallets...
    Agent A (provider): 0x...
    Agent B (requester): 0x...
[4/8] 🪪 Registering Agent A and starting its listener...
    🪪 Registered Agent A with card 0x...
    👂 Agent A is polling for posted echo tasks.
[6/8] 🤝 Running the two-agent task flow...
    🔎 Agent B discovered Agent A (...)
    📮 Agent B posted task 0x... with 0.100000000 SUI escrow.
    📥 Agent A detected task 0x...
    🤝 Agent A accepted task 0x...
    ✅ Agent A completed task 0x... with blob ...
    🔍 Agent B verified result blob ...: "Hello from Agent B!"
    💸 Agent B released payment. Agent A balance changed by +0.100000000 SUI.
[7/8] 💸 Showing payment flow and final balances...
    ✅ End-to-end payment flowed from Agent B to Agent A.
[8/8] 🧹 Cleaning up...
```

## Architecture

```text
+-------------------+                      +-------------------+
| Agent A           |                      | Agent B           |
| Provider wallet   |                      | Requester wallet  |
| capability: echo  |                      | discovers "echo" |
+---------+---------+                      +---------+---------+
          |                                          |
          | register / accept / complete             | discover / post / verify / release
          +-------------------+----------------------+ 
                              |
                     +--------v--------+
                     | Sui network     |
                     | Agent registry  |
                     | Task escrow     |
                     +--------+--------+
                              |
                     +--------v--------+
                     | Shared blob dir |
                     | input + result  |
                     +-----------------+
```

## Customizing it

To adapt this demo for your own capability:

- Change the capability definition in `src/agent-a.ts`
- Update the requester input/result verification in `src/agent-b.ts`
- Replace the echo result generation with your real agent work
- Keep the same discovery, escrow, completion, and release flow

## Files

- `src/setup.ts` - local Sui launcher, contract publisher, faucet funding, cleanup helpers
- `src/remote-setup.ts` - remote network (devnet/testnet) support via SDK publishing
- `src/demo-interface.ts` - shared `SuiDemo` interface and `DemoWallet` type
- `src/network-config.ts` - network mode resolution and remote endpoint URLs
- `src/agent-a.ts` - provider registration and event-driven task handling
- `src/agent-b.ts` - provider discovery, task posting, result verification, payment release
- `src/main.ts` - end-to-end orchestration and console output
