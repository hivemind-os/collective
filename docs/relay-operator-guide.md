# Relay Operator Guide

Community relays are staked routing nodes that register on Sui, advertise an endpoint, and heartbeat their availability for discovery.

## Prerequisites

- A funded mesh wallet with a relay stake position (`collective stake deposit <amount-sui> --type relay`)
- A deployed package ID in `~/.hivemind-os/collective/config.yaml`
- A reachable relay endpoint such as `wss://relay.example.com/ws`

## Register a relay

```bash
pnpm --filter @hivemind-os/collective-cli exec collective relay register \
  --endpoint wss://relay.example.com/ws \
  --stake-id 0x<relay-stake-object> \
  --region us-east \
  --fee 50 \
  --capabilities routing,streaming
```

This writes the relay registration on-chain, ties it to the relay stake position, and records the routing fee in basis points.

## List active relays

```bash
pnpm --filter @hivemind-os/collective-cli exec collective relay list
```

The list view prints the relay id, region, fee, stake, and endpoint so operators can verify discoverability.

## Heartbeats and deactivation

Relay servers can self-register and send periodic heartbeats automatically through `packages/relay` when `relayRegistry.enabled=true` is configured. For manual maintenance:

```bash
pnpm --filter @hivemind-os/collective-cli exec collective relay heartbeat --relay-id 0x<relay-id>
pnpm --filter @hivemind-os/collective-cli exec collective relay deactivate --relay-id 0x<relay-id>
```

## Relay server configuration

Set these environment variables for automatic registration and heartbeat management:

- `MESH_RELAY_REGISTRY_ENABLED=true`
- `MESH_RELAY_REGISTRY_RELAY_ID=0x...` (optional if registering on startup)
- `MESH_RELAY_REGISTRY_STAKE_POSITION_ID=0x...`
- `MESH_RELAY_REGISTRY_ENDPOINT=wss://relay.example.com/ws`
- `MESH_RELAY_REGISTRY_CAPABILITIES=routing,streaming`
- `MESH_RELAY_REGISTRY_REGION=us-east`
- `MESH_RELAY_REGISTRY_ROUTING_FEE_BPS=50`
- `MESH_RELAY_REGISTRY_HEARTBEAT_INTERVAL_MS=30000`

When enabled, the relay HTTP server exposes registry state in `/health` and `/info`, emits `X-Mesh-Relay-Fee` on routed responses, and maintains local runtime routing counters. External operators cannot directly write routing totals on-chain.
