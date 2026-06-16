# Multicode Marketplace Plugin Author Guide

Marketplace plugins are signed bundles over extension primitives Multicode
already supports: MCP configs, skill packs, capability modules, and CLI
plugins. A marketplace submission is accepted only when the registry entry,
`plugin.json`, declared component files, and ed25519 signature all validate
through the same code paths the app uses.

## Prerequisites

From the Multicode repo root:

```bash
npm ci
npx esbuild packages/module-sdk/src/cli.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/multicode-module.cjs
```

The commands below use the bundled local CLI:

```bash
MULTICODE_MODULE="node node_modules/.cache/multicode/multicode-module.cjs"
```

When the SDK package is installed in an external author workspace, replace that
variable with the packaged binary:

```bash
MULTICODE_MODULE="multicode-module"
```

## 1. Scaffold

Pick a lowercase plugin id. The id is the registry key and the folder name.

```bash
$MULTICODE_MODULE plugin scaffold acme-doc-search --out resources/marketplace/plugins/acme-doc-search --component mcp --component skills
```

By default, scaffold can create all component placeholders. Use `--component`
repeatedly when your bundle carries only some primitives.

After scaffold, edit:

- `resources/marketplace/plugins/acme-doc-search/plugin.json`
- `resources/marketplace/plugins/acme-doc-search/mcp/server.json`
- `resources/marketplace/plugins/acme-doc-search/skills/acme-doc-search/SKILL.md`

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

Sign after every change to `plugin.json`. Component file changes still need a
fresh verify/pack pass; if you change component paths or manifest metadata,
re-sign before submitting.

```bash
$MULTICODE_MODULE plugin sign resources/marketplace/plugins/acme-doc-search --key .private/acme-doc-search.key
```

Signing writes the normalized signed manifest back to `plugin.json`.

## 4. Verify

Run the same plugin verification command CI uses:

```bash
$MULTICODE_MODULE plugin verify resources/marketplace/plugins/acme-doc-search
```

A valid plugin prints `plugin signature valid` and the signer fingerprint. If
`plugin.json` changes after signing, verification fails with `INVALID
signature`; re-sign before submitting.

## 5. Pack Locally

Packing proves the bundle can be copied without private key material.

```bash
$MULTICODE_MODULE plugin pack resources/marketplace/plugins/acme-doc-search --out packed/acme-doc-search --force
$MULTICODE_MODULE plugin verify packed/acme-doc-search
```

`plugin pack` excludes `.git`, `node_modules`, `*.key`, and `*.pem`.

## 6. Add The Registry Entry

Create or update `resources/marketplace/marketplace.json`. The entry signature
must exactly match the signed `plugin.json` signature.

```bash
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('resources/marketplace/plugins/acme-doc-search/plugin.json','utf8')); console.log(JSON.stringify(m.signature,null,2))"
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
  "source": "https://github.com/multicode-labs/marketplace/tree/main/plugins/acme-doc-search",
  "provides": ["mcp", "skills"],
  "signature": {
    "algorithm": "ed25519",
    "publicKey": "<copied from plugin.json>",
    "signature": "<copied from plugin.json>"
  }
}
```

Add the icon at `resources/marketplace/icons/acme-doc-search.svg`. Registry
sources must be HTTPS URLs. Community submissions should use
`publisher.verified: false`; Multicode will install them only after the user
grants trust in the marketplace trust gate.

Only first-party publishers with a fingerprint listed in
`resources/marketplace/trusted-publishers.json` may set
`publisher.verified: true`.

## 7. Run The Registry Validator

Run this before opening a PR:

```bash
npm run verify:marketplace-registry
npm run test:marketplace-publish
```

The validator checks:

- `marketplace.json` with the shared marketplace index validator.
- Every `plugins/<id>/plugin.json` with `multicode-module plugin verify`.
- Registry entry id, name, version, provided components, and signature against
  the signed plugin manifest.
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
`npm run verify:marketplace-registry` command and the publish validation test.
Schema-invalid submissions fail with the exact shared-validator path, and
tampered signatures fail through `multicode-module plugin verify` with an
`INVALID signature` message.
