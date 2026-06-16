# First-Party Marketplace Seed Registry

This directory is the source registry content for the curated first-party
marketplace seed set. When published to `multicode-labs/marketplace`, this
directory is the repository root.

- Local registry path: `resources/marketplace/marketplace.json`
- Seed plugin bundles: `resources/marketplace/plugins/<plugin-id>/`
- First-party icon assets: `resources/marketplace/icons/`
- Publisher public keys: `resources/marketplace/trusted-publishers.json`
- Publish CI root workflow:
  `resources/marketplace/.github/workflows/marketplace-registry.yml`
- Remote publication target for the T2.1 `RegistryClient` default:
  `https://raw.githubusercontent.com/multicode-labs/marketplace/main/marketplace.json`

Publishing keeps `marketplace.json`, `plugins/`, `icons/`,
`trusted-publishers.json`, and `.github/workflows/marketplace-registry.yml` at
the same relative paths.

## Seed Plugins

Each seed wraps one MCP server already present in `resources/mcps/catalog.json`.
The plugin manifests are signed with ed25519 detached signatures over the
normalized `plugin.json`, including per-component file digests. The private
signing key is not stored in this repository.

- `browser-automation-mcp` wraps the `playwright` MCP server.
- `repository-workflows-mcp` wraps the `github` MCP server.
- `current-docs-mcp` wraps the `context7` MCP server.
- `api-reference-mcp` wraps the `openai-docs` MCP server.

All marketplace entries use `publisher.verified: true` for `Multicode Labs`.
First-party verification is represented by the publisher fingerprint in
`trusted-publishers.json`; the app trust path classifies the signed manifests as
trusted when that fingerprint is accepted.

## Verification

Run this from the Multicode app repo root to validate the local seed registry:

```bash
npm run verify:marketplace-registry
```

When validating a standalone registry checkout, pass that checkout as the root:

```bash
npm run verify:marketplace-registry -- --root ../marketplace
```

The verifier uses the shared marketplace schema validator for `marketplace.json`
and delegates every plugin bundle to `multicode-module plugin verify`, the same
authoring CLI path used before publish. It also checks signed component file
digests, canonical `plugins/<id>` source URLs, verified publisher signatures
against `trusted-publishers.json`, registry entries against their signed
`plugin.json`, icons, MCP component parseability, and absence of committed key
material.

The published registry workflow checks out the Multicode app validation tooling
and runs:

```bash
npm run verify:marketplace-registry -- --root "$GITHUB_WORKSPACE/registry"
npm run test:marketplace-publish
```
