# @sprintengine/module-sdk

Published contract types for building **SprintEngine Studio capability
modules** — the manifest and permission shapes, the main-process `MainHost`
registration contract, the renderer `RendererHost` contribution types (panels,
workspace types, Backlog item actions, Backlog link providers, commands,
settings sections, sidebar nav entries), Automations provider registration, and
the module notification payloads.

The package is types-first: it ships type declarations plus a handful of small
mirrored values (`BUNDLED_MODULE_IDS`, `KNOWN_CAPABILITY_PERMISSIONS`,
`createServiceToken`). It has no runtime dependency on Electron or on the
application's own code, so an external project can compile a module against the
tarball alone.

## Renamed in 0.6.0

This package was `@multicode/module-sdk` up to and including `0.5.0`. Change
every import to `@sprintengine/module-sdk` — root, `/ui`, `/surface` and
`/signing` — and the matching `--external:` flags in your bundler. Nothing else
moved: the types, the export names and the runtime contract are identical, so
the rename is a find-and-replace and not a migration. A bundle you already
built against the old specifiers still loads, because the host's import map
answers both names.

## Versioning

Semver, starting at `0.1.0`. See `CHANGELOG.md`. Inside the studio
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
  startup/shutdown hooks, `registerSidecar` (including host-owned `kind:
  'python'` sidecars — see "Python the host runs"), `runPython`,
  `registerLaunchContribution` (per-spawn env, PATH shims, shell functions,
  managed-MCP entries, host-context sections and a session lifetime tag — see
  "Launch contributions"), `notify(severity, title, body?)` (identity stamped
  by the host, per-module flood-bounded), and `registerMcpTools(tools)` —
  agent-facing MCP tools on the always-on Studio gateway, owned by your
  module's id with duplicate-name rejection. Tool availability follows your
  module's enablement live: a disabled module's tools stay listed and answer
  an actionable enable error instead of running. Declare `ipc:agents`. Skills
  your module ships ride the same
  ownership discipline through `registerSkills(skills)`, and
  `ensureSkillInstalled(workspaceRoot, skillId)` puts one in a workspace on
  demand — see "Skills a module ships".
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
  load error), `registerModalSurface` (a body the shell mounts in its modal
  shell, floated over whatever the window is showing — for a pick-and-close
  task over work that stays put. The shell draws no trigger for it unless you
  declare `launcher: { label, letter, Glyph }`, which puts your row in the
  workspace pane's kind list beside Browser, Terminal and Diff; `letter` must
  be exactly one character and the shell's own kinds win a collision, in which
  case your row keeps its label and glyph and has no shortcut. Your body is
  handed `{ workspaceId }` — the workspace its opener acted from, which for a
  pane row is the workspace it was picked in), `registerTopBarItem` (a control in the app's top-bar
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
  `entry.main` twin is `WorkspaceContextToken`) with
  `listWorkspaces()` / `watchWorkspaces(cb)` beside it for a surface that is
  not mounted inside one workspace (same view shape, same permission; the
  watch fires once with the current list, then on change), and
  `watchColorScheme(cb)` — the app's resolved `'light' | 'dark'`, immediately
  and on every change, for a themed runtime you host (Monaco, a chart
  library); ordinary UI reads `THEME_TOKENS` instead — and the live runtime
  surfaces — `getWorkingRoot` (the *effective working root*: the worktree a
  worktree-backed workspace does live work under, else the primary checkout;
  the methods below resolve workspace-relative paths against it; declare
  `ipc:workspace-read`), `watchAgentSessions` (read-only session views,
  snapshot + deduped changes; a workspace id watches that workspace,
  `undefined` watches every workspace narrowed to the agent-id namespaces
  you claimed — claim none and it reports nothing), `spawnAgent` (through the
  app's shared session runtime, structured failures), `focusTab` (agent or
  workspace-relative file tab), `listAgentRuntimes` (`{ id, label, available,
  models, isDefault }` from the availability-filtered catalog the shell's own
  pickers read), and `watchWorkspaceFile` (debounced
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
  workspace's `.sprintengine/modules/<moduleId>/`, global keys under per-user
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
import type { CapabilityManifest, RegisterMain, RegisterRenderer } from '@sprintengine/module-sdk'
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
import { readFileDropPayload, setFileDropData } from '@sprintengine/module-sdk'

onDrop={(event) => {
  const payload = readFileDropPayload(event.dataTransfer)
  if (payload) schedule(payload.files[0].path, payload.rootPath)
}}
```

The contract is drift-guarded: the repo gate fails if the app's MIME, payload
shape, or parse semantics ever diverge from this package.

## Skills a module ships

A skill is a directory with a `SKILL.md` (plus any harness sidecars, e.g.
`agents/openai.yaml`). Ship yours inside your module and hand them to the host:

```ts
export function registerMain(host: MainHost): void {
  host.registerSkills([
    {
      id: 'review-guide',
      sourceDir: 'skills/review-guide',
      targetPolicy: 'all-native',
      description: 'Walk a human reviewer through a code change.',
    },
  ])
}
```

`sourceDir` is relative to your module root and must stay inside it — the host
resolves it and rejects a path that escapes. Registration is owned exactly as
IPC channels and MCP tools are: an `id` a built-in skill or another module
already holds throws, the whole batch is validated before one skill of it
lands, and unloading your module takes its skills with it.

`targetPolicy` decides where the skill is copied in a workspace:

| policy | lands in |
| --- | --- |
| `'agents'` | `.agents/skills/<id>` — the harness-neutral directory |
| `'all-native'` | that, plus every installed CLI's own skill directory (`.claude/skills`, `.codex/skills`, …) |

Pick `'all-native'` whenever a prompt invokes the skill by name: a CLI resolves
an invocation only against its own directory.

A registered skill is a skill. The host installs it check-first — an
already-installed workspace is not rewritten, a stale copy is refreshed, and a
copy the user edited by hand is left alone — and stamps it with the same
managed manifest the app's own skills carry.

To put a skill in a workspace before an agent needs it:

```ts
const result = await host.ensureSkillInstalled(projectRoot, 'studio-review')
if (!result.ok) console.warn(`skill not installed: ${result.status}`)
```

It never throws. `ok: false` with `status: 'unknown-skill'` means nothing
answers to that id — usually a rename, or a module that failed to load;
`'local'` and `'modified'` mean a hand-made copy is in the way and was left
alone (both still report `ok: true`, because the skill IS present).

## Python the host runs

A module can ship Python packages inside its signed bundle and have the host
run them on the CPython the app already bundles. You never see the interpreter
path — that is the host's, so a missing user Python cannot silently take over.
Third-party modules must declare `process:spawn`; the host checks it at
`registerSidecar({ kind: 'python' })` and `runPython` and refuses a module
that omitted it. Bundled first-party modules have no permissions list — they
already run as the app — so that check is skipped for them.

**Sidecar** (`kind: 'python'`). The host owns the process: it containment-checks
`python.root` (the same rule as `registerSkills` — relative to your module
root, or an absolute path when the module has no root), prepends that directory
to `PYTHONPATH`, and spawns `python -m <module>`. `startOn: 'demand'` leaves
starting to you via the returned handle; the default starts at app startup.
`stop()` and unload kill the child.

```ts
export function registerMain(host: MainHost): void {
  const sidecar = host.registerSidecar({
    id: 'weather-deck-mcp',
    kind: 'python',
    python: {
      root: 'python',
      module: 'weather_deck_mcp',
      args: ['--http', '--port', '0'],
      env: { WEATHER_DECK_USER_ID: 'studio-app' },
    },
    startOn: 'demand',
  })
  sidecar.onStderr((chunk) => {
    if (chunk.includes('ready')) sidecar.signalReady()
  })
  void sidecar.start().then(() => sidecar.ready)
}
```

The handle also exposes `pid`, `onStdout` / `onStderr` chunk callbacks, and
`onExit`. Extra env on `start({ env })` is merged for that start only — a
per-start token belongs there, not in the spec. `kind: 'process'` is still a
declaration (or a first-party lifecycle); it is how non-Python daemons
register.

**One-shot.** `runPython` is the same interpreter and the same `root`
containment for a process that should exit:

```ts
const { exitCode, stdout, stderr } = await host.runPython({
  root: 'python',
  script: 'scripts/forecast.py',
  args: ['--city', 'Dublin'],
  timeoutMs: 15_000,
})
```

Exactly one of `script` or `module`. `script` is resolved inside `root` and
refused if it escapes.

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
| Motion | `--motion-normal`, `--motion-ease` | The app's standard transition duration and easing — use them as a pair (`transition: opacity var(--motion-normal) var(--motion-ease)`) so module UI moves at the app's pace |

## UI kit, surface shell and Monaco

Three of the app's own runtime pieces are bridged to modules, so a module-owned
door looks and behaves like a bundled one instead of re-implementing chrome a
shade off:

| Specifier | What it is |
|---|---|
| `@sprintengine/module-sdk/ui` | A curated slice of the app's component kit |
| `@sprintengine/module-sdk/surface` | The door shell and its rail/canvas substrate |
| `@monaco-editor/react` | The Monaco React wrapper the app already ships |

**They are host-provided.** This package ships only their TYPES; the `.js`
behind `./ui` and `./surface` is a stub that throws
`"@sprintengine/module-sdk/ui is provided by the host at runtime; mark it external
in your bundler"` the moment it is evaluated. The app installs an import map
before it evaluates your `entry.renderer` bundle and answers all three
specifiers (plus `react`, `react-dom`, `react-dom/client`,
`react/jsx-runtime`) with its own live instances — which is also why there is
exactly one React, one Monaco and one copy of the kit in the process.

So every one of them must be marked external:

```
esbuild src/renderer.tsx --bundle --format=esm --outfile=dist/renderer.mjs \
  --external:react --external:react-dom --external:react-dom/client \
  --external:react/jsx-runtime \
  --external:@monaco-editor/react \
  --external:@sprintengine/module-sdk/ui \
  --external:@sprintengine/module-sdk/surface
```

Keep `moduleResolution: "bundler"` (or `node16`) in your tsconfig so the
subpath `exports` are honoured. Bundling one of these in by mistake fails
loudly at load with the message above, never silently with a second React.

### `@sprintengine/module-sdk/ui`

`GhostButton`, `OutlineButton`, `PrimaryButton`, `Banner`, `PanelHeader`, `Drawer`,
`EmptyState`, `Field`, `Input`, `Textarea`, `InlineNotice`, `KbdChord`,
`LifecycleGlyph`, `LinkButton`, `RowButton`, `Section`, `SegmentedControl`,
`Select`, `Spinner`, `StatusDot`, `TruncatedText`, `CliModelPickerButton`, and
the `FOCUS_RING_CLASS` string for any focusable you draw yourself. Props are
published for each, alongside the shared vocabulary they are written in:
`Tone`, `StatusTone`, `LifecycleState`, `SelectItem`, `SegmentedControlItem`,
`FilterMenuGroup`, `CliRuntimeOption`.

The list is deliberately short and deliberately frozen: it is a versioned
contract, pinned against the app's own components by a drift guard in both
directions. A component you want that is not here is cheaper copied into your
module than frozen here forever.

### `@sprintengine/module-sdk/surface`

`GlobalSurfaceShell` — the door frame: title bar, actions slot, back
affordance, rail gutter, attention strip. `useSurfaceBackNav()` wires its back
control to the host's surface history. `SurfaceRail` is the list column every
bundled door uses (rows, groups, search, filter, scope, a new-affordance), and
`SurfaceCanvasState` is the one loading / empty / error canvas. Types:
`GlobalSurfaceBar`, `GlobalSurfaceShellProps`, `SurfaceCanvasStateProps`,
`SurfaceRailRow`, `SurfaceRailGroup`, `SurfaceRailSearch`,
`SurfaceRailFilter`, `SurfaceRailScope`, `SurfaceRailNewAffordance`,
`SurfaceRailProps`.

### `@monaco-editor/react`

Import `Editor` / `DiffEditor` as usual and declare `@monaco-editor/react` a
dependency for types; the host answers the specifier at runtime, so your bundle
carries no editor. Drive its theme from `host.watchColorScheme(scheme => …)`
rather than reading the app's CSS — the tokens are contract, the theme name
Monaco wants is not.

### Tailwind classes produce no CSS unless you ship it

The bridged components arrive fully styled — they were compiled by the app's
own Tailwind build, and the design tokens they reference
(`var(--bg-surface)`, …) come from the host stylesheet.

**Utility classes YOU write do not.** The app's Tailwind build scans app
source only, so a `flex gap-2 text-meta` first used inside your module compiles
to nothing at all and renders as unstyled markup. Either write plain CSS /
inline styles against the theme tokens above, or ship your own utilities-only
stylesheet and inject it. The second is a few lines:

```css
/* tailwind.css */
@import "tailwindcss/utilities" layer(utilities);
@source "./src";
/* plus a copy of the @theme block for any custom scale you use */
```

```
npx @tailwindcss/cli -i tailwind.css -o src/styles/utilities.css --minify
```

Then inject the built CSS text through a single `<style>` element when your
renderer entry registers. Utilities-only keeps it small and keeps it from
fighting the host's preflight, which has already run.

## Programmatic workspace creation

A module's `entry.main` can create a workspace through the always-on app core,
the same operation the UI performs:

```ts
import { WorkspaceServiceToken, type RegisterMain } from '@sprintengine/module-sdk'

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
import { WorkspaceContextToken } from '@sprintengine/module-sdk'

const workspaces = host.requireService(WorkspaceContextToken)
const view = await workspaces.get(workspaceId)
// { id, name, folderPath, mode } | null — unknown ids are null, never a throw
```

Renderer panels get the same view from `host.getWorkspace(workspaceId)` (a
snapshot read, not a subscription — live state is a separate surface).

`list()` on the same service enumerates every open workspace — the main-side
twin of `RendererHost.listWorkspaces`, and how an MCP tool your module
contributes answers "which project roots are open" with no window in sight.

## Launch contributions

Every agent spawn (and every plain-shell pane) asks registered modules what to
put on that launch. Declare `ipc:agents` and register a function of the launch
request; the host calls every contribution in module registration order, merges
the results, and never lets a throw fail the spawn — a failing contribution is
recorded as a module diagnostic and skipped.

```ts
import type { RegisterMain } from '@sprintengine/module-sdk'

export const registerMain: RegisterMain = (host) => {
  host.registerLaunchContribution((launch) => ({
    env: { MY_MODULE_ROOT: launch.workspaceRoot },
    pathEntries: ['/Users/dev/my-module/bin'],
    shellFunctions: [
      'mymodule() { command my-module "$@"; }',
      'export -f mymodule >/dev/null 2>&1 || true',
    ],
    hostContext: [{ heading: 'My module', body: 'Standing instruction for this agent.' }],
    session: { managed: false },
    identityKeys: ['MY_MODULE_AGENT_ID'],
  }))
}
```

- **`env`** is merged after the host's own session env and before the CLI
  manifest's `launch.env`. Protected identity keys (`TERM`, the agent-identity
  vars, `FORCE_HYPERLINK`) cannot be overwritten. `identityKeys` are stripped
  from inherited env first, so a stale value from the process that launched
  Studio cannot leak into a spawn that did not set its own.
