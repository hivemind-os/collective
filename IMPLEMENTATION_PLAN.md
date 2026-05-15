# Agentic Mesh — Implementation Plan

**Based on:** SPEC.md v0.1, ARCHITECTURE.md, POC Findings
**POC Status:** All core design decisions validated (19 Move tests, end-to-end demo across 2 processes)

---

## 1. What the POC Proved

| Design Decision | POC Result | Production Impact |
|---|---|---|
| Combined Task + Escrow object | ✅ Works, atomic state machine | Keep this design — simpler than separate objects |
| Event-based discovery | ✅ Cursor-paginated, filterable | Build cursor persistence + local SQLite cache |
| Clock-based dispute windows | ✅ `sui::clock::Clock` (0x6) reliable | Use in production as-is |
| Shared Registry object | ✅ Low contention for registration | Monitor; shard if >1000 concurrent registrations |
| Two-process coordination | ✅ 10s lifecycle via event polling | Add relay (Phase 2) for real-time |
| Gas costs | ✅ ~0.01 SUI per lifecycle | Affordable; re-verify on testnet |

**Key POC artifacts:** `poc/contracts/` (Move), `poc/packages/core/` (TypeScript client), `poc/findings/POC_FINDINGS.md`

---

## 2. Monorepo Structure

```
agentic-mesh/
├── contracts/                    # Move smart contracts (Sui)
│   └── agentic_mesh/
│       ├── sources/
│       │   ├── registry.move     # Registry + AgentCard
│       │   └── task.move         # Task + integrated escrow
│       └── tests/
│
├── packages/
│   ├── types/                    # Shared TypeScript types & constants
│   │   └── src/
│   │       ├── agent.ts          # AgentCard, capability, DID types
│   │       ├── task.ts           # Task, escrow, status types
│   │       ├── payment.ts        # Payment rail, pricing types
│   │       ├── events.ts         # On-chain event types
│   │       └── config.ts         # Network config, contract addresses
│   │
│   ├── core/                     # Protocol client library
│   │   └── src/
│   │       ├── identity/         # Ed25519 keypair, DID, signing, key hierarchy
│   │       ├── sui/              # Sui client, transaction builders, event queries
│   │       ├── registry/         # Register, discover, deactivate agents
│   │       ├── task/             # Post, accept, complete, release, claim, dispute
│   │       ├── walrus/           # BlobStore interface + Walrus/mock implementations
│   │       └── spending/         # Spending policy enforcement
│   │
│   ├── daemon/                   # Background daemon process
│   │   └── src/
│   │       ├── server.ts         # IPC server (named pipe / Unix socket)
│   │       ├── state.ts          # Shared state (identity, wallet, subscriptions)
│   │       ├── auth/             # OAuth, zkLogin, session management
│   │       ├── provider/         # Provider runtime (event listener, task queue, adapters)
│   │       ├── portal/           # Local web portal (localhost:PORT)
│   │       └── policy/           # Global spending limits, per-app overrides
│   │
│   ├── shim/                     # Lightweight MCP shim (pipes stdio → daemon IPC)
│   │   └── src/
│   │       ├── main.ts           # Entry point — auto-start daemon, connect, pipe
│   │       └── ipc.ts            # IPC client (named pipe / Unix socket)
│   │
│   ├── mcp-server/               # MCP tool/resource definitions (runs inside daemon)
│   │   └── src/
│   │       ├── tools/            # mesh_discover, mesh_execute, mesh_register, etc.
│   │       ├── resources/        # Capability directory, agent profiles, task status
│   │       └── prompts/          # Guided workflows
│   │
│   ├── cli/                      # CLI commands (mesh init, mesh config, mesh register)
│   │   └── src/
│   │       ├── commands/
│   │       └── utils/
│   │
│   ├── relay/                    # Relay node (Phase 2)
│   │   └── src/
│   │       ├── server/           # WebSocket + HTTP ingress
│   │       ├── routing/          # Provider session routing
│   │       └── settlement/       # x402 verification
│   │
│   └── e2e-tests/                # End-to-end test suites (real Sui network)
│       └── src/
│           ├── harness/          # Test infrastructure
│           │   ├── sui-network.ts      # Start/stop local Sui, deploy contracts
│           │   ├── contract-deployer.ts # Deploy + extract package/object IDs
│           │   ├── funded-wallet.ts     # Create & fund test wallets via faucet
│           │   ├── port-allocator.ts    # Dynamic port allocation (no collisions)
│           │   ├── daemon-manager.ts    # Start/stop daemon process
│           │   ├── shim-manager.ts      # Start MCP shims, send tool calls
│           │   ├── evm-network.ts       # Start/stop Anvil (Phase 2)
│           │   ├── relay-server.ts      # Start/stop local relay (Phase 2)
│           │   ├── mock-oidc-server.ts  # Local OIDC provider for zkLogin tests
│           │   ├── mock-salt-server.ts  # Local Mysten salt service mock
│           │   ├── process-tracker.ts   # PID tracking + descendant cleanup
│           │   └── timeouts.ts          # Per-operation timeout constants
│           ├── phase1/           # Phase 1 E2E tests
│           │   ├── contracts.test.ts
│           │   ├── core-registry.test.ts
│           │   ├── core-task.test.ts
│           │   ├── daemon-lifecycle.test.ts
│           │   ├── full-task-lifecycle.test.ts
│           │   ├── provider-runtime.test.ts
│           │   ├── multi-app.test.ts
│           │   ├── resilience.test.ts
│           │   ├── spending-policy.test.ts
│           │   ├── event-cursors.test.ts
│           │   └── walrus.test.ts          # Beta only
│           ├── phase2/           # Phase 2 E2E tests
│           │   ├── relay-realtime.test.ts
│           │   ├── x402-payment.test.ts
│           │   └── payment-routing.test.ts
│           └── phase3/           # Phase 3 E2E tests
│               ├── reputation.test.ts
│               ├── staking.test.ts
│               ├── disputes.test.ts
│               └── encryption.test.ts
│
├── poc/                          # POC validation work (gitignored)
├── SPEC.md
├── ARCHITECTURE.md
├── IMPLEMENTATION_PLAN.md
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── .gitignore
```

