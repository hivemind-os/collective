# Walrus spike findings

## Recommendation

Use the Walrus HTTP publisher + aggregator API for M8, and keep the TypeScript SDK as a later option once the repo is ready to move to `@mysten/sui` 2.x.

## What was validated

- Public Testnet endpoints are live and usable from Node.js on Windows:
  - Publisher: `https://publisher.walrus-testnet.walrus.space`
  - Aggregator: `https://aggregator.walrus-testnet.walrus.space`
- `PUT /v1/blobs?epochs=1` successfully stored blobs.
- `GET /v1/blobs/{blobId}` successfully fetched blobs.
- A 1 MiB round-trip succeeded with matching SHA-256.
- `@mysten/walrus@1.1.7` exists on npm.
- The SDK imported and read an existing blob successfully in an isolated Windows probe, but it peers on `@mysten/sui ^2.16.2` while this repo currently uses `@mysten/sui ^1.30.0`.

## Best integration path

### 1. HTTP API — recommended for M8

Why this is the best fit right now:

- Works with the repo's current dependency graph.
- Uses plain `fetch`, so it is easy to integrate into Node.js/TypeScript.
- Public Testnet publisher/aggregator endpoints already work.
- Much simpler operational model than direct SDK writes.

Important caveats:

- Public infrastructure has no SLA.
- Public publishers/aggregators default to a 10 MiB request limit.
- Renewal and deletion require ownership of the Walrus blob object, not just the blob ID.

### 2. `@mysten/walrus` SDK — viable later, not the best first step here

Pros:

- Official SDK.
- Read path worked in an isolated Windows probe.
- Supports lower-level Walrus flows, quilts, upload relay support, and direct storage-node access.

Cons:

- Requires `@mysten/sui` 2.x, which is a major-version mismatch for this repo today.
- Direct reads and writes are request-heavy. The SDK README notes roughly ~2200 requests to write a blob and ~335 requests to read one when talking to storage nodes directly.
- Write flows require a signer with SUI + WAL and more setup than the HTTP publisher path.

### 3. CLI — good fallback/admin tool, not primary Node integration

Good for:

- Manual debugging.
- Blob lifecycle management (`extend`, `delete`, attributes).
- Large uploads when public publisher limits are not enough.

Less ideal for M8 because it adds process-management overhead around a Node service.

## Blob ID format

Observed live blob IDs looked like this:

- `a7wmADgKiwLDFnpjyu6NBTkCS-1zLblj3TfmXZWxnew`
- `Vs9WwzQbE1VIBp3QAEWKxnJSdy88m2x3JUC4qAmsQD8`

Findings:

- Format: URL-safe base64 without padding.
- Length: 43 characters.
- Decoded length: 32 bytes.
- Practical interpretation: a 256-bit identifier rendered as base64url.

### Move mapping

The current Move `vector<u8>` type is appropriate.

Recommended mapping:

- Off-chain TypeScript: keep blob IDs as strings for ergonomics.
- On-chain Move: store the decoded 32-byte value in `vector<u8>`.

That means the Sui boundary should convert:

- `string (base64url)` -> `vector<u8>` by base64url decoding to 32 bytes
- `vector<u8>` -> `string (base64url)` by base64url encoding those 32 bytes

If the existing Move integration is currently storing UTF-8 bytes of the 43-character string, that still works mechanically, but it is less efficient and less semantically precise than storing the decoded 32-byte form.

## Expiry, permanence, and renewal

Validated/documented behavior:

- Blob lifetime is controlled by the `epochs` query parameter.
- If omitted, blobs default to `1` epoch.
- Testnet epoch duration is documented as `1 day`.
- Max storage duration is documented as `53` epochs.
- `permanent=true` creates a non-deletable blob.
- `deletable=true` creates a blob that can be deleted before expiry.
- Newly stored blobs are deletable by default unless `permanent=true` is set.

Important nuance:

- `permanent` does **not** mean infinite retention.
- Blobs still expire when their purchased epochs run out.

Renewal findings:

- Walrus docs expose renewal through blob-object management flows (`walrus extend --blob-obj-id <BLOB_OBJECT_ID>`).
- I did **not** find a simple public HTTP `extend` endpoint in the docs used for this spike.
- Renewal requires the blob object ID / ownership context, not only the blob ID string.

Implication for M8:

- If Agentic Mesh only stores a blob ID string today, renewal is not enough by itself.
- If long-lived blobs matter, M8 should also persist the returned Walrus blob object ID and define who owns it.
- The HTTP `send_object_to=<SUI_ADDRESS>` option is likely important once wallet ownership is designed.

## Size limits

Documented Walrus constraints:

- Approximate system max blob size: `13.6 GiB`.
- Quilt per-blob limit: approximately `4 GiB`.
- Public publisher/aggregator default request limit: `10 MiB`.

Spike result:

- 1 MiB blob upload/download worked against public Testnet.

Implication for M8:

- Small and medium task payloads are fine through public HTTP APIs.
- For larger payloads, use your own publisher, the CLI, or later a richer SDK/upload-relay flow.