- **`pathEntries`** are directories you own (typically under module storage)
  prepended to `PATH`. Write your own shims there; the host does not write them.
- **`shellFunctions`** are POSIX function definitions appended to the login
  shell bootstrap. They are unused on a native Windows PTY.
- **`mcpServers`** are managed MCP config entries in the shape the host already
  syncs into a workspace CLI config.
- **`hostContext`** sections are appended to the host-context document after the
  design-system and Knowledge Graph sections, and ride whatever channel the CLI
  manifest declares (`contextInjection`), so a standing instruction survives
  resume like the rest of the document.
- **`session.managed`** tags the terminal as module-owned for the idle reaper
  (excluded from the recency floor that protects the user's own agents).
  `session.reapExempt` holds it out of the reaper entirely.

A module that is disabled or not installed contributes nothing, so a plain
launch is byte-identical to a launch in a build with no modules.

## Agent sessions (main)

A module can own an agent TERMINAL: an ordinary agent tab, in the workspace your
surface was opened from, under the CLI and permission preset the user chose,
with a skill attached at spawn. Declare `agents:session` (checked on every call)
and `dependsOn: ['agent-runtime']`.

```ts
import { getAgentSessionService, type RegisterMain } from '@sprintengine/module-sdk'

export const registerMain: RegisterMain = (host) => {
  const agents = getAgentSessionService(host)

  host.registerIpc('my-module:start-guide', async ({ workspaceId, projectRoot, docId }) => {
    const started = await agents.spawn({
      workspaceId,               // required: where the agent lives
      cwd: projectRoot,          // absolute
      prompt: 'Walk me through this change.',
      skill: { id: 'my-guide' }, // installed before the CLI starts
      agentIdPrefix: 'my-guide-', // a namespace you registered
      agentIdKey: docId,
      label: 'My guide',
      role: 'my-guide',
    })
    if (!started.ok) return started // unknown_workspace | missing_cwd | unknown_skill | …
    // Lead the prompt with the CLI's own invocation when it has one:
    // started.skillInvocation === '/my-guide' on Claude, undefined elsewhere.
    return started
  })
}
```

- **One agent per key.** `spawn` matches on `${agentIdPrefix}${agentIdKey}`: a
  live session under that id takes the prompt and comes back `reused: true`
  (pass `reuseLive: false` to insist on a fresh one), and a dead or suspended
  one is disposed before the replacement starts. The terminal session id is
  minted per spawn and is never the agent id.
- **Follow-ups and endings.** `send(sessionId, text)` delivers one submitted
  turn through the app's serialized control plane. `kill(sessionId)` ends it.
  `setReapExempt(sessionId, true)` holds a working agent out of the idle
  reaper — the host clears the exemption when that session exits, so an
  unbalanced call cannot strand a process. `onExit(cb)` reports the exits of
  agents you own; `list()` returns them.
- **Scope.** Everything here is filtered by the agent-id namespaces your module
  registered. You cannot see, prompt, or stop another module's agents, or the
  user's own. (Today main holds no mirror of the renderer's namespace registry;
  see the CHANGELOG for what that limits.)

