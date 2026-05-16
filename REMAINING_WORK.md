# Agentic Mesh — Remaining Work

**Date:** 2026-05-15
**Current state:** All 22 implementation milestones complete, spec frozen at v1.0.0, all known shortcuts fixed, examples created. Everything runs against a local Sui network. Nothing has been deployed to a public network yet.

---

## 1. Sui Testnet / Mainnet Deployment

**Status:** Contracts only run against local `sui start` instances.

- [ ] Deploy Move contracts to **Sui testnet**
  - Publish `contracts/agentic_mesh` with a dedicated deployer wallet
  - Record the canonical `packageId` and `registryId` for testnet
  - Fund a deployment wallet and document the process
- [ ] Create a **network config registry** (testnet addresses, RPC URLs, faucet URLs) that the CLI and daemon can select via `--network testnet|mainnet|local`
- [ ] Add **contract upgrade strategy** — the current `Move.toml` uses `agentic_mesh = "0x0"` (auto-assign on publish). For upgradeability, decide on:
  - Immutable publish vs. upgradeable with `UpgradeCap`
  - If upgradeable: who holds the `UpgradeCap`? Multisig? DAO?
  - Migration plan for shared objects (Registry, StakePosition) across versions
- [ ] Deploy to **Sui mainnet** once testnet validation is complete
- [ ] Document the full deployment runbook (wallet setup, gas estimation, verification)

---

## 2. Walrus Production Integration

**Status:** Filesystem-based `FilesystemBlobStore` used in tests and examples. `WalrusBlobStore` exists and points at testnet endpoints but is behind an env-gate (`RUN_WALRUS_TESTNET=true`).

- [ ] Validate `WalrusBlobStore` against **Walrus testnet** end-to-end (store → fetch → verify)
- [ ] Integrate `HybridBlobStore` (Walrus + local cache) as the default in the daemon
- [ ] Handle Walrus availability/storage epoch expiry — blobs on Walrus have a TTL; tasks that reference expired blobs need graceful handling
- [ ] Evaluate Walrus costs and document pricing for providers and requesters
- [ ] Add Walrus blob pinning/renewal for long-lived task results

---

## 3. x402 / Base Production Integration

**Status:** x402 payment tests run against Anvil (local EVM fork). No real Base testnet or mainnet deployment.

- [ ] Deploy and test x402 payment flow against **Base Sepolia** (testnet)
- [ ] Deploy to **Base mainnet**
- [ ] Configure real USDC/WETH contract addresses for Base mainnet
- [ ] Add EVM wallet management to the CLI (import private key, connect hardware wallet)
- [ ] Test relay-mediated x402 payment flow end-to-end on a public network
- [ ] Document x402 setup for relay operators (RPC URLs, facilitator config)

---

## 4. Relay Infrastructure

**Status:** Relay server implementation is complete (Fastify + WebSocket). `relay_registry.move` allows on-chain registration. No public relay is running.

- [ ] Deploy at least one **seed relay** to a public server
- [ ] Create **Docker image** for relay deployment (`Dockerfile`, health checks, env config)
- [ ] Deploy relay registration on Sui testnet so agents can discover community relays
- [ ] Write operational runbook: monitoring, scaling, log aggregation, alerting
- [ ] Implement relay **rate limiting** and **abuse protection** for production traffic
- [ ] Add relay **TLS termination** guide (nginx/Caddy reverse proxy or native TLS)
- [ ] Test NAT traversal scenarios with real agents behind firewalls

---

## 5. Security Audit

**Status:** The v1.0 spec roadmap explicitly lists "Security audit" as a v1.0 deliverable. No audit has been performed.

