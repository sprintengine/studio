import type { ComponentType, LazyExoticComponent } from 'react'

import type { ModuleEventEnvelope } from '../../../shared/modules/events'
import type { CapabilityManifest, ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'
import { COMMAND_REGISTRY } from '../commands/commandRegistry'
import { collapseDuplicateKeybindings } from '../commands/keybindings'
import type { CommandAvailability, CommandContribution, CommandScope, ModuleCommandContext } from '../commands/types'
import type {
  AppNotification,
  DiagnosticSource,
  FuturePlanWorkspaceSource,
  LayoutTemplate,
} from '../types/workspace'
import type { BacklogItem, BacklogItemLink, BacklogItemStatus, BacklogResolvedLink } from '../utils/backlog'
import type { ModuleWorkspaceView } from '../../../shared/modules/workspace-view'
import { AGENT_RUNTIME_MODULE_ID } from '../../../shared/backlog/agent-links'
import type { WorkspaceFileWatcher, WorkspaceFileWatchEvent } from './workspace-file-watch'
import type { AgentSessionWatcher, ModuleAgentSessionView } from './agent-session-watch'
import type {
  ModuleAgentRuntimeOption,
  ModuleAgentSpawner,
  ModuleFocusTabInput,
  ModuleSpawnAgentInput,
  ModuleSpawnAgentResult,
} from './agent-spawn'
import type {
  WorkspaceRunGlyph,
  WorkspaceRunGlyphProviderInput,
} from '../utils/workspaceRunGlyph'

// Renderer-side host kernel. Mirrors the main-process MainHost: capability
// modules register their contributions (panels for now) into shared registries
// instead of the hardcoded factory switch + lazy-import block in
// WorkspaceLayout.tsx. Enablement is computed reactively from settings so a
// feature can be toggled without a reload.
//
// See future-plans/2026-05-28-feature-level-pluggable-architecture.md.

export type WorkspacePanelProps = {
  workspaceId: string
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
}

// A panel may be an eager component or a React.lazy() wrapper; both render the
// same way in JSX, and lazy keeps a disabled feature's bundle off the wire.
export type WorkspacePanelComponent =
  | ComponentType<WorkspacePanelProps>
  | LazyExoticComponent<ComponentType<WorkspacePanelProps>>

export type WorkspaceTypeIconComponent = ComponentType<{ className?: string }>

export type WorkspaceTypeTopBarView = {
  component: string
  name: string
}

export type WorkspaceTypeSupervisorScope = 'global' | 'all-windows'

export type WorkspaceTypeSupervisorComponent =
  | ComponentType
  | LazyExoticComponent<ComponentType>

export type WorkspaceTypeSupervisor = {
  Component: WorkspaceTypeSupervisorComponent
  scope: WorkspaceTypeSupervisorScope
}

// A module-owned config step in the workspace-creation hub. One step per type
// (v1): the hub renders it as the flow's one config page after the shared
// name/folder fields, holds the value shell-side for the pane's lifetime only,
// and hands it to createTemplate(context) on create — nothing is persisted by
// the shell. A throwing Component degrades to the type's zero-config flow
// (standard error surface), never a blocked hub.
export type WorkspaceCreationStepProps = {
  value: unknown
  setValue: (value: unknown) => void
}

export type WorkspaceCreationStepComponent =
  | ComponentType<WorkspaceCreationStepProps>
  | LazyExoticComponent<ComponentType<WorkspaceCreationStepProps>>

export type WorkspaceTypeCreationStep = {
  id: string
  /** Page title in the hub pane. */
  heading: string
  /** One-line page subtitle. */
  description?: string
  Component: WorkspaceCreationStepComponent
  /** Gates the Create button; absent means the step never blocks creation. */
  isReady?: (value: unknown) => boolean
  /** Footer hint while isReady is false, e.g. "Name a city to forecast." */
  blockedHint?: string
}

/** Context handed to createTemplate on create. */
export type WorkspaceTypeCreateContext = {
  /** The module creation step's collected value; undefined without a step. */
  stepValue?: unknown
}

// What the hub hands a type's async create hook (MC-2090). `createTemplate` is
// synchronous by design — it answers "what layout?" — so a type whose creation
// is real orchestration (probe a source, materialize it on disk, roll back on
// failure) had nowhere to put that work and left the hub driving it through a
// hard-coded branch. This is the contribution point for it.
export type WorkspaceTypeCreateRequest = {
  /** The name field's value, untrimmed. Empty means the user named nothing. */
  name: string
  /** The materialized folder. The hub creates/opens it before calling. */
  folderPath: string
  /** The creation step's collected value; undefined without a step. */
  stepValue?: unknown
  /**
   * Write back into the creation step's value. The step is where a module
   * renders its own failure (it owns that page's body), and the step value is
   * the one piece of state the two halves share — so a hook that fails puts
   * the reason here rather than throwing prose at a shell error surface.
   */
  setStepValue: (value: unknown) => void
}

// The shell capabilities an async create hook may use. Deliberately two: mint
// this type's workspace, and take it back. Anything else the module wants it
// does through its own surfaces.
export type WorkspaceTypeCreateHost = {
  /**
   * Create the workspace from this type's `createTemplate` and return its id —
   * the same row the zero-config path would have made. `name` overrides the
   * request's (use it for the type's own fallback, e.g. "Review"); the step
   * value reaches `createTemplate` either way.
   */
  createWorkspace(input?: { name?: string }): string
  /** Remove a workspace this hook created. The rollback half of the pair. */
  removeWorkspace(workspaceId: string): void
}

export type WorkspaceTypeDefinition = {
  id: string
  label: string
  description: string
  icon: WorkspaceTypeIconComponent
  accentToken?: string
  searchTerms?: string[]
  createTemplate(context?: WorkspaceTypeCreateContext): LayoutTemplate
  /**
   * Own this type's create action (MC-2090). When present the hub calls this
   * instead of creating the workspace itself: resolve to mean "created, close
   * the hub"; reject to leave the hub open with the create still available.
   * Call `host.createWorkspace()` to mint the row (that is what runs
   * `createTemplate`) and `host.removeWorkspace(id)` to roll it back — a create
   * that fails after minting must not leave an empty workspace behind.
   * Absent ⇒ the hub creates from `createTemplate` directly, unchanged.
   */
  createWorkspace?(request: WorkspaceTypeCreateRequest, host: WorkspaceTypeCreateHost): Promise<void>
  topBarViews?: {
    label: string
    views: WorkspaceTypeTopBarView[]
  }
  isRunGlyphProviderForWorkspace?(workspace: WorkspaceRunGlyphProviderInput): boolean
  deriveRunGlyph?(workspace: WorkspaceRunGlyphProviderInput): WorkspaceRunGlyph | null
  supervisors?: WorkspaceTypeSupervisor[]
  /** The type's config step in the creation hub (one per type in v1). */
  creationStep?: WorkspaceTypeCreationStep
  creationStepsId?: string
  pickerOrder?: number
  /**
   * Keep the type registered (so its runtime workspaces still resolve, render,
   * and get created programmatically) but withhold it from the new-workspace
   * creation picker. For a runtime-only container the user never creates by hand
   * — the `automations-host` mode, whose automations are created from the
   * full-page Automations door, not the picker (global-surfaces epic 1704). The
   * picker analog of `isHiddenFromRail`.
   */
  hiddenFromPicker?: boolean
}

export type RegisteredWorkspaceTypeDefinition = WorkspaceTypeDefinition & {
  moduleId: string
}

export type BacklogItemActionCategory = 'execute' | 'analyze' | 'transform' | 'publish' | 'review' | 'organize'

export type BacklogItemActionContext = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItem
  readSource(): Promise<string>
  updateStatus(status: BacklogItemStatus): Promise<void>
  addLink(link: BacklogItemLink): Promise<void>
  updateModuleMetadata(moduleId: string, value: unknown): Promise<void>
  startSourcePlan?(source: FuturePlanWorkspaceSource): void
  /**
   * Present when the context menu was opened on a multi-selection (MC-2060):
   * every selected item in list order — `item` is the anchor row and is always
   * one of them, and all of them are from the row's own project — plus that
   * project's full scanned item set for epic-membership expansion. Actions
   * that ignore this field keep their single-item behavior against `item`.
   */
  selection?: {
    items: ReadonlyArray<BacklogItem>
    projectItems: ReadonlyArray<BacklogItem>
  }
}

