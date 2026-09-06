# Changelog

## Unreleased

- **A door surface names and places itself** (Extensions drawer ruling,
  2026-09-05). `GlobalSurfaceDefinition` was `{ id, Component }` while the host
  grew five presentation fields around it, so an SDK module could register a
  door and then have no way to say what it is CALLED — the shell's chrome fell
  back to a capitalised id. All five are mirrored now, all optional, and a door
  that draws its own row through `registerSidebarNavEntry` may still omit every
  one: `label` (the drawer row's name, the bar's fallback title, the "not
  installed" explainer's heading), `Icon` (the glyph any chrome that names the
  surface draws), `onOpen` (runs just before a PLAIN open — a rail glyph, a
  drawer row, a history step — for discarding stale deep-link latches),
  `views` (several drawer rows for one surface that is several destinations to
  the person, each with its own label, glyph and `open()`), and `railPlacement`
  (`'sidebar'`, the default, replaces the app sidebar's column for the length of
  the visit; `'inline'` renders your rail beside your own canvas and leaves the
  column alone — right when the column already holds the navigation that reached
  you). New mirrored types: `SurfaceIconComponent`, `SurfaceViewDefinition`,
  `SurfaceRailPlacement`.

- **`roadmap` leaves `BUNDLED_MODULE_IDS`.** The app retired the module when
  Horizon did and the SDK's copy of the reserved list did not follow, so the
  SDK went on telling third parties that an id nothing ships was unclaimable.
  Caught only now because the drift guard's type pins were failing first and
  the runtime assertion below them never ran.

- **Modal surfaces no longer get a trigger, and the docs stop promising one**
  (Extensions drawer ruling, 2026-09-05). The 2026-09-01 entry below says the
  shell renders your trigger as a glyph button in the sidebar footer's settings
  cluster. It does not: that ruling was reversed four days later — every
  destination the shell's own chrome offers is a DOOR again, and the cluster
  went with it. A modal surface is now reached from inside the content it floats
  over (a pane launcher, a row action, a notification's Open), which is the
  shape a modal is actually for; contribute that trigger yourself and call
  `openModalSurface(id)`. `order` and `Icon` are the fields the retired cluster
  read and are **optional** as of this change — nothing renders them — kept so a
  module that already declares them still compiles.

- **Modal surfaces** (doors→modals, 2026-09-01). A new contribution kind beside
  the door pair: `registerModalSurface({ id, order, label, Icon, onOpen?,
  Component })` mounts your zero-prop body in the shell's modal shell (workbench
  width, flat darkening scrim — never a backdrop blur, terminals render at 60fps
  behind it — focus trap, Escape/scrim close) and renders your trigger as a
  glyph button in the sidebar footer's settings cluster, tooltip and accessible
  name from `label`. Trigger and mount gate on your module's enablement, no
  reload. `onOpen` runs just before a plain trigger open, for discarding stale
  deep-link latches; deep-link openers bypass it. The shell's own Settings,
  Plugins (né Extensions), Automations and Design surfaces are the first
  consumers. New mirrored types: `ModalSurfaceDefinition`,
  `ModalSurfaceIconComponent`.