## Creating automations from a module

Beyond registering trigger/action *kinds* (below), a module's `entry.main` can
create and manage real automation *records* — its own only — through the
scoped Automations service. Declare the `automations.manage` permission
(install-time disclosure) and `dependsOn: ['automations']`:

```ts
import { getAutomationsService, type RegisterMain } from '@sprintengine/module-sdk'

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
the studio, while `providers:list` still exposes the provider's declared `kind`
to the editor form.

Declare `label`, `glyph` and `summary` so the Automations panel can name the
kind without the host hard-coding your copy. `glyph` is one of
`AUTOMATION_PROVIDER_GLYPHS` (`agent`, `loop`, `board`, `clock`); omitted
falls back to the clock. A trigger that must not ping-pong with a companion
action declares `pairsWith: { actionKind, defaultDisableAfterRun: true }` —
the write path applies that default when the pair is written together and
`disableAfterRun` is left unspecified.

```ts
import {
  registerAutomationAction,
  type AutomationActionProvider,
  type CapabilityManifest,
  type RegisterMain,
} from '@sprintengine/module-sdk'

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
  label: 'Refresh forecast',
  glyph: 'clock',
  summary: 'Pull the latest forecast for the watched city',
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
unavailable in the app-active executor until the studio ships that capability.
The lower-level registry service token is intentionally not exported; use the
helper functions so provider ownership is always stamped from the host.