---

## 3. Technology Decisions (Locked)

| Component | Choice | Status |
|---|---|---|
| Language | TypeScript (Node.js 22+) | Locked |
| Blockchain (state) | Sui | Locked, POC-validated |
| Blockchain (x402) | Base (EVM L2) | Locked (Phase 2) |
| Blob storage | Walrus | Locked (mock until Phase 1 M8) |
| MCP SDK | `@modelcontextprotocol/sdk` | Locked |
| Sui SDK | `@mysten/sui` (JSON-RPC client) | Locked, POC-validated |
| Move edition | 2024 | Locked, POC-validated |
| Monorepo | pnpm + turborepo | Locked |
| Testing | Vitest + Move test framework + local Sui E2E harness | Locked |
| Build | tsup | Locked |
| IPC | Named pipe (Win) / Unix socket | Locked |
| Key storage | OS keychain (keytar) | Locked |
| Local DB | SQLite (better-sqlite3) | Locked |
| Relay server | Fastify | Locked (Phase 2) |
| x402 | viem + @x402/evm | Locked (Phase 2) |

---

## 4. Phase 1: Core + Sui State + Async Marketplace (v0.1)

Phase 1 is split into **alpha** (validated core) and **beta** (risky integrations):

- **v0.1-alpha:** Ed25519 identity, Sui Testnet contracts, mock BlobStore, daemon+shim, MCP tools, provider runtime, escrowed async tasks. Everything the POC validated, productionized.
- **v0.1-beta:** zkLogin/OAuth onboarding, Walrus Testnet, multi-app spending polish, web portal, full CLI.

This keeps the MVP centered on the validated Sui async marketplace while gating unvalidated integrations (Walrus, zkLogin) behind clear milestones.

**Dispute handling in v0.1:** Disputes are NOT exposed in UX. Requesters release payment or providers claim after the dispute window. Full dispute resolution ships in Phase 3.

### M1: Project Bootstrap

**Goal:** Monorepo with shared types, CI, linting, build pipeline, local dev scripts, and E2E test harness.

| Task | Detail |
|---|---|
| Init monorepo | `pnpm`, `turbo.json`, workspace config |
| Shared types package | `@agentic-mesh/types` — agent, task, event, config types |
| TSConfig base | Shared `tsconfig.base.json` (ES2022, ESM, strict) |
| Build pipeline | `tsup` per package, `turbo run build` |
| Linting | ESLint flat config + Prettier |
| CI | GitHub Actions: lint → build → unit test on PR; full E2E suite on merge (see §4a) |
| Git setup | Initialize repo, branch strategy (main + feature branches) |
| Local dev scripts | `scripts/local-sui.ps1` (start Sui, fund accounts, deploy contracts), `scripts/seed.ts` (register test agents), `scripts/reset.ts` (wipe local state) |
| **E2E test harness** | `packages/e2e-tests/` — `SuiTestNetwork` class, `PortAllocator`, `ProcessTracker`, `FundedWallet`, timeout constants. Verified: can start local Sui, deploy contracts, run one transaction, tear down cleanly on Windows + Linux. |

**Depends on:** Nothing
**Produces:** Buildable monorepo skeleton with `@agentic-mesh/types`, dev tooling, and proven test harness

---

### M2: Move Contracts (Production)

**Goal:** Production-ready Move contracts deployed to Sui Testnet. Scoped to v0.1 features only.

| Task | Detail |
|---|---|
| Upgrade `registry.move` | Add capability metadata fields (description, pricing hints), version tracking for contract upgrades, DID→address reverse lookup via events |
| Upgrade `task.move` | Add blob ID fields (`input_blob_id: vector<u8>`, `result_blob_id: vector<u8>`) for Walrus references, task expiry timeout (auto-refund if not accepted within configurable hours), `TaskAgreement` hash field for off-chain agreement verification |
| Escrow scope (v0.1 only) | Exact-price escrow: create/release/claim-after-window/cancel/refund. **No** partial release or metered payments (Phase 3) |
| Move unit tests | Expand from 19 to 40+: all state transitions, edge cases, adversarial scenarios, expiry flows |
| Testnet deployment | Deploy to Sui Testnet, record canonical package ID and object IDs |
| Upgrade capability | Test `sui client upgrade` flow for future contract updates |

**Depends on:** M1
**Produces:** Deployed contracts on Sui Testnet, canonical contract addresses

**POC learnings applied:** Keep combined Task+Escrow, method syntax, non-zero test clocks

---

### M2a: Walrus Spike

**Goal:** Prove Walrus SDK works before freezing contract schemas.

