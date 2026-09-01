# Drop-in extensions: modules and CLI plugins

Multicode picks up two kinds of third-party extension from per-user folders,
discovered on launch. Both folders are created (and seeded with a README) the
first time Multicode runs — including on a packaged install — so there is always
a discoverable place to drop things.

| Kind | Folder | Manifest | Surfaced in |
| --- | --- | --- | --- |
| **Capability module** | `~/.multicode/modules/<id>/` | `manifest.json` | Settings → Modules |
| **CLI plugin (BYO CLI)** | `~/.multicode/plugins/<id>/` | `plugin.json` | Settings → Agents |

In both cases the folder name must equal the manifest `id`. A user plugin with
the same id as a bundled CLI overrides the bundled one.

The module root can be relocated with the `MULTICODE_USER_MODULE_ROOT`
environment variable (used by the dev harness); plugins always resolve under
`~/.multicode/plugins`.

## Capability modules

A capability module extends the app itself — main-process services and IPC,
renderer panels, workspace types, commands, Backlog actions, settings
sections, sidebar nav doors, and modal surfaces (`registerModalSurface`: a
body mounted in the shell's modal shell plus a trigger glyph in the sidebar
footer's settings cluster) — through the `MainHost` / `RendererHost`
contracts. Modules are trust-gated: only modules the user has trusted execute
code.

- Author against [`@multicode/module-sdk`](../../packages/module-sdk/README.md).
- Validate, pack, and sign with the bundled `multicode-module` CLI.
- Install by dropping the folder into `~/.multicode/modules/<id>/`, or from
  **Settings → Modules → "Install from folder"**, then grant trust.
- Permissions are install-time disclosure — see [permissions.md](./permissions.md).

### Creating a workspace from a module

A module's `entry.main` can create workspaces programmatically through the
always-on core, the same flow the UI uses:

```ts
import { WorkspaceServiceToken } from '@multicode/module-sdk'

const workspaces = host.requireService(WorkspaceServiceToken)
const result = await workspaces.create({ name: 'Scratch', folderPath: '/abs/path' })
// { ok: true, workspaceId } | { ok: false, code, message }
```

The promise resolves only after the workspace is confirmed on the
workspace-sync bus, so a returned id is always a real workspace.

### Publishing a module to the marketplace

Folder install (above) is the developer loop. To let other users discover and
install your module from the **Plugins → Modules** shelf, publish it to
the marketplace registry as a signed plugin bundle:

1. **Sign the module.** `multicode-module keygen` once, then
   `multicode-module sign <module-dir> --key <key.pem>` and
   `multicode-module verify <module-dir>`. Keep the private key out of the
   module directory and out of version control; modules are code-bearing, so
   an unsigned module bundle is hard-blocked from install.
2. **Wrap it in a plugin bundle.**
   `multicode-module plugin scaffold <plugin-id> --component module`, replace
   the `module/` placeholder with your packed module
   (`multicode-module pack <module-dir> --out <staging>`), and fill in
   `plugin.json` — id, displayName, summary, category, and the same
   `permissions` your module manifest declares (they are what the install
   trust prompt shows).
3. **Sign and check the bundle.**
   `multicode-module plugin sign <plugin-dir> --key <key.pem>` writes
   per-component file digests into `plugin.json` and signs it — component
   bytes can't change afterwards without failing verification. Then
   `multicode-module plugin verify <plugin-dir>` runs the exact check the app
   runs at install.
4. **Open a registry PR.** Add `plugins/<plugin-id>/` (your signed bundle), an
   `icons/<plugin-id>.svg`, and a `marketplace.json` entry whose
   `name`/`latest`/`provides`/`signature` match your `plugin.json`
   byte-for-byte, with a `source` URL on an allowlisted HTTPS host
   (`github.com` / `raw.githubusercontent.com`). Registry CI runs the same
   verifier the app build runs (`verify:marketplace-registry`). The full
   command walkthrough, including the registry-entry shape, lives in
   [`docs/plugin-authors/README.md`](../plugin-authors/README.md). Registry
   entries reach the app through the published catalogue snapshot — the app's
   bundled index is generated from it, so listing follows the next snapshot
   release rather than the PR merge alone.

What users then see: your module on the Plugins modal's **Modules** shelf
(card copy comes from your module's `displayName` + `summary` — say what it
adds: workspace type, panels, commands), a trust prompt listing the REAL
permissions from your verified manifest at install time, and the module in
Settings → Modules once installed. Signed community bundles install through
that trust prompt; a publisher key fingerprint listed in
`trusted-publishers.json` installs without one; unsigned module bundles are
rejected outright.

## CLI plugins (BYO CLI)

A CLI plugin adds a new agent CLI (claude-code, codex, opencode, your own). It
is **not** a capability module — it is a declarative `plugin.json` describing
how to launch, resume, inject prompts into, and detect completion for a CLI.

- The authoring contract is `CliPluginManifest` in `@multicode/module-sdk`;
  `validateCliPluginManifest` is the **same validator the app runs** on load
  (the app imports it from the SDK), so a manifest it accepts will load.
- Worked examples: [`../2026-05-16-plugin-manifests-worked-examples.md`](../2026-05-16-plugin-manifests-worked-examples.md);
  design rationale: [`../2026-05-16-byo-cli-plugin-system.md`](../2026-05-16-byo-cli-plugin-system.md).
- Install by dropping the folder into `~/.multicode/plugins/<id>/`, or from
  **Settings → Agents → "Install CLI from folder"**. New plugins are picked up
  immediately on install, or on the next launch / Settings refresh.

Declarative CLI plugins run no code of their own — they only configure how the
app spawns an external binary you already trust — so they are not gated behind
the module trust prompt. (Executable *provider* adapters, a separate provider
manifest kind, are signature-gated; see `src/shared/plugin-manifest.ts`.)
