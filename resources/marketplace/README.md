# First-Party Marketplace Seed Registry

This directory is the source registry content for the curated first-party
marketplace seed set.

- Local registry path: `resources/marketplace/marketplace.json`
- Seed plugin bundles: `resources/marketplace/plugins/<plugin-id>/`
- First-party icon assets: `resources/marketplace/icons/`
- Publisher public keys: `resources/marketplace/trusted-publishers.json`
- Remote publication target for the T2.1 `RegistryClient` default:
  `https://raw.githubusercontent.com/multicode-labs/marketplace/main/marketplace.json`

T4.2 publish CI should publish this directory as the `multicode-labs/marketplace`
repository root, keeping `marketplace.json`, `plugins/`, `icons/`, and
`trusted-publishers.json` at the same relative paths.

## Seed Plugins

Each seed wraps one MCP server already present in `resources/mcps/catalog.json`.
The plugin manifests are signed with ed25519 detached signatures and the
private signing key is not stored in this repository.

- `browser-automation-mcp` wraps the `playwright` MCP server.
- `repository-workflows-mcp` wraps the `github` MCP server.
- `current-docs-mcp` wraps the `context7` MCP server.
- `api-reference-mcp` wraps the `openai-docs` MCP server.

All marketplace entries use `publisher.verified: true` for `Multicode Labs`.
First-party verification is represented by the publisher fingerprint in
`trusted-publishers.json`; the app trust path classifies the signed manifests as
trusted when that fingerprint is accepted.

## Verification

Run this from the repo root:

```bash
npm run verify:marketplace-registry
```

The verifier uses the shared marketplace schema validator for `marketplace.json`
and delegates every plugin bundle to `multicode-module plugin verify`, the same
authoring CLI path used before publish. It also checks that verified publisher
signatures resolve to `trusted-publishers.json`, registry entries match their
signed `plugin.json`, icons exist, MCP components parse, and no key material is
committed.