- The four module-boundary surfaces (MC-2090). Each was discovered separately by
  a task trying to put a door behind a real module boundary; they are published
  together so a contribution API does not grow four subtly different escape
  hatches for the same problems.

  - **A module-owned event channel.** `MainHost.emit(topic, payload?)` pushes to
    `RendererHost.subscribe(topic, cb)` — the subscribe verb the request/response
    bridge (`RendererHost.invoke`) does not have, and without which a module's
    renderer half cannot learn that its main half finished something. Identity is
    stamped from the emitting host's scope, so only your module's subscribers see
    it and you can never emit as another module. Delivery: fan-out to every open
    window, FIFO per module, **no replay** (an event emitted with no window open
    is dropped — events are signals, so keep the durable answer readable through
    an IPC channel and let the event say "read it again"), and **no flood
    bound** (unlike `notify`, dropping one would make a subscriber wrong).
    Delivery pauses while your module is disabled and resumes on re-enable; the
    returned closure unsubscribes. `subscribe` before the shell wires the source
    is a working no-op, never a throw. New mirrored type: `ModuleEventEnvelope`.

  - **App-level module state on `RendererHost`.** `getModuleAppState<T>(key)` /
    `setModuleAppState(key, value)` / `watchModuleAppState(cb)` — the scope above
    `getWorkspaceModuleState`, for state that belongs to your module rather than
    to a single workspace: remembered defaults, the last thing the user opened.
    It is renderer-side and **synchronous** on purpose: these values are read
    inside render, and routing them through the `entry.main`
    `ModuleStorageService` would change render timing (an async hydration flashes
    a default before the remembered value lands). Scoped to your module, persists
    with app settings, survives a disable/enable cycle, and shares a keyspace
    with your contributed Settings section's values — which are app-level module
    state by another name. `undefined` read / `false` write mean "not set" and
    "not stored", never a deletion signal. Pair `get` + `watch` with
    `useSyncExternalStore` for a reactive read. Disclosure: `storage`.

  - **Module-owned agent-id namespaces.**
    `RendererHost.registerAgentIdNamespace({ prefix, label })` claims every agent
    id starting with `prefix` for your module, and names what the shell calls
    those sessions where no workspace claims them. A module that spawns agents
    outside a window's knowledge — a background guide, a companion — owned ids
    the shell previously had to recognise by importing the module's own
    predicate. Keep the prefix distinctive and terminated (`'review-guide-'`, not
    `'review'`); a prefix overlapping one another module already claimed is a
    registration error. The shell gates resolution on live enablement.
    Disclosure: `ipc:agents`. New mirrored type: `AgentIdNamespaceDefinition`.

  - **An async create hook on `WorkspaceTypeDefinition`.**
    `createWorkspace(request, host)` lets a type own its whole create action when
    creating it is orchestration rather than a layout choice — probe a source,
    materialize it on disk, roll back on failure. `createTemplate` stays
    synchronous and keeps answering only "what layout?". Resolve to mean
    "created, close the hub"; reject to leave the hub open with the create still
    available. The host lends exactly two capabilities: `createWorkspace()` mints
    the row (running your `createTemplate`) and `removeWorkspace(id)` takes it
    back, so a create that fails after minting leaves no empty workspace behind.
    `request.setStepValue` writes into your creation step's value, which is where
    a failed hook reports — your step owns that page's body. Absent ⇒ the hub
    creates from `createTemplate` directly, unchanged. New mirrored types:
    `WorkspaceTypeCreateRequest`, `WorkspaceTypeCreateHost`.

- Top-bar items on `RendererHost` (MC-1861):
  `registerTopBarItem({ id, order, Component })` contributes a control to the
  app's top-bar title-strip cluster. The `Component` is zero-prop and
  self-contained — state, tooltip, action — eager or `React.lazy()`
  (`TopBarItemComponent`); the bar filters by your module's live enablement
  and orders contributed items by `order` (ties on id), so a module toggle
  adds/removes the control without a reload. Duplicate ids are a registration
  error naming the owner. The top bar is dense: contribute a single compact
  control (an icon button), not a cluster. First consumer: the bundled
  voice-dictation module's mic button. Also removed `voiceDictationEnabled`
  from `CommandAvailability` — the voice toggle is a module command now
  (`voice-dictation.toggle`); module commands gate on enablement through the
  contribution list, not a shell availability enum entry.

- MCP tool contributions on `MainHost` (MC-1855):
  `registerMcpTools(tools: McpToolRegistration[])` puts agent-facing MCP tools
  on Multicode's always-on Studio gateway, owned by your module's id the way
  IPC channels are. A tool name another module already registered is a
  registration error and the whole batch is rejected (no partial
  registration). Availability follows your module's live enablement at the
  gateway: while the module is registered but disabled the tools stay listed
  on `tools/list`, and `tools/call` answers a normal MCP tool result carrying
  an actionable "enable it in Settings → Modules" error instead of running —
  toggling needs no app restart, and connected clients are nudged with
  `notifications/tools/list_changed`. Tools of a module that never loaded are
  not listed. New mirrored types: `McpToolRegistration`, `McpToolResult`,
  `McpConnectionContext`, `McpConnectionMetadata` (all exact-identity
  drift-guarded). Keep JSON-Schema array fields arrays end to end.
  Disclosure: an MCP tool is agent-reachable capability — declare
  `ipc:agents`.

- Global door surfaces on `RendererHost` (MC-1854):
  `registerGlobalSurface({ id, Component })` publishes the full-page surface
  behind a sidebar nav entry with the same id. A global surface is a
  first-class, instance-global extension point: no workspace type, panel, or
  project scope is required to own a top-level door. `Component` is zero-prop,
  eager or `React.lazy()` (`GlobalSurfaceComponent`). The shell gates the
  mount on your module's live enablement — while the module is uninstalled or
  disabled it renders an explicit "not installed" door (name, one sentence,
  one CTA into Extensions) and never clears the user's persisted spot, so
  reinstalling lands them back on the door. An id already claimed by another
  module is a registration error, reported as a module load error that gates
  off the failing module's other contributions.

