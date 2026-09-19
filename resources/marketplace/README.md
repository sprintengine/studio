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

One population ships a committed `plugins/<id>/` bundle.

**The signed MCP seeds are gone** (owner ruling 2026-09-08).
`browser-automation-mcp` (Playwright), `repository-workflows-mcp` (GitHub),
`current-docs-mcp` (Context7) and `api-reference-mcp` (openai-docs) each wrapped
one MCP server that somebody else wrote and published it under our name. Being
signed made them ours to vouch for, not ours to ship. Their four rows, their
four `plugins/<id>/` directories and their four `icons/*.svg` are removed; the
index is 18 rows and carries **no signed component at all**.

Nothing was re-signed and nothing needed to be. There is no index-wide
signature: each signed entry carried its own `signature` over its own bytes, so
removing four left the other eighteen byte-identical.

`trusted-publishers.json` stays, and not out of caution. All 13 agent-CLI rows
set `publisher.verified: true`, and `validateInlineCliEntry` allows that claim
only under a name listed there as verified — identity proven by the signed app
bundle instead of by a detached signature. Deleting the file would fail all 13.
The SprintEngine Labs key is a trust anchor for those rows now rather than for any
signature, and the signature path itself is still exercised: the publish test
signs a probe bundle with a throwaway key it generates and trusts for the length
of the run.

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
to project most of it from a private catalogue-snapshot package
(`scripts/generate-connector-catalogue.mjs`) went with the 256 snapshotted
plugin entries it produced, and `scripts/sync-catalogue.mjs`, which pulled this
seed back from `sprintengine/studio-releases`, went with the MCP catalogue it
also fetched. This directory is the source of truth; it is published
to `studio-releases`, not read back from it.

## Source policy and widened schema

This seed is the first-party curated set and the shipped registry default — it
is no longer the *only* source the app will consume:

- **Allowlisted sources, not a single-repo pin**: the app downloader and the
  registry verifier accept any bundle `source` that is HTTPS on an allowlisted
  host (`github.com`, `api.github.com`, `raw.githubusercontent.com`, plus an
  optional `SPRINTENGINE_MARKETPLACE_EXTRA_HOSTS` list), covering the entry URL and
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
- **Registry read is config-swappable**: `SPRINTENGINE_MARKETPLACE_REGISTRY_URL`
  can point the read at a hosted catalogue's `GET /v1/registry`; this seed
  stays the offline/packaged fallback either way.

## Verification

Run this from the studio repo root to validate the local seed registry:

```bash
npm run verify:marketplace-registry
```

When validating a standalone registry checkout, pass that checkout as the root:

```bash
npm run verify:marketplace-registry -- --root ../marketplace
```

The verifier uses the shared marketplace schema validator for `marketplace.json`
and delegates every *signed* plugin bundle to `sprintengine-module plugin verify`,
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

The published registry workflow checks out the studio's validation tooling
and runs:

```bash
npm run verify:marketplace-registry -- --root "$GITHUB_WORKSPACE/registry"
npx vitest run resources/marketplace/verify-marketplace.test.ts
```
