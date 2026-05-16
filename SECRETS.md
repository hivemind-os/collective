# Repository Secrets

This document lists the secrets required by the CI/CD workflows in this repository.

Configure them in **Settings → Secrets and variables → Actions → Repository secrets**.

---

## `NPM_TOKEN`

**Used by**: `publish-packages.yml`

An npm automation token with publish permissions for the `@hivemind-os` scope.

### How to generate

1. Log in to [npmjs.com](https://www.npmjs.com)
2. Go to **Access Tokens** → **Generate New Token**
3. Select **Granular Access Token**
4. Set permissions: **Read and write** for packages
5. Scope it to the `@hivemind-os` organization
6. Copy the token and add it as a repository secret named `NPM_TOKEN`

> **Note**: The `@hivemind-os` npm organization must exist and your account must
> have publish access. Create the org at https://www.npmjs.com/org/create if needed.

---

## `SUI_KEYSTORE`

**Used by**: `deploy-contracts.yml`

Base64-encoded contents of your Sui keystore file (`~/.sui/sui_config/sui.keystore`).
This file contains the private key(s) used to sign transactions.

### How to generate

```bash
# Create a dedicated deployer keypair (if you don't have one)
sui client new-address ed25519 deployer

# Base64-encode the keystore file
# Linux:
base64 -w 0 ~/.sui/sui_config/sui.keystore
# macOS:
base64 -i ~/.sui/sui_config/sui.keystore
```

Copy the output and add it as a repository secret named `SUI_KEYSTORE`.

> **Security**: Use a dedicated deployer address — not your personal wallet.
> Fund it with only enough SUI for gas on the target network.

---

## `SUI_CLIENT_CONFIG`

**Used by**: `deploy-contracts.yml`

Base64-encoded contents of your Sui client config (`~/.sui/sui_config/client.yaml`).
This defines RPC endpoints, the active environment, and the active address.

### How to generate

```bash
# Verify your config has the correct active-env and active-address
cat ~/.sui/sui_config/client.yaml

# Base64-encode it
# Linux:
base64 -w 0 ~/.sui/sui_config/client.yaml
# macOS:
base64 -i ~/.sui/sui_config/client.yaml
```

Copy the output and add it as a repository secret named `SUI_CLIENT_CONFIG`.

### Example `client.yaml` structure

```yaml
keystore:
  File: /home/runner/.sui/sui_config/sui.keystore
envs:
  - alias: devnet
    rpc: "https://fullnode.devnet.sui.io:443"
  - alias: testnet
    rpc: "https://fullnode.testnet.sui.io:443"
  - alias: mainnet
    rpc: "https://fullnode.mainnet.sui.io:443"
active_env: testnet
active_address: "0xYOUR_DEPLOYER_ADDRESS"
```

> **Tip**: The `deploy-contracts.yml` workflow will attempt to switch to the
> requested network if the active env doesn't match, but it's best to configure
> all three environments in the config upfront.

---

## GitHub Environments

For **mainnet deployments**, create a GitHub Environment named `mainnet` with
protection rules:

1. Go to **Settings → Environments → New environment**
2. Name it `mainnet`
3. Enable **Required reviewers** and add trusted team members
4. Optionally add a **wait timer** for extra safety

The `deploy-contracts.yml` workflow automatically uses this environment when
`network` is set to `mainnet`, requiring manual approval before deployment.