## Latency observations

Observed from this Windows Node.js environment against public Testnet infrastructure:

| Payload | Store time | Fetch time |
| --- | ---: | ---: |
| 14 bytes (`Hello, Walrus!`) | ~3.4s to ~6.4s | ~16ms to ~1.3s |
| 1 MiB | ~7.5s | ~1.3s |

Notes:

- Times varied between calls.
- Public infrastructure and testnet conditions likely dominate these numbers.
- M8 should assume retries/backoff are needed.

## Windows compatibility

### HTTP API

Confirmed working from Node.js on Windows.

### TypeScript SDK

Confirmed in an isolated probe that on Windows:

- `pnpm add @mysten/walrus @mysten/sui@^2.16.2` succeeds.
- The SDK imports cleanly.
- `client.walrus.readBlob()` successfully read a live testnet blob.

Known concerns from docs/SDK README:

- Browser/bundler environments may need explicit WASM configuration.
- Node environments may need custom fetch timeout tuning.
- No Windows-specific blocker was observed in this spike.

## Issues and concerns

1. **Repo dependency mismatch**
   - `@mysten/walrus` peers on `@mysten/sui ^2.16.2`.
   - This repo currently depends on `@mysten/sui ^1.30.0`.
   - Direct SDK adoption would likely force a Sui SDK upgrade.

2. **Retention management needs more than blob IDs**
   - Renewal/delete flows require blob object ownership.
   - Blob ID alone is not enough for full lifecycle management.

3. **Public infra is fine for the spike, not enough for production guarantees**
   - No formal availability guarantees.
   - Public request-size limits.
   - Testnet may wipe without notice.

4. **Deletion semantics differ from the current filesystem store**
   - `BlobStore.delete()` cannot be cleanly implemented through the public HTTP path alone.
   - The spike implementation throws a clear error instead of pretending deletion works.

## M8 recommendation

1. Implement M8 on top of the HTTP publisher/aggregator API first.
2. Keep the underlying Walrus storage IDs as Walrus base64url strings, but wrap them in an Agentic Mesh blob reference (`walrus:<walrus-blob-id>:<sha256>`) when integrity metadata needs to travel with the task.
3. Keep Move blob IDs as `vector<u8>` containing the decoded 32-byte value.
4. Persist additional metadata for future lifecycle management:
   - `blobId`
   - `blobObjectId`
   - `epochs`
   - whether the blob was stored as permanent/deletable
5. Add retry/backoff and endpoint failover before production use.
6. Plan a separate upgrade track if you later want the full `@mysten/walrus` SDK in-repo.

## Production configuration

Agentic Mesh now exposes three blob store modes in daemon config:

```yaml
blobstore:
  mode: filesystem | walrus | hybrid
  filesystem:
    dataDir: ~/.agentic-mesh/blobs
  walrus:
    publisherUrl: https://publisher.walrus-testnet.walrus.space
    aggregatorUrl: https://aggregator.walrus-testnet.walrus.space
    epochs: 5
    maxBlobSize: 10485760
    retryAttempts: 3
    retryDelayMs: 1000
    timeoutMs: 30000
  hybrid:
    preferWalrus: true
    cacheLocally: true
```

### Mode selection

- `filesystem`: content-addressed local storage only.
- `walrus`: stores payloads in Walrus and returns Agentic Mesh blob references in the form `walrus:<walrus-blob-id>:<sha256>` so downstream fetches can verify integrity.
- `hybrid`: stores in Walrus first, falls back to filesystem if Walrus is unavailable, and can cache Walrus payloads locally for faster reads.

### Switching between filesystem and Walrus

**Filesystem only**

```yaml
blobstore:
  mode: filesystem
  filesystem:
    dataDir: ~/.agentic-mesh/blobs
```

**Walrus only**

```yaml
blobstore:
  mode: walrus
  walrus:
    publisherUrl: https://publisher.walrus-testnet.walrus.space
    aggregatorUrl: https://aggregator.walrus-testnet.walrus.space
    epochs: 5
```

**Hybrid with local cache**

```yaml
blobstore:
  mode: hybrid
  filesystem:
    dataDir: ~/.agentic-mesh/blobs
  walrus:
    publisherUrl: https://publisher.walrus-testnet.walrus.space
    aggregatorUrl: https://aggregator.walrus-testnet.walrus.space
    epochs: 5
  hybrid:
    preferWalrus: true
    cacheLocally: true
```

## Public endpoints

### Testnet

- Publisher: `https://publisher.walrus-testnet.walrus.space`
- Aggregator: `https://aggregator.walrus-testnet.walrus.space`

### Mainnet

- Aggregator: `https://aggregator.walrus-mainnet.walrus.space`
- Publisher: no anonymous public publisher is expected on mainnet; production deployments should run or provision an authenticated publisher endpoint.

For the current public operator lists, refer to the Walrus operator manifests:

- `https://docs.walrus.site/data/operator-list-testnet.json`
- `https://docs.walrus.site/data/operator-list-mainnet.json`
