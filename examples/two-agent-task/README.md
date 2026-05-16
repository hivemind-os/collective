# Two-agent task demo

This standalone example spins up a local Sui network, publishes the Agentic Mesh contracts, funds two wallets, and shows an end-to-end task flow:

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
  - On Windows the script checks `%LOCALAPPDATA%\\bin\\sui.exe` first
  - Otherwise it falls back to `sui` on your `PATH`

## Run it

```bash
cd examples/two-agent-task
pnpm install
pnpm start
```

The `start` script builds the local `@agentic-mesh/types` and `@agentic-mesh/core` workspace packages first, then runs the demo with `tsx`.

## What it demonstrates

- Local Sui test network startup with faucet
- Contract deployment from `../../contracts/agentic_mesh`
- Two funded wallets with separate agent roles
- On-chain provider registration and capability discovery
- Task posting with SUI escrow
- Event-driven provider execution using `EventSubscription`
- Result verification and escrow release
- Graceful cleanup on success or `Ctrl+C`

## Expected output

```text
========================================================================
🤖 Agentic Mesh two-agent demo
Agent A discovers work. Agent B discovers Agent A. SUI moves on-chain.
========================================================================
[1/8] 🚀 Starting local Sui test network...
    RPC: http://127.0.0.1:...
    Faucet: http://127.0.0.1:...
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
                     | Local Sui chain |
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
- `src/agent-a.ts` - provider registration and event-driven task handling
- `src/agent-b.ts` - provider discovery, task posting, result verification, payment release
- `src/main.ts` - end-to-end orchestration and console output