| Task | Detail |
|---|---|
| Store/fetch test | Store and retrieve a blob on Walrus Testnet via `@mysten/walrus` |
| Blob ID format | Confirm on-chain representation (u256 hex, size, encoding) |
| Expiry behavior | Test blob lifecycle, renewal, permanence options |
| Windows/CI viability | Confirm Walrus SDK works on Windows and in CI |
| Schema decision | Finalize `input_blob_id` / `result_blob_id` field types in Move contracts |

**Depends on:** M1
**Produces:** Validated Walrus integration path, confirmed schema for M2

---

### M3: Core Library

**Goal:** `@agentic-mesh/core` — the protocol client library that all higher-level packages depend on.

| Task | Detail |
|---|---|
| **Identity module** | Ed25519 keypair generation + persistence (OS keychain via keytar), DID creation (`did:mesh:<base58-pubkey>`), message signing/verification. Interface designed so zkLogin can plug in later (M7). |
| **Sui client module** | Connection manager (localnet/testnet/mainnet), transaction builder helpers, error handling with retry logic, gas estimation |
| **Registry client** | `registerAgent()`, `updateAgent()`, `deactivateAgent()`, `discoverByCapability()`, `getAgentCard()` |
| **Task client** | `postTask()`, `acceptTask()`, `completeTask()`, `releasePayment()`, `claimPayment()`, `cancelTask()`, `getTask()`. **No** `disputeTask()` in v0.1 UX. |
| **Event subscription** | Cursor-based poll + subscribe hybrid, cursor persistence to SQLite, idempotent processing, backfill on restart, configurable poll interval |
| **Local cache** | SQLite-backed agent registry cache, synced from Sui events, FTS5 search for capability discovery, TTL-based invalidation |
| **BlobStore interface** | Abstract interface (`store(data) → id+hash`, `fetch(id) → data`), filesystem mock implementation (default for local dev) |
| **Spending policy** | Policy evaluation engine (daily/monthly/per-task limits), balance tracking, approval/rejection with reason |
| **Vitest test suite** | Unit tests for all modules, mocked Sui client for fast testing |

**Depends on:** M1, M2 (contract addresses)
**Produces:** `@agentic-mesh/core` — importable by daemon, MCP server, CLI, provider

---

### M4: Daemon Process (Minimal)

**Goal:** Minimal background daemon — IPC server, identity, single MCP session. No provider runtime yet.

| Task | Detail |
|---|---|
| **IPC server** | Named pipe (Windows: `\\.\pipe\agentic-mesh`) / Unix socket (`~/.agentic-mesh/mesh.sock`), JSON-RPC over IPC, socket permissions (owner-only ACL) |
| **State manager** | Identity lifecycle (load from keychain, generate Ed25519 if missing), wallet state (nonce tracking, balance cache), Sui event subscription manager |
| **IPC security** | Socket ACLs (owner-only read/write), per-connection app identification, tool-level permissions (read-only vs spend/sign) |
| **MCP session** | Accept one shim connection, create MCP session, route tool calls to core library, enforce spending policy |
| **Health & lifecycle** | PID file for singleton enforcement, graceful shutdown, auto-start via shim |
| **Config** | YAML config file (`~/.agentic-mesh/config.yaml`), environment variable overrides, sensible defaults |
| **Logging** | Structured JSON logging (pino), log rotation, configurable verbosity |

**Depends on:** M3
**Produces:** Running daemon that can serve one MCP client with identity + Sui state

---

### M4a: Minimal Vertical Slice

**Goal:** Prove the full stack end-to-end BEFORE building all remaining features.

| Requirement | Detail |
|---|---|
| Contracts on Testnet | M2 contracts deployed |
| Ed25519 identity | Generated by daemon on first run |
| Mock BlobStore | Filesystem-based |
| Minimal daemon | IPC + one MCP session |
| One MCP tool | `mesh_execute` — post task, poll for completion, release payment |
| Sample provider | Echo capability — accept task, return echo of input hash |
| End-to-end proof | MCP app calls `mesh_execute` → Sui task posted → provider accepts/completes → payment released |

**Depends on:** M4, M5 (minimal shim), M6 (just `mesh_execute`)
**Produces:** Confidence that the architecture works before investing in remaining milestones

---

### M5: MCP Shim

**Goal:** Tiny binary that MCP-compatible apps spawn. Pipes stdio to the daemon's IPC.

| Task | Detail |
|---|---|
| **Shim binary** | `mesh connect` — entry point for MCP hosts |
| **Auto-start daemon** | Check if daemon is running (PID file / pipe exists), start if not, wait for ready |
| **Stdio ↔ IPC bridge** | Pipe MCP JSON-RPC messages between stdio (app) and IPC (daemon) |
| **App metadata** | Send `shim_hello` on connect: app name (from env/args), PID, requested profile |
| **Error handling** | If daemon dies, return MCP error to app, attempt restart |
| **Size target** | <100 lines of code, minimal dependencies |

**Depends on:** M4
**Produces:** `mesh connect` command — the only thing MCP apps need to know

---

### M6: MCP Tool Definitions

**Goal:** The MCP tools that agents use to interact with the mesh.

| Tool | Description | Core Library Call |
|---|---|---|
| `mesh_discover` | Find agents by capability, returns ranked list | `registry.discoverByCapability()` |
| `mesh_execute` | Post a task, wait for result, release payment | `task.postTask()` → poll → `task.releasePayment()` |
| `mesh_execute_async` | Post a task, return task ID immediately | `task.postTask()` |
| `mesh_task_status` | Check status of a previously posted task | `task.getTask()` |
| `mesh_register` | Register current agent as a provider | `registry.registerAgent()` |
| `mesh_deactivate` | Remove agent from registry | `registry.deactivateAgent()` |
| `mesh_balance` | Check wallet balance (SUI) | Sui RPC `getBalance()` |
| `mesh_policy_update` | Update spending limits | `spending.updatePolicy()` |
| `mesh_task_history` | List past tasks (requester + provider) | Local SQLite query |

