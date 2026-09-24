# Changelog

## Unreleased

- **`SegmentedControlItem` takes an optional `badge`.** `{ count, label, tone? }`
  draws the kit's count badge after the segment's label and adds `label` to the
  segment's accessible name — for a choice with something waiting behind it.
  Additive: an item without one is unchanged.

- **`send-after-ready` is implemented, and `CliReadinessSignal` says what
  "ready" means.** A CLI plugin whose `promptInjection.mode` is
  `send-after-ready` now has its first message typed in (one bracketed paste,
  one Enter) on a new launch; a resume never sends it again. Its `readiness` is
  one of `{ type: 'bracketed-paste', timeoutMs }` (the line editor turned
  bracketed paste on; sent anyway at the deadline) or
  `{ type: 'output-match', pattern, timeoutMs }` (the CLI printed `pattern`;
  nothing is typed at the deadline, and the person is handed the message back).
  `pattern` must now compile as a regular expression. An `input`
  `promptInjection.overflow` may carry `env`, set only on a launch whose first
  message is typed in; a `send-after-ready` manifest's overflow must be `input`.
  A manifest whose `output-match` pattern was a never-matching placeholder now
  never types its message and hands it back instead. `readiness` is validated
  and used whatever the mode: on a `positional-arg` manifest it governs the
  typed delivery of a first message too long for the command line, and an
  invalid one now rejects the manifest instead of being ignored.

- **The app's previous name is gone from every contract.** This is a
  **breaking change**, with no aliases kept:
  - the host's import map answers only the `@sprintengine/module-sdk` scope, so
    a bundle built against an earlier scope must be rebuilt;
  - the panel-command window event is `sprintengine:panel-command`;
  - the authoring CLI binary is `sprintengine-module`;
  - the drop-in extension roots are `~/.sprintengine/modules` and
    `~/.sprintengine/plugins`.

- **`BacklogItemView` loses `kind`.** A Backlog item is a markdown file with
  metadata; the host no longer guesses a plan kind from its filename or title,
  and no longer reads a `kind:` / `planKind:` frontmatter field. This is a
  **breaking type change** for a module that reads `item.kind`. Read
  `item.type` for the triage type (an `.html` file with no `type:` reads as
  `mockup`), or `item.relativePath` for the file's format.

- **The host no longer runs Python.** `MainHost.runPython`,
  `RunPythonRequest`, `RunPythonResult`, `PythonSidecarConfig` and
  `SidecarSpec.python` are removed, and the app stops bundling CPython. A
  `registerSidecar` call is a declaration again: the host lists it but spawns
  nothing, so `SidecarHandle` loses the members only a host-spawned child
  could feed — `pid`, `onStdout`, `onStderr`, `onExit`, `ready` and
  `signalReady()` — along with `SidecarChunkListener` and
  `SidecarExitListener`. This is a **breaking change**: a module that
  registered a `kind: 'python'` sidecar or called `runPython` stops
  compiling. Ship your own runtime and spawn it yourself (declare
  `process:spawn`), or port the work to TypeScript.

- **`LifecycleState` loses `review`, `testing`, `product`,
  `changes_requested`, `recorded`, `approved_auto`, `done_unmerged` and
  `done_merged`, and `WorkspaceRunGlyphState` loses `review`.** They were
  the in-tree run engine's pipeline stages, and nothing in the host produces
  them any more. This is a **breaking type change**: a `deriveRunGlyph`
  provider or a `LifecycleGlyph` caller that returns one stops compiling. Map
  the stage onto the remaining vocabulary (`in_progress` for a stage still
  running, `needs_input` for a stage waiting on a person, `done` for a
  finished one).

- **`ActionContext.spawnAgent` loses `specialistId`.** Nothing in the app
  reads it, and the host ignored it. This is a **breaking type change** for an
  automation action provider that sets it: the property no longer exists, so
  the compile fails rather than the value being dropped silently. Delete the
  assignment and say what the agent should do in `prompt`, or install the
  skill you want and attach it through the Agent Sessions service instead.

  The module id `sprint-engine` stays in `BUNDLED_MODULE_IDS`. It is reserved,
  not bundled: the Sprint Engine ships as an out-of-tree module that installs
  under that id, and the reservation is what stops anything else claiming the
  name.