## BYO-CLI plugins (adding an agent CLI)

A **CLI plugin** is a different artifact from a capability module: a folder
containing a `plugin.json` that teaches the studio how to launch, resume, drive,
and detect completion for a new agent CLI (claude-code, codex, opencode, and
your own). Drop it into `~/.multicode/plugins/<id>/`, or install it from
**Settings → Agents → "Install CLI from folder"**. The plugin id must equal the
folder name; a user plugin with a bundled CLI's id overrides the bundled one.

Author and pre-flight validate against the published contract:

```ts
import { validateCliPluginManifest, type CliPluginManifest } from '@sprintengine/module-sdk'

const result = validateCliPluginManifest(JSON.parse(pluginJson))
if (!result.ok) console.error(result.issues) // [{ path, message }, …]
```

`validateCliPluginManifest` is pure (no Node/DOM) and is **the same validator the
studio runs** when it loads a `plugin.json` (the app imports it from this
package), so a manifest it accepts is loadable by the studio — the authoring
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

# 3. Check the module the way the studio will.
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
SDK and to distribute or sell those modules, including closed-source. The
SprintEngine Studio application is MIT as well; marketplace distribution is
still covered by separate marketplace terms.

### Packaged web runtimes and WebAssembly

`host.getAssetUrl('runtime/index.html')` returns a stable `studio-module:` URL
for a file in the installed module. Use it as an iframe's `src`. Inside that
frame, fetch `.wasm`/data files normally. HTML's relative script, worker and data
URLs resolve inside the package. Each module has a private, stable origin derived
from an installation secret, allowing IndexedDB save data to survive app restarts. The protocol is registered as a standard,
secure scheme with fetch support; it does not bypass content security policy.