**MCP Resources:**
| Resource | Description |
|---|---|
| `mesh://capabilities` | Browseable capability directory |
| `mesh://agent/{did}` | Agent profile |
| `mesh://task/{id}` | Task details and status |
| `mesh://wallet` | Wallet balance and spending summary |

**Depends on:** M3, M4 (daemon routes MCP calls)
**Produces:** Full MCP tool surface — agents can interact with the mesh

---

### M4b: Provider Runtime

**Goal:** Provider mode inside the daemon — listen for tasks, execute, complete.

| Task | Detail |
|---|---|
| **Event listener** | Subscribe to `TaskPosted` events matching registered capabilities, cursor-based with persistence |
| **Task queue** | Configurable concurrency (default: 1), queue depth, rejection when full |
| **Execution adapters** | Adapter interface + built-in adapters: local function, MCP sampling (ask local agent to do work), HTTP webhook. **Required sample:** `echo` capability with deterministic I/O for testing |
| **Result submission** | Complete task on-chain, store result via BlobStore |
| **Registration** | Read `capabilities.yaml`, register AgentCard on Sui |

**Depends on:** M4, M6
**Produces:** Daemon can operate as both consumer and provider

---

### M4c: Multi-App Support

**Goal:** Daemon serves multiple MCP sessions with isolated spending.

| Task | Detail |
|---|---|
| **Connection multiplexing** | Accept N shim connections simultaneously |
| **Per-app identification** | Route to correct profile based on `shim_hello` metadata |
| **Global spending coordination** | Single budget across all apps, per-app overrides |
| **Profile isolation** | Optional separate identities/wallets per profile |
| **Audit trail** | Log which app initiated each task |

**Depends on:** M4, M5
**Produces:** Multi-app daemon — Claude + VS Code + custom agents share one mesh node

---

### M7: Auth & Onboarding (v0.1-beta)

**Goal:** zkLogin-based identity with slick browser OAuth UX.

| Task | Detail |
|---|---|
| **zkLogin spike** | Proof-of-life: Google OIDC → Mysten salt → ephemeral key + ZK proof → Sui Devnet tx |
| **OAuth provider integration** | Google Sign-In as primary OIDC provider, Apple Sign-In as secondary |
| **HKDF EVM key derivation** | `HKDF(sha256(identity_privkey \|\| user_salt \|\| oauth_sub), iss, "agentic-mesh:evm:v1")` → secp256k1 EVM key (ready for Phase 2 x402) |
| **Local web portal** | Localhost HTTP server (Fastify), single-page setup flow (OAuth → spending limits → done), settings/wallet/history pages |
| **Device code flow** | RFC 8628 fallback for headless environments (SSH, servers) |
| **Session management** | OAuth refresh token persistence, silent JWT renewal, ephemeral key rotation per session |
| **First-run UX** | Shim triggers daemon → daemon detects no identity → opens browser → user signs in → daemon signals ready → shim retries tool call |

**Depends on:** M4
**Produces:** Zero-config onboarding — first mesh tool call triggers browser setup

**Note:** zkLogin requires Sui Devnet/Testnet. Ed25519 standalone keys remain as fallback/dev mode.

---

### M8: Walrus Integration (v0.1-beta)

**Goal:** Store task payloads on Walrus instead of passing raw bytes on-chain.

| Task | Detail |
|---|---|
| **BlobStore Walrus implementation** | `@mysten/walrus` SDK integration, store blobs on Walrus Testnet, return blob IDs |
| **Task payload flow** | Consumer stores input on Walrus → posts task with blob ID → provider fetches from Walrus → stores result on Walrus → completes task with result blob ID |
| **Content addressing** | SHA-256 hash of blob content stored alongside blob ID for integrity verification |
| **Size limits** | Enforce max blob size per task (configurable, default 10MB) |
| **Error handling** | Walrus unavailability fallback (retry with backoff), blob expiry tracking |
| **Integration tests** | End-to-end task lifecycle with real Walrus Testnet blobs |

**Depends on:** M2a (Walrus spike), M3
**Produces:** Decentralized payload storage — no on-chain data size constraints

---

### M9: CLI & Developer Experience

**Goal:** `@agentic-mesh/cli` — the user-facing command-line tool.

| Command | Description |
|---|---|
| `mesh init` | First-time setup (starts daemon, generates Ed25519 key or opens browser for OAuth) |
| `mesh connect` | MCP shim entry point (used in app configs) |
| `mesh daemon start\|stop\|status` | Daemon lifecycle management |
| `mesh register --config capabilities.yaml` | Register as provider |
| `mesh config` | View/edit configuration |
| `mesh policy set --daily <amount>` | Update spending limits |
| `mesh wallet balance` | Check SUI balance |
| `mesh wallet fund` | Show deposit address / testnet faucet |
| `mesh discover <capability>` | Search for agents |
| `mesh task status <id>` | Check task status |
| `mesh logs` | Tail daemon logs |

**Documentation (ships with M9):**
- README with quick-start
- Getting started guide (consumer)
- Provider setup guide
- Architecture overview for contributors

