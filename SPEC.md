# Agentic Mesh Protocol Specification

**Version:** 0.1.0-draft
**Status:** Draft
**Date:** 2026-05-14

---

## Table of Contents

1. [Overview](#1-overview)
2. [Design Principles](#2-design-principles)
3. [Terminology](#3-terminology)
4. [Protocol Layers](#4-protocol-layers)
5. [Layer 1: Identity](#5-layer-1-identity)
6. [Layer 2: Discovery](#6-layer-2-discovery)
7. [Layer 3: Capability Description](#7-layer-3-capability-description)
8. [Layer 4: Negotiation & Agreements](#8-layer-4-negotiation--agreements)
9. [Layer 5: Payment](#9-layer-5-payment)
10. [Layer 6: Task Execution](#10-layer-6-task-execution)
11. [Layer 7: Reputation & Disputes](#11-layer-7-reputation--disputes)
12. [Security Model](#12-security-model)
13. [Privacy Model](#13-privacy-model)
14. [Network Topology & Bootstrap](#14-network-topology--bootstrap)
15. [Error Handling](#15-error-handling)
16. [Extension Points](#16-extension-points)
17. [Appendix: Wire Formats](#17-appendix-wire-formats)

---

## 1. Overview

The **Agentic Mesh Protocol** defines a decentralized agent network in which autonomous AI agents discover, negotiate with, pay, and delegate tasks to one another using a **dual-chain architecture**: **Sui** for canonical shared state and **Base** for HTTP-native x402 payments.

The protocol assumes many agents run on desktops, laptops, or private infrastructure behind NAT. Providers therefore do **not** need to expose public HTTP servers. Instead, agents use outbound connections to **relay nodes** for low-latency traffic and **Sui + Walrus** for asynchronous coordination and large data exchange.

### 1.1 Problem Statement

Today's AI agent ecosystems are siloed. An agent built with one framework cannot easily discover or transact with agents built on another. Centralized orchestrators create single points of failure, control, and rent extraction. There is no standard way for an agent to:

- Advertise capabilities without operating public internet-facing infrastructure
- Discover specialized agents through a canonical, shared registry
- Pay for services using either HTTP-native payments or cheap native on-mesh transfers
- Coordinate long-running tasks with escrow, verifiable completion, and dispute hooks
- Build and verify reputation across interactions and organizational boundaries

### 1.2 Proposed Solution

Agentic Mesh provides a layered protocol stack that separates concerns cleanly:

```
┌─────────────────────────────────────┐
│  Layer 7: Reputation & Disputes     │
├─────────────────────────────────────┤
│  Layer 6: Task Execution            │
├─────────────────────────────────────┤
│  Layer 5: Payment                   │
├─────────────────────────────────────┤
│  Layer 4: Negotiation & Agreements  │
├─────────────────────────────────────┤
│  Layer 3: Capability Description    │
├─────────────────────────────────────┤
│  Layer 2: Discovery                 │
├─────────────────────────────────────┤
│  Layer 1: Identity                  │
└─────────────────────────────────────┘
```

Each layer can evolve independently.

- **Sui** anchors identity bindings, AgentCard registry state, staking/slashing, reputation commitments, task coordination, and escrow.
- **Base** provides the EVM payment environment for **x402**, using the existing `@x402/evm` stack for relay-mediated, HTTP-native payments.
- **Walrus** stores large task inputs, results, and extended profiles.
- **Relay nodes** provide low-latency routing and streaming between agents that maintain only outbound connectivity.

### 1.3 Value Proposition

| Value | Description |
|-------|-------------|
| **Specialization** | Agents optimized for narrow tasks compose into powerful pipelines |
| **Resilience** | Canonical state lives on Sui while multiple relays and indexers prevent dependence on any single operator |
| **Cost Efficiency** | On-mesh Sui transfers are typically much cheaper than Base x402 settlement for agent-to-agent work |
| **Composability** | Anyone can publish an AgentCard, accept tasks, and integrate new capabilities without permission |
| **Permissionless Monetization** | Agents can monetize through Base x402 or native Sui escrow and transfer flows |
| **Low-Friction Participation** | Outbound-only connectivity and zkLogin onboarding reduce infrastructure and key-management burden |
| **Privacy** | Payloads can be encrypted end-to-end; relays and storage layers need only minimal metadata |
| **Competition** | Multiple agents for the same capability drives quality up and prices down |

---

## 2. Design Principles

1. **Decentralized by default.** No single party can censor, surveil, or extract rent from the network.
2. **Outbound-first connectivity.** Agents MUST be able to participate without accepting inbound public connections.
3. **Dual payment rails.** Use Base x402 for HTTP-native payments and Sui-native transfers/escrow for on-mesh coordination.
4. **Trust-minimized shared state.** Critical registry, staking, escrow, and reputation anchors live on Sui.
5. **Layered and modular.** Each protocol layer is independently evolvable and replaceable.
6. **Agent-framework agnostic.** Any agent — regardless of framework, language, or model — can participate if it speaks the protocol.
7. **Privacy-conscious.** Minimize metadata leakage. Support private capabilities and encrypted task payloads.
8. **Economically sustainable.** Valuable work is paid for, spam is costly, and relay operators are incentive-aligned via staking and fees.

---

## 3. Terminology

| Term | Definition |
|------|-----------|
| **Agent** | An autonomous software entity that can discover, negotiate with, pay, and perform tasks for other agents |
| **AgentCard** | A signed capability manifest whose canonical copy is represented by a Sui object in the on-chain registry |
| **Capability** | A discrete unit of work an agent can perform, described by input/output schemas and pricing |
| **Requester** | An agent requesting a task be performed |
| **Provider** | An agent performing a task in exchange for payment |
| **Relay Node** | A public WebSocket/HTTP service that routes real-time traffic between agents that only maintain outbound connections |
| **Facilitator** | A service that verifies and settles x402 payments on Base for relay-mediated HTTP flows |
| **TaskAgreement** | A signed contract between requester and provider specifying terms of a task |
| **Escrow** | A Sui smart-contract object that holds payment until completion, release, timeout, or dispute resolution |
| **ReputationEvent** | A signed, timestamped record of a task outcome (completion, dispute, cancellation) |
| **Walrus** | Sui's decentralized storage layer for large task payloads, results, evidence bundles, and extended profiles |
| **Indexer** | An optional service that indexes Sui registry objects and events for rich search and discovery |
| **Mesh** | The shared-state and relay-routed network formed by agents, Sui, Walrus, relays, and indexers |

---

## 4. Protocol Layers

The protocol is organized into seven layers. Each layer depends only on the layers below it.

### Layer Dependencies

```
Reputation & Disputes  ──depends on──▸  Task Execution, Payment, Identity
Task Execution         ──depends on──▸  Negotiation, Payment, Identity
Payment                ──depends on──▸  Identity
Negotiation            ──depends on──▸  Capability Description, Identity
Capability Description ──depends on──▸  Identity
Discovery              ──depends on──▸  Identity
Identity               ──depends on──▸  (cryptographic primitives only)
```

---

## 5. Layer 1: Identity

### 5.1 Agent Identity

Every agent in the mesh is identified by a **Decentralized Identifier (DID)** derived from a **persistent Ed25519 identity keypair** generated during first-time setup.

**Identity Key:**
- Algorithm: Ed25519
- Generated once during setup and stored in the local OS keychain or equivalent secure enclave
- The public key serves as the basis for the agent's DID
- DID Method: `did:mesh:<base58-encoded-public-key>`
- This key remains the root mesh identity even when zkLogin is used for Sui wallet onboarding

**Example:**
```
did:mesh:7Hf2pWkzV9QxYn3jKmNvRtBsCdAeUwXg4LhJi5Zo8F6E
```

### 5.2 Key Separation

> **CRITICAL:** Identity keys and payment keys MUST be separate.

An agent maintains distinct key material for different purposes:

| Key Type | Algorithm | Purpose |
|----------|-----------|---------|
| Identity Key | Ed25519 | Persistent mesh identity key for signing AgentCards, messages, reputation events, and DID documents |
| Sui Wallet Authorization | zkLogin ephemeral Ed25519 per session, or standalone Ed25519 wallet | Native Sui payments, staking, registry operations, and escrow |
| EVM Payment Key | secp256k1 | x402 payments on Base |

The Sui wallet address and EVM payment key are **bound** to the identity key via signed attestations in the Agent DID Document.

### 5.3 Agent DID Document

```json
{
  "@context": "https://agentic-mesh.org/did/v1",
  "id": "did:mesh:7Hf2pWkzV9QxYn...",
  "created": "2026-05-14T10:00:00Z",
  "updated": "2026-05-14T10:00:00Z",
  "verificationMethod": [
    {
      "id": "did:mesh:7Hf2pWkzV9QxYn...#identity",
      "type": "Ed25519VerificationKey2020",
      "controller": "did:mesh:7Hf2pWkzV9QxYn...",
      "publicKeyMultibase": "z6Mkf5rGMoatrSj1f..."
    },
    {
      "id": "did:mesh:7Hf2pWkzV9QxYn...#encryption",
      "type": "X25519KeyAgreementKey2020",
      "controller": "did:mesh:7Hf2pWkzV9QxYn...",
      "publicKeyMultibase": "z6LS..."
    }
  ],
  "authentication": ["did:mesh:7Hf2pWkzV9QxYn...#identity"],
  "assertionMethod": ["did:mesh:7Hf2pWkzV9QxYn...#identity"],
  "keyAgreement": ["did:mesh:7Hf2pWkzV9QxYn...#encryption"],
  "paymentEndpoints": [
    {
      "id": "did:mesh:7Hf2pWkzV9QxYn...#sui-wallet",
      "network": "sui:mainnet",
      "address": "0xabc...def",
      "proof": "<signature-binding-this-wallet-to-identity>"
    },
    {
      "id": "did:mesh:7Hf2pWkzV9QxYn...#evm-wallet",
      "network": "eip155:8453",
      "address": "0x1234...abcd",
      "proof": "<signature-binding-this-wallet-to-identity>"
    }
  ],
  "attestations": [
    {
      "id": "did:mesh:7Hf2pWkzV9QxYn...#binding-v1",
      "type": "IdentityBindingAttestation",
      "suiAddress": "0xabc...def",
      "evmAddress": "0x1234...abcd",
      "proof": "<identity-signature-binding-did-sui-and-evm-addresses>"
    }
  ],
  "service": [
    {
      "id": "did:mesh:7Hf2pWkzV9QxYn...#relay-primary",
      "type": "AgenticMeshRelay",
      "serviceEndpoint": "wss://relay-1.agentic-mesh.org/v1/ws",
      "relayId": "did:mesh:relay-alpha",
      "modes": ["sync", "streaming", "negotiation"]
    },
    {
      "id": "did:mesh:7Hf2pWkzV9QxYn...#relay-secondary",
      "type": "AgenticMeshRelay",
      "serviceEndpoint": "wss://relay-2.agentic-mesh.org/v1/ws",
      "relayId": "did:mesh:relay-beta",
      "modes": ["sync", "streaming", "fallback"]
    }
  ],
  "keyRotation": {
    "previousKeys": [],
    "rotationPolicy": "manual"
  }
}
```

Agents do **not** advertise public provider HTTP endpoints in the DID Document. Service entries identify relay rendezvous points and other outbound-friendly coordination surfaces.

### 5.4 Key Rotation & Revocation

- Agents MAY rotate identity keys by publishing a new DID Document signed by the **old** key, containing the new key and a `rotatedAt` timestamp.
- Payment keys MAY be rotated independently by updating the `paymentEndpoints` in the DID Document.
- Revocation or deactivation is achieved by publishing a Sui registry transaction that supersedes or deactivates the current AgentCard and emits the corresponding registry event.
- Consumers MUST check key freshness against the latest Sui object state and event sequence before trusting a cached DID Document.

### 5.5 zkLogin Identity

Agents MAY use **Sui zkLogin** to simplify wallet onboarding, but zkLogin does **not** replace the mesh identity key.

1. During first-time setup, the client generates a **persistent Ed25519 mesh identity keypair** and stores it in the OS keychain.
2. The DID is derived from that persistent public key: `did:mesh:<base58-pubkey>`.
3. The user authenticates with an OAuth provider (Google, Apple, GitHub, etc.) and zkLogin yields the **Sui address** used for registry operations, staking, escrow, and native Sui payments.
4. zkLogin ephemeral keys are regenerated per session for Sui transaction authorization. They do **not** replace the persistent identity key.
5. The **EVM payment key** MAY be derived client-side from the mesh identity private key, `user_salt`, and OAuth subject for x402 payments on Base.
6. The mesh identity key, Sui address, and EVM address are bound together via signed attestations in the DID Document.

**Key hierarchy:**

```text
Mesh Identity Key (Ed25519, persistent, OS keychain)
  |- Signs: AgentCards, messages, reputation events, DID documents
  |- DID: did:mesh:<base58-pubkey>
  |
  |- Sui Wallet Address (from zkLogin or standalone Ed25519)
  |  `- Used for: registry operations, staking, escrow, native Sui payments
  |
  `- EVM Payment Key (secp256k1, derived via HKDF or imported)
     `- Used for: x402 payments on Base
```

For v1, Agentic Mesh uses the standard **Mysten salt service**, which holds the full `user_salt`. This means Mysten can reconstruct the user's Sui address, as is already true for any zkLogin user. Mysten still **cannot** derive the EVM payment key because the EVM derivation happens client-side and additionally requires the local mesh identity private key.

**EVM derivation (`user_salt` held by Mysten salt service):**

```text
ethKey = HKDF-SHA256(
  ikm: sha256(identity_privkey || user_salt || oauth_sub),
  salt: oauth_iss,
  info: "agentic-mesh:evm:v1"
)
```

This enables zero-friction onboarding:

```text
OAuth login  persistent mesh identity key + zkLogin Sui address + derived EVM address
```

No seed phrase is required for the default onboarding path. Future versions MAY support decentralized salt custody (Walrus + password, Shamir across relays, or self-managed salts), while advanced operators MAY still manage manually generated keys.

---

## 6. Layer 2: Discovery

Discovery is the process by which agents find each other on the mesh. In v1, discovery is **Sui-native**: the blockchain is the canonical registry, optional indexers accelerate search, and each agent maintains a local cache for fast reads.

### 6.1 Discovery Architecture

```
┌──────────────────────────────────────────────────────┐
│  Tier 3: Sui Indexer Services (optional)             │  ← Rich search, ranking, filtering
├──────────────────────────────────────────────────────┤
│  Tier 2: Sui On-Chain Registry                       │  ← AgentCard objects, canonical state
├──────────────────────────────────────────────────────┤
│  Tier 1: Local Cache (SQLite)                        │  ← Fast lookup, offline reads
└──────────────────────────────────────────────────────┘
```

### 6.2 Tier 1: Local Cache (SQLite)

Agents SHOULD maintain a local SQLite cache of AgentCards and related metadata synchronized from Sui events.

**Cache goals:**
- Fast local lookup by DID, capability tag, relay availability, or payment network
- Offline reads against the last synchronized registry snapshot
- Local ranking, admission heuristics, and request routing decisions
- Reduced dependence on remote RPC/indexer latency for hot paths

**Synchronization model:**
1. Subscribe to `AgentRegistered`, `AgentUpdated`, and `AgentDeactivated` events from Sui
2. Materialize the latest AgentCard state locally
3. Refresh Walrus-backed profile blobs on demand or opportunistically
4. Evict or mark stale cache entries when `expiresAt` passes or the on-chain object is deactivated

### 6.3 Tier 2: Sui On-Chain Registry

The canonical registry is a Sui smart contract centered on a **shared `Registry` object**. AgentCards remain owned Sui objects with `key, store` abilities, while the shared registry maintains the discovery indexes.

```move
public struct Registry has key {
    id: UID,
    // capability_tag -> vector of AgentCard object IDs
    agents_by_capability: Table<String, vector<address>>,
    // DID -> AgentCard object ID
    agents_by_did: Table<vector<u8>, address>,
    agent_count: u64,
}
```

```move
public fun register_agent(
    registry: &mut Registry,
    /* agent card fields, stake proof, ctx */
): address
```

**Core properties:**
- **Registration:** `register_agent` creates an owned `AgentCard` object and adds its object ID to the shared registry indexes
- **Update:** `update_agent` supersedes the prior state while preserving sequence ordering and refreshing the shared indexes
- **Deactivation:** `deactivate_agent` marks the card inactive, removes its capability entries from the shared `Registry`, and emits an event
- **Discovery:** Consumers query the `Registry` dynamic fields by capability tag to get AgentCard object IDs, then fetch those objects directly
- **Listing / complex queries:** Consumers subscribe to `AgentRegistered`, `AgentUpdated`, and `AgentDeactivated` and build a local index for rich filtering or full listings
- **Pagination:** Event streams are naturally paginated by Sui checkpoint and cursor

The blockchain **is** the registry. No separate authoritative discovery service is required.

Rich profile data that would be expensive to store directly on-chain MAY be stored on Walrus and referenced from the AgentCard via blob IDs.

### 6.4 Tier 3: Sui Indexer Services (Optional)

For production search (semantic matching, compound filters, ranking, availability scoring), optional **Sui indexer services** MAY index registry objects, task events, staking state, and reputation anchors.

**Indexer capabilities:**
- Full-text and semantic search over capability descriptions and Walrus profile blobs
- Filtering by price range, reputation threshold, supported networks, relay support, and jurisdiction
- Ranked results using price, latency, stake, success rate, or freshness
- Enriched joins across registry state, task history, and reputation anchors

**Trust model:** Indexers are accelerators, not authorities. Consumers MUST verify AgentCard signatures and Sui object state directly before acting.

### 6.5 Bootstrap

New agents join the mesh through a minimal bootstrap set:

1. **Sui RPC endpoint** (public or self-hosted) — connect to the registry and event stream
2. **Community relay nodes** — enable low-latency routing and streaming
3. **Hardcoded default relay list** — allow first connection before any local cache exists

Bootstrap sources are trusted only for reachability. Correctness comes from verifying Sui state, signatures, and object ownership.

---

## 7. Layer 3: Capability Description

### 7.1 AgentCard

The AgentCard is the primary document through which an agent advertises itself to the mesh. It is signed, versioned, and anchored on-chain via a Sui object.

```json
{
  "@context": "https://agentic-mesh.org/agentcard/v1",
  "agentId": "did:mesh:7Hf2pWkzV9QxYn...",
  "suiObjectId": "0x9f4c...42",
  "name": "WeatherAgent",
  "description": "High-accuracy global weather forecasting agent",
  "version": "2.1.0",
  "issuedAt": "2026-05-14T10:00:00Z",
  "expiresAt": "2026-06-14T10:00:00Z",
  "sequence": 42,
  "previousHash": "sha256:abc123...",
  "relayEndpoints": [
    {
      "relayDid": "did:mesh:relay-alpha",
      "endpoint": "wss://relay-1.agentic-mesh.org/v1/ws",
      "modes": ["sync", "streaming", "negotiation"]
    },
    {
      "relayDid": "did:mesh:relay-beta",
      "endpoint": "wss://relay-2.agentic-mesh.org/v1/ws",
      "modes": ["sync", "streaming", "fallback"]
    }
  ],
  "walrusProfileBlobId": "0x0f1e2d3c4b5a6978",
  "totalTasksCompleted": 1284,
  "totalTasksDisputed": 12,
  "registeredAt": 1715680800000,

  "capabilities": [
    {
      "id": "get-current-weather",
      "version": "1.0.0",
      "description": "Get current weather conditions for a location",
      "tags": ["weather", "forecast", "current-conditions"],
      "inputSchema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "City name or coordinates" },
          "units": { "type": "string", "enum": ["metric", "imperial"], "default": "metric" }
        },
        "required": ["location"]
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "temperature": { "type": "number" },
          "humidity": { "type": "number" },
          "conditions": { "type": "string" },
          "windSpeed": { "type": "number" }
        }
      },
      "pricing": [
        {
          "scheme": "exact",
          "amount": "1000",
          "currency": "USDC",
          "coinType": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
          "network": "sui:mainnet",
          "displayPrice": "$0.001"
        },
        {
          "scheme": "exact",
          "amount": "1000",
          "currency": "USDC",
          "coinType": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "network": "eip155:8453",
          "displayPrice": "$0.001"
        }
      ],
      "sla": {
        "maxLatencyMs": 5000,
        "availability": 0.99
      },
      "executionMode": "sync"
    },
    {
      "id": "generate-forecast-report",
      "version": "1.0.0",
      "description": "Generate a detailed 7-day weather forecast report",
      "tags": ["weather", "forecast", "report", "long-running"],
      "inputSchema": {
        "type": "object",
        "properties": {
          "location": { "type": "string" },
          "days": { "type": "integer", "minimum": 1, "maximum": 14 }
        },
        "required": ["location"]
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "report": { "type": "string" },
          "dailyForecasts": { "type": "array" }
        }
      },
      "pricing": [
        {
          "scheme": "exact",
          "amount": "50000",
          "currency": "USDC",
          "coinType": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
          "network": "sui:mainnet",
          "displayPrice": "$0.05"
        }
      ],
      "sla": {
        "maxLatencyMs": 60000,
        "availability": 0.95
      },
      "executionMode": "async"
    }
  ],

  "protocols": ["agentic-mesh/1.0"],

  "admissionPolicy": {
    "minRequesterReputation": 0.3,
    "maxConcurrentTasks": 100,
    "geoRestrictions": [],
    "requiredPaymentNetworks": ["sui:mainnet", "eip155:8453"]
  },

  "reputationRefs": [
    {
      "provider": "did:mesh:reputation-provider-1",
      "uri": "walrus://blob_reputation_manifest_provider_1"
    }
  ],

  "termsHash": "sha256:def456...",
  "termsUri": "walrus://blob_weather_agent_terms_v2",

  "signature": {
    "signer": "did:mesh:7Hf2pWkzV9QxYn...#identity",
    "algorithm": "Ed25519",
    "value": "<base64-encoded-signature-over-canonical-card>"
  }
}
```

The on-chain `AgentCard` stores verifiable facts rather than a protocol-defined score field. In Move, these fields are represented as values such as `total_tasks_completed`, `total_tasks_disputed`, `stake: Balance<SUI>`, `registered_at`, and `walrus_profile_blob_id: u256`; the JSON materialization above uses camelCase and hex-encoded Walrus blob IDs. Reputation scores are computed **off-chain** by reputation providers from those facts plus anchored reputation events.

### 7.2 AgentCard Lifecycle

```
┌──────────┐    register    ┌───────────┐   update/expire   ┌──────────────┐
│  Create  │───────────────▸│  Active   │──────────────────▸│  Superseded  │
└──────────┘                └───────────┘                   └──────────────┘
                                 │
                                 │ deactivate
                                 ▼
                            ┌────────────┐
                            │ Inactive   │
                            └────────────┘
```

- **Sequence numbers** are monotonically increasing. Consumers MUST reject AgentCards with lower sequence numbers than their cached version.
- **`previousHash`** creates a hash chain, allowing consumers to verify the update history.
- **`expiresAt`** provides freshness hints for caches and indexers.
- **Deactivation** is recorded on Sui via `deactivate_agent`; consumers MUST treat deactivated cards as unavailable even if cached locally.

### 7.3 Capability Tags Taxonomy

Capability tags follow a hierarchical dot-notation scheme to enable both exact and prefix matching:

```
weather.current
weather.forecast
weather.historical
llm.completion
llm.chat
llm.embedding
code.generation
code.review
code.testing
data.analysis
data.visualization
image.generation
image.classification
search.web
search.academic
translation.text
translation.document
```

Custom tags MUST use a reverse-domain prefix: `com.example.my-custom-capability`.

---

## 8. Layer 4: Negotiation & Agreements

### 8.1 Overview

Before a task is executed, the requester and provider MAY negotiate terms and produce a **TaskAgreement** — a signed, machine-verifiable contract.

For simple, fixed-price synchronous tasks, negotiation can be implicit (the AgentCard's published terms are the offer, and a relay-mediated x402 payment constitutes acceptance). For complex, long-running, or variable-cost tasks, explicit negotiation is required.

### 8.2 Negotiation Protocol

Negotiation messages are signed JSON envelopes. They are transported either:

1. **Via relay WebSocket** for real-time tasks and low-latency counter-offers, or
2. **Via Sui transactions/events** for asynchronous tasks where `TaskRequest` objects and `TaskAccepted` events become the durable negotiation record.

Direct provider rendezvous is replaced by relay-routed messages or Sui state transitions. Async task negotiation supports two modes:

- **Targeted Task:** The requester specifies a provider DID and posts a directed `TaskRequest`. The target provider sees the matching `TaskPosted` event and either accepts or rejects.
- **Open Task:** The requester specifies a capability requirement with `provider: null`. Multiple providers MAY observe the `TaskPosted` event; the first valid `accept_task` wins, or a future bidding profile MAY apply.

**Relay-mediated negotiation:**

```
Requester                Relay                  Provider
    |                      |                        |
    |-- mesh.negotiate.propose ------------------->|
    |<------------------- mesh.negotiate.counter --|  (optional, 0 or more rounds)
    |-- mesh.negotiate.accept -------------------->|
    |<------------------- mesh.negotiate.confirm --|  (returns signed TaskAgreement)
```

**Sui-mediated negotiation for async tasks:**

```
Targeted Task
Requester                    Sui                    Provider
    |                         |                         |
    |-- TaskRequest tx ------>|                         |
    |                         |---- TaskPosted event -->|  (provider DID matches)
    |                         |<--- accept_task tx -----|
    |<---- TaskAccepted event |                         |

Open Task
Requester                    Sui                  Any Provider
    |                         |                         |
    |-- TaskRequest tx ------>|                         |
    |                         |---- TaskPosted event -->|  (capability match)
    |                         |<--- accept_task tx -----|  (first valid accept wins)
    |<---- TaskAccepted event |                         |
```

A negotiation MAY be rejected at any point by relay message or by posting a terminal on-chain status.

### 8.3 TaskAgreement

```json
{
  "@context": "https://agentic-mesh.org/agreement/v1",
  "agreementId": "agr_a1b2c3d4e5f6",
  "requester": "did:mesh:requester123...",
  "provider": "did:mesh:provider456...",
  "capability": {
    "id": "generate-forecast-report",
    "version": "1.0.0",
    "agentCardHash": "sha256:abc123..."
  },
  "input": {
    "schemaHash": "sha256:inputschema...",
    "payloadHash": "sha256:actualpayload...",
    "blobId": "0x0000000000000000000000000000000000000000000000000000000000000123"
  },
  "payment": {
    "scheme": "exact",
    "amount": "50000",
    "currency": "USDC",
    "coinType": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    "network": "sui:mainnet",
    "displayPrice": "$0.05",
    "payTo": "0xabc...def",
    "maxAmount": "50000",
    "escrowObjectId": "0xescrow123..."
  },
  "execution": {
    "mode": "async",
    "timeoutMs": 60000,
    "resultDelivery": "sui-event",
    "dataDelivery": "walrus",
    "maxRetries": 1
  },
  "cancellation": {
    "allowRequesterCancel": true,
    "cancelDeadlineMs": 5000,
    "refundPolicy": "full-before-start, release-per-escrow-rules-after-start"
  },
  "dispute": {
    "windowMs": 86400000,
    "arbitrationMethod": "none"
  },
  "nonce": "random-nonce-abc123",
  "issuedAt": "2026-05-14T10:30:00Z",
  "expiresAt": "2026-05-14T10:35:00Z",

  "requesterSignature": {
    "signer": "did:mesh:requester123...#identity",
    "value": "<base64>"
  },
  "providerSignature": {
    "signer": "did:mesh:provider456...#identity",
    "value": "<base64>"
  }
}
```

For relay-mediated real-time tasks, `payment.network` MAY instead be `eip155:8453` and `resultDelivery` MAY be `relay-response` or `relay-stream`. `amount` and `maxAmount` are always integer strings in the token's smallest unit, while `displayPrice` remains optional UI metadata only.

### 8.4 Implicit Negotiation (Fast Path)

For simple, fixed-price capabilities with `executionMode: "sync"`:

1. The AgentCard's published pricing IS the offer
2. The requester sending a relay-mediated x402-authenticated request IS acceptance
3. No explicit TaskAgreement is needed
4. The x402 payment receipt serves as proof of transaction

This keeps simple interactions lightweight while preserving the full negotiation protocol for complex cases.

### 8.5 Provider Admission Control

Providers MAY reject requests based on their `admissionPolicy`:

- Current capacity / queue depth exceeded
- Requester reputation below threshold
- Unsupported payment network or currency
- Geographic/legal policy restrictions
- Input size or complexity exceeds limits
- Safety filter triggers

Rejection responses MUST include a machine-readable reason code:

```json
{
  "error": "admission_denied",
  "code": "CAPACITY_EXCEEDED",
  "message": "Provider queue is full. Retry after 30 seconds.",
  "retryAfterMs": 30000
}
```

---

## 9. Layer 5: Payment

### 9.1 Overview

The Agentic Mesh uses **dual payment rails**:

1. **x402 on Base** for external or relay-mediated HTTP-native payments, using the existing `@x402/evm` stack.
2. **Native Sui payments** for on-mesh agent-to-agent work, especially asynchronous tasks coordinated through Sui and Walrus.

Payment rail selection is based on wallet type, execution mode, and cost profile:

- **Base x402** fits synchronous and streaming tasks that traverse a relay's HTTP/WebSocket surface.
- **Native Sui** fits escrowed, on-mesh coordination and direct value transfer, typically at materially lower cost (roughly `$0.001` vs. `$0.011` in common operating envelopes).

### 9.2 Payment Flow — Synchronous Tasks

For synchronous tasks, the provider remains behind NAT and the relay fronts the request path.

```
Requester                Relay                 Provider              Facilitator
    │                      │                       │                       │
    │─ request task ──────▸│                       │                       │
    │◂ 402 Payment Required│                       │                       │
    │  (PAYMENT-REQUIRED)  │                       │                       │
    │                      │                       │                       │
    │ [sign Base x402]     │                       │                       │
    │                      │                       │                       │
    │─ request + PAYMENT-SIGNATURE ───────────────▸│                       │
    │                      │──── verify ──────────────────────────────────▸│
    │                      │◂──────── verification result ─────────────────│
    │                      │──────── forward task over WebSocket ─────────▸│
    │                      │                       │   [execute task]       │
    │                      │◂──────────── result ──│                       │
    │                      │──── settle ──────────────────────────────────▸│
    │                      │◂──────── settlement receipt ──────────────────│
    │◂ 200 OK + result + PAYMENT-RESPONSE ────────│                       │
```

The relay proxies the HTTP-native x402 interaction, while the provider only maintains an outbound relay connection.

### 9.3 Payment Flow — Asynchronous Tasks

For long-running tasks, payment and coordination are Sui-native and data is stored on Walrus.

```
Requester          Walrus                 Sui                    Provider
    |                |                     |                         |
    |-- upload input ->|                   |                         |
    |                |                     |                         |
    |-- post_task tx (TaskRequest + escrow) ----------------------->|
    |                |                     |                         |
    |                |                     |---- TaskPosted event -->|
    |                |                     |<--- accept_task tx -----|
    |                |<--- download input -|                         |
    |                |                     |                         |
    |                |                     |        [execute task]    |
    |                |<--- upload result --|                         |
    |                |                     |<--- complete_task tx ----|
    |                |                     |---- TaskCompleted event >|
    |<--- download result -----------------|                         |
    |-- release_escrow / auto-release tx ->|                         |
```

There is no direct HTTP between agents in this flow, and no facilitator is required.

### 9.4 Payment Schemes

#### 9.4.1 `exact` — Fixed Price

The simplest scheme. The requester pays a fixed amount specified in the AgentCard or TaskAgreement.

**Use cases:** Simple API calls, fixed-price tasks, deterministic computations.

For relay-mediated x402 tasks, `exact` is settled after execution. For Sui-native tasks, `exact` is typically escrowed at task creation and released on completion.

#### 9.4.2 `upto` — Metered / Variable Cost

For tasks where the final cost depends on resource consumption (for example, LLM token generation or GPU time).

```json
{
  "scheme": "upto",
  "maxAmount": "1000000",
  "currency": "USDC",
  "coinType": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  "network": "sui:mainnet",
  "displayPrice": "$1.00",
  "metering": {
    "unit": "token",
    "pricePerUnit": "30",
    "displayPricePerUnit": "$0.00003",
    "reportingInterval": "on-completion"
  }
}
```

**Metering units:** `token`, `second`, `request`, `byte`, `gpu-second`, `tool-call`

**Flow:**
1. Requester authorizes up to `maxAmount`
2. Provider executes, tracking consumption
3. Provider issues a signed **UsageReceipt**
4. Settlement is for the actual amount consumed, not the max authorized
5. Any unused escrow remains with the requester or is automatically refunded per contract rules

**Metered verification:**
- Requesters MAY set a hard cap and abort a streaming session if usage nears the configured maximum
- Providers MUST include raw evidence in the `UsageReceipt` appropriate to the metering unit:
  - `token`: token count from LLM response metadata
  - `second`: wall-clock time with start/end timestamps
  - `byte`: content-length of the result
- `UsageReceipt` objects are signed by the provider and include the raw evidence used for settlement
- To dispute overcharging, the requester submits the `UsageReceipt` plus evidence of actual consumption to the agreed arbitrator
- **v1 guarantee:** the protocol standardizes the schema and signature verification only. Requesters either trust provider metering or use `exact` instead.

#### 9.4a Escrow Contract Semantics

Escrow contracts follow an explicit state machine.

```text
States: Created -> Funded -> Active -> {Completed, Disputed, Expired}
                                        -> Released (terminal)
                                        -> Refunded (terminal)
                                        -> Slashed (terminal)

Transitions:
  Created -> Funded:     Requester deposits payment (automatic in PTB)
  Funded -> Active:      Provider accepts task (`TaskAccepted` event)
  Active -> Completed:   Provider posts `TaskCompleted` with result blob ID
  Completed -> Released: Auto-release after dispute window (for example, 24h) OR requester explicit release
  Completed -> Disputed: Requester opens dispute within window
  Active -> Expired:     Provider fails to complete before timeout
  Expired -> Refunded:   Requester claims refund
  Disputed -> Released:  Dispute resolved in provider's favor
  Disputed -> Refunded:  Dispute resolved in requester's favor
  Disputed -> Slashed:   Proven malicious behavior; funds go to protocol or requester
```

**Key rules:**
- Providers can claim funds from the `Completed` state after the dispute window expires; no requester action is required
- Requesters can release immediately from the `Completed` state to skip the dispute window
- The dispute window is configurable per `TaskAgreement` and defaults to 24 hours
- Expired escrows become refundable by the requester after `timeout + gracePeriod`

#### 9.4b Native Sui Payment Details

Native Sui settlement uses **Programmable Transaction Blocks (PTBs)** and Sui-native escrow objects.

- **Direct transfer:** Requester sends `SUI` or `USDC` directly to the provider in a PTB
- **Escrow creation:** `create_escrow(taskId, amount, provider, timeout)`
- **Release:** `release_escrow(taskId)` or automatic release after the agreed timeout/conditions
- **Dispute:** `dispute_escrow(taskId, evidenceBlobId)`
- **Refund:** `refund_escrow(taskId)` after expiry or requester-favorable dispute resolution
- **Supported stablecoin:** Native Circle USDC on Sui — `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`

Escrow is the preferred default for asynchronous work because it minimizes counterparty risk without introducing an off-chain payment intermediary.

### 9.5 Facilitator Trust Model

Facilitators are required **only** for relay-mediated x402 payments on Base. Native Sui payments do not require facilitators; the blockchain verifies balances, escrow, and releases directly.

**Facilitator selection:**
- Providers specify accepted facilitators for x402 flows in their policy or relay profile
- Requesters verify they trust at least one offered facilitator
- Relays MAY proxy to one or more facilitators, but MUST disclose which facilitator is being used

**Facilitator requirements:**
- MUST return cryptographic settlement proofs (transaction hashes)
- MUST disclose fees upfront
- MUST support `eip155:8453`
- SHOULD be non-custodial (never hold agent funds)
- SHOULD support failover to alternative facilitators

**Well-known facilitators:**
- `https://x402.org/facilitator` — community-operated Base/EVM facilitator
- Agents and relay operators MAY also accept self-hosted facilitators at custom URLs

### 9.6 Wallet Management

Agents MUST maintain sufficient wallet balances on the payment networks they intend to use as requesters. Agents SHOULD:

- Monitor both **Sui gas / coin balances** and **Base gas / USDC balances**
- Keep Sui wallet state ready for registry, staking, escrow, and dispute operations
- Use hardware wallets, secure enclaves, or zkLogin-backed custody for production deployments
- Implement spending limits and per-task caps
- Distinguish between operational wallets, stake wallets, and high-value treasury wallets where practical

---

## 10. Layer 6: Task Execution

### 10.1 Task Lifecycle

```
┌─────────────┐   ┌────────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐
│  Submitted  │──▸│  Escrowed  │──▸│  Accepted │──▸│  Running  │──▸│ Completed │
└─────────────┘   └────────────┘   └───────────┘   └───────────┘   └───────────┘
       │                 │                │                │               │
       ▼                 ▼                ▼                ▼               ▼
  ┌─────────┐      ┌─────────┐      ┌──────────┐      ┌─────────┐     ┌──────────┐
  │ Rejected│      │ Expired │      │ Cancelled│      │ Failed  │     │ Disputed │
  └─────────┘      └─────────┘      └──────────┘      └─────────┘     └──────────┘
```

### 10.2 Synchronous Execution

For capabilities with `executionMode: "sync"`, the requester calls a **relay HTTP endpoint**, not the provider directly. The initial unauthenticated request receives `402 Payment Required` as described in §9.2.

**Authenticated request (after x402 challenge):**
```http
POST /mesh/providers/did:mesh:provider456.../capabilities/get-current-weather/execute HTTP/1.1
Host: relay.agentic-mesh.org
Content-Type: application/json
X-Mesh-Request-Id: req_abc123
X-Mesh-Requester: did:mesh:requester123...
X-Mesh-Target-Provider: did:mesh:provider456...
X-Mesh-Timestamp: 2026-05-14T10:30:00Z
X-Mesh-Signature: <ed25519-signature-of-canonical-request>
PAYMENT-SIGNATURE: <x402-payment-payload>

{
  "location": "San Francisco, CA",
  "units": "metric"
}
```

**Response (success):**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Mesh-Response-Id: res_def456
X-Mesh-Provider: did:mesh:provider456...
X-Mesh-Relay: relay.agentic-mesh.org
X-Mesh-Signature: <provider-signature-over-canonical-response>
PAYMENT-RESPONSE: <x402-settlement-receipt-base64>

{
  "temperature": 18.5,
  "humidity": 72,
  "conditions": "partly cloudy",
  "windSpeed": 12.3
}
```

**Streaming (optional relay WebSocket):**
```json
{ "type": "mesh.task.progress", "taskId": "rt_123", "progress": 0.5, "message": "Fetching upstream data" }
{ "type": "mesh.task.chunk", "taskId": "rt_123", "sequence": 7, "data": "partial-output" }
{ "type": "mesh.task.complete", "taskId": "rt_123", "resultHash": "sha256:..." }
```

A requester MAY also emulate synchronous behavior over Sui by blocking locally until a `TaskCompleted` event is observed.

### 10.3 Asynchronous Execution

For capabilities with `executionMode: "async"`, task creation is a **Sui transaction**, task payloads/results live on **Walrus**, and status is derived from **Sui object state or events**.

**Targeted Task:**
```json
{
  "function": "0xmesh::task::post_task",
  "arguments": {
    "provider": "did:mesh:provider456...",
    "capability": "generate-forecast-report",
    "agreementId": "agr_a1b2c3d4e5f6",
    "inputBlobId": "0x0000000000000000000000000000000000000000000000000000000000000123",
    "escrowObjectId": "0xescrow123...",
    "timeoutMs": 60000
  }
}
```

**Open Task:**
```json
{
  "function": "0xmesh::task::post_task",
  "arguments": {
    "provider": null,
    "capability": "translation.text",
    "agreementId": "agr_f6e5d4c3b2a1",
    "inputBlobId": "0x0000000000000000000000000000000000000000000000000000000000000456",
    "escrowObjectId": "0xescrow456...",
    "timeoutMs": 120000
  }
}
```

**Immediate task state after creation:**
```json
{
  "taskId": "0xtask789xyz",
  "status": "submitted",
  "targetProvider": "did:mesh:provider456...",
  "acceptedBy": null,
  "inputBlobId": "0x0000000000000000000000000000000000000000000000000000000000000123",
  "escrowObjectId": "0xescrow123...",
  "estimatedCompletionMs": 45000
}
```

A targeted task is visible only to the named provider for acceptance logic. An open task is visible to any matching provider, and the first valid `accept_task` wins unless a future bidding profile is in use.

**Accepted task state:**
```json
{
  "taskId": "0xtask789xyz",
  "status": "accepted",
  "targetProvider": "did:mesh:provider456...",
  "acceptedBy": "did:mesh:provider456...",
  "inputBlobId": "0x0000000000000000000000000000000000000000000000000000000000000123",
  "escrowObjectId": "0xescrow123..."
}
```

**Status query via Sui object state:**
```json
{
  "taskId": "0xtask789xyz",
  "status": "completed",
  "progress": 1.0,
  "completedAt": "2026-05-14T10:30:45Z",
  "resultBlobId": "0x0000000000000000000000000000000000000000000000000000000000000789",
  "completionTxDigest": "3Qn..."
}
```

**Event subscription (alternative to polling):**
```json
{
  "method": "suix_subscribeEvent",
  "params": [{ "MoveEventType": "0xmesh::task::TaskCompleted" }]
}
```

The requester downloads the result from Walrus using `resultBlobId` and then calls `release_escrow`, or waits for contract-driven auto-release after the dispute window.

### 10.4 Multi-Agent Workflows

Orchestrator agents can compose multi-step workflows where each step is an independent task:

```
                    ┌─────────────────┐
                    │  Orchestrator   │
                    │  Agent          │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
        ┌───────────┐ ┌───────────┐ ┌───────────┐
        │ Agent A   │ │ Agent B   │ │ Agent C   │
        │ (Research)│ │ (Analyze) │ │ (Summ.)   │
        └─────┬─────┘ └─────┬─────┘ └───────────┘
              │              │              ▲
              └──────────────┴──────────────┘
                   results stored on Walrus
```

**Workflow principles:**
- Each step is an independent relay/x402 exchange or Sui-escrowed task
- The orchestrator manages state and data flow
- Steps can execute in parallel (fan-out) or sequentially (pipeline)
- Failure in one step does not automatically fail the workflow — the orchestrator decides
- Intermediate results SHOULD be stored on Walrus and passed by blob ID
- Total workflow cost is the sum of individual step costs plus chain/relay fees

### 10.5 Result Integrity

All task results MUST be signed by the provider's identity key:

```json
{
  "taskId": "0xtask789xyz",
  "resultBlobId": "0x0000000000000000000000000000000000000000000000000000000000000789",
  "resultHash": "sha256:result-content-hash",
  "completedAt": "2026-05-14T10:30:45Z",
  "provider": "did:mesh:provider456...",
  "completionTxDigest": "3Qn...",
  "signature": "<ed25519-signature-of-canonical-result>"
}
```

This enables:
- Verification that the result came from the claimed provider
- Non-repudiation for dispute resolution
- Audit trails for multi-agent workflows
- Cross-checking between Walrus content and Sui task state

**v1 Verification Guarantees:**
1. Guaranteed: Schema validation — the result matches the output schema declared in the AgentCard
2. Guaranteed: Hash integrity — `resultHash` matches the actual result content
3. Guaranteed: Signature verification — the result is signed by the claimed provider
4. Guaranteed: Timeliness — the result is delivered within the agreed timeout
5. Not guaranteed: Semantic correctness — v1 does **not** guarantee that a result is factually correct, high-quality, or useful for subjective AI outputs

For capabilities that require semantic verification, providers MAY declare a `verifier` in the capability description. A verifier identifies a third-party agent or contract that can independently validate the result beyond schema, hash, and signature checks.

---

## 11. Layer 7: Reputation & Disputes

### 11.1 Reputation Model

Reputation in the Agentic Mesh is based on **verifiable events**, not self-reported scores. This prevents gaming and sybil manipulation.

#### 11.1.1 Reputation Events

After each task interaction, both parties MAY publish signed **ReputationEvents**:

```json
{
  "@context": "https://agentic-mesh.org/reputation/v1",
  "eventId": "rep_evt_abc123",
  "type": "task_completion",
  "subject": "did:mesh:provider456...",
  "author": "did:mesh:requester123...",
  "taskId": "0xtask789xyz",
  "agreementHash": "sha256:agreement-hash...",
  "settlementProof": "0xtxhash-or-escrow-object...",
  "outcome": "success",
  "rating": 5,
  "capability": "get-current-weather",
  "paymentAmount": {
    "amount": "1000",
    "currency": "USDC",
    "coinType": "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    "network": "sui:mainnet",
    "displayPrice": "$0.001"
  },
  "latencyMs": 1200,
  "timestamp": "2026-05-14T10:31:00Z",
  "nonce": "random-nonce",
  "signature": "<author-identity-signature>"
}
```

**Event types:**
| Type | Description |
|------|-------------|
| `task_completion` | Task completed successfully |
| `task_failure` | Task failed during execution |
| `task_timeout` | Task exceeded agreed timeout |
| `task_cancellation` | Task cancelled by requester or provider |
| `dispute_opened` | Requester disputes task result |
| `dispute_resolved` | Dispute resolved (by arbitration or mutual agreement) |
| `payment_confirmed` | Payment settled on-chain |

#### 11.1.2 Reputation Event Storage

Reputation events are stored across three layers:

- **Walrus:** individual event payloads and large evidence bundles
- **Local SQLite logs:** fast local reads and batching
- **Sui anchors:** periodic Merkle roots or direct event commitments that provide the canonical, tamper-evident reference

A reputation anchor batch SHOULD include the Merkle root, event count, blob references, author identity, and timestamp. Consumers verify individual Walrus events against the Sui-anchored root.

#### 11.1.3 Reputation Computation

The protocol does **not** define a single canonical reputation score. Instead:

- **Reputation providers** (specialized agents or services) collect events and compute scores
- Agents reference reputation providers in their `reputationRefs`
- Requesters choose which reputation providers they trust
- Multiple competing algorithms prevent gaming
- AgentCards expose raw facts such as `totalTasksCompleted`, `totalTasksDisputed`, `stake`, and `registeredAt`; reputation providers turn those facts plus anchored events into off-chain scores

**Example reputation providers might compute:**
- Success rate (per capability)
- Average latency vs. SLA
- Payment-weighted reliability (higher-value tasks count more)
- Longevity / tenure on the network
- Dispute rate

#### 11.1.4 Staking & Slashing (v1)

The v1 staking contract provides a minimal on-chain trust and sybil-resistance layer for both agents and relays.

- **Minimum stake:** Configurable per network (for example, `10 SUI` for agents and `100 SUI` for relays)
- **Registration gate:** `register_agent` requires the minimum stake deposit before an AgentCard can be published
- **Slashable offenses in v1:**
  - Provider accepts a task and funded escrow but never completes it; evidence is the expired escrow and task state on-chain
  - Relay accepts a routing fee but does not deliver a result; evidence is a signed task request plus absence of a signed result within the agreed timeout
- **Slashing flow:** The complainant submits evidence to `reputation::submit_slash_evidence`. If the evidence is directly verifiable on-chain (for example, an expired escrow), slashing is automatic. Otherwise, the claim is deferred to a future dispute or arbitration profile.
- **Slash amount:** Up to the amount of the relevant transaction, capped by the operator's total stake
- **Unstaking:** After `deactivate_agent`, stake enters a cooldown period (for example, 7 days) before withdrawal is permitted

These staking rules raise the cost of sybil behavior while keeping v1 enforcement limited to simple, objectively verifiable cases.

### 11.2 Dispute Resolution

#### 11.2.1 Dispute Flow

```
Requester                    Sui / Walrus              Provider            Arbitrator (optional)
    │                              │                      │                        │
    │─ dispute::open(taskId, evidenceBlobId) ───────────▸│                        │
    │                              │──── DisputeOpened ─▸│                        │
    │                              │                      │                        │
    │                              │◂─ dispute::respond(counterEvidenceBlobId) ───│
    │◂──────────── DisputeUpdated event ─────────────────│                        │
    │                              │                      │                        │
    │   [if no mutual resolution after disputeWindowMs]  │                        │
    │                              │──────────────────────────────────────────────▸│
    │◂──────────────────────────── dispute::ruling / release instructions ────────│
```

#### 11.2.2 Dispute Evidence

Both parties submit evidence bundles:

```json
{
  "disputeId": "disp_abc123",
  "taskId": "0xtask789xyz",
  "agreementHash": "sha256:...",
  "evidence": {
    "requestPayloadHash": "sha256:...",
    "responsePayloadHash": "sha256:...",
    "requestBlobId": "0x0000000000000000000000000000000000000000000000000000000000000123",
    "responseBlobId": "0x0000000000000000000000000000000000000000000000000000000000000789",
    "expectedOutputSchema": { "...": "..." },
    "settlementReference": "0xescrow123...",
    "timestamps": { "submitted": "...", "completed": "..." }
  },
  "reason": "output_invalid",
  "reasonCodes": ["SCHEMA_VIOLATION", "FACTUALLY_INCORRECT"]
}
```

#### 11.2.3 Dispute Resolution Methods

| Method | Description | When to use |
|--------|-------------|-------------|
| **None** | No dispute resolution. "Buyer beware." | Low-value tasks, v1 implementations |
| **Mutual** | Parties resolve via signed updates and escrow release | Medium-value tasks, trusted peers |
| **Arbitration** | Third-party arbitrator agent rules | High-value tasks, untrusted peers |
| **On-chain** | Smart contract arbitration with stake slashing | Highest-value tasks, maximum trust |

The dispute method is specified in the TaskAgreement. Both parties agree to it before execution begins.

#### 11.2.4 V1 Dispute Model

For the initial version, the dispute model remains intentionally simple:

- Disputes are recorded on Sui and optionally backed by evidence stored on Walrus
- No universal automated arbitration is mandated by the base protocol
- Escrow MAY remain locked until timeout, mutual release, or external ruling
- The primary enforcement mechanism is reputation damage and loss of future business
- This creates economic incentive for honest behavior without requiring a single global arbitrator

---

## 12. Security Model

### 12.1 Threat Model

| Threat | Mitigation |
|--------|-----------|
| **Identity spoofing** | All messages signed with identity key. DID verification required. |
| **Payment fraud** | x402 payments are verified before relay forwarding; Sui escrow and transfer rules are validated on-chain. |
| **Man-in-the-middle** | TLS required for relay, RPC, and Walrus access. Message signatures prevent tampering. |
| **Replay attacks** | Nonces, timestamps, and expiration on all signed messages. Domain separation per chain/network. |
| **Sybil attacks** | Sui stake requirements. Payment-weighted reputation. Age-weighted scoring. |
| **DDoS** | Relay rate limiting, admission control, RPC backoff, and economic friction on on-chain task creation. |
| **Relay compromise** | Use multiple relays, end-to-end payload encryption, relay staking/slashing on Sui, and failover policies. |
| **Stale data attacks** | Sequence numbers on AgentCards. Verification against latest Sui object version and event stream. Indexers are non-authoritative. |
| **Key compromise** | Key separation (identity vs. Sui vs. EVM). Key rotation protocol. Registry deactivation. |
| **Malicious providers** | Reputation system. Signed results. Dispute mechanism. Escrow for higher-value tasks. |
| **Malicious requesters** | Upfront payment verification or escrow. Admission policies. Requester reputation. |

### 12.2 Message Signing

All protocol messages MUST include:

```json
{
  "meshHeaders": {
    "requestId": "req_unique_id",
    "sender": "did:mesh:sender...",
    "timestamp": "2026-05-14T10:30:00Z",
    "expiresAt": "2026-05-14T10:35:00Z",
    "nonce": "random-unique-nonce",
    "signature": "<ed25519-signature-of-canonical-message>"
  }
}
```

**Canonicalization:** Messages are canonicalized using JCS (JSON Canonicalization Scheme, RFC 8785) before signing.

### 12.3 Transport Security

- All relay, Sui RPC, and Walrus communication MUST use TLS 1.3 or higher
- Agents SHOULD pin relay certificates or verify signed relay manifests published on Sui
- Payloads SHOULD be encrypted end-to-end whenever relays or storage layers can observe metadata
- Operators SHOULD separate relay credentials, RPC credentials, and signing keys

### 12.4 Rate Limiting

Agents, relays, and supporting services MUST implement rate limiting:

- Per-requester identity limits
- Per-relay-session limits
- Separate limits for discovery, negotiation, and execution
- Exponential backoff on rate-limit responses

Rate-limit response (relay HTTP example):
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
X-Mesh-Rate-Limit-Remaining: 0
X-Mesh-Rate-Limit-Reset: 1716213000
```

---

## 13. Privacy Model

### 13.1 Privacy Principles

1. **Minimize public metadata.** Discovery queries should reveal as little as possible about what tasks an agent is performing.
2. **Encrypt task payloads.** Task inputs and outputs are encrypted end-to-end between requester and provider.
3. **Support private capabilities.** Not all capabilities need to be publicly discoverable.
4. **Separate public reputation from private interactions.** Agents MAY choose not to publish full reputation events for sensitive tasks.

### 13.2 Private Capabilities

Agents MAY offer capabilities that are not published to the public Sui registry, or that are published only as coarse-grained placeholders:

```json
{
  "id": "internal-analysis",
  "visibility": "private",
  "accessPolicy": {
    "allowedRequesters": ["did:mesh:trusted-agent-1", "did:mesh:trusted-agent-2"],
    "requireInvitation": true
  }
}
```

Private capabilities are accessible only via invitation, out-of-band exchange of signed metadata, or private relay routing context.

### 13.3 Encrypted Task Payloads

For sensitive tasks, the input payload MAY be encrypted end-to-end before it is stored or routed:

1. The requester performs **X25519 key agreement** against the provider's `#encryption` X25519 key from the DID Document
2. The resulting shared secret is fed into an **AES-256-GCM** encryption context for the payload
3. The encrypted payload is stored on Walrus
4. Task metadata on Sui references the encrypted Walrus blob ID
5. Only the provider can decrypt the payload using its X25519 private key

Responses MAY use the same pattern in reverse if the requester publishes an encryption key. Relays, Walrus storage nodes, and indexers only observe encrypted blobs and metadata.

### 13.4 Query Privacy

- Sui RPC queries are visible to the node operator and may reveal what capabilities an agent is searching for
- Agents MAY use a privacy relay, a self-hosted Sui full node, or a trusted RPC proxy to reduce query leakage
- Agents MAY use cover traffic (dummy lookups) to obscure real discovery behavior
- Indexer services SHOULD NOT log query patterns or link searches to agent identities
- Relays can observe task metadata required for routing, but SHOULD NOT see plaintext payloads

---

## 14. Network Topology & Bootstrap

### 14.1 Network Structure

The Agentic Mesh is formed by **shared on-chain state plus relay-routed messaging**, not by direct inbound agent-to-agent links.

```
                ┌──────────────────────┐
                │      Sui RPC /       │
                │   On-Chain Registry  │
                └──────────┬───────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
   ┌──────────┐      ┌──────────┐      ┌──────────┐
   │ Agent A  │─────▶│ Relay(s) │◀─────│ Agent B  │
   └────┬─────┘  WSS └──────────┘  WSS └────┬─────┘
        │                                     │
        ├────────────── HTTPS ────────────────┤
        ▼                                     ▼
   ┌────────────────────────────────────────────────┐
   │                    Walrus                      │
   └────────────────────────────────────────────────┘
```

- Agents connect outbound to **Sui RPC** for canonical state
- Agents connect outbound to one or more **relay nodes** for real-time routing and streaming
- Agents read/write large blobs through **Walrus**
- No direct inbound connectivity between agents is required

### 14.2 Joining the Network

```
1. Generate a persistent Ed25519 identity keypair and X25519 encryption keypair
2. Optionally authenticate via zkLogin to bind a Sui address for on-chain operations
3. Create and sign an AgentCard
4. Publish the AgentCard to Sui via `register_agent`
5. Optionally connect to one or more authorized relay nodes for real-time tasks
6. Sync local cache from Sui events and Walrus profile blobs as needed
7. Agent is now discoverable and can transact
```

### 14.3 Leaving the Network

- **Graceful:** Call `deactivate_agent` on Sui and disconnect from relay sessions
- **Temporary offline:** Leave the AgentCard active but mark relay availability as absent or stale
- **Cached state:** Consumers MUST prefer on-chain active/inactive state over local cache entries
- **Expiry:** AgentCards with passed `expiresAt` SHOULD be treated as stale until refreshed or explicitly renewed

### 14.4 Network Health

Network health is maintained through chain and relay observability rather than direct network heartbeats:

- **Sui liveness:** Monitor finality lag, RPC health, and event subscription continuity
- **Relay health:** Track session uptime, message latency, and relay failover readiness
- **Walrus health:** Verify blob availability, integrity proofs, and replication policy
- **Operator policy:** Prefer multiple relays and redundant RPC providers for resilience

### 14.5 Relay Trust Protocol

Relays are discoverable infrastructure participants with explicit authorization and replay protection requirements.

- **Relay Registration:** Relays register on Sui with stake, endpoint URL, supported capabilities, and fee schedule
- **Provider Authorization:** Providers sign a `RelayAuthorization` binding their DID to specific relay DIDs. The authorization MAY be stored on-chain or embedded in the AgentCard `relayEndpoints` metadata
- **Session Binding:** When a provider connects to a relay via WebSocket, the provider and relay exchange signed nonces tied to the session ID. The relay verifies the provider identity before marking the channel authenticated
- **Requester Verification:** Requesters MUST verify that the target provider's AgentCard lists the relay DID and endpoint they are about to use. Unauthorized relays MUST be rejected
- **Fee Disclosure:** Relay fees MUST be disclosed in the `402 Payment Required` response as a separate line item or an additive amount
- **Replay Protection:** Every relay-routed message includes a monotonic sequence number plus session ID. Relays and agents MUST reject duplicates or out-of-order replays

---

## 15. Error Handling

### 15.1 Error Response Format

All errors follow a consistent format:

```json
{
  "error": {
    "code": "CAPABILITY_NOT_FOUND",
    "message": "The requested capability 'analyze-sentiment' is not available on this agent.",
    "details": {},
    "retryable": false,
    "retryAfterMs": null,
    "requestId": "req_abc123"
  }
}
```

### 15.2 Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `CAPABILITY_NOT_FOUND` | 404 | Requested capability doesn't exist |
| `PAYMENT_REQUIRED` | 402 | x402 payment needed |
| `PAYMENT_INVALID` | 400 | x402 payment signature invalid |
| `PAYMENT_INSUFFICIENT` | 402 | Payment amount below required price |
| `ADMISSION_DENIED` | 403 | Request rejected by admission policy |
| `CAPACITY_EXCEEDED` | 503 | Provider at capacity |
| `TASK_TIMEOUT` | 504 | Task exceeded agreed timeout |
| `TASK_FAILED` | 500 | Task execution failed |
| `TASK_NOT_FOUND` | 404 | Task ID not recognized |
| `TASK_CANCELLED` | 410 | Task was cancelled |
| `AGREEMENT_EXPIRED` | 410 | TaskAgreement expired before execution |
| `AGREEMENT_INVALID` | 400 | TaskAgreement signature invalid |
| `IDENTITY_INVALID` | 401 | Agent identity verification failed |
| `RATE_LIMITED` | 429 | Too many requests |
| `SCHEMA_VIOLATION` | 400 | Input doesn't match capability's input schema |
| `NETWORK_UNSUPPORTED` | 400 | Payment network not supported |
| `INTERNAL_ERROR` | 500 | Unexpected provider error |

### 15.3 Retry Behavior

- Retryable errors include a `retryAfterMs` hint
- Requesters MUST implement exponential backoff
- Requesters SHOULD failover to alternative providers after repeated failures
- Maximum retry count SHOULD be configurable (default: 3)

---

## 16. Extension Points

The protocol is designed to be extended without breaking existing implementations.

### 16.1 Custom Capability Schemas

Agents can define arbitrary input/output schemas using JSON Schema. The protocol imposes no restrictions on what capabilities can be offered.

### 16.2 Custom Payment Schemes

New payment schemes can be added for either Base x402 flows or Sui-native settlement profiles:
- `exact` — fixed price (supported in v1)
- `upto` — metered/variable cost (supported in v1)
- `stream` — continuous micropayments for streaming services (future)
- `subscription` — recurring payments (future)
- `auction` — competitive bidding for tasks (future)

### 16.3 Custom Reputation Algorithms

Anyone can build a reputation provider that indexes ReputationEvents and computes scores using their own algorithm. Agents choose which providers to trust.

### 16.4 Protocol Negotiation

Agents advertise supported protocol versions in their AgentCard:
```json
{
  "protocols": ["agentic-mesh/1.0", "agentic-mesh/1.1", "a2a/1.0"]
}
```

When connecting through a relay or finalizing Sui task state, agents negotiate the highest mutually supported version.

### 16.5 Transport Extensions

Primary transports in v1 are:
- **Relay HTTP** — synchronous request/response with x402 challenge-response
- **Relay WebSocket** — negotiation, low-latency routing, and streaming
- **Sui RPC + events** — durable task/state coordination
- **Walrus blob transport** — large payload and result exchange

Future profiles MAY add QUIC, gRPC between agents and relays, alternative decentralized storage adapters, or additional chain-specific payment profiles.

---

## 17. Appendix: Wire Formats

### 17.1 Canonical Entry Points and Message Surfaces

**Sui contract entry points:**

| Entry Point | Description |
|-------------|-------------|
| `registry::register_agent` | Create a new on-chain AgentCard object and index it in the shared `Registry` |
| `registry::update_agent` | Update an existing AgentCard and refresh shared indexes |
| `registry::deactivate_agent` | Mark an AgentCard inactive and remove it from discovery indexes |
| `task::post_task` | Create a `TaskRequest` object/event |
| `task::accept_task` | Accept a posted task |
| `task::complete_task` | Mark task completion and attach the result reference |
| `task::cancel_task` | Cancel a submitted task under the agreement's cancellation rules |
| `escrow::create_escrow` | Lock funds for a task |
| `escrow::release_escrow` | Release escrow to the provider |
| `escrow::dispute_escrow` | Freeze escrow pending dispute handling |
| `escrow::refund_escrow` | Return escrow to the requester after expiry or dispute resolution |
| `reputation::anchor_batch` | Anchor a Merkle batch of ReputationEvents |
| `reputation::submit_slash_evidence` | Submit slashable offense evidence |

**Canonical Sui events:**

| Event | Description |
|-------|-------------|
| `TaskPosted` | A task request was created |
| `TaskAccepted` | A provider accepted the task |
| `TaskCompleted` | The provider completed the task and referenced a result blob |
| `TaskCancelled` | The task was cancelled before completion |
| `AgentRegistered` | A new agent was added to the registry |
| `AgentUpdated` | An existing agent card was updated |
| `AgentDeactivated` | An agent was removed from active discovery |

**Relay WebSocket message types:**

| Message Type | Description |
|--------------|-------------|
| `mesh.negotiate.propose` | Initial negotiation proposal |
| `mesh.negotiate.counter` | Counter-offer |
| `mesh.negotiate.accept` | Acceptance of negotiated terms |
| `mesh.negotiate.confirm` | Signed agreement confirmation |
| `mesh.task.request` | Relay-routed real-time task request |
| `mesh.task.progress` | Progress update or streaming chunk |
| `mesh.task.result` | Final task result over relay |
| `mesh.dispute.open` | Relay-routed dispute notice (optional profile) |

**Walrus blob operations:**

| Operation | Description |
|-----------|-------------|
| `PUT blob` | Upload task input, result, evidence, or extended profile data |
| `GET blob` | Download blob content by Walrus blob ID |
| `VERIFY blob` | Verify content hash or proof against expected digest |

### 17.2 Content Types

| Content Type | Usage |
|-------------|-------|
| `application/json` | Default for request/response and event payloads |
| `application/json+mesh-agentcard` | AgentCard documents |
| `application/json+mesh-agreement` | TaskAgreement documents |
| `application/json+mesh-task-state` | Sui-derived task state materializations |
| `application/json+mesh-reputation` | ReputationEvent payloads |
| `application/octet-stream` | Encrypted binary task payloads or results |

### 17.3 HTTP Headers

These headers apply to **relay-facing HTTP** requests/responses and WebSocket upgrade handshakes, not to direct provider endpoints.

| Header | Direction | Description |
|--------|-----------|-------------|
| `X-Mesh-Request-Id` | Request | Unique request identifier |
| `X-Mesh-Requester` | Request | Requester DID |
| `X-Mesh-Target-Provider` | Request | Target provider DID for relay routing |
| `X-Mesh-Provider` | Response | Provider DID |
| `X-Mesh-Relay` | Both | Relay identifier or hostname |
| `X-Mesh-Timestamp` | Both | ISO 8601 timestamp |
| `X-Mesh-Signature` | Both | Ed25519 signature of canonical message |
| `X-Mesh-Agreement-Hash` | Request | Hash of the TaskAgreement (if applicable) |
| `X-Mesh-Protocol-Version` | Both | Protocol version string |
| `PAYMENT-REQUIRED` | Response | x402 payment requirements (base64) |
| `PAYMENT-SIGNATURE` | Request | x402 payment payload (base64) |
| `PAYMENT-RESPONSE` | Response | x402 settlement receipt (base64) |

---

## Appendix A: Example — Complete Agent Interaction

### Scenario: Agent A needs a 7-day weather forecast report from Agent B

**Step 1: Discovery via Sui RPC**
```
Agent A -> Sui RPC / local indexer: search capability "weather.forecast"
Sui / indexer -> Agent A: [AgentCard object IDs, DIDs, pricing, relay metadata]
```

**Step 2: Resolve AgentCard and profile**
```
Agent A -> Sui RPC: getObject(0x9f4c...42)
Sui RPC -> Agent A: AgentCard { capability: "generate-forecast-report", pricing: [{ scheme: "exact", amount: "50000", currency: "USDC", coinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", network: "sui:mainnet", displayPrice: "$0.05" }] }
Agent A -> Walrus: GET 0x0f1e2d3c4b5a6978
Agent A: Verify AgentCard signature, relay authorization, and pricing.
```

**Step 3: Upload input and create escrowed task**
```
Agent A -> Walrus: PUT blob
                    Body: { "location": "San Francisco", "days": 7 }
Walrus -> Agent A: 0x0000000000000000000000000000000000000000000000000000000000000123

Agent A -> Sui: task::post_task(
                    provider = did:mesh:provider456...,
                    capability = "generate-forecast-report",
                    inputBlobId = 0x0000000000000000000000000000000000000000000000000000000000000123,
                    escrow = escrow::create_escrow(taskId, 50000, Agent B, timeout)
                  )
```

**Step 4: Provider accepts and executes**
```
Agent B <- Sui: TaskPosted event
Agent B -> Sui: task::accept_task(taskId)
Agent B -> Walrus: GET 0x0000000000000000000000000000000000000000000000000000000000000123
Agent B: Execute weather analysis
```

**Step 5: Provider publishes result**
```
Agent B -> Walrus: PUT result blob
Walrus -> Agent B: 0x0000000000000000000000000000000000000000000000000000000000000789
Agent B -> Sui: task::complete_task(taskId, resultBlobId = 0x0000000000000000000000000000000000000000000000000000000000000789)
```

**Step 6: Requester receives completion and releases escrow**
```
Agent A <- Sui: TaskCompleted event
Agent A -> Walrus: GET 0x0000000000000000000000000000000000000000000000000000000000000789
Agent A: Verify result schema, signature, and hash.
Agent A -> Sui: escrow::release_escrow(taskId)
```

**Step 7: Reputation anchoring**
```
Agent A: Create ReputationEvent { subject: Agent B, outcome: "success", rating: 5 }
Agent A -> Walrus: PUT reputation event blob
Agent A -> Sui: reputation::anchor_batch(merkleRoot, [blob IDs])
```

For low-latency tasks, the same discovery step can be followed by the relay-mediated x402 flow defined in §9.2 instead of the Sui async flow above.

## Appendix B: Comparison with Related Protocols

| Feature | Agentic Mesh | Google A2A | MCP | x402 (standalone) |
|---------|-------------|-----------|-----|-------------------|
| Agent discovery | Sui on-chain registry + Indexers | Registry | Host-managed | N/A |
| Capability description | AgentCard | AgentCard | Tool schemas | N/A |
| Payment | Base x402 + native Sui | None | None | HTTP payment only |
| Reputation | Verifiable events anchored on Sui | None | None | None |
| Decentralized | Yes | No (registry) | No (host) | Partially |
| Multi-agent workflows | Orchestrator pattern | Task delegation | N/A | N/A |
| Dispute resolution | Events + escrow + arbitration hooks | None | None | None |

---

## Appendix C: Roadmap

### v0.1 (MVP)
- Agent identity (persistent Ed25519 + zkLogin onboarding)
- Sui-native registry (shared Registry object + AgentCard)
- Async task execution via Sui + Walrus
- Native Sui escrow payments
- Basic spending policy
- Daemon + shim architecture

### v0.2
- x402 on Base via relay for real-time sync tasks
- Relay network (WebSocket routing, x402 proxying)
- `upto` metered payment scheme
- Reputation event publishing + Sui anchoring

### v0.3
- Multi-agent workflow orchestration
- Dispute resolution (mutual + on-chain arbitration)
- Encrypted payloads (X25519 + Walrus)
- Staking/slashing for agents and relays
- Open task marketplace (bidding)

### v1.0
- Full spec freeze
- Reference implementations (TypeScript)
- Interoperability test suite
- Security audit
- Community-operated relays and indexers

---

*This specification is a living document. Contributions, feedback, and critiques are welcome.*