export type BacklogItemActionState = 'enabled' | 'disabled'

export type BacklogItemAction = {
  id: string
  label: string
  category: BacklogItemActionCategory
  order?: number
  /** Selection-aware display label; falls back to `label` when absent. */
  getLabel?: (context: BacklogItemActionContext) => string
  isVisible?: (context: BacklogItemActionContext) => boolean
  getState?: (context: BacklogItemActionContext) => BacklogItemActionState
  run: (context: BacklogItemActionContext) => void | Promise<void>
}

export type RegisteredBacklogItemAction = BacklogItemAction & {
  moduleId: string
}

export type BacklogLinkProviderInput = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItem
  link: BacklogItemLink
}

export type BacklogLinkProvider = {
  moduleId: string
  targetKinds: string[]
  resolveLinkStatus(input: BacklogLinkProviderInput): Promise<BacklogResolvedLink>
  openLink?(input: BacklogLinkProviderInput): Promise<void | boolean>
}

// A deep-link action a module contributes for its own notifications. Mirrors
// registerBacklogItemAction: the provider is keyed by the notification `source`
// it owns, enablement-gated, and returns serializable-data-driven actions. An
// action's run() composes shell capabilities (revealWorkspace) — the
// notification record itself never carries a callback (it persists to
// localStorage). The shell supplies a generic workspace-reveal fallback when no
// provider matches, so Open works for every workspace type; a provider only
// adds deeper focus on top.
export type NotificationActionContext = {
  notification: AppNotification
  /** Shell capability: switch the active workspace in the current window. */
  revealWorkspace(workspaceId: string): void
}

export type NotificationAction = {
  id: string
  label: string
  isVisible?(context: NotificationActionContext): boolean
  run(context: NotificationActionContext): void | Promise<void>
}

export type NotificationActionProvider = {
  /** The notification source this provider owns (e.g. 'sprintengine'). */
  source: DiagnosticSource
  resolveActions(context: NotificationActionContext): NotificationAction[]
}

export type RegisteredNotificationActionProvider = NotificationActionProvider & {
  moduleId: string
}

// A command contributed by a module. Unlike shell CommandDefinitions, module
// commands carry their handler callback directly — handlerPath indirection is
// a shell-internal idiom. The registered command id is namespaced
// `<moduleId>.<id>`, so user keybinding overrides persist by full id and
// survive module disable/enable cycles (storage keeps them; consumers filter
// by enablement instead).
export type ModuleCommandDefinition = {
  /** Bare command id; the registered id becomes `<moduleId>.<id>`. */
  id: string
  title: string
  /** Grouping label in the palette and Shortcuts settings, e.g. the module's display name. */
  category: string
  /**
   * `panel:<moduleId>` gates on "a workspace whose mode belongs to my module
   * is active" — the shell derives it from the workspace-type registry.
   */
  scopes: readonly CommandScope[]
  defaultKeybindings?: readonly string[]
  /**
   * Either shell availability preconditions, or a predicate over the
   * published `ModuleCommandContext` view — the module path for "offer this
   * only when…" without growing the shell's availability enum per module.
   */
  availability?: readonly CommandAvailability[] | ((context: ModuleCommandContext) => boolean)
  allowInEditableTarget?: boolean
  run: () => void | Promise<void>
}

export type RegisteredModuleCommand = CommandContribution & {
  moduleId: string
  run: () => void | Promise<void>
}

// A Settings overlay section contributed by a module. The host owns
// persistence: section values live in the module's `module:<id>` namespace
// inside the existing app-settings storage (never a new store or file), so
// they survive module disable/enable cycles and app restarts.
export type SettingsSectionProps = {
  values: Readonly<Record<string, unknown>>
  /** Persist one value in the module's namespace; `undefined` deletes the key. */
  setValue: (key: string, value: unknown) => void
}

export type SettingsSectionComponent =
  | ComponentType<SettingsSectionProps>
  | LazyExoticComponent<ComponentType<SettingsSectionProps>>

// Brand constraint: icons follow the house glyph pattern (24×24 viewBox,
// fill="none", currentColor strokes). The Settings rail sizes and tints the
// glyph via className; a module must not bake in its own colors.
export type SettingsSectionIconComponent = ComponentType<{ className?: string }>

export type SettingsSectionDefinition = {
  id: string
  label: string
  /** One-line rail description; the overlay falls back to naming the owning module. */
  description?: string
  icon: SettingsSectionIconComponent
  /** Eager component or React.lazy() wrapper, mirroring WorkspacePanelComponent. */
  Component: SettingsSectionComponent
  /** Sort hint among contributed sections; built-in tabs always render first. */
  order?: number
}

export type RegisteredSettingsSection = SettingsSectionDefinition & {
  moduleId: string
}

// Read-only workspace snapshot for module code: the id → root/name/mode
// resolution both processes need for per-workspace persistence and scoped
// services. Deliberately a snapshot, not a subscription — live workspace state
// stays a separate surface. The declaration + mapping live in
// shared/modules/workspace-view so the renderer and main surfaces can't drift.
export type { ModuleWorkspaceView } from '../../../shared/modules/workspace-view'

// A top-nav door a module contributes to the workspace sidebar's instance-level
// nav cluster (the band that holds New chat, Automations, Sprints, Connectors).
// The entry is a self-contained row component so it owns its full behavior —
// a status dot, an open action against the LOCAL window's store, active-state —
// exactly like the shell's own doors; the host only owns placement + gating.
// Consumers filter by the owning module's enablement and sort by `order`, so a
// module toggle adds/removes its door without a reload, at a deterministic slot.
export type SidebarNavEntryRenderProps = {
  /** The sidebar is collapsed to the icon rail; render icon-only with a tooltip. */
  collapsed: boolean
}

export type SidebarNavEntryComponent =
  | ComponentType<SidebarNavEntryRenderProps>
  | LazyExoticComponent<ComponentType<SidebarNavEntryRenderProps>>

export type SidebarNavEntryDefinition = {
  id: string
  /**
   * Sort key within the top-nav cluster; lower renders first. The shell's
   * built-in doors reserve Create=0, Automations=10, Sprints=20, Connectors=30,
   * so a module door slots deterministically around them (Roadmap uses 40, after
   * Connectors). Ties break on id.
   */
  order: number
  /** The row. Rendered as its own element so it may use hooks and own its behavior. */
  Component: SidebarNavEntryComponent
}

export type RegisteredSidebarNavEntry = SidebarNavEntryDefinition & {
  moduleId: string
}

// A control a module contributes to the app's top bar (the title-strip control
// cluster WorkspaceActions renders). Mirrors registerSidebarNavEntry: the item
// is a self-contained zero-prop component that owns its full behavior — state,
// tooltip, action — exactly like the shell's own top-bar controls; the host
// only owns placement + gating. Consumers filter by the owning module's
// enablement and sort by `order`, so a module toggle adds/removes its control
// live, without a reload, at a deterministic slot.
export type TopBarItemComponent =
  | ComponentType
  | LazyExoticComponent<ComponentType>

export type TopBarItemDefinition = {
  id: string
  /**
   * Sort key among contributed top-bar items; lower renders first, ties break
   * on id. The shell's own controls are not part of this ordering — contributed
   * items render together in the bar's module slot (after Notifications).
   */
  order: number
  /** The control. Rendered as its own element so it may use hooks and own its behavior. */
  Component: TopBarItemComponent
}

export type RegisteredTopBarItem = TopBarItemDefinition & {
  moduleId: string
}