**Depends on:** M4, M6
**Produces:** Complete CLI for users and developers

---

### M10: End-to-End Integration Testing

**Goal:** Comprehensive E2E test suites that spin up real local Sui networks, deploy real contracts, run real daemon/shim processes, and mock as little as possible. Tests are tiered and gated per phase.

---

#### Test Harness (`packages/e2e-tests/src/harness/`)

The harness manages all infrastructure lifecycle. Every test suite gets a real local Sui network.

**`SuiTestNetwork`:**
```typescript
class SuiTestNetwork {
  // Starts `sui start --with-faucet --force-regenesis` on allocated ports
  // Deploys Move contracts via `sui client publish` (same as production)
  // Extracts packageId, registryId, upgrade cap from publish output
  // Provides funded wallet factory (faucet-backed, unique per test)
  async start(ports: AllocatedPorts): Promise<void>;
  async createFundedWallet(amount?: bigint): Promise<TestWallet>;
  async stop(): Promise<void>;
  get contractAddresses(): ContractAddresses;
  get client(): SuiClient;
}
```

**`PortAllocator`:** Reserves unique ports for every service (Sui RPC, faucet, daemon IPC, relay WS, Anvil, mock OIDC, mock salt). Prevents collisions across parallel CI workers. Fails fast if ports are occupied.

**`ProcessTracker`:** Tracks exact PIDs of all spawned processes (Sui, daemon, relay, Anvil). On teardown: kill by PID (not by name), including descendant processes. Windows-compatible — uses `taskkill /T /PID` for tree kill, no POSIX signals.

**`DaemonManager`:** Starts/stops the real daemon process for tests. Configures it to use the local Sui network and dynamic ports. Waits for IPC ready. Captures structured logs for test diagnostics.

**`ShimManager`:** Spawns real MCP shims as child processes, sends MCP JSON-RPC tool calls over stdio, captures responses. Simulates what Claude Desktop or VS Code would do.

**Timeout constants:** Every external wait has an explicit timeout:
| Operation | Default Timeout |
|---|---|
| Sui network startup | 30s |
| Contract deployment | 15s |
| Faucet funding | 10s |
| Transaction confirmation | 10s |
| Event delivery | 15s |
| Daemon startup | 10s |
| Daemon shutdown | 5s |

---

#### Test Tiers

Tests are organized into four tiers of increasing scope. Developers can run the smallest relevant tier locally.

**Tier 1 — Contract E2E** (local Sui + Move contracts only, no TypeScript app code)
- Deploy contracts to local Sui via `sui client publish`
- Call every contract entry function via `sui client call`
- Verify: all state transitions, events emitted, escrow balances, access control
- **No daemon, no shim, no TypeScript client** — tests the contract surface in isolation

**Tier 2 — SDK E2E** (TypeScript `@agentic-mesh/core` + local Sui)
- Core library operations against real local Sui
- Registry: register, discover, update, deactivate
- Task: post, accept, complete, release, claim, cancel
- Event subscription: cursor persistence, backfill, idempotent processing
- **No daemon** — tests the SDK correctness

**Tier 3 — Daemon E2E** (daemon + shim + local Sui)
- Daemon lifecycle: start, health, shutdown
- MCP tool calls via real shim: `mesh_discover`, `mesh_execute`, `mesh_register`
- Provider runtime: event-driven task processing with echo capability
- Spending policy enforcement

**Tier 4 — Full Mesh E2E** (multiple agents, full lifecycle, failure scenarios)
- Consumer + provider as separate daemon instances
- Multi-app: two shims connected to same daemon
- Resilience: kill daemon, restart, cursor recovery, task completion
- Payment routing: Sui escrow (Phase 1), x402 via Anvil (Phase 2), relay real-time (Phase 2)

---

#### Test Isolation Strategy

Each test gets a **fresh environment** to prevent hidden coupling:

| Resource | Isolation Method |
|---|---|
| Sui network | Shared per test suite (started in `beforeAll`), but: |
| Wallets | Fresh keypair + faucet funding per test |
| Agent registrations | Unique capability IDs per test (e.g. `echo-<testId>`) |
| Event cursors | Reset to empty per test |
| Tasks | Fresh task per test (unique input hash) |
| Daemon | Fresh config directory per test (temp dir) |
| SQLite databases | Fresh DB file per test |
| Ports | Dynamically allocated per suite |

Test order is randomized periodically in CI to catch hidden dependencies.

---

#### Phase 1 Test Suites

**`contracts.test.ts`** — Tier 1
- Deploy contracts to local Sui
- Register agent, verify AgentCard fields
- Duplicate registration fails
- Update agent, verify event emitted
- Deactivate agent, double-deactivate fails
- Post task with escrow, verify SUI locked
- Accept task, wrong provider fails
- Complete task, non-provider fails
- Release payment, verify provider balance increased
- Claim payment after dispute window (advance clock)
- Claim before window expires fails
- Cancel open task, full refund
- Cancel accepted task fails
- Double release fails
- Insufficient escrow fails
- Task expiry timeout and auto-refund
- Gas cost benchmarks (record and assert within bounds)

**`core-registry.test.ts`** — Tier 2
- `registerAgent()` creates on-chain AgentCard
- `discoverByCapability()` returns matching agents
- `getAgentCard()` returns correct fields
- `updateAgent()` modifies on-chain state
- `deactivateAgent()` removes from discovery
- Local cache syncs from events, FTS5 search works

