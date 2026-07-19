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
sections, and sidebar nav doors — through the `MainHost` / `RendererHost`
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
