# Drop-in extensions: modules and CLI plugins

SprintEngine Studio picks up two kinds of third-party extension from per-user
folders, discovered on launch. Both folders are created (and seeded with a
README) the first time the app runs — including on a packaged install — so there
is always a discoverable place to drop things.

| Kind | Folder | Manifest | Surfaced in |
| --- | --- | --- | --- |
| **Capability module** | `~/.multicode/modules/<id>/` | `manifest.json` | Settings → Modules |
| **CLI plugin (BYO CLI)** | `~/.multicode/plugins/<id>/` | `plugin.json` | Settings → Agents |

In both cases the folder name must equal the manifest `id`. A user plugin with
the same id as a bundled CLI overrides the bundled one.

The module root can be relocated with the `SPRINTENGINE_USER_MODULE_ROOT`
environment variable (used by the dev harness); plugins always resolve under
`~/.multicode/plugins`.

## Capability modules

A capability module extends the app itself — main-process services and IPC,
renderer panels, workspace types, commands, Backlog actions, settings
sections, sidebar nav doors, and modal surfaces (`registerModalSurface`: a
body mounted in the shell's modal shell, floated over whatever the window is
showing, optionally with a `launcher` row in the workspace pane's kind list)
— through the `MainHost` / `RendererHost`
contracts. Modules are trust-gated: only modules the user has trusted execute
code.

- Author against [`@sprintengine/module-sdk`](../../packages/module-sdk/README.md).
- Validate, pack, and sign with the bundled `multicode-module` CLI.
- Install by dropping the folder into `~/.multicode/modules/<id>/`, or from
  **Settings → Modules → "Install a module from a folder"**, then grant trust.
- Permissions are install-time disclosure — see [permissions.md](./permissions.md).

### Creating a workspace from a module

A module's `entry.main` can create workspaces programmatically through the
always-on core, the same flow the UI uses:

```ts
import { WorkspaceServiceToken } from '@sprintengine/module-sdk'

const workspaces = host.requireService(WorkspaceServiceToken)
const result = await workspaces.create({ name: 'Scratch', folderPath: '/abs/path' })
// { ok: true, workspaceId } | { ok: false, code, message }
```

The promise resolves only after the workspace is confirmed on the
workspace-sync bus, so a returned id is always a real workspace.

### Developing a first-party module locally

A handful of module ids are **reserved** (`BUNDLED_MODULE_IDS`): the app
installs one only when its `manifest.json` is signed by a key whose
fingerprint is listed in `resources/marketplace/trusted-publishers.json`. That
is what stops anyone shadowing a first-party module — and it also means a
contributor building the app from source cannot install their own build of
one, because they do not hold the release signing key.

`resources/marketplace/trusted-publishers.dev.json` is the way through. It has
the same shape as `trusted-publishers.json`, it is gitignored, and its
fingerprints are unioned into the trusted set **only when the app is not
packaged** (`src/main/marketplace/trusted-publishers.ts`). A packaged build
never reads it, and neither does the registry verifier
(`npm run verify:marketplace-registry` opens `trusted-publishers.json` by name),
so a dev key can never become a signing authority for anybody else.

```bash
# once
multicode-module keygen --out ~/.config/sprintengine/keys/my-dev.key
# prints: Public key fingerprint: <fingerprint>

cat > resources/marketplace/trusted-publishers.dev.json <<'JSON'
{
  "schemaVersion": 1,
  "publishers": [
    {
      "name": "Multicode Labs",
      "verified": true,
      "publicKey": "<the public key the keygen printed>",
      "fingerprint": "<fingerprint>",
      "scope": "Local development only; never committed."
    }
  ]
}
JSON
```

The `name` must equal the `publisher.name` on the registry entry you are
standing in for. Then sign both the inner module manifest and the bundle
`plugin.json` with that key, install, and restart the app.
### Shipping skills with a module

Skills are not a closed set the app compiles in. A module can carry its own
skill directories and register them at startup:

```ts
host.registerSkills([
  {
    id: 'review-guide',
    sourceDir: 'skills/review-guide',      // relative to the module root
    targetPolicy: 'all-native',            // or 'agents'
    description: 'Walk a human reviewer through a code change.',
  },
])
```

`sourceDir` must stay inside the module root — the host resolves it and
rejects anything that escapes. An `id` a built-in skill or another module
already owns is a registration error, and unloading the module unregisters its
skills.

From then on the skill is a skill: an agent launched with that skill id gets it
copied into the workspace before it starts, `targetPolicy: 'all-native'` fans
it out into every installed CLI's own skill directory (`.claude/skills`,
`.codex/skills`, …) rather than only `.agents/skills`, and the copy carries the
same managed manifest as the app's own skills, so a hand-edited copy is never
overwritten.