// A door-routed full-page surface a module contributes (global-surfaces epic
// 1704). The companion to a sidebar nav door: the door calls
// `openGlobalSurface(id)` on the local window's store, and WorkspaceManager
// mounts the surface registered under that same id over the workspace card
// region (gated on the owning module's enablement). Splitting the surface
// component out of the shell is what lets the Automations/Reviews door tasks
// register their page without editing WorkspaceManager/WorkspaceSidebar. The
// component is zero-prop and owns its own data/state, exactly like a panel.
export type GlobalSurfaceComponent =
  | ComponentType
  | LazyExoticComponent<ComponentType>

export type GlobalSurfaceDefinition = {
  /** Matches the id the door opens via `openGlobalSurface`. Non-empty; unique. */
  id: string
  /** The full-page surface. Eager or React.lazy(), mirroring WorkspacePanelComponent. */
  Component: GlobalSurfaceComponent
}

export type RegisteredGlobalSurface = GlobalSurfaceDefinition & {
  moduleId: string
}

// A modal surface a module contributes (doors→modals, 2026-09-01). The modal
// counterpart to a door's nav-entry + global-surface pair: the surface mounts
// inside the shell's modal shell over whatever the window is showing, and its
// trigger is a glyph button the shell renders in the sidebar footer's settings
// cluster. One registration owns both halves — the shell owns trigger placement,
// tooltip wiring, and the modal chrome (width step, flat scrim, focus trap,
// close semantics); the module owns only the body. The body is zero-prop and
// exits through SurfaceExitContext, exactly as it would through a door's back
// chevron.
export type ModalSurfaceIconComponent = ComponentType<{ className?: string }>

export type ModalSurfaceDefinition = {
  /** Matches the id opened via `openModalSurface`. Non-empty; unique. */
  id: string
  /** Sort key among trigger glyphs in the settings cluster; lower renders first, ties break on id. */
  order: number
  /**
   * The trigger's tooltip and accessible name, and the dialog's accessible
   * name — user-facing copy, decoupled from the id ("Plugins" over id
   * `extensions`). Non-empty; sentence case.
   */
  label: string
  /** The trigger glyph; the shell sizes it via className. */
  Icon: ModalSurfaceIconComponent
  /**
   * Called just before the shell opens this modal from its trigger glyph — a
   * PLAIN open, landing on the surface's default view. Discard stale deep-link
   * latches here (the Plugins surface drains a pending view target on mount,
   * so a latch left by a dispatch that never mounted would otherwise reroute a
   * plain open). Deep-link openers dispatch their own state and bypass this.
   */
  onOpen?: () => void
  /** The modal body. Eager or React.lazy(), mirroring GlobalSurfaceComponent. */
  Component: GlobalSurfaceComponent
}

export type RegisteredModalSurface = ModalSurfaceDefinition & {
  moduleId: string
}

// The single tenant of the right-docked workspace aside column (MC-1766). The
// column is app-level chrome outside the workspace card, so unlike panels and
// door surfaces there is exactly ONE slot — a second claimant would have to
// fight the first for the same strip of window. Registration is single-slot and
// ownership-guarded like `provideBacklogReader`; WorkspaceAsideMount owns the
// width, the resize edge, and the landmark, and this component fills it.
export type WorkspaceAsideDefinition = {
  /** Stable id for the tenant, for diagnostics and duplicate reporting. */
  id: string
  /** Accessible name for the column landmark, e.g. "Skills". Non-empty. */
  label: string
  /** The column's content. Eager or React.lazy(), mirroring GlobalSurfaceDefinition. */
  Component: GlobalSurfaceComponent
}

export type RegisteredWorkspaceAside = WorkspaceAsideDefinition & {
  moduleId: string
}

// An agent-id namespace a module claims (MC-2090). A module that spawns agents
// outside a window's knowledge — a background guide, a companion — owns ids the
// shell then has to reason about without knowing whose they are: what to call
// the session when no workspace row claims it, and whether the id is one it may
// adopt onto a workspace. Both questions used to be answered by core importing
// the module's own `isXAgentId` predicate; this is the seam that replaces it.
export type AgentIdNamespaceDefinition = {
  /**
   * Every agent id starting with this belongs to the claiming module. Keep it
   * distinctive and terminated (`'review-guide-'`, not `'review'`) so it cannot
   * swallow a sibling's ids.
   */
  prefix: string
  /**
   * What the shell calls sessions in this namespace that no workspace claims,
   * e.g. "Reviews". Sentence case; it is a group name in a session list.
   */
  label: string
}

export type RegisteredAgentIdNamespace = AgentIdNamespaceDefinition & {
  moduleId: string
}

// Read access to the workspace's Backlog for module renderers. The kernel owns
// only the seam: the backlog module provides the implementation (shared scan +
// watcher), and the scoped host methods below route through it — the kernel
// never imports backlog internals.
export type BacklogReader = {
  list(workspaceId: string): Promise<BacklogItem[]>
  /** Fires once with the current snapshot, then on every change; returns the unsubscriber. */
  watch(workspaceId: string, cb: (items: BacklogItem[]) => void): () => void
}

// Backing store for the per-module workspace-state accessors (MC-1573). The
// kernel owns only the seam: modules/index.ts wires it over the workspace
// store's `Workspace.moduleState` bag, and the scoped host methods route
// through it with the owning module's id — the kernel never imports the store.
export type WorkspaceModuleStateStore = {
  get(workspaceId: string, moduleId: string): unknown
  /** False when the write was not stored (unknown workspace, reserved key). */
  set(workspaceId: string, moduleId: string, state: unknown): boolean
}

// Backing store for the app-level module-state accessors (MC-2090). Same seam
// shape as WorkspaceModuleStateStore, one scope up: modules/index.ts wires it
// over the app-settings `module:<id>` namespace that already backs contributed
// Settings sections, so a module's app-level state and its settings section
// share one keyspace and one persistence path.
export type ModuleAppStateStore = {
  /** The module's whole namespace; `{}` when it has never written. */
  get(moduleId: string): Readonly<Record<string, unknown>>
  /** False when the write was not stored (empty key, store not wired). */
  set(moduleId: string, key: string, value: unknown): boolean
  /** Fires whenever the module's namespace changes. Returns the unsubscriber. */
  subscribe(moduleId: string, cb: (values: Readonly<Record<string, unknown>>) => void): () => void
}

// Source of main→renderer module events (MC-2090). The kernel owns only the
// seam: modules/index.ts wires it over `window.api.onModuleEvent`, and the
// scoped host's `subscribe` filters the stream to the calling module's own
// events. One preload listener backs every module's subscriptions.
export type ModuleEventSource = (cb: (envelope: ModuleEventEnvelope) => void) => () => void