- **`CommandAvailability` loses `sprintengineWorkspace`,
  `sprintengineHasArchitect`, `sprintengineFocusAgentVisible` and
  `sprintEngineEnabled`.** The shell no longer computes any of them, so a
  command gating on one could never become available. The union is open at the
  type level, so a module that still names one compiles — and reads as
  unsatisfied, which is what it already was. Gate on a `panel:<moduleId>` scope
  or an availability predicate instead.

- **`CliManifest` loses `souls` and `CliSoulsSpec`.** The app no longer reads a
  CLI plugin's role directory, because it has no concept of a role.

- **`BacklogItemLink` loses `target.taskId` and `priorStatus`.** Both were
  written only by the in-tree run engine for an epic child's run link, and
  nothing reads them now: the host drops them when it normalises a stored
  link. A module that set either stops compiling; delete the assignment.

- **`CliModelPickerButtonProps` loses `noneOption`.** The pinned "no runtime"
  row served the retired planning agent; the trigger always names a runtime
  now.

- **`McpConnectionMetadata` loses `sprintRunId`.** Nothing set it once the
  in-tree run engine left; an out-of-tree module identifies its own connections
  through `agentId`.

- **A workspace type can hide its workspaces from the rail.**
  `WorkspaceTypeDefinition.hiddenFromRail` withholds workspaces of that type
  from the Projects list, keyboard switch targets, and command-palette
  results, the same way `hiddenFromPicker` withholds the type from the
  creation picker. Hidden means hidden from discovery: the workspace stays
  in the store, in window assignments, and explicitly activatable. A door
  surface that took over finding those workspaces sets this so they are not
  listed again under one project.

- **A module can contribute Open actions for its bell rows**
  (`host.registerNotificationActionProvider`). One provider per `source`; a
  duplicate is a registration error. `resolveActions` receives
  `{ notification: { workspaceId?, navigationTarget? }, revealWorkspace }`
  and returns `{ id, label, run }` actions. Returning none leaves the shell's
  generic workspace-reveal fallback. New types: `NotificationActionProvider`,
  `NotificationActionContext`, `NotificationAction`, `NotificationActionView`.

- **A module can contribute a door / nav-entry waiting count**
  (`host.registerDoorBadge`). `{ rowId, getWaitingCount, subscribe,
  notificationSource? }` — the shell merges the count with that row's unread
  bell news, and `notificationSource` is how unnamed notices of that source
  fall to the row. Duplicate `rowId` is a registration error. Gone with the
  module, so a count with no row never appears. New type:
  `DoorBadgeContribution`.