To put one in a workspace ahead of time — a skill an agent will be told to
invoke, or one the user should see listed — call
`host.ensureSkillInstalled(workspaceRoot, skillId)`. It never throws and
answers `{ ok, status, message? }`; `status: 'unknown-skill'` means nothing
answers to that id.

### Shipping Python with a module

A module can ship Python packages inside its signed bundle. The host runs them
on the CPython the app already bundles — you never see the interpreter path.
Declare `process:spawn`.

```ts
const sidecar = host.registerSidecar({
  id: 'my-module-mcp',
  kind: 'python',
  python: {
    root: 'python',                 // relative to the module root
    module: 'my_module_mcp',        // python -m
    args: ['--http', '--port', '0'],
    env: { MY_MODULE_USER_ID: 'studio-app' },
  },
  startOn: 'demand',
})
sidecar.onStderr((chunk) => {
  if (chunk.includes('ready')) sidecar.signalReady()
})
await sidecar.start()
await sidecar.ready
```

`python.root` must stay inside the module root, same containment rule as
`registerSkills`. `stop()` and unload kill the child. For a process that
should exit, `host.runPython({ root, script | module, args, cwd, env,
timeoutMs })` returns `{ exitCode, stdout, stderr }`.

### Publishing a module to the marketplace

Folder install (above) is the developer loop. To let other users discover and
install your module from the Extensions door's **Plugins** view, publish it to
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
   (`github.com`, `api.github.com`, `raw.githubusercontent.com`, plus anything
   `SPRINTENGINE_MARKETPLACE_EXTRA_HOSTS` adds). Registry CI runs the same
   verifier the app build runs (`verify:marketplace-registry`). The full
   command walkthrough, including the registry-entry shape, lives in
   [`docs/plugin-authors/README.md`](../plugin-authors/README.md). Registry
   entries reach the app through the published catalogue snapshot — the app's
   bundled index is generated from it, so listing follows the next snapshot
   release rather than the PR merge alone.

What users then see: your module in the Extensions door's **Plugins** view,
carrying a `Module` component chip inside its source and category group (card
copy comes from your module's `displayName` + `summary` — say what it adds:
workspace type, panels, commands), a trust prompt listing the REAL
permissions from your verified manifest at install time, and the module in
Settings → Modules once installed. Signed community bundles install through
that trust prompt; a publisher key fingerprint listed in
`trusted-publishers.json` installs without one; unsigned module bundles are
rejected outright.

## CLI plugins (BYO CLI)

A CLI plugin adds a new agent CLI (claude-code, codex, opencode, your own). It
is **not** a capability module — it is a declarative `plugin.json` describing
how to launch, resume, inject prompts into, and detect completion for a CLI.

- The authoring contract is `CliPluginManifest` in `@sprintengine/module-sdk`;
  `validateCliPluginManifest` is the **same validator the app runs** on load
  (the app imports it from the SDK), so a manifest it accepts will load. The
  SDK type is the launch/resume/detect core; the bundled manifests also carry
  the presentation and installation fields the app's own `PluginManifest`
  models (`summary`, `category`, `icon`, `detect`, `install`, `update`,
  `package`) — read `src/shared/plugin-manifest.ts` for those.
- The bundled CLI plugins under `resources/plugins/` are the worked examples:
  each is a `plugin.json` in the shape a user plugin takes.
- Install by dropping the folder into `~/.multicode/plugins/<id>/`, or from
  **Settings → Agents → "Install a CLI from a folder"**. New plugins are picked
  up immediately on install, on the next launch, or when you press **Re-check
  every CLI now**.

Declarative CLI plugins run no code of their own — they only configure how the
app spawns an external binary you already trust — so they are not gated behind
the module trust prompt. (Executable *provider* adapters, a separate provider
manifest kind — `kind: "provider"`, the shape `resources/plugins/claude-agent`,
`openrouter` and `xai` take — are signature-gated; see
`src/shared/plugin-manifest.ts`.)
