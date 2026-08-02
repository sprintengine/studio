# Multicode Marketplace Plugin Author Guide

Marketplace plugins are signed bundles over extension primitives Multicode
already supports: MCP configs, skill packs, capability modules, and CLI
plugins. A marketplace submission is accepted only when the registry entry,
`plugin.json`, declared component files, and ed25519 signature all validate
through the same code paths the app uses.

Registry pull requests target the standalone `hotstacklabs/sprintengine-marketplace`
repository layout:

```text
marketplace.json
trusted-publishers.json
icons/<plugin-id>.svg
plugins/<plugin-id>/plugin.json
plugins/<plugin-id>/<component files>
```

## Prerequisites

From the Multicode repo root:

```bash
npm ci
npx esbuild packages/module-sdk/src/cli.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/multicode-module.cjs
```

The commands below use the bundled local CLI:

```bash
MULTICODE_MODULE="node $(pwd)/node_modules/.cache/multicode/multicode-module.cjs"
```

When the SDK package is installed in an external author workspace, replace that
variable with the packaged binary:

```bash
MULTICODE_MODULE="multicode-module"
```

Run the scaffold, sign, verify, pack, and registry-entry commands below from a
checkout of the marketplace registry repository, where `marketplace.json` lives
at the current directory.

## 1. Scaffold

Pick a lowercase plugin id. The id is the registry key and the folder name.

```bash
$MULTICODE_MODULE plugin scaffold acme-doc-search --out plugins/acme-doc-search --component mcp --component skills
```

By default, scaffold can create all component placeholders. Use `--component`
repeatedly when your bundle carries only some primitives.

After scaffold, edit:

- `plugins/acme-doc-search/plugin.json`
- `plugins/acme-doc-search/mcp/server.json`
- `plugins/acme-doc-search/skills/acme-doc-search/SKILL.md`

Declare real permissions in `plugin.json`. Permissions are install-time
disclosure, not a runtime sandbox. See
[`docs/module-authors/permissions.md`](../module-authors/permissions.md).

## 2. Create A Signing Key

Keep the private key outside the plugin folder and outside git.

```bash
mkdir -p .private
$MULTICODE_MODULE keygen --out .private/acme-doc-search.key
```

The CLI prints the public-key fingerprint. Store the private key in your own
secret manager. Do not add `.key` or `.pem` files to the registry.

## 3. Sign

Sign after every change to `plugin.json` or any declared component file. The
sign command writes per-component file digests into `plugin.json` before adding
the ed25519 signature, so component byte changes require a fresh signature.

```bash
$MULTICODE_MODULE plugin sign plugins/acme-doc-search --key .private/acme-doc-search.key
```

Signing writes the normalized signed manifest, including component file
digests, back to `plugin.json`.

## 4. Verify

Run the same plugin verification command CI uses:

```bash
$MULTICODE_MODULE plugin verify plugins/acme-doc-search
```

A valid plugin prints `plugin signature valid` and the signer fingerprint. If
`plugin.json` changes after signing, verification fails with `INVALID
signature`; if a component file changes after signing, verification fails with a
component digest mismatch. Re-sign before submitting.

## 5. Pack Locally

Packing proves the bundle can be copied without private key material.

```bash
$MULTICODE_MODULE plugin pack plugins/acme-doc-search --out packed/acme-doc-search --force
$MULTICODE_MODULE plugin verify packed/acme-doc-search
```

`plugin pack` excludes `.git`, `node_modules`, `*.key`, and `*.pem`.

## 6. Add The Registry Entry

Create or update `marketplace.json` at the registry root. The entry signature
must exactly match the signed `plugin.json` signature.

```bash
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('plugins/acme-doc-search/plugin.json','utf8')); console.log(JSON.stringify(m.signature,null,2))"
```

Example community entry:

```json
{
  "id": "acme-doc-search",
  "name": "Acme Doc Search",
  "publisher": {
    "name": "Acme Tools",
    "verified": false
  },
  "summary": "Installs Acme's documentation search MCP and helper skill.",
  "category": "Documentation",
  "icon": "icons/acme-doc-search.svg",
  "latest": 1,
  "source": "https://github.com/hotstacklabs/sprintengine-marketplace/tree/main/plugins/acme-doc-search",
  "provides": ["mcp", "skills"],
  "signature": {
    "algorithm": "ed25519",
    "publicKey": "<copied from plugin.json>",
    "signature": "<copied from plugin.json>"
  }
}
```

Add the icon at `icons/acme-doc-search.svg`. Registry sources must use the
canonical `https://github.com/hotstacklabs/sprintengine-marketplace/tree/main/plugins/<id>`
layout. Community submissions should use `publisher.verified: false`; Multicode
will install them only after the user grants trust in the marketplace trust gate.

Only first-party publishers with a fingerprint listed in
`trusted-publishers.json` may set `publisher.verified: true`.

## 7. Run The Registry Validator

The registry repo runs `.github/workflows/marketplace-registry.yml` on pull
requests. That workflow checks out the Multicode app validation tooling and
validates the registry checkout as the root:

```bash
npm run verify:marketplace-registry -- --root "$GITHUB_WORKSPACE/registry"
```

To run the same validator locally from a Multicode repo checkout:

```bash
npm run verify:marketplace-registry
npm run test:marketplace-publish
```

Pass `-- --root <registry-checkout>` when validating a standalone registry
checkout outside `resources/marketplace`:

```bash
npm run verify:marketplace-registry -- --root ../marketplace
```

The validator checks:

- `marketplace.json` with the shared marketplace index validator.
- Every `plugins/<id>/plugin.json` with `multicode-module plugin verify`.
- Signed component file digests against the committed bytes under
  `plugins/<id>/`.
- Registry entry id, name, version, provided components, and signature against
  the signed plugin manifest.
- Registry entry source against the canonical `plugins/<id>` GitHub path.
- Verified publisher fingerprints against `trusted-publishers.json`.
- Icon paths, MCP component parseability, and absence of committed key material.

## 8. Submit The PR

Open a pull request against the marketplace registry with:

- `marketplace.json`
- `plugins/<id>/plugin.json`
- every declared component file under `plugins/<id>/`
- an icon under `icons/`
- no private keys

The `.github/workflows/marketplace-registry.yml` job runs the same
`npm run verify:marketplace-registry -- --root "$GITHUB_WORKSPACE/registry"`
command and the publish validation test. Schema-invalid submissions fail with
the exact shared-validator path, and tampered signatures fail through
`multicode-module plugin verify` with an `INVALID signature` message.
