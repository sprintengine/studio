# @multicode/module-sdk

Published contract types for building **Multicode capability modules** — the
manifest and permission shapes, the main-process `MainHost` registration
contract, the renderer `RendererHost` contribution types (panels, workspace
types, Backlog item actions, Backlog link providers, commands, settings
sections), and the module notification payloads.

The package is types-first: it ships type declarations plus a handful of small
mirrored values (`BUNDLED_MODULE_IDS`, `KNOWN_CAPABILITY_PERMISSIONS`,
`createServiceToken`). It has no runtime dependency on Electron or on Multicode
application code, so an external project can compile a module against the
tarball alone.

## Versioning

Semver, starting at `0.1.0`. See `CHANGELOG.md`. Inside the Multicode
repository a drift guard (`drift/sdk-drift-guard.ts`, run in the verify
pipeline) fails the build whenever these declarations diverge from the in-app
contracts, so a published version always matches the app version it ships with.

## v1 support surface

- **Manifest** (`CapabilityManifest`): id, displayName, integer version,
  publisher, category, summary, `defaultEnabled`, `dependsOn`/`conflictsWith`,
  `source: 'third-party'`, `permissions`, `entry`, `signature`.
- **Entries**: `entry.main` (CommonJS, `export registerMain(host)`) runs in the
  main process for **trusted** modules; `entry.renderer` (single-file ESM
  bundle, `export registerRenderer(host)`) loads in the renderer for trusted
  modules. **`entry.preload` is reserved and NOT loaded in v1** — the manifest
  field exists for forward compatibility only.
- **Trust**: only `trusted` modules execute code. Signing is detached ed25519
  over the canonical manifest; trust binds to manifest content (changing the
  manifest voids trust).
- **Permissions are install-time disclosure, not runtime enforcement.** The
  consent UI shows what your module declares; it does not sandbox it. Prefer
  the tiered `ipc:*` scopes; `ipc:invoke` is the legacy broad scope and is
  flagged as broad to the user.
- **Main host**: `registerIpc` (channel ownership enforced), service tokens,
  startup/shutdown hooks, `registerSidecar`, and `notify(severity, title,
  body?)` (identity stamped by the host, per-module flood-bounded).
- **Renderer host**: `registerPanel`, `registerWorkspaceType`,
  `registerBacklogItemAction`, `registerBacklogLinkProvider`,
  `registerCommand` (registered id is namespaced `<moduleId>.<id>`), and
  `registerSettingsSection` (values persist in the module's own
  `module:<id>` settings namespace).
- **React**: panels, icons, and settings sections are React components. The
  app provides React at runtime; compile against `@types/react` 18 (declared
  as an optional peer dependency) and bundle your renderer entry as ESM with
  React marked external.

## Intentional narrowings (v1)

These app capabilities exist but are not in the published surface; the drift
guard verifies the narrowings stay *sound* (an SDK-typed module is always
valid for the app):

- `WorkspacePanelProps` exposes `workspaceId` only (the app may pass extra
  shell-internal props such as future-plan hooks).
- `WorkspaceTypeDefinition` omits shell-internal hooks (top-bar supervisors,
  run-glyph providers).
- Workspace layout JSON (`WorkspaceLayoutJson`) is a conservative subset of
  the app's FlexLayout model (rows, tabsets, tabs); the app accepts more.
- `BacklogItemView` widens enumerated app internals (item kind, triage axes)
  to `string` so new app values never break compiled modules, and omits
  shell-only fields.
- `MainHost.ipcMain` is typed `unknown` to keep the SDK Electron-free.
- `BacklogItemActionContext` omits the shell-internal `startSourcePlan` hook.

## Building a module

```ts
import type { CapabilityManifest, RegisterMain, RegisterRenderer } from '@multicode/module-sdk'
```

Author `manifest.json` matching `CapabilityManifest`, bundle `entry.main` as
CJS and `entry.renderer` as a single-file ESM bundle, sign the manifest, and
install the module folder under `~/.multicode/modules/<id>/`. See
`test-fixtures/external-project/` in the repository for a complete minimal
module compiled against this package.

## Signing and packaging: the `multicode-module` CLI

The package ships a `multicode-module` binary (run it with
`npx multicode-module` from a project that depends on this package). It uses
the same canonicalization and ed25519 code the app's verifier imports, so the
CLI and the app can never disagree about what a valid signature is.

The happy path from module directory to installable, signed module:

```sh
# 1. One-time: generate your ed25519 signing keypair.
#    Writes a PKCS#8 PEM private key; keep it OUT of the module directory
#    and out of version control. The public key is derived from it at sign time.
npx multicode-module keygen --out ~/keys/module-signing.key

# 2. Sign the module. Validates manifest.json, writes the normalized manifest
#    (sorted, unknown keys stripped) back including the detached signature —
#    the bytes on disk are exactly what the app verifies.
npx multicode-module sign path/to/my-module --key ~/keys/module-signing.key

# 3. Check the module the way the Multicode app will.
#    Exit 0 + signer fingerprint when valid; exit 1 when unsigned or tampered.
npx multicode-module verify path/to/my-module

# 4. Assemble the installable copy. Validates the manifest (bad ids, reserved
#    bundled ids, malformed permissions all fail with explicit errors) and
#    copies the module to --out (default packed/<id>), excluding node_modules,
#    .git, and any *.key / *.pem files.
npx multicode-module pack path/to/my-module --out dist/my-module
```

Re-running `sign` replaces the previous signature. Any edit to the manifest
after signing invalidates the signature (`verify` and the app both report it
as invalid); re-sign after every manifest change.

In the app, a valid signature shows the module as **signed** with the signer's
key fingerprint — the user still grants trust explicitly before any code runs.