export type RendererHost = {
  registerPanel(componentId: string, component: WorkspacePanelComponent): void
  registerWorkspaceType(definition: WorkspaceTypeDefinition): void
  registerBacklogItemAction(action: BacklogItemAction): void
  registerBacklogLinkProvider(provider: BacklogLinkProvider): void
  registerNotificationActionProvider(provider: NotificationActionProvider): void
  registerCommand(definition: ModuleCommandDefinition): void
  registerSettingsSection(definition: SettingsSectionDefinition): void
  /**
   * Contribute a top-nav door to the workspace sidebar's instance-level nav
   * cluster. Registered unconditionally at boot; the sidebar filters by this
   * module's enablement and orders by `order`, so a module toggle shows/hides
   * the door without a reload. The row acts on the local window's store.
   */
  registerSidebarNavEntry(definition: SidebarNavEntryDefinition): void
  /**
   * Contribute a control to the app's top bar (the title-strip control
   * cluster). Registered unconditionally at boot; the bar filters by this
   * module's enablement and orders by `order`, so a module toggle shows/hides
   * the control without a reload. Duplicate ids throw.
   */
  registerTopBarItem(definition: TopBarItemDefinition): void
  /**
   * Contribute a door-routed full-page surface (global-surfaces epic 1704),
   * mounted by WorkspaceManager over the workspace card region when a door
   * opens it via `openGlobalSurface(id)`. Registered unconditionally at boot;
   * the mount gates on this module's live enablement. Duplicate ids throw.
   */
  registerGlobalSurface(definition: GlobalSurfaceDefinition): void
  /**
   * Contribute a modal surface: a body the shell mounts in its modal shell
   * when `openModalSurface(id)` opens it, plus a trigger glyph the shell
   * renders in the sidebar footer's settings cluster. Registered
   * unconditionally at boot; the trigger and mount gate on this module's
   * enablement, so a module toggle shows/hides both without a reload.
   * Duplicate ids throw.
   */
  registerModalSurface(definition: ModalSurfaceDefinition): void
  /**
   * Claim the right-docked workspace aside column (MC-1766). A single slot:
   * the second module to claim it throws, naming the module that holds it. The
   * mount gates on this module's live enablement. No module claims it today.
   */
  registerWorkspaceAside(definition: WorkspaceAsideDefinition): void
  /**
   * Invoke an IPC channel this module's own `entry.main` registered via
   * `MainHost.registerIpc`. The channel must be `<moduleId>:`-prefixed —
   * validated here before any IPC, and again by the main-side dispatcher,
   * which also requires the owning module to be third-party and to declare
   * the `ipc:invoke` permission. A contract, not a security boundary.
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>
  /**
   * Provide the Backlog read implementation (backlog module only — a single
   * slot, ownership-guarded like registerBacklogLinkProvider).
   */
  provideBacklogReader(reader: BacklogReader): void
  /** The workspace's Backlog items (read-only views; mutate via BacklogItemActionContext). */
  listBacklogItems(workspaceId: string): Promise<BacklogItem[]>
  /** Observe the workspace's Backlog: fires with the current snapshot, then on change. */
  watchBacklogItems(workspaceId: string, cb: (items: BacklogItem[]) => void): () => void
  /**
   * Resolve a workspace id to its read-only view. Null means "not currently
   * resolvable" — an unknown id, or early boot before the shell wires the
   * resolver — never a throw and never a deletion signal.
   * Disclosure permission: `ipc:workspace-read`.
   */
  getWorkspace(workspaceId: string): Promise<ModuleWorkspaceView | null>
  /**
   * Your module's entry in the workspace's per-module state bag (MC-1573).
   * Scoped to the calling module — one module can never read another's entry
   * through this surface. `undefined` means no state is recorded for this
   * workspace, the workspace id is unknown, or the shell hasn't wired the
   * store yet (early boot, tests) — never a throw and never a deletion
   * signal; retry later instead of discarding state. Entries persist with the
   * workspace and sync across windows. Disclosure permission: `storage`.
   */
  getWorkspaceModuleState<T = unknown>(workspaceId: string): T | undefined
  /**
   * Replace your module's entry in the workspace's per-module state bag;
   * null/undefined removes it. Keep entries JSON-serializable — they persist
   * into the workspace registry verbatim. False means the write was NOT
   * stored (unknown workspace id, or the shell hasn't wired the store yet) —
   * surface it or retry; never assume success. Disclosure permission:
   * `storage`.
   */
  setWorkspaceModuleState(workspaceId: string, state: unknown): boolean
  /**
   * Read one key from your module's APP-level state (MC-2090) — the scope
   * above `getWorkspaceModuleState`, for state that belongs to the module
   * rather than to any one workspace: remembered defaults, the last thing the
   * user opened. Synchronous and store-backed, so a renderer selector can
   * derive from it without an IPC round trip changing render timing.
   * `undefined` means the key has never been set (or the shell has not wired
   * the store yet, at early boot) — never a throw and never a deletion signal.
   * Scoped to the calling module: one module can never read another's.
   * Persists with app settings and survives a disable/enable cycle.
   * Disclosure permission: `storage`.
   */
  getModuleAppState<T = unknown>(key: string): T | undefined
  /**
   * Write one key in your module's app-level state; `undefined` deletes it.
   * Keep values JSON-serializable — they persist into app settings verbatim.
   * False means the write was NOT stored (empty key, or the shell has not
   * wired the store yet) — surface it or retry; never assume success.
   * Disclosure permission: `storage`.
   */
  setModuleAppState(key: string, value: unknown): boolean
  /**
   * Observe your module's app-level state: `cb` fires with the current values
   * on every change (not on subscribe — read the current value with
   * `getModuleAppState`). Returns the unsubscriber; call it on unmount. Pair
   * the two with `useSyncExternalStore` for a reactive read.
   */
  watchModuleAppState(cb: (values: Readonly<Record<string, unknown>>) => void): () => void
  /**
   * Subscribe to events your module's `entry.main` pushed with
   * `MainHost.emit` (MC-2090) — the subscribe verb `invoke` does not have.
   * Scoped to your module: another module's events never reach you, and yours
   * never reach it. `cb` receives the emitted payload. Returns the
   * unsubscriber; call it on unmount. Nothing is replayed, so a subscriber
   * must be correct having missed every event emitted before it subscribed —
   * read current state through an invoke and let events keep it fresh. See the
   * delivery contract in shared/modules/events.ts.
   */
  subscribe(topic: string, cb: (payload: unknown) => void): () => void
  /**
   * Claim an agent-id namespace for your module (MC-2090): every agent id
   * starting with `prefix` is yours, and `label` is what the shell calls those
   * sessions where no workspace claims them. Without this, an agent your
   * module spawned outside a window's knowledge is an unlabelled, unadoptable
   * session. Registered once at boot; the shell gates on your module's live
   * enablement. A prefix that overlaps one another module already claimed is a
   * registration error. Disclosure permission: `ipc:agents`.
   */
  registerAgentIdNamespace(definition: AgentIdNamespaceDefinition): void
  /**
   * The workspace's *effective working root*: where its live work happens.
   * `ModuleWorkspaceView.folderPath` deliberately reports the durable primary
   * checkout; a worktree-backed workspace (sprint runs) does live work under a
   * worktree, and this resolves that root. The live-runtime methods below
   * (`watchWorkspaceFile`, `spawnAgent`, `focusTab`) resolve workspace-relative
   * paths against it. Null means "not currently resolvable" — never a throw.
   * Disclosure permission: `ipc:workspace-read`.
   */
  getWorkingRoot(workspaceId: string): Promise<string | null>
  /**
   * Watch one workspace-relative file (resolved against the effective working
   * root): the callback fires once with the current content (null when the
   * file doesn't exist), then debounced on every change. Rejects with a named
   * cause for absolute/escaping paths, unknown/folderless workspaces, an
   * unwired backend (early boot, tests), or a disabled Agent Runtime module.
   * Resolve the returned closure's promise, keep it, and call it on unmount.
   * Disclosure permission: `filesystem:read-workspace`.
   */
  watchWorkspaceFile(
    workspaceId: string,
    relativePath: string,
    cb: (event: WorkspaceFileWatchEvent) => void
  ): Promise<() => void>
  /**
   * Observe the workspace's live agent sessions: `cb` fires once with the
   * current read-only views, then on every change (deduped). Returns the
   * unsubscriber — call it on unmount. Throws with a named cause before the
   * shell wires the session source or while the Agent Runtime module is
   * disabled. Disclosure permission: `ipc:agents`.
   */
  watchAgentSessions(workspaceId: string, cb: (sessions: ModuleAgentSessionView[]) => void): () => void
  /**
   * Spawn an agent session through the SHARED session runtime (the same path
   * every shell surface uses) and add its tab to the workspace layout.
   * Structured result, never a throw for expected failures (unknown
   * workspace, folderless workspace, unavailable runtime, spawn failure).
   * Rejects with a named cause before the shell wires the backend or while
   * the Agent Runtime module is disabled. Disclosure: `ipc:agents`.
   */
  spawnAgent(input: ModuleSpawnAgentInput): Promise<ModuleSpawnAgentResult>
  /**
   * Focus a workspace tab: an agent's terminal tab (added if missing) or a
   * file tab by workspace-relative path (false when not open/focusable).
   * Throws with a named cause when agent runtime is unavailable.
   */
  focusTab(input: ModuleFocusTabInput): boolean
  /**
   * The agent runtimes currently available to spawn: ids + display labels
   * only (installed CLIs, from the same availability-filtered catalog the
   * shell's pickers use) — plugin internals stay unexposed. Throws with a
   * named cause when agent runtime is unavailable.
   */
  listAgentRuntimes(): ModuleAgentRuntimeOption[]
}

