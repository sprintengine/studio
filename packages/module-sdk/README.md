# @multicode/module-sdk

Published contract types for building **Multicode capability modules** — the
manifest and permission shapes, the main-process `MainHost` registration
contract, the renderer `RendererHost` contribution types (panels, workspace
types, Backlog item actions, Backlog link providers, commands, settings
sections, sidebar nav entries), Automations provider registration, and the
module notification payloads.

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

## Support surface (v0.4)

- **Manifest** (`CapabilityManifest`): id, displayName, integer version,
  publisher, category, summary, `defaultEnabled`, `dependsOn`/`conflictsWith`,
  `source: 'third-party'`, `permissions`, `entry`, `signature`.
- **Entries**: `entry.main` (CommonJS, `export registerMain(host)`) runs in the
  main process for **trusted** modules; `entry.renderer` (single-file ESM
  bundle, `export registerRenderer(host)`) loads in the renderer for trusted
  modules. **`entry.preload` is reserved and NOT loaded** — the manifest
  field exists for forward compatibility only.
- **Trust**: only `trusted` modules execute code. Signing is detached ed25519
  over the canonical manifest; trust binds to manifest content (changing the
  manifest voids trust).
- **Permissions are install-time disclosure, not runtime enforcement.** The
  consent UI shows what your module declares; it does not sandbox it. Prefer
  the tiered `ipc:*` scopes when they cover what you touch; `ipc:invoke` is
  the broad scope (flagged as broad to the user) and is also the declared
  gate for `RendererHost.invoke` — the one surface where the host actually
  checks the declaration. Declare it if and only if your module uses the
  bridge or genuinely needs the broad legacy surface.
- **Main host**: `registerIpc` (channel ownership enforced), service tokens,
  startup/shutdown hooks, `registerSidecar`, `notify(severity, title,
  body?)` (identity stamped by the host, per-module flood-bounded), and
  `registerMcpTools(tools)` — agent-facing MCP tools on the always-on Studio
  gateway, owned by your module's id with duplicate-name rejection. Tool
  availability follows your module's enablement live: a disabled module's
  tools stay listed and answer an actionable enable error instead of running.
  Declare `ipc:agents`.