**`core-task.test.ts`** — Tier 2
- Full lifecycle: `postTask()` → `acceptTask()` → `completeTask()` → `releasePayment()`
- `claimPayment()` after window expiry
- `cancelTask()` with full refund
- Unauthorized operations rejected
- BlobStore mock: store input → task carries blob reference → fetch result

**`event-cursors.test.ts`** — Tier 2
- Start from empty cursor, receive all events
- Persist cursor to SQLite, restart subscription, no missed events
- Duplicate event delivery is idempotent (task not processed twice)
- Cursor advances only after durable local processing
- Daemon offline → events emitted → restart → backfill catches all
- High-frequency events (10 rapid tasks) → all captured in order

**`daemon-lifecycle.test.ts`** — Tier 3
- Start daemon with local Sui config
- Verify IPC socket created (named pipe on Windows)
- Connect shim, send health check, get response
- Graceful shutdown: drain in-progress work, close subscriptions
- PID file prevents duplicate daemon
- Auto-generate Ed25519 identity on first start

**`full-task-lifecycle.test.ts`** — Tier 4
- Two daemon instances (consumer + provider) on same local Sui
- Provider registers with echo capability
- Consumer calls `mesh_discover` → finds provider
- Consumer calls `mesh_execute` → task posted → provider auto-accepts via event listener
- Provider completes (echo result) → consumer receives result → payment released
- Verify: provider balance increased by task price minus gas

**`provider-runtime.test.ts`** — Tier 3
- Register daemon as provider with echo capability
- Post task externally → daemon detects via event subscription
- Daemon accepts, executes echo adapter, completes task
- Verify result blob matches expected echo output
- Concurrent tasks (post 3 tasks, daemon processes all with configurable concurrency)
- Task with non-matching capability → daemon ignores

**`multi-app.test.ts`** — Tier 4
- Start one daemon, connect two shims (simulating Claude + VS Code)
- Both shims send `mesh_discover` → both get results
- Shim A posts task (1 SUI) → spending tracked
- Shim B posts task (1 SUI) → global budget enforced across both
- Exceed daily limit → next task rejected with spending policy error
- Verify per-app audit trail logs which shim initiated each task