- Per-module workspace state on `RendererHost` (MC-1573):
  `getWorkspaceModuleState<T>(workspaceId)` /
  `setWorkspaceModuleState(workspaceId, state)` — your module's own durable
  entry in the workspace's per-module state bag, scoped to the calling module
  by the host. Entries persist with the workspace registry and sync across
  windows like built-in workspace fields; keep them JSON-serializable.
  null/undefined removes the entry. Read resolves `undefined` and write
  reports `false` when the workspace id is unknown or the shell hasn't wired
  workspace state yet (early boot) — retry later; neither is a deletion
  signal and neither throws. Disclosure: `storage`. The accessor pair is the
  pinned shape (exact-identity drift-guarded); no watch variant yet — re-read
  on render until a consumer motivates one.

- Live runtime surfaces on `RendererHost` (MC-1535, the extraction blocker
  set): `watchAgentSessions(workspaceId, cb)` — read-only session views
  (`ModuleAgentSessionView`: sessionId/agentId/name/kind/system/executionId/
  isLive, enum-ish fields widened to string), snapshot then deduped change
  events; `spawnAgent(input)` — spawns through the app's SHARED session
  runtime (never a bespoke PTY) with structured failures
  (`unknown_workspace`/`missing_folder`/`unknown_runtime`/`spawn_failed`)
  and adds the agent's layout tab; `focusTab({ kind: 'agent' | 'file' })`;
  `listAgentRuntimes()` — ids + labels from the shell's availability-
  filtered CLI catalog (no plugin internals);
  `watchWorkspaceFile(workspaceId, relativePath, cb)` — debounced content
  watch (null = file absent), absolute/escaping paths reject with a named
  cause; and `getWorkingRoot(workspaceId)` — the *effective working root*
  (`ModuleWorkspaceView.folderPath` stays the durable primary checkout;
  worktree-backed workspaces do live work under a worktree, and the file
  watch, spawn cwd, and file-tab focus all resolve against that root).
  Every method fails with a named cause when agent runtime is unavailable
  (unwired shell vs the Agent Runtime module disabled are distinct causes).
  Disclosures: `ipc:agents` (sessions/spawn/focus),
  `filesystem:read-workspace` (file watch), `ipc:workspace-read`
  (working root).

- Module-owned workspace-creation config steps (MC-1534):
  `WorkspaceTypeDefinition.creationStep` —
  `{ id, heading, description?, Component, isReady?, blockedHint? }`, one
  step per type in v1. The hub renders the step as the flow's one config page
  after the shared name/folder fields; `Component` receives
  `{ value, setValue }` (`WorkspaceCreationStepProps`); `isReady(value)`
  gates the Create button and `blockedHint` is the footer hint while it is
  false. The collected value arrives in the new optional
  `createTemplate(context?: WorkspaceTypeCreateContext)` argument
  (`{ stepValue?: unknown }`) — the shell holds it for the pane's lifetime
  only and persists nothing. A throwing step component degrades to the
  type's zero-config create with an inline notice; it never blocks the hub.