- [ ] **Move contract audit** — the 7 modules (registry, task, staking, dispute, reputation, marketplace, relay_registry) control real funds via escrow and staking
- [ ] **TypeScript SDK audit** — identity management, key storage, session tokens, IPC security
- [ ] **Relay server audit** — WebSocket authentication, DID verification, replay protection
- [ ] **Cryptographic review** — Ed25519 signing, X25519 encryption, zkLogin integration, HKDF key derivation
- [ ] **Dependency audit** — supply chain review of critical dependencies (@noble/ed25519, @noble/ciphers, viem, better-sqlite3, keytar)
- [ ] Address any findings and re-test

---

## 6. Package Publishing (npm)

**Status:** All packages are `"private": true` with no `publishConfig`. The SDK cannot be consumed outside the monorepo.

- [ ] Decide which packages to publish: `@agentic-mesh/types`, `@agentic-mesh/core`, `@agentic-mesh/mcp-server` at minimum
- [ ] Add `publishConfig` with `"access": "public"` to each publishable package
- [ ] Set up **changesets** or a release workflow for semantic versioning
- [ ] Add a GitHub Actions workflow for `npm publish` on tagged releases
- [ ] Write a **CONTRIBUTING.md** with development setup, PR conventions, and release process
- [ ] Publish initial versions to npm

---

## 7. CLI Distribution

**Status:** The CLI works via `pnpm --filter @agentic-mesh/cli exec mesh ...` from the monorepo. No standalone binary or global npm install.

- [ ] Make `@agentic-mesh/cli` a publishable package with a `bin` entry
- [ ] Test `npx @agentic-mesh/cli mesh init` flow
- [ ] Consider a standalone binary via `pkg` or `bun compile` for zero-dependency install
- [ ] Add shell completions (bash, zsh, PowerShell)
- [ ] Add `mesh --version` and `mesh --help` polish

---

## 8. CI/CD Enhancements

**Status:** CI runs lint, build, unit tests, and a smoke E2E on local Sui (Ubuntu + Windows). No testnet CI, no coverage reporting, no Move contract CI.

- [ ] Add **Move contract tests** to CI (`sui move test` step)
- [ ] Add **code coverage** reporting (vitest coverage → Codecov/Coveralls)
- [ ] Add a **testnet integration** CI job (deploy contracts to Sui testnet, run subset of E2E)
- [ ] Add **release automation** (tag → build → publish → GitHub Release)
- [ ] Add **dependency update** automation (Dependabot or Renovate)
- [ ] Consider a nightly job that runs the full E2E suite (all phases) against a fresh local Sui

---

## 9. Streaming Payments

**Status:** Intentional v1 design limitation. Metered tasks use periodic Sui transactions, not true payment channels or streaming.

- [ ] Evaluate **Sui payment channels** or a Layer 2 for high-frequency micro-payments
- [ ] Design a streaming payment protocol (open channel → stream units → settle)
- [ ] Implement and test against metered task workloads
- [ ] Update the spec with the streaming payment extension

---

## 10. Interoperability Testing

**Status:** The v1.0 spec roadmap calls for an "Interoperability test suite." Current tests validate the TypeScript reference implementation against itself.

- [ ] Define an **interoperability test protocol** — what must a conforming implementation support?
- [ ] Create a **conformance test harness** that validates any Agentic Mesh client against the spec
- [ ] Test against at least one **alternative implementation** (e.g., Python, Rust)
- [ ] Publish the conformance suite as a standalone package

---

## 11. Production Hardening

- [ ] **Graceful degradation** — what happens when Sui RPC is slow or unreachable? Add circuit breakers and retry policies throughout
- [ ] **Event cursor persistence** — verify SQLite cursor store handles crashes, partial writes, and DB corruption
- [ ] **Daemon process management** — add systemd/launchd service files for production installs
- [ ] **Log rotation** — configure pino log rotation for long-running daemons
- [ ] **Metrics / observability** — expose Prometheus metrics from daemon and relay (task counts, payment amounts, latency histograms)
- [ ] **Health endpoints** — `/health` and `/ready` for relay and indexer in production deployments
- [ ] **Rate limiting** — add per-DID rate limits to the relay and indexer

---

## 12. Documentation Gaps