The host checks current trust and enablement on every request, rejects paths
and symlinks outside the module root, and serves WebAssembly with
`application/wasm`. Files are limited to 128 MiB by the runtime (distribution
importers may apply smaller limits). The URL helper accepts plain relative paths;
add a fragment or query to its returned URL if needed. This API is available
only in Studio versions that ship module asset support; feature-detect
`typeof host.getAssetUrl === 'function'` for a useful upgrade notice on older hosts.

For a game, mount an iframe with `sandbox="allow-scripts allow-same-origin
allow-pointer-lock"`, grant fullscreen explicitly if needed, and pause/stop its
runtime when the panel unmounts. The iframe's module origin differs from Studio's
renderer origin. Audio and pointer lock still require the user's browser gesture.

Module package directories contain web assets: never store secrets inside an
installed module directory or publish/log the private URLs returned by the host.
Studio gates module requests using the requesting browser frame; unrelated
web frames are blocked. Unguessable origin capabilities also cover worker requests,
which bypass Electron’s frame interception. Load HTML under its module origin to
fetch its packaged resources. This is not a sandbox for hostile module code.

## Opening a zero-config workspace

Games, dashboards and other folderless workspaces can set
`openOnFirstLoad: true` on their `registerWorkspaceType` definition. Once the
module is trusted and enabled, the primary Studio window creates a workspace
from `createTemplate()`, names it with the type's `label`, and opens it. If a
workspace of that type already exists, Studio opens that workspace instead.
Studio waits for the saved workspace registry before checking for an existing
row. A persisted per-type marker prevents reopening or stealing focus on later
launches, including after the user closes the workspace.

Contribute an explicit command so people can reopen it:

```ts
host.registerCommand({
  id: 'open',
  title: 'Open my workspace',
  category: 'My module',
  scopes: ['global'],
  async run() {
    await host.openWorkspace('my-workspace-type')
  },
})
```

`openWorkspace(typeId): Promise<string>` returns the opened workspace id. It
only accepts a type owned by the calling module, rechecks enablement after
startup, and brings an existing workspace into the calling window. These two
entry points support types without `creationStep` or `createWorkspace`; they
never bypass a type's setup or custom creation hook. They create no directory.

New renderer-only modules load immediately after installation and trust, so
their first-load workspace opens in the same session. Studio never evaluates
the same module id twice in one renderer: updating loaded code, retrying a
failed evaluation, or loading a module with `entry.main`/`entry.preload` requires
a restart. Trust still precedes execution. Closing a workspace keeps its
first-load marker; use the explicit command to reopen it. On older Studio
versions, feature-detect `typeof host.openWorkspace === 'function'`.