// The kernel owns the registries and is consumed by the factory/rail. Modules
// register through a scoped `hostFor(moduleId)` (mirroring the main-process
// MainKernel) so each panel records its owning module — that's what lets the
// factory gate a host panel by its module's enablement without a per-feature
// switch arm.
export type RendererKernel = {
  hostFor(moduleId: string): RendererHost
  getPanel(componentId: string): WorkspacePanelComponent | undefined
  /** The capability module that registered the panel, for enablement gating. */
  getPanelModule(componentId: string): string | undefined
  getWorkspaceType(id: string): RegisteredWorkspaceTypeDefinition | undefined
  getWorkspaceTypes(moduleEnabled?: (moduleId: string) => boolean): RegisteredWorkspaceTypeDefinition[]
  getWorkspaceTypeModule(id: string): string | undefined
  getBacklogItemActions(): RegisteredBacklogItemAction[]
  getBacklogLinkProviders(moduleEnabled?: (moduleId: string) => boolean): BacklogLinkProvider[]
  getNotificationActionProviders(
    moduleEnabled?: (moduleId: string) => boolean
  ): RegisteredNotificationActionProvider[]
  getModuleCommand(commandId: string): RegisteredModuleCommand | undefined
  getModuleCommands(moduleEnabled?: (moduleId: string) => boolean): RegisteredModuleCommand[]
  /**
   * The one merge point for the command pipeline: the static shell registry
   * followed by enabled module commands. The palette, the keyboard dispatcher,
   * and the Shortcuts settings tab all consume this so a module toggle removes
   * (and re-enabling restores) a command everywhere at once, without a reload.
   * Shell commands come first, so on a duplicate binding at equal scope
   * specificity the dispatcher keeps firing the built-in.
   */
  getCommandContributions(moduleEnabled?: (moduleId: string) => boolean): CommandContribution[]
  /**
   * Contributed Settings sections for enabled modules, in stable order
   * (order hint, then id) regardless of registration order, so the rail reads
   * the same across reloads. The overlay renders these after built-in tabs.
   */
  getSettingsSections(moduleEnabled?: (moduleId: string) => boolean): RegisteredSettingsSection[]
  /**
   * Contributed sidebar nav doors for enabled modules, sorted by `order` then
   * id so the top-nav cluster reads the same across reloads. The sidebar merges
   * these with its own built-in doors (Create/Automations/Sprints/Connectors),
   * which carry their own `order`, into one deterministic band.
   */
  getSidebarNavEntries(moduleEnabled?: (moduleId: string) => boolean): RegisteredSidebarNavEntry[]
  /**
   * Contributed top-bar controls for enabled modules, sorted by `order` then
   * id so the bar reads the same across reloads. WorkspaceActions renders
   * these in the bar's module slot, so a module toggle adds/removes a control
   * without a reload.
   */
  getTopBarItems(moduleEnabled?: (moduleId: string) => boolean): RegisteredTopBarItem[]
  /**
   * The full-page surface registered under `id`, with its owning module — so
   * WorkspaceManager can gate the mount on that module's enablement. Undefined
   * when no surface (or a disabled/absent module's surface) claims the id.
   */
  getGlobalSurface(id: string): RegisteredGlobalSurface | undefined
  /**
   * All contributed full-page surfaces for enabled modules, in stable order
   * (id) regardless of registration order. The mount resolves a single surface
   * by id; this listing exists for parity with the other registries.
   */
  getGlobalSurfaces(moduleEnabled?: (moduleId: string) => boolean): RegisteredGlobalSurface[]
  /**
   * The modal surface registered under `id`, with its owning module — so the
   * modal mount can gate on that module's enablement. Undefined when no
   * surface claims the id.
   */
  getModalSurface(id: string): RegisteredModalSurface | undefined
  /**
   * Contributed modal surfaces for enabled modules, sorted by `order` then id
   * so the settings-cluster trigger glyphs read the same across reloads.
   */
  getModalSurfaces(moduleEnabled?: (moduleId: string) => boolean): RegisteredModalSurface[]
  /**
   * The module claiming the workspace aside column, with its owning module so
   * the mount can gate on enablement. Undefined while the column is unclaimed —
   * the mount then renders nothing at all, never an empty column.
   */
  getWorkspaceAside(): RegisteredWorkspaceAside | undefined
  /**
   * The module namespace owning `agentId`, or undefined when no enabled module
   * claims it. The shell asks this instead of importing a module's own id
   * predicate — it is how a session no workspace claims gets a group label,
   * and how core knows an unrecorded agent id is adoptable.
   */
  getAgentIdNamespace(
    agentId: string,
    moduleEnabled?: (moduleId: string) => boolean
  ): RegisteredAgentIdNamespace | undefined
  /**
   * Enablement source for host methods that must gate on a module's live
   * enablement without a caller-supplied predicate (the Backlog read API).
   * Wired once at boot by modules/index.ts from the workspace store; absent
   * (early boot, tests) the reader's owning module is treated as enabled.
   */
  setModuleEnablementResolver(resolver: (moduleId: string) => boolean): void
  /**
   * Workspace-view source for `RendererHost.getWorkspace`. Wired once at boot
   * by modules/index.ts from the workspace store; absent (early boot, tests)
   * every lookup resolves to null.
   */
  setWorkspaceResolver(resolver: (workspaceId: string) => ModuleWorkspaceView | null): void
  /**
   * Backing store for the per-module workspace-state accessors (MC-1573).
   * Wired once at boot by modules/index.ts over the workspace store's bag;
   * absent (early boot, tests) reads resolve undefined and writes report
   * false. The kernel scopes every call by the owning module's id.
   */
  setWorkspaceModuleStateStore(store: WorkspaceModuleStateStore): void
  /**
   * Backing store for the app-level module-state accessors (MC-2090). Wired
   * once at boot by modules/index.ts over the app-settings `module:<id>`
   * namespace; until it lands reads resolve undefined and writes report false.
   * A watch registered before it lands is held by the kernel and attaches here,
   * because modules register synchronously at import and this wiring is a
   * microtask later. The kernel scopes every call by the owning module's id.
   */
  setModuleAppStateStore(store: ModuleAppStateStore): void
  /**
   * Source for `RendererHost.subscribe`. Wired once at boot by modules/index.ts
   * over `window.api.onModuleEvent`. The kernel owns the subscriber set, so ONE
   * listener on this source backs every module's subscriptions and a subscribe
   * made before the source lands still receives once it does — module code
   * never has to guard the wiring window. Absent (tests, windowless bundles)
   * nothing is delivered, which is indistinguishable from nothing being emitted.
   */
  setModuleEventSource(source: ModuleEventSource): void
  /**
   * Working-root source for `RendererHost.getWorkingRoot`. Wired once at boot
   * by modules/index.ts (store + worktree resolution); absent (early boot,
   * tests) every lookup resolves to null.
   */
  setWorkingRootResolver(resolver: (workspaceId: string) => string | null): void
  /**
   * File-watch backend for `RendererHost.watchWorkspaceFile`. Wired once at
   * boot by modules/index.ts over the shell's fs watch plumbing; absent
   * (tests, early boot) the host method rejects with a named cause.
   */
  setWorkspaceFileWatcher(watcher: WorkspaceFileWatcher): void
  /**
   * Agent-session source for `RendererHost.watchAgentSessions`. Wired once at
   * boot by modules/index.ts over the shell's terminal-sessions store.
   */
  setAgentSessionWatcher(watcher: AgentSessionWatcher): void
  /**
   * Spawn/focus/runtimes backend for the module agent surface. Wired once at
   * boot by modules/index.ts over the shared session runtime + layout
   * helpers + availability-filtered CLI catalog.
   */
  setAgentSpawner(spawner: ModuleAgentSpawner): void
}