**Status:** 4 docs exist (getting-started, provider-guide, relay-operator-guide, mcp-tool-reference). Several production-facing docs are missing.

- [ ] **Deployment guide** — how to deploy contracts, run a relay, set up indexer
- [ ] **Security guide** — key management best practices, threat model, backup/recovery
- [ ] **Upgrade guide** — how to handle contract upgrades, client version compatibility
- [ ] **Troubleshooting guide** — common errors, debugging tips, log interpretation
- [ ] **API reference** (auto-generated) — TypeDoc or similar for the SDK packages
- [ ] **Architecture decision records (ADRs)** — document key decisions (dual-chain, shared vs owned objects, etc.) for future contributors
- [ ] Update the spec's Appendix C roadmap to reflect post-v1.0 plans

---

## 13. Skipped / Gated Tests

**Status:** 5 test cases are currently skipped behind environment flags.

| Test | Gate | Reason |
|------|------|--------|
| `walrus-e2e.test.ts` | `RUN_WALRUS_TESTNET` | Needs real Walrus testnet |
| `walrus-lifecycle-e2e.test.ts` | `RUN_WALRUS_TESTNET` | Needs real Walrus testnet |
| `walrus-spike.test.ts` | `RUN_WALRUS_TESTNET` | Needs real Walrus testnet |
| `x402-payment.test.ts` | `RUN_ANVIL_TESTS` | Needs Anvil (Foundry) running |
| `staking-e2e.test.ts` (slash test) | Hard-skipped | Needs local Sui clock fast-forward |

- [ ] Set up CI with Walrus testnet credentials to un-gate Walrus tests
- [ ] Set up CI with Anvil to un-gate x402 tests
- [ ] Investigate Sui localnet clock manipulation for the staking slash test

---

## 14. Repository Cleanup

- [ ] Remove ~300 `Pub.mesh-local-*.toml` files from the working directory (they're gitignored but clutter the disk)
- [ ] Clean up `sui_tmp/` directory if present
- [ ] Review and prune any stale `scripts/` that were only used during development
- [ ] Add a `pnpm run clean:all` script that removes runtime artifacts

---

## 15. Community & Governance

- [ ] **LICENSE** — choose and add a license file (MIT, Apache 2.0, or dual)
- [ ] **CONTRIBUTING.md** — contribution guidelines, code of conduct, PR process
- [ ] **Issue templates** — bug report, feature request, security vulnerability
- [ ] **Governance model** — who controls contract upgrades? Multisig? Token governance? DAO?
- [ ] **Relay operator incentives** — document the economic model for running community relays
- [ ] **Agent staking economics** — validate the 10 SUI agent / 100 SUI relay minimums against real-world economics

---

## Priority Order (Suggested)

| Priority | Item | Why |
|----------|------|-----|
| **P0** | Sui testnet deployment | Nothing works on a public network yet |
| **P0** | Security audit | Contracts handle real funds |
| **P0** | License | Cannot have community adoption without one |
| **P1** | Walrus production integration | Filesystem blob store doesn't scale |
| **P1** | Seed relay deployment | Real-time task flow needs at least one relay |
| **P1** | npm package publishing | SDK must be consumable outside the monorepo |
| **P1** | CLI distribution | Developers need `npx @agentic-mesh/cli` |
| **P2** | x402 / Base production | Dual-chain is a differentiator but Sui-only works |
| **P2** | CI/CD enhancements | Move tests in CI, coverage, release automation |
| **P2** | Documentation gaps | Deployment guide, security guide critical for operators |
| **P2** | Production hardening | Metrics, health checks, rate limiting |
| **P3** | Interoperability testing | Important for ecosystem but not blocking launch |
| **P3** | Streaming payments | v2 feature, periodic Sui txs work for v1 |
| **P3** | Governance model | Needed before mainnet, not before testnet |
| **P3** | Repository cleanup | Nice-to-have, doesn't block anything |