- Workspace supervisors + sidebar run glyphs (MC-1537) published on
  `WorkspaceTypeDefinition`: `supervisors` (render-nothing background
  components; scope `'global'` = one instance in the primary window while the
  module is enabled, `'all-windows'` = one per window; mounted inside a crash
  boundary and a display:none host) and `deriveRunGlyph(workspace)` (sync
  sidebar status — `{ state, live, label }` with `state` from the stable
  `WorkspaceRunGlyphState` subset; input is the minimal `{ mode }` view; the
  mode's own provider wins the dispatch; return null for "no run signal").
  Both were v1 narrowings; extraction makes them load-bearing (an auto-run IS
  a supervisor; the calendar benchmark's "2 scheduled today" badge needs the
  glyph slot).
- Module command scopes + availability (MC-1533): `CommandScope` and
  `CommandAvailability` are open at the type level (`(string & {})`) — the
  shell derives a module's `panel:<moduleId>` scope from the workspace-type
  registry and activates it while a workspace of that module's mode is
  active. `ModuleCommandDefinition.availability` now also accepts a predicate
  over the published `ModuleCommandContext`
  (`{ activeWorkspaceId, activeWorkspaceMode }`) — "offer this only when…"
  without a shell enum change; predicate commands fail closed when no context
  is wired. Panel-targeted dispatch stays the module bus pattern (a
  `multicode:panel-command` CustomEvent from the command's `run()`), now the
  documented convention. In-tree proof: Switchboard/Watchtower's built-in
  commands are registered through this path.
- Per-module, per-workspace storage: `getModuleStorage(host)` →
  `{ get, set, delete, list }` scoped to your module, with host-owned file
  placement (workspace `.multi-code/modules/<moduleId>/<key>.json`, or
  per-user app data for global keys). JSON values with a 1 MB cap, keys
  `^[a-z0-9][a-z0-9._-]{0,63}$`, atomic write-then-rename, honest errors
  (`invalid_key` / `invalid_value` / `value_too_large` /
  `invalid_workspace_root` / `io_error`; a corrupt record reads as
  `io_error`, never silently missing). New `storage` disclosure permission.
  Main-side only in v1 — renderer access rides the module's own
  `host.invoke` channels.
- `BacklogItemLink` mirror caught up with the app: `target.taskId?` (the task
  inside a run target that owns the item), `priorStatus?` (item status to
  restore if the linked work is abandoned), and the `pending` value in
  `BacklogItemLinkStatus`.
- Workspace context resolution (id → root/name/mode): renderer
  `RendererHost.getWorkspace(workspaceId)` and main-side
  `WorkspaceContextToken` (`core.workspace-context`, always-on) both resolve a
  read-only `ModuleWorkspaceView` (`{ id, name, folderPath, mode }`). Unknown
  ids resolve `null`, never a throw. Disclosure permission:
  `ipc:workspace-read`. Replaces deriving the workspace root from Backlog item
  paths or drop payloads.

## 0.4.0 — 2026-07-07

Calendar-class workspace parity: a module's renderer can now reach its own
`entry.main` (IPC bridge), create and observe real automations (scoped
service + one-shot `at` cadence), enumerate and watch the Backlog, accept
Backlog/Files drags, and style against published theme tokens.

- File-drop drag-and-drop contract: `MULTICODE_FILE_DROP_MIME`,
  `FileDropPayload`, `setFileDropData`, `hasFileDropData` (the dragover-safe
  presence check), and the null-safe `readFileDropPayload` (missing entry,
  bad JSON, unknown version, or invalid shape ⇒ `null`, never a throw; file
  entries are rebuilt, dropping unknown properties). Backlog-panel and
  Files-tree drags are now a supported module surface, drift-guarded against
  the app implementation.
- Theme token contract: `THEME_TOKENS` + `ThemeToken` publish the CSS
  custom-property names guaranteed present in every app theme (chrome,
  border, text, accent, and semantic tone families). Names only — values are
  theme-specific and retuned freely. A repo gate verifies presence per theme.

- Backlog read API on `RendererHost`: `listBacklogItems(workspaceId)` and
  `watchBacklogItems(workspaceId, cb)` expose the workspace's Backlog as
  read-only `BacklogItemView`s, backed by the same shared scan + watcher the
  Backlog panel uses. `watch` fires with the current snapshot, then on every
  change; unsubscribe via the returned closure. Declare the `backlog.read`
  disclosure permission. Both methods fail with a named cause when the
  backlog module is disabled or absent.

- `ScheduleTriggerConfig` gains the one-shot `at` cadence:
  `{ type: 'at', datetime: 'YYYY-MM-DDTHH:mm' }` — local wall-clock resolved
  in the config's `timezone` (seconds optional and ignored; a trailing
  `Z`/offset is rejected). Fires exactly once; after the fire time the
  automation stays listed with no upcoming run. A wall-clock inside a DST
  spring-forward gap resolves to the first instant after the gap, matching
  daily/weekly.

- Scoped Automations service: `getAutomationsService(host)` returns a
  `ModuleAutomationsService` with owned CRUD (`create`/`update`/`delete`/
  `list`/`listRuns`) and ownership-filtered `onRunEvent`. New mirrored types:
  `AutomationDefinition`, `AutomationDefinitionDraft`,
  `AutomationDefinitionPatch`, `AutomationsRunEvent`,
  `AutomationRunEventStatus`, `AutomationRunEventTrigger`,
  `ModuleAutomationsError`, `ModuleAutomationsResult`. Every method returns a
  structured result (`invalid_workspace` covers roots the app does not have
  open); writes require the workspace folder to be open in the app.
  `AutomationDefinition` gains `ownerModuleId` (stamped server-side;
  module-created automations show a "via <module>" attribution in the panel,
  and open panels refresh live when a module writes). New
  `automations.manage` disclosure permission.

- `RendererHost.invoke(channel, payload?)`: renderer→module-main IPC bridge.
  A module's renderer code can now call channels its own `entry.main`
  registered via `MainHost.registerIpc`. Channels must be `<moduleId>:`-
  prefixed; the host routes only to third-party-owned channels whose module
  declares `ipc:invoke`. Refused invokes reject with an Error carrying a
  structured `code` (new exported type `ModuleBridgeRefusalCode`). A
  contract, not a security boundary — trust gating remains the boundary.

- Licensed MIT (`LICENSE` added, `license` field set, included in published
  files). Permits building and selling modules, including closed-source;
  covers this SDK package only, not the Multicode app or marketplace terms.
- New Automations provider authoring surface:
  `registerAutomationTrigger`, `registerAutomationAction`, provider/context
  types for trusted modules that declare `dependsOn: ['automations']`.
- `BUNDLED_MODULE_IDS` now includes `automations`, matching the app reserved-id
  set.
- `BacklogItemLink.type` now includes `agent`, matching the app's
  lifecycle-neutral working-agent links.
- Three additive Backlog disclosure scopes — `backlog.read`, `backlog.write`,
  `backlog.link.open` — added to `CapabilityPermission` and
  `KNOWN_CAPABILITY_PERMISSIONS`. Install-time disclosure vocabulary only (no
  runtime enforcement), consistent with the existing `ipc:*` tiers.

## 0.3.0 — 2026-06-15

BYO-CLI plugin authoring and programmatic workspace creation.

- New CLI plugin authoring surface: `CliPluginManifest` (the `plugin.json`
  contract for adding an agent CLI), `validateCliPluginManifest` /
  `parseCliPluginManifest`, and the supporting token types (`CliLaunchSpec`,
  `CliResumeSpec`, `CliPromptInjection`, `CliCompletionSpec`, `CliCapabilities`,
  `CliMcpConfigSpec`, `CliModelSelectionSpec`, `CliSkillIntegration`,
  `CliSkillInstallTarget`, `CliSkillInvocation`, …). A CLI plugin is a folder
  dropped into `~/.multicode/plugins/<id>/`, or installed from
  Settings → Agents → "Install CLI from folder".
- `validateCliPluginManifest` is the **single source of truth** for CLI
  manifest validation: the Multicode app loads a `plugin.json` by delegating to
  it (no separate in-app copy), so the authoring contract and the loader cannot
  drift. As part of consolidating the two former copies, `version` is now
  required to be a positive integer (the app previously accepted any number).
- New `WorkspaceService` + `WorkspaceServiceToken`: resolve with
  `host.requireService(WorkspaceServiceToken)` from `entry.main` to create a
  workspace programmatically. The creation runs the same renderer flow as the
  UI and is confirmed on the workspace-sync bus before it resolves.
- `CommandAvailability` mirror synced with the app (`diagnosticsEnabled`).

## 0.2.0 — 2026-06-11

Signing toolchain for module authors.

- New `multicode-module` CLI (`bin`): `keygen` (ed25519 PKCS#8 PEM keypair),
  `pack` (validate + assemble an installable module directory; excludes
  node_modules, .git, and key material), `sign` (detached ed25519 signature
  over the canonical manifest, normalized manifest written back to disk),
  `verify` (checks a module directory exactly like the Multicode app).
- New `@multicode/module-sdk/signing` subpath export:
  `generateModuleSigningKeyPair`, `signManifest`, `verifyModuleSignature`,
  `manifestFingerprint`, `publicKeyFingerprint`. The Multicode app's verifier
  imports these same functions, so signer and verifier cannot drift.
- Manifest validation (`parseThirdPartyModuleManifest`,
  `validateThirdPartyModuleManifest`, `canonicalManifestPayload`) is now the
  single source of truth consumed by both the app and the CLI.

## 0.1.0 — 2026-06-10

Initial published surface.

- Manifest contracts: `CapabilityManifest`, `ModuleEntry`, `ModuleSignature`,
  `ModuleSource`, `ModuleTrustStatus`, `CapabilityCategory`,
  `BUNDLED_MODULE_IDS`.
- Permission disclosure vocabulary: `CapabilityPermission`,
  `KNOWN_CAPABILITY_PERMISSIONS` (tiered `ipc:*` scopes; `ipc:invoke` legacy
  broad scope).
- Main host: `MainHost`, `RegisterMain`, `IpcInvokeHandler`, `ServiceToken`,
  `createServiceToken`, `SidecarSpec` (including `startOn` spawn policy),
  startup/shutdown hooks.
- Notifications: `ModuleNotifyInput`, `ModuleNotification`,
  `ModuleNotificationSeverity`.
- Renderer host: `RendererHost`, `RegisterRenderer`, panel types, workspace
  type definition + layout JSON subset, Backlog item actions and link
  providers, module commands (`ModuleCommandDefinition`, scopes,
  availability), settings sections.
- `entry.preload` documented as reserved, not loaded in v1.
