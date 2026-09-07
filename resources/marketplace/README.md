# First-Party Marketplace Seed Registry

This directory is the source registry content for the curated first-party
marketplace seed set. When published to `sprintengine/studio-releases`, this
directory is the repository root.

- Local registry path: `resources/marketplace/marketplace.json`
- Seed plugin bundles: `resources/marketplace/plugins/<plugin-id>/`
- First-party icon assets: `resources/marketplace/icons/`
- Publisher public keys: `resources/marketplace/trusted-publishers.json`
- Publish CI root workflow:
  `resources/marketplace/.github/workflows/marketplace-registry.yml`
- Remote publication target for the T2.1 `RegistryClient` default:
  `https://raw.githubusercontent.com/sprintengine/studio-releases/main/marketplace.json`

Publishing keeps `marketplace.json`, `plugins/`, `icons/`,
`trusted-publishers.json`, and `.github/workflows/marketplace-registry.yml` at
the same relative paths.

## Seed Plugins

Two populations ship a committed `plugins/<id>/` bundle.

**Signed MCP seeds.** Each wraps one MCP server. The plugin manifests are signed
with ed25519 detached signatures over the normalized `plugin.json`, including
per-component file digests. The private signing key is not stored in this
repository.

- `browser-automation-mcp` wraps the `playwright` MCP server.
- `repository-workflows-mcp` wraps the `github` MCP server.
- `current-docs-mcp` wraps the `context7` MCP server.
- `api-reference-mcp` wraps the `openai-docs` MCP server.

Only the last of those four is still a `resources/mcps/catalog.json` row. The
frozen-snapshots retirement (2026-09-06) cut that catalogue to the 16 servers no
plugin carries, and Playwright, GitHub and Context7 are all plugins in
`anthropics/claude-plugins-official`. The three signed bundles that wrap them are
therefore a second route to a server the Anthropic tab already offers — recorded
here rather than removed, because this item's brief is the registry's data and
these are signed entries, and unpicking a signed bundle is its own change. See
backlog/2026-09-06-the-frozen-snapshots-retire.md, "What this item leaves".

These use `publisher.verified: true` for `Multicode Labs`. First-party
verification is represented by the publisher fingerprint in
`trusted-publishers.json`; the app trust path classifies the signed manifests as
trusted when that fingerprint is accepted.

**Unsigned automation starters** (`*-automation`). Each is a definition — a
schedule trigger, a `spawn-agent` action and a prompt — interpreted by the app's
automation engine, never loaded as code, so it ships unsigned like every other
non-code-bearing bundle. A signature is what would let an entry claim
`publisher.verified`, so these declare `false`; integrity of the committed bytes
comes from the component file digests instead, which the verifier requires.
Their marks are committed at `icons/<id>.svg` for review and inlined into
`marketplace.json` as `data:` URIs so they render without resolving against the
remote registry.

Every entry in `marketplace.json` is now hand-authored. The generator that used
to project most of it from `@hotstack/catalogue-snapshot`
(`scripts/generate-connector-catalogue.mjs`) went with the 256 snapshotted
plugin entries it produced; `npm run sync:catalogue` refreshes this seed from
`sprintengine/studio-releases`, which is where the entries are edited.

## Source policy and widened schema

This seed is the first-party curated set and the shipped registry default — it
is no longer the *only* source the app will consume:

- **Allowlisted sources, not a single-repo pin**: the app downloader and the
  registry verifier accept any bundle `source` that is HTTPS on an allowlisted
  host (`github.com`, `api.github.com`, `raw.githubusercontent.com`, plus an
  optional `MULTICODE_MARKETPLACE_EXTRA_HOSTS` list), covering the entry URL and
  every followed per-file `download_url`. First-party seed staging is still
  scoped to `sprintengine/studio-releases` (via
  `src/shared/marketplace/canonical-source.ts`), not implied by the source
  string.
- **Widened registry schema** (`src/shared/marketplace/manifest.ts`): registry
  entries may omit `signature`, carry `categories[]`/`tags[]`, and use the
  inline-MCP entry shape (`mcp.servers`, no bundle `source`) in place of a signed
  bundle. Existing signed-bundle entries (this seed) stay valid unchanged.
- **Trust is by signature + component kind, not by listing**: code-bearing
  bundles (`module`/`cli`) keep the hard signature gate; unsigned
  MCP/skills/automation and inline-MCP entries install only through the community
  trust prompt. The four MCP seeds remain signed and verified via the
  trusted-publisher fingerprint; the automation starters do not, and say so by
  declaring `publisher.verified: false`.
- **Registry read is config-swappable**: `MULTICODE_MARKETPLACE_REGISTRY_URL`
  can point the read at the HotStack catalogue `GET /v1/registry`; this seed
  stays the offline/packaged fallback either way.

See `knowledge/multicode/extensibility-platform.md` (HotStack Catalogue Consumer
section) and `knowledge/hotstack-catalogue.md` for the full contracts.

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
and delegates every *signed* plugin bundle to `multicode-module plugin verify`,
the same authoring CLI path used before publish. It also checks component file
digests, allowlisted HTTPS source URLs (the host allowlist above, replacing the
former canonical `plugins/<id>` pin), verified publisher signatures
against `trusted-publishers.json`, registry entries against their
`plugin.json`, icons, MCP component parseability, and absence of committed key
material.

An unsigned entry that ships a committed bundle gets an equivalent gate rather
than the CLI one: its manifest must parse, it must carry no `module`/`cli`
component, its component digests must match the committed bytes, and an
`automation` payload must be a valid definition draft. Two rules apply to every
entry regardless of shape — an entry with no signature may not set
`publisher.verified`, and every committed `plugins/<id>/` payload must be
claimed by an entry the verifier actually checked.

The published registry workflow checks out the Multicode app validation tooling
and runs:

```bash
npm run verify:marketplace-registry -- --root "$GITHUB_WORKSPACE/registry"
node scripts/testing/run-tests.mjs resources/marketplace/verify-marketplace.test.ts
```