const SHELL_COMMAND_IDS: ReadonlySet<string> = new Set(COMMAND_REGISTRY.map((command) => command.id))

export function createRendererHost(): RendererKernel {
  const panels = new Map<string, WorkspacePanelComponent>()
  const panelModules = new Map<string, string>()
  const workspaceTypes = new Map<string, RegisteredWorkspaceTypeDefinition>()
  const backlogItemActions = new Map<string, RegisteredBacklogItemAction>()
  const backlogLinkProviders = new Map<string, BacklogLinkProvider>()
  const notificationActionProviders = new Map<DiagnosticSource, RegisteredNotificationActionProvider>()
  const moduleCommands = new Map<string, RegisteredModuleCommand>()
  const settingsSections = new Map<string, RegisteredSettingsSection>()
  const sidebarNavEntries = new Map<string, RegisteredSidebarNavEntry>()
  const topBarItems = new Map<string, RegisteredTopBarItem>()
  const globalSurfaces = new Map<string, RegisteredGlobalSurface>()
  const modalSurfaces = new Map<string, RegisteredModalSurface>()
  const agentIdNamespaces = new Map<string, RegisteredAgentIdNamespace>()
  let workspaceAside: RegisteredWorkspaceAside | null = null
  let backlogReader: { moduleId: string; reader: BacklogReader } | null = null
  let moduleEnabledResolver: ((moduleId: string) => boolean) | null = null
  let workspaceResolver: ((workspaceId: string) => ModuleWorkspaceView | null) | null = null
  let workspaceModuleStateStore: WorkspaceModuleStateStore | null = null
  let moduleAppStateStore: ModuleAppStateStore | null = null
  // Both backings are wired a microtask after boot, but modules register
  // synchronously at import — so a module that subscribes inside
  // `registerRenderer` would silently get a dead subscription. The kernel owns
  // the subscriber sets instead and attaches to each backing when it lands, so
  // an early subscribe survives the wiring window. The event set also means ONE
  // source listener backs every module's subscriptions, however many there are.
  type ModuleEventSubscriber = { moduleId: string; topic: string; cb: (payload: unknown) => void }
  const moduleEventSubscribers = new Set<ModuleEventSubscriber>()
  let detachModuleEventSource: (() => void) | null = null
  type ModuleAppStateWatcher = {
    moduleId: string
    cb: (values: Readonly<Record<string, unknown>>) => void
    detach?: () => void
  }
  const moduleAppStateWatchers = new Set<ModuleAppStateWatcher>()

  const dispatchModuleEvent = (envelope: ModuleEventEnvelope): void => {
    for (const subscriber of [...moduleEventSubscribers]) {
      if (envelope.sourceModuleId !== subscriber.moduleId || envelope.topic !== subscriber.topic) continue
      // Live gate on every delivery, not just at subscribe (the Backlog watcher
      // pattern): a subscription stops receiving the moment the user disables
      // the owning module, and resumes on re-enable.
      if (moduleEnabledResolver && !moduleEnabledResolver(subscriber.moduleId)) continue
      try {
        subscriber.cb(envelope.payload)
      } catch (error) {
        // A throwing subscriber must not break the shared dispatch loop for
        // every other module on the one source listener.
        console.error(`[modules] event subscriber from module "${subscriber.moduleId}" threw:`, error)
      }
    }
  }

  const attachModuleAppStateWatcher = (watcher: ModuleAppStateWatcher): void => {
    if (!moduleAppStateStore || watcher.detach) return
    watcher.detach = moduleAppStateStore.subscribe(watcher.moduleId, watcher.cb)
  }
  let workingRootResolver: ((workspaceId: string) => string | null) | null = null
  let workspaceFileWatcher: WorkspaceFileWatcher | null = null
  let agentSessionWatcher: AgentSessionWatcher | null = null
  let agentSpawner: ModuleAgentSpawner | null = null
  const agentRuntimeDisabled = (): boolean =>
    moduleEnabledResolver !== null && !moduleEnabledResolver(AGENT_RUNTIME_MODULE_ID)
  // Shared gate for the live-runtime methods (MC-1535): the error names the
  // actual cause so a module author can tell "the shell has not wired this
  // backend yet" (early boot, tests) from "the user turned the Agent Runtime
  // module off". Before the enablement resolver lands the module is treated
  // as enabled, matching the Backlog gate's boot window.
  const requireAgentRuntime = <T>(backend: T | null, surface: string): T => {
    if (agentRuntimeDisabled()) {
      throw new Error(`${surface} is not available — the Agent Runtime module is disabled.`)
    }
    if (!backend) {
      throw new Error(`${surface} is not available — the shell has not wired the agent-runtime backend.`)
    }
    return backend
  }
  // Shared gate for the Backlog read methods: the error names the actual cause
  // so a module author can tell "nothing provides this" from "the user turned
  // the backlog module off".
  const requireBacklogReader = (): BacklogReader => {
    if (!backlogReader) {
      throw new Error('No Backlog reader is registered — the backlog module did not load.')
    }
    if (moduleEnabledResolver && !moduleEnabledResolver(backlogReader.moduleId)) {
      throw new Error('The Backlog module is disabled.')
    }
    return backlogReader.reader
  }
  const enabledModuleCommands = (moduleEnabled?: (moduleId: string) => boolean): RegisteredModuleCommand[] =>
    [...moduleCommands.values()]
      .filter((command) => !moduleEnabled || moduleEnabled(command.moduleId))
      .sort((a, b) => a.id.localeCompare(b.id))
  return {
    hostFor(moduleId) {
      return {
        registerPanel(componentId, component) {
          if (panels.has(componentId)) {
            throw new Error(`Renderer panel "${componentId}" is already registered.`)
          }
          panels.set(componentId, component)
          panelModules.set(componentId, moduleId)
        },
        registerWorkspaceType(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Workspace type id must be a non-empty string.')
          }
          if (definition.id === 'standard') {
            throw new Error('Workspace type "standard" is shell-owned and cannot be registered.')
          }
          if (workspaceTypes.has(definition.id)) {
            throw new Error(`Workspace type "${definition.id}" is already registered.`)
          }
          workspaceTypes.set(definition.id, { ...definition, moduleId })
        },
        registerBacklogItemAction(action) {
          if (backlogItemActions.has(action.id)) {
            throw new Error(`Backlog item action "${action.id}" is already registered.`)
          }
          backlogItemActions.set(action.id, { ...action, moduleId })
        },
        registerBacklogLinkProvider(provider) {
          if (provider.moduleId !== moduleId) {
            throw new Error(`Backlog link provider "${provider.moduleId}" must be registered by its owning module "${moduleId}".`)
          }
          if (provider.targetKinds.length === 0) {
            throw new Error(`Backlog link provider "${provider.moduleId}" must own at least one target kind.`)
          }
          const uniqueTargetKinds = new Set(provider.targetKinds)
          if (uniqueTargetKinds.size !== provider.targetKinds.length) {
            throw new Error(`Backlog link provider "${provider.moduleId}" declares duplicate target kinds.`)
          }
          for (const targetKind of provider.targetKinds) {
            const owner = backlogLinkProviders.get(targetKind)
            if (owner) {
              throw new Error(`Backlog link target kind "${targetKind}" is already owned by module "${owner.moduleId}".`)
            }
          }
          for (const targetKind of provider.targetKinds) {
            backlogLinkProviders.set(targetKind, provider)
          }
        },
        registerNotificationActionProvider(provider) {
          if (notificationActionProviders.has(provider.source)) {
            const owner = notificationActionProviders.get(provider.source)
            throw new Error(
              `Notification action provider for source "${provider.source}" is already registered by module "${owner?.moduleId}".`
            )
          }
          notificationActionProviders.set(provider.source, { ...provider, moduleId })
        },
        registerCommand(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Module command id must be a non-empty string.')
          }
          const commandId = `${moduleId}.${definition.id}`
          if (SHELL_COMMAND_IDS.has(commandId)) {
            throw new Error(`Command "${commandId}" is already registered by the application command registry.`)
          }
          if (moduleCommands.has(commandId)) {
            throw new Error(`Module command "${commandId}" is already registered.`)
          }
          if (definition.title.trim().length === 0) {
            throw new Error(`Module command "${commandId}" must have a non-empty title.`)
          }
          if (definition.scopes.length === 0) {
            throw new Error(`Module command "${commandId}" must declare at least one scope.`)
          }
          // The shell only ever activates `panel:<moduleId>` for a module's
          // workspaces (plus specific shell-pushed literals) — a typo'd panel
          // scope would register cleanly and then be permanently dead, so it
          // fails loudly here instead. In-tree scar: Watchtower is a second
          // surface of the switchboard module with its own shell-pushed scope.
          for (const scope of definition.scopes) {
            if (!scope.startsWith('panel:')) continue
            const allowed = scope === `panel:${moduleId}`
              || (moduleId === 'switchboard' && scope === 'panel:watchtower')
            if (!allowed) {
              throw new Error(
                `Module command "${commandId}" declares scope "${scope}", but the shell only activates "panel:${moduleId}" for module "${moduleId}" — the command would never be offered.`
              )
            }
          }
          // A function-form availability lands on the shared contribution
          // shape as `availabilityPredicate`, so the palette and dispatcher
          // evaluate it through the same gate as enum preconditions.
          const { availability, ...rest } = definition
          moduleCommands.set(commandId, {
            ...rest,
            ...(typeof availability === 'function'
              ? { availabilityPredicate: availability }
              : { availability }),
            id: commandId,
            moduleId,
            defaultKeybindings: definition.defaultKeybindings
              ? collapseDuplicateKeybindings(definition.defaultKeybindings)
              : undefined,
          })
        },
        registerSettingsSection(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Settings section id must be a non-empty string.')
          }
          const existing = settingsSections.get(definition.id)
          if (existing) {
            throw new Error(
              `Settings section "${definition.id}" is already registered by module "${existing.moduleId}".`
            )
          }
          settingsSections.set(definition.id, { ...definition, moduleId })
        },
        registerSidebarNavEntry(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Sidebar nav entry id must be a non-empty string.')
          }
          const existing = sidebarNavEntries.get(definition.id)
          if (existing) {
            throw new Error(
              `Sidebar nav entry "${definition.id}" is already registered by module "${existing.moduleId}".`
            )
          }
          sidebarNavEntries.set(definition.id, { ...definition, moduleId })
        },
        registerTopBarItem(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Top bar item id must be a non-empty string.')
          }
          const existing = topBarItems.get(definition.id)
          if (existing) {
            throw new Error(
              `Top bar item "${definition.id}" is already registered by module "${existing.moduleId}".`
            )
          }
          topBarItems.set(definition.id, { ...definition, moduleId })
        },
        registerGlobalSurface(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Global surface id must be a non-empty string.')
          }
          const existing = globalSurfaces.get(definition.id)
          if (existing) {
            throw new Error(
              `Global surface "${definition.id}" is already registered by module "${existing.moduleId}".`
            )
          }
          globalSurfaces.set(definition.id, { ...definition, moduleId })
        },
        registerModalSurface(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Modal surface id must be a non-empty string.')
          }
          // Core Settings never registers here (it must not be module-gated —
          // its own enablement toggles live inside it), so without this
          // reservation a module could claim the id, put a second glyph in the
          // cluster, and have it open core Settings.
          if (definition.id === 'settings') {
            throw new Error('Modal surface id "settings" is reserved for the app\'s own Settings.')
          }
          // Same reservation for the Diff popout (the pane-to-popup mechanism,
          // 2026-09-05): core, opened from the pane strip, never a trigger.
          if (definition.id === 'diff') {
            throw new Error('Modal surface id "diff" is reserved for the app\'s own Diff popout.')
          }
          if (definition.label.trim().length === 0) {
            throw new Error(`Modal surface "${definition.id}" must have a non-empty label.`)
          }
          const existing = modalSurfaces.get(definition.id)
          if (existing) {
            throw new Error(
              `Modal surface "${definition.id}" is already registered by module "${existing.moduleId}".`
            )
          }
          modalSurfaces.set(definition.id, { ...definition, moduleId })
        },
        registerAgentIdNamespace(definition) {
          const prefix = definition.prefix.trim()
          if (prefix.length === 0) {
            throw new Error('Agent id namespace prefix must be a non-empty string.')
          }
          if (definition.label.trim().length === 0) {
            throw new Error(`Agent id namespace "${prefix}" must have a non-empty label.`)
          }
          // Overlap, not equality: a prefix that contains — or is contained by —
          // an existing one makes ownership of a concrete id ambiguous, and the
          // resolver would answer by registration order rather than by design.
          for (const existing of agentIdNamespaces.values()) {
            if (prefix.startsWith(existing.prefix) || existing.prefix.startsWith(prefix)) {
              throw new Error(
                `Agent id namespace "${prefix}" overlaps "${existing.prefix}", already claimed by module "${existing.moduleId}".`
              )
            }
          }
          agentIdNamespaces.set(prefix, { ...definition, prefix, moduleId })
        },
        registerWorkspaceAside(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Workspace aside id must be a non-empty string.')
          }
          if (definition.label.trim().length === 0) {
            throw new Error('Workspace aside label must be a non-empty string.')
          }
          if (workspaceAside) {
            throw new Error(
              `The workspace aside is already claimed by module "${workspaceAside.moduleId}".`
            )
          }
          workspaceAside = { ...definition, moduleId }
        },
        provideBacklogReader(reader) {
          if (backlogReader) {
            throw new Error(
              `The Backlog reader is already provided by module "${backlogReader.moduleId}".`
            )
          }
          backlogReader = { moduleId, reader }
        },
        async listBacklogItems(workspaceId) {
          return requireBacklogReader().list(workspaceId)
        },
        watchBacklogItems(workspaceId, cb) {
          const reader = requireBacklogReader()
          return reader.watch(workspaceId, (items) => {
            // Live gate on every delivery, not just at subscribe: an active
            // watch stops streaming the moment the user disables the backlog
            // module (and resumes on re-enable) instead of outliving the
            // toggle. The provider is re-read so the gate follows ownership.
            if (
              backlogReader
              && moduleEnabledResolver
              && !moduleEnabledResolver(backlogReader.moduleId)
            ) {
              return
            }
            try {
              cb(items)
            } catch (error) {
              // A throwing module callback must not break the shared scan's
              // emit loop for sibling subscribers (the Backlog panel included).
              console.error(`[modules] backlog watch callback from module "${moduleId}" threw:`, error)
            }
          })
        },
        async getWorkspace(workspaceId) {
          return workspaceResolver ? workspaceResolver(workspaceId) : null
        },
        getWorkspaceModuleState<T = unknown>(workspaceId: string): T | undefined {
          return workspaceModuleStateStore
            ? (workspaceModuleStateStore.get(workspaceId, moduleId) as T | undefined)
            : undefined
        },
        setWorkspaceModuleState(workspaceId, state) {
          return workspaceModuleStateStore
            ? workspaceModuleStateStore.set(workspaceId, moduleId, state)
            : false
        },
        getModuleAppState<T = unknown>(key: string): T | undefined {
          if (!moduleAppStateStore) return undefined
          return moduleAppStateStore.get(moduleId)[key] as T | undefined
        },
        setModuleAppState(key, value) {
          return moduleAppStateStore ? moduleAppStateStore.set(moduleId, key, value) : false
        },
        watchModuleAppState(cb) {
          const watcher: ModuleAppStateWatcher = { moduleId, cb }
          moduleAppStateWatchers.add(watcher)
          // Held by the kernel, not the store, so a watch registered before the
          // store is wired attaches when it lands rather than silently dying.
          attachModuleAppStateWatcher(watcher)
          return () => {
            moduleAppStateWatchers.delete(watcher)
            watcher.detach?.()
          }
        },
        subscribe(topic, cb) {
          // The kernel owns the subscriber set (see dispatchModuleEvent): one
          // source listener backs every module's subscriptions, and a subscribe
          // made before the source is wired still receives once it lands.
          const subscriber: ModuleEventSubscriber = { moduleId, topic, cb }
          moduleEventSubscribers.add(subscriber)
          return () => {
            moduleEventSubscribers.delete(subscriber)
          }
        },
        async getWorkingRoot(workspaceId) {
          return workingRootResolver ? workingRootResolver(workspaceId) : null
        },
        async watchWorkspaceFile(workspaceId, relativePath, cb) {
          const watcher = requireAgentRuntime(workspaceFileWatcher, 'Workspace file watch')
          return watcher(workspaceId, relativePath, (event) => {
            // Live gate on every delivery, not just at subscribe (the Backlog
            // watcher pattern): an active watch stops streaming the moment the
            // user disables the Agent Runtime module.
            if (agentRuntimeDisabled()) return
            cb(event)
          })
        },
        watchAgentSessions(workspaceId, cb) {
          const watcher = requireAgentRuntime(agentSessionWatcher, 'Agent session observation')
          return watcher(workspaceId, (sessions) => {
            if (agentRuntimeDisabled()) return
            cb(sessions)
          })
        },
        async spawnAgent(input) {
          return requireAgentRuntime(agentSpawner, 'Agent spawn').spawnAgent(input)
        },
        focusTab(input) {
          return requireAgentRuntime(agentSpawner, 'Tab focus').focusTab(input)
        },
        listAgentRuntimes() {
          return requireAgentRuntime(agentSpawner, 'Agent runtime listing').listAgentRuntimes()
        },
        async invoke(channel, payload) {
          if (!channel.startsWith(`${moduleId}:`)) {
            throw new Error(
              `Module "${moduleId}" may only invoke its own channels ("${moduleId}:*"); got "${channel}".`
            )
          }
          const outcome = await window.api.moduleBridgeInvoke(channel, payload)
          if (!outcome.ok) {
            // Keep the structured refusal code on the thrown error so module
            // code can branch on the refusal kind without parsing prose.
            throw Object.assign(new Error(outcome.message), { code: outcome.code })
          }
          return outcome.result
        },
      }
    },
    getPanel(componentId) {
      return panels.get(componentId)
    },
    getPanelModule(componentId) {
      return panelModules.get(componentId)
    },
    getWorkspaceType(id) {
      return workspaceTypes.get(id)
    },
    getWorkspaceTypes(moduleEnabled) {
      // The module list registers eagerly at boot and these definitions are
      // stored by reference, so lookups are stable. Components that derive
      // arrays from this registry should still memoize those arrays before
      // returning them from Zustand selectors.
      return [...workspaceTypes.values()]
        .filter((definition) => !moduleEnabled || moduleEnabled(definition.moduleId))
        .sort((a, b) => {
          const order = (a.pickerOrder ?? 100) - (b.pickerOrder ?? 100)
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getWorkspaceTypeModule(id) {
      return workspaceTypes.get(id)?.moduleId
    },
    getBacklogItemActions() {
      return [...backlogItemActions.values()].sort((a, b) => {
        const order = (a.order ?? 100) - (b.order ?? 100)
        return order === 0 ? a.label.localeCompare(b.label) : order
      })
    },
    getBacklogLinkProviders(moduleEnabled) {
      const providers = new Set<BacklogLinkProvider>()
      for (const provider of backlogLinkProviders.values()) {
        if (moduleEnabled && !moduleEnabled(provider.moduleId)) continue
        providers.add(provider)
      }
      return [...providers].sort((a, b) => {
        const moduleOrder = a.moduleId.localeCompare(b.moduleId)
        return moduleOrder === 0 ? a.targetKinds.join('\0').localeCompare(b.targetKinds.join('\0')) : moduleOrder
      })
    },
    getNotificationActionProviders(moduleEnabled) {
      return [...notificationActionProviders.values()]
        .filter((provider) => !moduleEnabled || moduleEnabled(provider.moduleId))
        .sort((a, b) => a.source.localeCompare(b.source))
    },
    getModuleCommand(commandId) {
      return moduleCommands.get(commandId)
    },
    getModuleCommands(moduleEnabled) {
      return enabledModuleCommands(moduleEnabled)
    },
    getCommandContributions(moduleEnabled) {
      return [...COMMAND_REGISTRY, ...enabledModuleCommands(moduleEnabled)]
    },
    getSettingsSections(moduleEnabled) {
      return [...settingsSections.values()]
        .filter((section) => !moduleEnabled || moduleEnabled(section.moduleId))
        .sort((a, b) => {
          const order = (a.order ?? 100) - (b.order ?? 100)
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getSidebarNavEntries(moduleEnabled) {
      return [...sidebarNavEntries.values()]
        .filter((entry) => !moduleEnabled || moduleEnabled(entry.moduleId))
        .sort((a, b) => {
          const order = a.order - b.order
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getTopBarItems(moduleEnabled) {
      return [...topBarItems.values()]
        .filter((item) => !moduleEnabled || moduleEnabled(item.moduleId))
        .sort((a, b) => {
          const order = a.order - b.order
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getGlobalSurface(id) {
      return globalSurfaces.get(id)
    },
    getGlobalSurfaces(moduleEnabled) {
      return [...globalSurfaces.values()]
        .filter((surface) => !moduleEnabled || moduleEnabled(surface.moduleId))
        .sort((a, b) => a.id.localeCompare(b.id))
    },
    getModalSurface(id) {
      return modalSurfaces.get(id)
    },
    getModalSurfaces(moduleEnabled) {
      return [...modalSurfaces.values()]
        .filter((surface) => !moduleEnabled || moduleEnabled(surface.moduleId))
        .sort((a, b) => {
          const order = a.order - b.order
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getWorkspaceAside() {
      return workspaceAside ?? undefined
    },
    getAgentIdNamespace(agentId, moduleEnabled) {
      // Longest prefix first, so a future nested claim resolves to the more
      // specific owner rather than to whichever registered first. Registration
      // already rejects overlaps, making this a belt to that brace.
      const candidates = [...agentIdNamespaces.values()].sort(
        (a, b) => b.prefix.length - a.prefix.length
      )
      return candidates.find(
        (namespace) =>
          agentId.startsWith(namespace.prefix)
          && (!moduleEnabled || moduleEnabled(namespace.moduleId))
      )
    },
    setModuleEnablementResolver(resolver) {
      moduleEnabledResolver = resolver
    },
    setWorkspaceModuleStateStore(store) {
      workspaceModuleStateStore = store
    },
    setModuleAppStateStore(store) {
      moduleAppStateStore = store
      // Attach anything that watched before the store landed (a module's
      // registerRenderer runs synchronously, this wiring a microtask later).
      for (const watcher of moduleAppStateWatchers) attachModuleAppStateWatcher(watcher)
    },
    setModuleEventSource(source) {
      // One listener on the source, whoever subscribed and whenever. Re-wiring
      // replaces the old attachment rather than stacking a second dispatcher.
      detachModuleEventSource?.()
      detachModuleEventSource = source(dispatchModuleEvent)
    },
    setWorkspaceResolver(resolver) {
      workspaceResolver = resolver
    },
    setWorkingRootResolver(resolver) {
      workingRootResolver = resolver
    },
    setWorkspaceFileWatcher(watcher) {
      workspaceFileWatcher = watcher
    },
    setAgentSessionWatcher(watcher) {
      agentSessionWatcher = watcher
    },
    setAgentSpawner(spawner) {
      agentSpawner = spawner
    },
  }
}

export type RendererModule = {
  manifest: CapabilityManifest
  registerRenderer?: (host: RendererHost) => void
}

// Pure helper shared by the factory, the panel rail, and the Modules settings
// tab so "is this feature on?" is computed identically everywhere.
export function isModuleEnabled(
  manifests: ReadonlyArray<CapabilityManifest>,
  overrides: ModuleEnablementOverrides,
  moduleId: string
): boolean {
  return resolveModuleEnablement([...manifests], overrides).order.includes(moduleId)
}