- **A workspace type can own its sidebar row and its create control.**
  `WorkspaceTypeDefinition` gains `createLabel` (the picker/hub create
  control; defaults to `label`), `RowMark` (glyph beside the row title),
  and `rowActions` (`{ id, label, variant?, isVisible, confirm, run }`,
  extra context-menu items on that type's rows). The shell draws
  those from the registration; they are absent with the module, never a
  disabled core row. New types: `WorkspaceTypeRowAction`,
  `WorkspaceTypeRowActionConfirm`, `WorkspaceTypeSidebarWorkspace`.

- **A module can contribute Files-tree context-menu actions**
  (`host.registerFileAction`). The function receives `{ id, label, order?,
  getLabel?, isVisible(context), getState(context), run(context) }` where
  `context` is `{ workspaceId, workspaceRoot, entries }` and each entry is
  `{ name, path, isDir, gitDeleted? }`. The explorer renders visible
  contributions from enabled modules under a heading named for the module;
  the row is absent — not a disabled core item — when the module is off.
  Duplicate ids are a registration error. New types: `FileAction`,
  `FileActionContext`, `FileActionEntry`, `FileActionState`.

- **A module can contribute to every agent launch**
  (`host.registerLaunchContribution`). The function receives `{ cli,
  workspaceRoot, sessionId, agentId, agentKind, resume, knowledgeRoot,
  pathStyle }` and returns `{ env, pathEntries, shellFunctions,
  mcpServers, hostContext, session, identityKeys }`. Contributions run in
  module registration order and a throw is recorded as a module diagnostic
  without failing the spawn. Declare `ipc:agents`. New types:
  `LaunchContribution`, `LaunchContributionRequest`,
  `LaunchContributionResult`, `LaunchContributionMcpServer`,
  `LaunchContributionHostContextSection`, `LaunchContributionSessionTag`,
  `LaunchContributionPathStyle`.

- **A module can ship Python the host runs on the managed interpreter**
  (`MainHost.registerSidecar` `kind: 'python'`, `MainHost.runPython`). Sidecar
  registration used to be a label: `kind` was free-form and nothing honoured
  it, so a module that wanted its own packages on the app's CPython had to
  spawn `python3` itself and hope. `registerSidecar({ id, kind: 'python',
  python: { root, module, args, env }, startOn })` is now host-owned — the
  host containment-checks `python.root` (the same rule as `registerSkills`),
  prepends it to `PYTHONPATH`, and spawns on the managed interpreter. The
  returned `SidecarHandle` carries `pid`, stdout/stderr chunk callbacks,
  `onExit`, and a `ready` promise the module resolves from its own output via
  `signalReady()`. `stop()` and unload kill the child. `kind: 'process'` with
  a module-supplied lifecycle stays legal for non-Python daemons.
  `runPython({ root, script | module, args, cwd, env, timeoutMs })` is the
  one-shot twin and returns `{ exitCode, stdout, stderr }`. Third-party
  modules must declare `process:spawn` on both surfaces (the host checks it);
  bundled first-party modules have no permissions list and are not gated
  there. New mirrored types: `PythonSidecarConfig`,
  `SidecarHandle`, `SidecarRunState`, `SidecarRuntimeStatus`,
  `SidecarStartOptions`, `RunPythonRequest`, `RunPythonResult`.

- **Automations providers carry display metadata and pairing defaults.**
  `AutomationActionProvider` and `AutomationTriggerProvider` gain optional
  `label`, `glyph` (from the closed `AUTOMATION_PROVIDER_GLYPHS` vocabulary:
  `agent`, `loop`, `board`, `clock`) and `summary`. The Automations panel
  reads those instead of hard-coding a module's copy. A trigger may declare
  `pairsWith: { actionKind, defaultDisableAfterRun }` so a chained pair
  defaults `disableAfterRun` without the host naming either kind.
  `ActionKind` keeps the bundled literals (`spawn-agent`, `run-command`,
  `run-skill-loop`) and stays open to module-namespaced kinds.

- **`RendererHost.invoke` routes to any module that declares `ipc:invoke`.**
  The main-side dispatcher used to refuse bundled owners, which left a module
  built here unable to use the bridge it publishes. That restriction is
  dropped: prefix + permission remain the gate. No type change.

- **Backlog item actions render in menus, not as header buttons.**
  `BacklogItemAction.order` positions an action within the row's right-click
  menu and the detail header's More-actions menu. The header's own buttons
  belong to the shell. No type change.

- **The package is now `@sprintengine/module-sdk`**, matching the app's name.
  **A module author must change every import**, including the `--external:`
  flags for the host-bridged subpaths: `@sprintengine/module-sdk`,
  `@sprintengine/module-sdk/ui`, `@sprintengine/module-sdk/surface`,
  `@sprintengine/module-sdk/signing`. The types, the exports and the runtime
  contract are unchanged — only the name is.

- **Packaged web runtimes have stable module origins.** `RendererHost.getAssetUrl`
  resolves an installed asset to a `studio-module:` URL. Packaged HTML supports
  relative scripts, WebAssembly, workers and IndexedDB. Private per-installation
  origins prevent unrelated pages from guessing asset URLs, with current trust and
  enablement checks and containment inside the module directory.
- **Panel headers are available through the shared UI kit.** `PanelHeader` and
  `PanelHeaderProps` are exported from `@sprintengine/module-sdk/ui` so contributed
  panels can use Studio's existing header component.

- **Folderless workspaces can open themselves after installation.** Set
  `WorkspaceTypeDefinition.openOnFirstLoad: true` to create/focus that type on
  its first enabled, trusted renderer load. A persisted marker prevents focus
  stealing or recreation after closing it, and only the primary window runs
  automatic creation. `RendererHost.openWorkspace(typeId)` lets a module's
  command explicitly reopen its own type. Both use the registered template,
  reuse existing workspaces and reject types requiring a creation step or
  custom creation hook.
- **New renderer-only modules activate after install/trust.** Studio refreshes
  trusted renderer entries and adds their contributions without restarting.
  Each module id is evaluated at most once per renderer session; modules with
  main/preload entries, updates to running code and failed evaluations still
  require a restart. Existing registry consumers update reactively, and an
  `openOnFirstLoad` workspace opens as soon as the new module is ready.

## 0.5.0 — 2026-09-10

- **An MCP tool can say that it writes.** `McpToolRegistration.mutates?: boolean`.
  The Studio gateway used to classify mutations from a table of core tool names,
  which a module's tool could never be in — so a module tool that wrote to disk
  was served to a remote caller holding only the read scope, and left no audit
  entry. Declare `mutates: true` and the gateway requires `<family>:operate`
  from a tailnet caller and records every call, refusals included. Omitted means
  a read, as before.
- **The host's UI kit, door shell and Monaco are bridged to modules**
  (Reviews-extraction ruling D6, 2026-09-10). A module that wanted to look like
  the app had two options, both bad: re-implement the chrome a shade off, or
  bundle a second copy of React-dependent components and break hooks. Two new
  subpath entry points now publish the app's own pieces —
  `@sprintengine/module-sdk/ui` (`GhostButton`, `OutlineButton`, `PrimaryButton`,
  `Banner`, `Drawer`, `EmptyState`, `Field`, `Input`, `Textarea`,
  `InlineNotice`, `KbdChord`, `LifecycleGlyph`, `LinkButton`, `RowButton`,
  `Section`, `SegmentedControl`, `Select`, `Spinner`, `StatusDot`,
  `TruncatedText`, `CliModelPickerButton`, `FOCUS_RING_CLASS`) and
  `@sprintengine/module-sdk/surface` (`GlobalSurfaceShell`, `useSurfaceBackNav`,
  `SurfaceRail`, `SurfaceCanvasState`) — alongside `@monaco-editor/react`,
  which the host has always shipped and now answers for modules too. All three
  join `react` and friends in the import map the host installs before it
  evaluates an `entry.renderer` bundle, so there is one React, one Monaco and
  one kit in the process.

  Both subpaths ship TYPES ONLY: their runtime is a stub that throws
  `"@sprintengine/module-sdk/ui is provided by the host at runtime; mark it
  external in your bundler"`, so forgetting the external is a loud failure at
  load rather than a silent second React. Add
  `--external:@monaco-editor/react --external:@sprintengine/module-sdk/ui
  --external:@sprintengine/module-sdk/surface` to your bundle.

  Two things this does NOT give you. Tailwind utility classes written inside a
  module compile to nothing — the app's Tailwind build scans app source only —
  so a module that writes its own classes must ship a utilities-only stylesheet
  (README shows the four-line entry). And the published list is short on
  purpose: it is a versioned contract pinned in both directions by the drift
  guard, so a component that is not on it is cheaper copied into your module
  than frozen here forever.
- **A modal surface contributes the row that opens it** (D7, 2026-09-10).
  `ModalSurfaceDefinition.launcher = { label, letter, Glyph }` puts your
  surface in the workspace pane's kind list — the strip's "+" menu and the
  pane's empty-state launcher, beside Browser, Terminal, Files, Diff, Git and
  Backlog. It is the one trigger the shell draws for a modal, and it exists
  because Reviews was hard-coded into that list: the entry above says
  "contribute that trigger yourself", which a module reaching for the pane
  could not do. `letter` must be exactly one character (uppercased for you) and
  a malformed launcher is a registration error. The shell's own kinds win a
  letter collision, as does an earlier-registered module: the losing row keeps
  its label and glyph and simply has no shortcut, rather than taking a key the
  person already knows.

- **A modal body is told which workspace opened it.** `Component` is now
  `ComponentType<{ workspaceId?: string }>` (`ModalSurfaceComponent`), and the
  shell passes the workspace its opener acted from — for a pane row, the
  workspace the row was picked in. A modal floats over the window rather than
  mounting inside a workspace card, so it had no way to know what it was acting
  on but "the active workspace", which can change under an open modal. A
  zero-prop component still satisfies the type, so an app-level surface needs
  no change.

- **The open workspaces, not just one.** `RendererHost.listWorkspaces()` and
  `watchWorkspaces(cb)` return the same `ModuleWorkspaceView` rows
  `getWorkspace` resolves, for a surface that is not mounted inside any one
  workspace and so has no id to ask about. The watch fires once with the
  current list, then on change (deduped by value). Declare
  `ipc:workspace-read`. Empty — never a throw — before the shell wires
  workspace state.

- **`RendererHost.watchColorScheme(cb)`** reports the app's resolved
  `'light' | 'dark'` immediately and on every change (an explicit theme switch,
  or an OS switch while the preference follows the system). For a themed
  runtime you HOST and must hand a concrete value — Monaco's base theme, a
  chart palette. Ordinary module UI should keep reading `THEME_TOKENS` and
  re-skin without JavaScript. New published type: `ModuleColorScheme`.

- **`watchAgentSessions` takes `undefined` for "every workspace"**, narrowed to
  the agent-id namespaces your module claimed with `registerAgentIdNamespace`.
  A module whose `entry.main` spawns agents without a window's knowledge had no
  workspace id to watch and no way to follow them; this is that watch. Claim no
  namespace and the unscoped call reports an empty list — it is never a window
  onto other modules' sessions. A workspace id behaves exactly as before.

- **`listAgentRuntimes()` answers what a picker needs.**
  `ModuleAgentRuntimeOption` widens from `{ id, label }` to
  `{ id, label, available, models, isDefault }` (`models` being
  `ModuleAgentRuntimeModelOption[]` — the manifest, discovered and user-added
  ids merged, exactly the rows the shell's own model picker shows). A module
  building a CLI + model picker previously had ids and labels and nothing else
  to preselect or disable with.

- **`THEME_TOKENS` gains `--motion-normal` and `--motion-ease`** — the app's
  standard transition duration and easing, guaranteed in every theme by the
  same per-theme repo gate as the rest. Use them as a pair
  (`transition: opacity var(--motion-normal) var(--motion-ease)`) so module UI
  moves at the app's pace instead of inventing its own.
- **`plugin scaffold` and `plugin sign` write components in canonical order,
  and print the `provides` array to paste.** A registry entry's `provides` must
  equal the component kinds the app derives from the bundle, and the app derives
  them by filtering `MARKETPLACE_COMPONENT_KINDS` (`mcp, skills, module, cli,
  automation`) — so an author who typed `--component cli --component mcp`, or who
  hand-wrote `plugin.json`, read one order out of their own file and the
  downloader computed another. The mismatch surfaced as a registry-mismatch
  failure on the user's machine, naming two lists that look the same. Both
  writers of `plugin.json` now key `components` canonically before the manifest
  is signed, and `plugin scaffold`, `plugin sign` and `plugin verify` each end
  with a `Registry entry "provides": [...]` line that is the exact array the
  registry entry needs.
- **Agent sessions: a module can own an agent TERMINAL** (`getAgentSessionService(host)`,
  new scope `agents:session`). A module's `entry.main` had two doors to an agent
  and neither fits a long-lived working one: the companion service drives a
  conversation-runtime session (no pty, no tab, no CLI of the user's choosing),
  and `ipc:agents` discloses a renderer surface main-side code cannot reach.
  The third door is the one the in-tree review guide always actually used — an
  ordinary agent terminal, spawned in the workspace the module's surface was
  opened from, under the user's CLI, permission default, runtime overrides, MCP
  and knowledge graph, with a skill attached at spawn. `spawn` (fresh, or
  `reused: true` when a live session already answers to the same agent id),
  `send`, `kill`, `setReapExempt`, `onExit`, `list`. New types:
  `ModuleAgentSessionRecord`, `ModuleAgentSpawnRequest`, `ModuleAgentSpawnResult`,
  `ModuleAgentExitEvent`, `ModuleAgentSessionService`.

  Scoping is by agent-id prefix: name your agents `${agentIdPrefix}${agentIdKey}`
  under a namespace you registered, and `list()` answers for those and nothing
  else. Every method checks `agents:session` at runtime — the third scope that
  is genuinely gated, alongside `ipc:invoke` and `agents:companion`.

  *Known limitation.* Agent-id namespaces are registered on the RENDERER host and
  main holds no mirror of that registry yet, so main cannot verify that a prefix
  is one you registered. Until it can, a prefix is validated as non-empty and
  ownership falls back to "prefixes this module has spawned under in this
  process" — sound (no module can reach another's agents) but forgotten across a
  restart, so `list()` may under-report sessions spawned before one.

- **`WorkspaceContextService.list()`.** `WorkspaceContextToken` could resolve one
  workspace id and had no way to enumerate them, so an MCP tool a module
  contributes — which runs with no window and no renderer to ask — could not
  answer "which project roots are open". `list(): Promise<ModuleWorkspaceView[]>`
  is the main-side twin of `RendererHost.listWorkspaces`.
- **A module can ship its own skills** (`MainHost.registerSkills`,
  `MainHost.ensureSkillInstalled`). Skills used to be a closed set compiled
  into the app, so a module that wanted an agent to run with its own skill had
  no way to say so — it could spawn an agent and name a skill that was never
  copied anywhere. `registerSkills([{ id, sourceDir, targetPolicy,
  description }])` hands the host a directory inside your module root
  (resolved and containment-checked; a rootless bundled module passes an
  absolute path) and the host then treats it exactly as it treats its own:
  same check-first install, same managed manifest, same `'all-native'` fan-out
  into every installed CLI's native skill directory, and the same resolution
  at the agent-launch boundary. Ownership matches `registerMcpTools` — an id a
  built-in or another module holds throws, the batch is validated before one
  skill of it lands, and unloading the module unregisters its skills.
  `ensureSkillInstalled(workspaceRoot, skillId)` pre-installs one on demand
  and never throws; an id nothing answers to now returns
  `{ ok: false, status: 'unknown-skill' }` (and is logged by the app's launch
  path) where it used to be a silent no-op. New mirrored types:
  `ModuleSkillRegistration`, `ModuleSkillTargetPolicy`,
  `EnsureSkillInstalledResult`.

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

- The four module-boundary surfaces. Each was discovered separately by
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

- Top-bar items on `RendererHost`:
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

- MCP tool contributions on `MainHost`:
  `registerMcpTools(tools: McpToolRegistration[])` puts agent-facing MCP tools
  on SprintEngine's always-on Studio gateway, owned by your module's id the way
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

- Global door surfaces on `RendererHost`:
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

- Per-module workspace state on `RendererHost`:
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

- Live runtime surfaces on `RendererHost` (the extraction blocker
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

- Module-owned workspace-creation config steps:
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

- Workspace supervisors + sidebar run glyphs published on
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
- Module command scopes + availability: `CommandScope` and
  `CommandAvailability` are open at the type level (`(string & {})`) — the
  shell derives a module's `panel:<moduleId>` scope from the workspace-type
  registry and activates it while a workspace of that module's mode is
  active. `ModuleCommandDefinition.availability` now also accepts a predicate
  over the published `ModuleCommandContext`
  (`{ activeWorkspaceId, activeWorkspaceMode }`) — "offer this only when…"
  without a shell enum change; predicate commands fail closed when no context
  is wired. Panel-targeted dispatch stays the module bus pattern (a
  `sprintengine:panel-command` CustomEvent from the command's `run()`), now the
  documented convention. In-tree proof: Switchboard/Watchtower's built-in
  commands are registered through this path.
- Per-module, per-workspace storage: `getModuleStorage(host)` →
  `{ get, set, delete, list }` scoped to your module, with host-owned file
  placement (workspace `.sprintengine/modules/<moduleId>/<key>.json`, or
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

- File-drop drag-and-drop contract: `SPRINTENGINE_FILE_DROP_MIME`,
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
  covers this SDK package only, not the SprintEngine app or marketplace terms.
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
  dropped into `~/.sprintengine/plugins/<id>/`, or installed from
  Settings → Agents → "Install CLI from folder".
- `validateCliPluginManifest` is the **single source of truth** for CLI
  manifest validation: the SprintEngine app loads a `plugin.json` by delegating to
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

- New `sprintengine-module` CLI (`bin`): `keygen` (ed25519 PKCS#8 PEM keypair),
  `pack` (validate + assemble an installable module directory; excludes
  node_modules, .git, and key material), `sign` (detached ed25519 signature
  over the canonical manifest, normalized manifest written back to disk),
  `verify` (checks a module directory exactly like the SprintEngine app).
- New `@sprintengine/module-sdk/signing` subpath export:
  `generateModuleSigningKeyPair`, `signManifest`, `verifyModuleSignature`,
  `manifestFingerprint`, `publicKeyFingerprint`. The SprintEngine app's verifier
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
