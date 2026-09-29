# SprintEngine Studio Marketplace Plugin Author Guide

Marketplace plugins are signed bundles over extension primitives the studio
already supports. The four component kinds (`MARKETPLACE_COMPONENT_KINDS`) are
`mcp`, `skills`, `module` and `automation`. There is no `cli` kind: agent CLIs
ship with the app, and no bundle adds or replaces one. A marketplace submission
is accepted only when the registry entry, `plugin.json`, declared component
files, and ed25519 signature all validate through the same code paths the app
uses.

The same `plugin.json` is also what a **GitHub install** reads, from the root of
a repository — see "Publishing from GitHub instead" at the end. A module you
build from a template (`sprintengine-module init`) already has that layout.

Registry pull requests target the standalone `sprintengine/studio-releases`
repository layout:

```text
marketplace.json
trusted-publishers.json
icons/<plugin-id>.svg
plugins/<plugin-id>/plugin.json
plugins/<plugin-id>/<component files>
```

## Prerequisites

From the studio repo root:

```bash
npm ci
npx esbuild packages/module-sdk/src/cli.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/sprintengine/sprintengine-module.cjs
```

The commands below use the bundled local CLI:

```bash
SPRINTENGINE_MODULE="node $(pwd)/node_modules/.cache/sprintengine/sprintengine-module.cjs"
```

When the SDK package is installed in an external author workspace, replace that
variable with the packaged binary:

```bash
SPRINTENGINE_MODULE="sprintengine-module"
```

Run the scaffold, sign, verify, pack, and registry-entry commands below from a
checkout of the marketplace registry repository, where `marketplace.json` lives
at the current directory.

## 1. Scaffold

Pick a lowercase plugin id. The id is the registry key and the folder name.

```bash
$SPRINTENGINE_MODULE plugin scaffold acme-doc-search --out plugins/acme-doc-search --component mcp --component skills
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

A `module` component is a capability module folder. Its `manifest.json` must
declare `"engines": { "hostApi": 1 }` and carry a `files` map (every file's
sha256, written by `sprintengine-module sign`); sign the module before you sign
the bundle, because signing the module rewrites its manifest and the bundle's
digests cover it. A bundle whose signed module has no `files` is refused.

## 2. Create A Signing Key

Keep the private key outside the plugin folder and outside git.

```bash
mkdir -p .private
$SPRINTENGINE_MODULE keygen --out .private/acme-doc-search.key
```

The CLI prints the public-key fingerprint. Store the private key in your own
secret manager. Do not add `.key` or `.pem` files to the registry.

## 3. Sign

Sign after every change to `plugin.json` or any declared component file. The
sign command writes per-component file digests into `plugin.json` before adding
the ed25519 signature, so component byte changes require a fresh signature.

```bash
$SPRINTENGINE_MODULE plugin sign plugins/acme-doc-search --key .private/acme-doc-search.key
```

Signing writes the normalized signed manifest, including component file
digests, back to `plugin.json`.

## 4. Verify

Run the same plugin verification command CI uses:

```bash
$SPRINTENGINE_MODULE plugin verify plugins/acme-doc-search
```

A valid plugin prints `<id>: plugin signature valid` and the signer fingerprint. If
`plugin.json` changes after signing, verification fails with `INVALID
signature`; if a component file changes after signing, verification fails with a
component digest mismatch. Re-sign before submitting.

## 5. Pack Locally

Packing proves the bundle can be copied without private key material.

```bash
$SPRINTENGINE_MODULE plugin pack plugins/acme-doc-search --out packed/acme-doc-search --force
$SPRINTENGINE_MODULE plugin verify packed/acme-doc-search
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
  "source": "https://github.com/sprintengine/studio-releases/tree/main/plugins/acme-doc-search",
  "provides": ["mcp", "skills"],
  "signature": {
    "algorithm": "ed25519",
    "publicKey": "<copied from plugin.json>",
    "signature": "<copied from plugin.json>"
  }
}
```

Add the icon at `icons/acme-doc-search.svg`. A registry `source` must be an
`https:` URL on an allowlisted host (`github.com`, `api.github.com`,
`raw.githubusercontent.com`); the canonical
`https://github.com/sprintengine/studio-releases/tree/main/plugins/<id>` layout
is the convention, not a validated pin. Community submissions should use
`publisher.verified: false`; the studio will install them only after the user
grants trust in the marketplace trust gate.

Only first-party publishers with a fingerprint listed in
`trusted-publishers.json` may set `publisher.verified: true`. The one exception
is an inline-CLI entry (`entry.cli`, which points at a bundled
`resources/plugins/<id>` and carries no signature): it may claim verified when
its publisher name is listed as verified.

## 7. Run The Registry Validator

The registry repo carries `.github/workflows/marketplace-registry.yml`, run on
`workflow_dispatch`. That workflow checks out the studio's validation
tooling and runs the verifier. Locally you can point it at a registry checkout
with `--root`:

```bash
npm run verify:marketplace-registry -- --root "$GITHUB_WORKSPACE/registry"
```

To run the same validator locally from a checkout of the studio repository:

```bash
npm run verify:marketplace-registry
npx vitest run resources/marketplace/verify-marketplace.test.ts
```

Pass `-- --root <registry-checkout>` when validating a standalone registry
checkout outside `resources/marketplace`:

```bash
npm run verify:marketplace-registry -- --root ../marketplace
```

The validator checks:

- `marketplace.json` with the shared marketplace index validator.
- Every `plugins/<id>/plugin.json` with `sprintengine-module plugin verify`.
- Signed component file digests against the committed bytes under
  `plugins/<id>/`.
- Registry entry id, name, version, provided components, and signature against
  the signed plugin manifest.
- Registry entry `source` against the HTTPS host allowlist.
- Bundled skill payload digests, and the absence of orphan payload files.
- An inline icon against the committed mark, byte for byte.
- That a publisher claiming `verified: true` is proven by a signature (unless
  the entry is an inline CLI).
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
`npm run verify:marketplace-registry` command and the publish validation test. Schema-invalid submissions fail with
the exact shared-validator path, and tampered signatures fail through
`sprintengine-module plugin verify` with an `INVALID signature` message.

## Publishing from GitHub instead

A registry listing is not the only way in. Anyone can install an extension
straight from its repository URL (the Extensions door's **Install extension
from GitHub…**). The repository layout:

```text
plugin.json            at the repository root; components.module.path = "module"
module/manifest.json   with "engines" and "files" ("signature" if signed)
module/dist/…          the built bundles, committed
```

- Studio resolves the default branch to a commit, reads `plugin.json` at the
  repository root at that commit, shows the name, publisher, permissions, MCP
  servers and signing, and installs the components it names — for a module,
  only the `module/` folder.
- **Signed** (a valid module signature over `files`, and a signed bundle):
  installs through the normal trust prompt, showing your key's fingerprint.
- **Unsigned** is allowed from GitHub, unlike the registry. Studio warns that
  nobody vouches for the code, and a bundle with module code needs an explicit
  "I trust this code" choice before it installs. The module's `files` map is
  still required: it is what the installed folder is held to, and an unsigned
  module without one is refused with that reason.
- **Invalid** signatures (anything changed after signing) are refused.
- Updates re-resolve the commit and ask again when the permissions, the MCP
  disclosure or the signing change.
- A repository with a `.claude-plugin/` folder is an agent skill source, not a
  Studio extension; add it from the Skills path.

Commit the rebuilt `module/dist/` together with the `module/manifest.json`
its build produced: a module whose files do not match its `files` is refused as
tampered.