- **Renderer host**: `registerPanel`, `registerWorkspaceType` (workspace
  types may now ship `supervisors` — render-nothing background components
  the shell mounts while your module is enabled, inside a crash boundary and
  a display:none host — `deriveRunGlyph`, the sidebar status slot:
  `{ state, live, label }` from the stable `WorkspaceRunGlyphState` subset —
  and `creationStep`, one module-owned config page in the workspace-creation
  hub: `{ id, heading, description?, Component, isReady?, blockedHint? }`,
  where `Component` receives `{ value, setValue }`, `isReady(value)` gates
  the Create button with `blockedHint` as the footer hint, and the collected
  value arrives in `createTemplate(context?: { stepValue?: unknown })`; the
  shell holds the value for the pane's lifetime only and persists nothing —
  a throwing step component degrades to your type's zero-config create with
  an inline notice, never a blocked hub, and `createWorkspace(request, host)`,
  the async create hook for a type whose creation is orchestration rather than
  a layout choice: resolve to mean "created, close the hub", reject to leave it
  open; `host.createWorkspace()` mints the row and `host.removeWorkspace(id)`
  takes it back, so a create that fails after minting leaves nothing behind,
  and `request.setStepValue` is where the failure goes — your step owns that
  page's body. Absent ⇒ the hub creates from `createTemplate` directly),
  `registerBacklogItemAction`, `registerBacklogLinkProvider`,
  `registerCommand` (registered id is namespaced `<moduleId>.<id>`; scope
  `panel:<moduleId>` activates while a workspace of your module's mode is
  active, and `availability` accepts a predicate over the published
  `ModuleCommandContext` view; panel-targeted dispatch is a
  `multicode:panel-command` CustomEvent from your `run()`),
  `registerSettingsSection` (values persist in the module's own
  `module:<id>` settings namespace), `registerSidebarNavEntry` (an
  instance-level door in the workspace sidebar's top-nav cluster — a
  `SidebarNavEntryDefinition` of `{ id, order, Component }`; the door shows
  only while your module is enabled and sits at its `order`, so the module
  toggle adds/removes it without a reload, and the row acts on the local
  window's store), `registerGlobalSurface` (the full-page surface behind
  that door — a `GlobalSurfaceDefinition` of `{ id, Component }` whose `id`
  matches the one the nav entry opens; a global surface is a first-class,
  instance-global extension point needing no workspace type, panel, or
  project scope, and its zero-prop `Component` may be eager or
  `React.lazy()`; while your module is uninstalled or disabled the shell
  shows an explicit "not installed" door in its place and keeps the user's
  spot, and an id already claimed by another module is reported as a module
  load error), `registerTopBarItem` (a control in the app's top-bar
  title-strip cluster — a `TopBarItemDefinition` of `{ id, order, Component }`;
  the zero-prop `Component` owns its full behavior and may be eager or
  `React.lazy()`, the bar shows it only while your module is enabled and
  orders contributed items by `order`, and the top bar is dense: contribute
  one compact control, not a cluster), `invoke` (call your own
  `entry.main`'s `registerIpc` channels; see below), and the Backlog read
  API — `listBacklogItems(workspaceId)` / `watchBacklogItems(workspaceId, cb)`
  return `BacklogItemView`s from the same scan the Backlog panel uses (watch
  fires with the current snapshot, then on change; declare `backlog.read`;
  both fail with a named cause when the backlog module is disabled), and
  `getWorkspace(workspaceId)` — the workspace's read-only
  `ModuleWorkspaceView` (`{ id, name, folderPath, mode }`; unknown ids
  resolve `null`, never a throw; declare `ipc:workspace-read`; the
  `entry.main` twin is `WorkspaceContextToken`), and the live runtime
  surfaces — `getWorkingRoot` (the *effective working root*: the worktree a
  worktree-backed workspace does live work under, else the primary checkout;
  the methods below resolve workspace-relative paths against it; declare
  `ipc:workspace-read`), `watchAgentSessions` (read-only session views,
  snapshot + deduped changes), `spawnAgent` (through the app's shared
  session runtime, structured failures), `focusTab` (agent or
  workspace-relative file tab), `listAgentRuntimes` (ids + labels from the
  availability-filtered catalog), and `watchWorkspaceFile` (debounced
  content watch; declare `ipc:agents` / `filesystem:read-workspace`
  respectively — each fails with a named cause when the Agent Runtime
  module is disabled), and per-module workspace state —
  `getWorkspaceModuleState<T>(workspaceId)` /
  `setWorkspaceModuleState(workspaceId, state)`, your module's own durable
  entry on the workspace (persisted with the workspace, synced across
  windows, scoped to your module by the host; keep entries
  JSON-serializable; read resolves `undefined` and write reports `false`
  when the workspace is unknown or the shell hasn't wired workspace state
  yet — retry later, never treat either as a deletion signal; declare
  `storage`), and app-level module state —
  `getModuleAppState<T>(key)` / `setModuleAppState(key, value)` /
  `watchModuleAppState(cb)`, the scope above the per-workspace bag, for what
  belongs to your module rather than to a single workspace (remembered
  defaults, the last thing the user opened). Renderer-side and synchronous on
  purpose: these are read inside render, and routing them through the
  `entry.main` storage service would change render timing. Persists with app
  settings, survives a disable/enable cycle, shares a keyspace with your
  Settings section's values, and pairs with `useSyncExternalStore` for a
  reactive read; declare `storage`. Plus `subscribe(topic, cb)` — the receiving
  end of `MainHost.emit`, scoped to your module, with no replay (see below) —
  and `registerAgentIdNamespace({ prefix, label })`, which claims every agent id
  starting with `prefix` for your module and names what the shell calls those
  sessions where no workspace claims them; a prefix overlapping another
  module's is a registration error, and resolution is gated on your module's
  live enablement (declare `ipc:agents`).
- **Module events (main → renderer)**: `MainHost.emit(topic, payload?)` pushes
  to your own `RendererHost.subscribe(topic, cb)` — the subscribe verb
  `invoke` does not have. Identity is stamped from the emitting host's scope,
  so only your module's subscribers receive it. One emit reaches every open
  window, ordering is FIFO per module, and **nothing is replayed**: an event
  emitted with no window open is dropped and a window opened later sees nothing
  earlier, so keep the durable answer readable through an IPC channel and let
  the event say "read it again". Unlike `notify`, emission is not flood-bounded
  — dropping an event would make a subscriber wrong. Delivery pauses while your
  module is disabled and resumes on re-enable; call the returned unsubscriber
  on unmount. Payloads cross IPC and must be structured-cloneable.
- **Automations providers**: `registerAutomationTrigger` and
  `registerAutomationAction` register trusted module providers with the
  Automations registry using the current `host.moduleId`. Declare
  `dependsOn: ['automations']` so the registry service exists before your
  `entry.main` runs.
- **Module storage**: `getModuleStorage(host)` → scoped
  `get`/`set`/`delete`/`list`, keyed per module and (optionally) per
  workspace. The host owns file placement — workspace-scoped keys under the
  workspace's `.multi-code/modules/<moduleId>/`, global keys under per-user
  app data — so modules stop hand-rolling home-dir files or raw
  localStorage. JSON values (1 MB cap), locked-down keys, atomic writes.
  Declare the `storage` permission and `dependsOn: ['agent-runtime']` (or a
  chain reaching it) so your `entry.main` registers after the provider;
  renderer panels reach storage through the module's own `host.invoke`
  channels.
- **React**: panels, icons, and settings sections are React components. The
  app provides React at runtime; compile against `@types/react` 18 (declared
  as an optional peer dependency) and bundle your renderer entry as ESM with
  React marked external.

## Intentional narrowings

These app capabilities exist but are not in the published surface; the drift
guard verifies the narrowings stay *sound* (an SDK-typed module is always
valid for the app):

- `WorkspacePanelProps` exposes `workspaceId` only (the app may pass extra
  shell-internal props such as future-plan hooks).
- `WorkspaceTypeDefinition.deriveRunGlyph` receives a minimal
  `{ mode }` view (the app passes a richer internal shape) and returns states
  from the published `WorkspaceRunGlyphState` subset (the shell's own
  vocabulary is wider and keeps growing); `isRunGlyphProviderForWorkspace` is
  not published — a module's provider always matches its own mode, and the
  mode's own provider wins the dispatch.
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

## Calling your entry.main from the renderer

`MainHost.registerIpc` and `RendererHost.invoke` pair up: your `entry.main`
registers a channel (with Node access), and your renderer code — a panel, a
command handler, a Backlog action — calls it:

```ts
// entry.main
export const registerMain: RegisterMain = (host) => {
  host.registerIpc('my-module:save-events', async (_event, payload) => {
    // Node APIs available here (fs, etc.)
    return { saved: true }
  })
}

// entry.renderer (panel or command code)
const result = await host.invoke('my-module:save-events', { events })
```

The channel must start with `<moduleId>:` — your own module id. The host
routes an invoke only when the channel is registered via `registerIpc`, is
prefixed with its owning module's id, the owner is a third-party module, and
the owner's manifest declares the `ipc:invoke` permission. A refused invoke
rejects with an Error whose `code` property is a `ModuleBridgeRefusalCode`
(`unknown_channel` | `not_bridgeable` | `permission_missing`), so your code
can branch on the refusal kind instead of parsing the message.

**This bridge is a contract, not a security boundary.** All renderer code runs
in one shared world; the bridge does not isolate modules from each other or
from the app. Trust gating — only `trusted` modules execute at all — remains
the actual boundary.

## Accepting drags from the Backlog and Files panels

Backlog rows and Files-tree entries put a published payload on their drags
under `MULTICODE_FILE_DROP_MIME`. `readFileDropPayload` is the safe reader:
it returns `null` — never throws — for a missing entry, unparseable JSON, an
invalid shape, or an unknown `version` (only `version: 1` exists today;
future versions parse to `null`, so always handle it). A Backlog-item drag
carries the item's markdown file path in `files[0].path`. `setFileDropData`
originates a drag the app's own drop targets (agent terminals) accept, and
`hasFileDropData` is the `dragover`-safe presence check (the DnD protected
mode blanks `getData` until the drop, so gate `preventDefault` on it).

```ts
import { readFileDropPayload, setFileDropData } from '@multicode/module-sdk'

onDrop={(event) => {
  const payload = readFileDropPayload(event.dataTransfer)
  if (payload) schedule(payload.files[0].path, payload.rootPath)
}}
```

The contract is drift-guarded: the repo gate fails if the app's MIME, payload
shape, or parse semantics ever diverge from this package.

## Theme tokens

`THEME_TOKENS` (with the `ThemeToken` string-literal union) lists the theme
CSS custom properties guaranteed present in every app theme — a repo gate
verifies each one per theme. Consume them as CSS variables, via Tailwind
arbitrary values (`bg-[var(--bg-surface)]`) or plain `var()`. Only the names
are contract: values differ per theme and are retuned freely, so never read
or cache resolved values in JS, and never hard-code a hex.

| Family | Tokens | Use for |
|---|---|---|
| Chrome | `--bg-app`, `--bg-surface`, `--bg-surface-raised`, `--bg-hover`, `--bg-selected` | Window, panels/cards, raised controls, hover and selection fills |
| Border | `--border-subtle`, `--border-default`, `--border-strong` | Hairlines, control outlines, emphasized edges |
| Text | `--text-strong`, `--text-default`, `--text-muted`, `--text-subtle`, `--text-disabled`, `--text-on-accent` | Headings → body → secondary → hints → disabled; text on accent fills |
| Accent | `--accent-primary`, `--accent-primary-soft`, `--focus-ring` | Primary actions/selection, soft accent fills; `--focus-ring` is a full box-shadow value |
| Tone | `--tone-neutral`, `--tone-accent`, `--tone-warn`, `--tone-good`, `--tone-error`, `--tone-merged` | Semantic status: idle/neutral, active/info, caution, success, failure, merged/PR-purple |

## Programmatic workspace creation

A module's `entry.main` can create a workspace through the always-on app core,
the same operation the UI performs:

```ts
import { WorkspaceServiceToken, type RegisterMain } from '@multicode/module-sdk'

export const registerMain: RegisterMain = (host) => {
  host.registerIpc('my-module:new-scratch', async () => {
    const workspaces = host.requireService(WorkspaceServiceToken)
    const result = await workspaces.create({ name: 'Scratch', folderPath: '/abs/path' })
    return result // { ok: true, workspaceId } | { ok: false, code, message }
  })
}
```

`create` resolves only after the new workspace is observed on the workspace-sync
bus, so the returned id is always a real, confirmed workspace (or an explicit
failure). The service is provided by the always-on `agent-runtime` core, so
`requireService` never throws for it.

To resolve an existing workspace id to its folder root, name, and mode —
per-workspace persistence paths, scoped Automations `workspaceRoot`s — use the
read-only workspace context (also always-on; declare `ipc:workspace-read`):

```ts
import { WorkspaceContextToken } from '@multicode/module-sdk'

const workspaces = host.requireService(WorkspaceContextToken)
const view = await workspaces.get(workspaceId)
// { id, name, folderPath, mode } | null — unknown ids are null, never a throw
```

Renderer panels get the same view from `host.getWorkspace(workspaceId)` (a
snapshot read, not a subscription — live state is a separate surface).

## Creating automations from a module

Beyond registering trigger/action *kinds* (below), a module's `entry.main` can
create and manage real automation *records* — its own only — through the
scoped Automations service. Declare the `automations.manage` permission
(install-time disclosure) and `dependsOn: ['automations']`:

```ts
import { getAutomationsService, type RegisterMain } from '@multicode/module-sdk'

export const registerMain: RegisterMain = (host) => {
  host.registerIpc('my-module:schedule-digest', async (_event, workspaceRoot: unknown) => {
    const automations = getAutomationsService(host)
    const created = await automations.create({
      workspaceRoot: workspaceRoot as string,
      draft: {
        name: 'Daily digest',
        status: 'enabled',
        // Cadences: interval, daily, weekly, or the one-shot
        // { type: 'at', datetime: '2026-07-09T09:30' } — local wall-clock in
        // `timezone`, fires once, then the automation shows no upcoming run.
        trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '09:00' }, timezone: 'UTC' } },
        action: { kind: 'my-module.build-digest', config: {} },
      },
    })
    return created // { ok: true, automation } | { ok: false, code, message }
  })
  const off = getAutomationsService(host).onRunEvent((event) => {
    // Only events for automations this module owns.
  })
  host.onShutdown(() => off())
}
```

Every method is pre-scoped to your module: `create` stamps `ownerModuleId`
(the Automations panel shows a "via <module>" attribution), `list` returns
only your records, and `update`/`delete`/`listRuns` refuse records you do not
own — including the user's (`not_owner`). The user outranks your module: they
can edit or delete module-created automations from the panel.

## Automations provider registration

A trusted module's `entry.main` can contribute an Automations trigger or action
provider. Provider ids are namespaced by the registering module id inside
Multicode, while `providers:list` still exposes the provider's declared `kind`
to the editor form.

```ts
import {
  registerAutomationAction,
  type AutomationActionProvider,
  type CapabilityManifest,
  type RegisterMain,
} from '@multicode/module-sdk'

export const manifest: CapabilityManifest = {
  id: 'weather-deck',
  displayName: 'Weather Deck',
  version: 1,
  defaultEnabled: true,
  source: 'third-party',
  dependsOn: ['automations'],
  entry: { main: 'dist/main.cjs' },
}

const refreshForecast: AutomationActionProvider = {
  kind: 'weather-deck.refresh-forecast',
  configSchema: { type: 'object' },
  run: async (_config, context) => {
    context.reportProgress({ summary: 'Refreshing forecast.' })
    return { status: 'completed', summary: 'Forecast refreshed.' }
  },
}

export const registerMain: RegisterMain = (host) => {
  registerAutomationAction(host, refreshForecast)
}
```

Automations provider code only runs from trusted modules, under the same
third-party module trust gate as other `entry.main` code. `run-command` remains
unavailable in the app-active executor until Multicode ships that capability.
The lower-level registry service token is intentionally not exported; use the
helper functions so provider ownership is always stamped from the host.

## BYO-CLI plugins (adding an agent CLI)

A **CLI plugin** is a different artifact from a capability module: a folder
containing a `plugin.json` that teaches Multicode how to launch, resume, drive,
and detect completion for a new agent CLI (claude-code, codex, opencode, and
your own). Drop it into `~/.multicode/plugins/<id>/`, or install it from
**Settings → Agents → "Install CLI from folder"**. The plugin id must equal the
folder name; a user plugin with a bundled CLI's id overrides the bundled one.

Author and pre-flight validate against the published contract:

```ts
import { validateCliPluginManifest, type CliPluginManifest } from '@multicode/module-sdk'

const result = validateCliPluginManifest(JSON.parse(pluginJson))
if (!result.ok) console.error(result.issues) // [{ path, message }, …]
```

`validateCliPluginManifest` is pure (no Node/DOM) and is **the same validator the
Multicode app runs** when it loads a `plugin.json` (the app imports it from this
package), so a manifest it accepts is loadable by Multicode — the authoring
contract and the loader cannot drift. The bundled manifests under
`resources/plugins/` in the app repository are worked `plugin.json` examples.

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

## License

MIT — see [`LICENSE`](./LICENSE). You are free to build modules against this
SDK and to distribute or sell those modules, including closed-source. The MIT
license covers this SDK package only; it does not grant rights to the Multicode
application itself, and it does not by itself govern distribution through any
Multicode marketplace (that is covered by separate marketplace terms).