**`resilience.test.ts`** — Tier 4
- Post task, provider accepts → kill daemon process (SIGKILL equivalent)
- Restart daemon → cursor recovery from SQLite → picks up TaskCompleted event
- Release payment successfully (task wasn't lost)
- Verify no duplicate processing (idempotent event handling)
- Provider daemon restart mid-poll → resumes from persisted cursor

**`spending-policy.test.ts`** — Tier 3
- Set daily limit to 5 SUI
- Post tasks until budget exhausted → 6th task rejected
- Per-task limit: set max 2 SUI/task, attempt 3 SUI task → rejected
- Monthly limit accumulation across multiple days (simulated)
- Policy update via `mesh_policy_update` → new limits applied immediately

**`walrus.test.ts`** — Tier 2 (v0.1-beta only, scheduled/optional CI)
- Store blob on Walrus Testnet → receive blob ID
- Fetch blob by ID → verify content matches
- Full task lifecycle with Walrus: store input → post task → provider fetches → stores result → consumer fetches
- Content addressing: SHA-256 hash verified on fetch
- Blob size enforcement: exceed 10MB → rejected

---

#### Phase 2 Test Suites

**`relay-realtime.test.ts`** — Tier 4
- Start local relay server
- Consumer daemon connects to relay via outbound WebSocket
- Provider daemon connects to relay
- Consumer posts real-time task → relay routes to provider → provider responds → relay routes result
- Verify sub-second round-trip (no Sui transaction for relay-mediated tasks)
- Relay disconnection → fallback to Sui async flow
- Two relays available → load balancing / failover

**`x402-payment.test.ts`** — Tier 4
- Start local Anvil (Foundry) as EVM test network
- Deploy test ERC20 token contract
- Fund consumer with test tokens
- Consumer posts real-time task with x402 payment
- Provider receives x402 402 response, submits payment, receives result
- Verify: provider's ERC20 balance increased, consumer's decreased
- Invalid payment → 402 response not cleared → task fails gracefully

**`payment-routing.test.ts`** — Tier 4
- Async task → always uses Sui escrow (verify no EVM interaction)
- Real-time relay task with Sui wallet → uses Sui payment
- Real-time relay task with EVM wallet → uses x402 on Anvil
- Consumer preference override → forces specific rail
- Rail unavailable → fallback to alternate

---

#### Phase 3 Test Suites

**`reputation.test.ts`** — Tier 4
- Complete 5 tasks → reputation events emitted for each
- Query reputation score → reflects completion history
- Discovery ranking: higher-reputation agent ranked first
- Failed task (dispute) → negative reputation impact

**`staking.test.ts`** — Tier 4
- Agent stakes 10 SUI → verify stake locked on-chain
- Unstake after cooldown → verify SUI returned
- Slash trigger (expired escrow, non-delivery) → stake reduced
- Attempt operation requiring stake without sufficient stake → rejected

**`disputes.test.ts`** — Tier 4
- Consumer disputes within window → funds held
- Mutual resolution (consumer + provider agree) → funds split
- On-chain arbitration (stake-weighted vote) → funds distributed
- Evidence submission via Walrus → blob ID recorded on dispute
- Dispute after window expires → rejected

**`encryption.test.ts`** — Tier 4
- X25519 key exchange between two agents
- Consumer encrypts task input → posts to Walrus → only provider can decrypt
- Provider encrypts result → only consumer can decrypt
- Relay and Walrus never see plaintext (verify encrypted bytes differ from content)
- Wrong key → decryption fails gracefully

---

#### CI Strategy

| Trigger | What Runs | Timeout | Blocking? |
|---|---|---|---|
| **Every PR** | Move unit tests (`sui move test`) + TypeScript unit tests (Vitest, mocked) | 5 min | Yes |
| **Every PR** | **Smoke E2E**: start local Sui → deploy contracts → fund 2 wallets → register provider → post task → accept → complete → release (one full lifecycle) | 3 min | Yes |
| **Merge to main** | Full Tier 1–4 E2E suite for current phase against local Sui | 15 min | Yes |
| **Nightly** | Full E2E against Sui Testnet (real network, not local) | 30 min | No (alert on failure) |
| **Nightly** | Walrus integration tests (Walrus Testnet) | 15 min | No (track flake rate, promote to blocking when stable) |
| **Manual/weekly** | zkLogin integration against Sui Devnet + real Google OIDC | 10 min | No |

**CI environment requirements:**
- Sui CLI installed (via `suiup` or Docker image)
- Node.js 22+ (matches production)
- Foundry/Anvil installed (Phase 2+)
- Windows + Linux runners (both must pass)

---

#### What's Real vs Mocked

| Component | E2E Tests | Why |
|---|---|---|
| Sui network | ✅ Real local `sui start` | Core of the system — must test real chain |
| Move contracts | ✅ Real deployment via `sui client publish` | Must match production deploy path |
| Sui transactions | ✅ Real sign + execute + wait | Core correctness guarantee |
| Event subscriptions | ✅ Real cursor-based polling | Critical for task coordination |
| Ed25519 identity | ✅ Real keypair generation | No external dependencies |
| Daemon process | ✅ Real process with IPC | Must test actual process lifecycle |
| MCP shim | ✅ Real stdio pipe | Must test actual MCP flow |
| Provider runtime | ✅ Real event listener + echo adapter | Must test event-driven architecture |
| Spending policy | ✅ Real SQLite DB | No external dependencies |
| BlobStore (alpha) | ✅ Filesystem mock (by design) | Alpha uses FS; not mocking, this IS the implementation |
| BlobStore (beta) | ✅ Walrus Testnet | Real integration (scheduled CI) |
| EVM / x402 | ✅ Real local Anvil (Foundry) | Real EVM, deterministic block production |
| Relay server | ✅ Real relay process | Must test WebSocket routing |
| zkLogin OIDC | ⚡ Local mock OIDC + mock salt | External OAuth can't run locally; mock tests flow, Devnet tests correctness |
| Base mainnet quirks | ⚡ Not covered in local tests | Nightly against Testnet covers this |

**Depends on:** M1–M9 (tests are written incrementally alongside each milestone; M10 is the integration gate)
**Produces:** Confidence that each phase works end-to-end with minimal mocking. Every merge to main is verified against a real local Sui network.

---

## 5. Phase 2: x402 + Relay Real-time (v0.2)

### M11: Relay Server

| Task | Detail |
|---|---|
| WebSocket server | Fastify + `@fastify/websocket`, accept outbound connections from agents |
| Session management | Provider registers session, consumer connects for task routing |
| Message routing | Route task request/response between consumer and provider sessions |
| Staking | Relay registers on Sui with minimum stake (100 SUI) |
| Health monitoring | Relay health endpoint, uptime tracking |

### M12: x402 on Base

| Task | Detail |
|---|---|
| EVM wallet | secp256k1 key from HKDF derivation, `viem` client for Base |
| x402 client | `@x402/evm` integration, Permit2 authorization |
| Payment rail selection | Async tasks → Sui escrow. Real-time relay tasks → prefer Sui, fallback x402 on Base |
| Relay settlement | Relay proxies x402 402 responses, verifies payment, routes to provider |

### M13: Real-time Task Flow

| Task | Detail |
|---|---|
| Relay client | Outbound WebSocket connection from daemon to relay |
| Sync task execution | Consumer → relay → provider → relay → consumer (low-latency) |
| Streaming support | Progressive result delivery for long-running tasks |
| Fallback | If relay unavailable, fall back to Sui async flow |

---

## 6. Phase 3: Trust Layer (v0.3)

### M14: Reputation System
- Reputation event publishing (task completion, dispute outcomes)
- Merkle tree anchoring on Sui (periodic batch commits)
- Local reputation score computation
- Reputation-weighted discovery ranking

### M15: Staking & Slashing
- Agent minimum stake (10 SUI)
- Relay minimum stake (100 SUI)
- Auto-slash for on-chain verifiable violations (expired escrow, non-delivery)
- Slash proposal + vote for off-chain disputes

### M16: Dispute Resolution
- Mutual dispute resolution (requester + provider agree)
- On-chain arbitration (stake-weighted voting)
- Evidence submission via Walrus blobs
- Partial release (proportional to completed work)

### M17: Encrypted Payloads
- X25519 key exchange between agents
- Encrypted task inputs/results on Walrus
- Public key published in AgentCard
- End-to-end encryption (relay and Walrus never see plaintext)

### M18: Open Marketplace
- Open task posting (no pre-selected provider)
- Provider bidding on open tasks
- Auction mechanism (lowest bid wins, or reputation-weighted)
- Task categories and search

---

## 7. Phase 4: Scale (v1.0)

### M19: Indexer Integration
- Sui indexer for complex registry queries (multi-field search, aggregations)
- GraphQL API for agent discovery
- Historical analytics (task volume, gas costs, reputation trends)

### M20: Multi-Provider Routing
- Multi-provider task execution (fan-out to N providers, aggregate results)
- Provider selection strategies (cheapest, fastest, highest-reputation)
- Circuit breaker for unreliable providers

### M21: Advanced Metering & Verification
- `upto` metered payment scheme (pay-per-unit with ceiling)
- Result verification (provider proves work via hash chain or zk proof)
- Streaming payment (micro-payments as work progresses)

### M22: Community Infrastructure
- ✅ Community-operated relay nodes (staked, earning routing fees)
- ✅ Community indexers
- ✅ Reference implementation documentation
- ✅ Interoperability test suite
- ✅ Spec freeze for v1.0
- ↗ External security audit recommended as a post-freeze operational follow-up

### Completion Summary

The reference implementation is complete through **M22**. Milestones **M1–M22 are implemented in the monorepo**, and the protocol surface is frozen at **v1.0.0** for interoperability.

| Milestone | Status |
|---|---|
| M1–M6 | ✅ Complete |
| M7–M12 | ✅ Complete |
| M13–M18 | ✅ Complete |
| M19–M22 | ✅ Complete |

---

## 8. Milestone Dependency Graph

```
Phase 1 — v0.1-alpha:

M1 (Bootstrap) ──┬──→ M2 (Contracts) ──→ M3 (Core Lib) ──→ M4 (Daemon Min) ──→ M5 (Shim) ──→ M6 (MCP Tools)
                  │                                                │                               │
                  ├──→ M2a (Walrus Spike)                          ├──→ M4b (Provider Runtime) ────┘
                  │                                                │
                  └────────────────────────────────────────────────→ M4a (Vertical Slice) ──→ M9 (CLI)
                                                                   │
                                                                   └──→ M4c (Multi-App) ──→ M10 (E2E Tests)

Phase 1 — v0.1-beta:

M4 ──→ M7 (Auth/zkLogin)
M2a + M3 ──→ M8 (Walrus Integration)

Phase 2:
M10 ──→ M11 (Relay) ──→ M13 (Real-time)
M10 ──→ M12 (x402) ──→ M13

Phase 3:
M13 ──→ M14 (Reputation) ──→ M15 (Staking) ──→ M16 (Disputes)
M13 ──→ M17 (Encryption)
M16 ──→ M18 (Marketplace)

Phase 4:
M18 ──→ M19–M22
```

**Vertical Slice (M4a)** gates further milestone investment — if the full stack doesn't work end-to-end, stop and reassess before building M4b/M4c/M9.

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Walrus SDK immaturity | Medium | Medium | M2a spike validates early; abstract behind `BlobStore` interface; FS fallback |
| zkLogin complexity | Medium | High | Test early (M7 spike), standalone Ed25519 as fallback identity |
| Shared Registry contention at scale | Low | Medium | Shard by capability prefix if needed; registration is infrequent |
| Sui mainnet gas volatility | Medium | Low | Gas estimation + budget margin; sponsor transactions for onboarding |
| x402 Sui spec not implemented | High | Medium | Use x402 only on Base (production); Sui-native escrow for on-mesh payments |
| Event delivery latency on mainnet | Medium | Medium | Relay network (Phase 2) for real-time; async flow tolerant of seconds of latency |
| MCP protocol evolution | Low | Medium | Thin MCP layer; core protocol is MCP-independent |
| Provider race conditions | Medium | Low | Failed acceptance is cheap (~0.001 SUI); add pre-qualification in Phase 3 |
| Daemon IPC security | Medium | High | Socket ACLs (owner-only), per-app auth, tool-level permissions (M4) |
| Dispute fund locking | Medium | Medium | Don't expose disputes in v0.1; requesters release or providers claim after window |

---

## 10. Definition of Done

### v0.1-alpha (core, validated stack)

- [x] Move contracts deployed to Sui Testnet with ≥40 unit tests
- [x] Ed25519 identity generation and persistence
- [x] `mesh connect` works as MCP server for Claude Desktop and VS Code
- [x] `mesh_discover` returns agents by capability from Sui registry
- [x] `mesh_execute` posts task, waits for completion, releases payment (end-to-end)
- [x] Provider mode: daemon subscribes to task events, accepts and completes matching tasks
- [x] Echo sample capability passes full lifecycle test
- [x] Multi-app: two MCP apps share one daemon, spending limits enforced
- [x] Mock BlobStore (filesystem) for all task payloads
- [x] Event cursor persistence — daemon restart doesn't lose task state
- [x] Daemon IPC security: socket ACLs, per-app identification
- [x] **PR smoke E2E passes** (local Sui, deploy, one full task lifecycle)
- [x] **Full Tier 1–4 E2E suite passes on merge** (all `phase1/*.test.ts`)
- [x] **Nightly Sui Testnet E2E passes** (real network verification)
- [x] CLI commands: `init`, `connect`, `daemon`, `register`, `config`, `wallet`, `discover`
- [x] Local dev scripts: start Sui, deploy contracts, seed test agents
- [x] Documentation: README, getting started, provider guide

### v0.1-beta (adds risky integrations)

- [x] zkLogin: Google OAuth → Mysten salt → Sui wallet (first-run UX)
- [x] HKDF EVM key derivation from zkLogin secrets
- [x] Walrus Testnet: task payloads stored/retrieved via Walrus
- [x] Local web portal: setup, settings, wallet, history
- [x] Device code flow for headless environments
