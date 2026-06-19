// @multicode/module-sdk — the published contract surface external authors
// compile against when building Multicode capability modules.
//
// The repository is the consumer-of-record: a drift guard inside the Multicode
// repo (packages/module-sdk/drift/sdk-drift-guard.ts) type-checks that these
// declarations stay equivalent to (or sound narrowings of) the in-app
// contracts, and that mirrored value exports stay identical. The SDK never
// imports application code, so the published tarball is self-contained.
//
// Some shapes are deliberately narrowed for external publication (renderer
// internals such as run-glyph providers and workspace supervisors are not in
// the v1 surface). Every narrowing is listed in README.md.

import type { ComponentType, LazyExoticComponent } from 'react'

// ── Manifest ─────────────────────────────────────────────────────────────────

export type CapabilityCategory =
  | 'core'
  | 'dev-tools'
  | 'vcs'
  | 'orchestration'
  | 'insight'
  | 'connectivity'
  | (string & {})

export type ModuleSource = 'bundled' | 'third-party'

/** Detached ed25519 signature over the canonical manifest (signature field excluded). */
export type ModuleSignature = {
  algorithm: 'ed25519'
  publicKey: string
  signature: string
}

/**
 * Code entry points, relative to the module root. `entry.main` runs in the
 * main process for trusted modules; `entry.renderer` is loaded into the
 * renderer for trusted modules. `entry.preload` is reserved and NOT loaded in
 * v1 — declare it only for forward compatibility.
 */
export type ModuleEntry = {
  main?: string
  preload?: string
  renderer?: string
}

export type CapabilityManifest = {
  id: string
  displayName: string
  version: number
  publisher?: string
  category?: CapabilityCategory
  summary?: string
  /** Whether the module loads when the user has expressed no preference. */
  defaultEnabled: boolean
  /** Core modules are always enabled. Third-party modules must not set this. */
  core?: boolean
  /** Capability ids this module needs loaded (and enabled) before it can load. */
  dependsOn?: string[]
  /** Capability ids that must not be enabled at the same time as this one. */
  conflictsWith?: string[]
  /** Provenance. Absent ⇒ bundled first-party. Installed modules are 'third-party'. */
  source?: ModuleSource
  /** Permission scopes requested (install-time disclosure, not runtime enforcement). */
  permissions?: string[]
  entry?: ModuleEntry
  signature?: ModuleSignature
}

/** Trust classification: only 'trusted' modules are eligible to execute code. */
export type ModuleTrustStatus = 'trusted' | 'signed' | 'unsigned' | 'invalid'

/** Reserved bundled module ids a third-party module may not claim. */
export const BUNDLED_MODULE_IDS: readonly string[] = [
  'agent-runtime',
  'backlog',
  'dev-tools',
  'git',
  'memory-graph',
  'switchboard',
  'multiloop',
  'sprint-engine',
  'automations',
  'mobile-relay',
  'voice-dictation',
]

// ── Permissions (install-time disclosure vocabulary) ─────────────────────────

export type CapabilityPermission =
  | 'filesystem:read-workspace'
  | 'filesystem:write-workspace'
  | 'filesystem:read-home'
  | 'process:spawn'
  | 'network'
  | 'ipc:workspace-read'
  | 'ipc:workspace-write'
  | 'ipc:agents'
  | 'ipc:settings'
  | 'ipc:invoke'
  | (string & {})

export const KNOWN_CAPABILITY_PERMISSIONS: readonly string[] = [
  'filesystem:read-workspace',
  'filesystem:write-workspace',
  'filesystem:read-home',
  'process:spawn',
  'network',
  'ipc:workspace-read',
  'ipc:workspace-write',
  'ipc:agents',
  'ipc:settings',
  'ipc:invoke',
]

// ── Notifications ────────────────────────────────────────────────────────────

export type ModuleNotificationSeverity = 'info' | 'warning' | 'error'

/** What a module passes to `host.notify(...)`; identity and time are stamped by the host. */
export type ModuleNotifyInput = {
  severity: ModuleNotificationSeverity
  title: string
  body?: string
}

export type ModuleNotification = {
  /** Stamped by the host kernel from the emitting module's scope. */
  sourceModuleId: string
  severity: ModuleNotificationSeverity
  title: string
  body?: string
  /** Epoch ms at emission, assigned by the kernel. */
  emittedAt: number
}

// ── Main-process host (entry.main) ───────────────────────────────────────────

/**
 * The raw IPC event is typed `unknown` in the SDK so the package carries no
 * Electron dependency; treat it as opaque unless you depend on Electron types
 * yourself.
 */
export type IpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>

export type StartupHook = () => void | Promise<void>
export type ShutdownHook = () => void | Promise<void>

/** Typed handle for a service one module provides and others require. */
export type ServiceToken<T> = { readonly key: string; readonly __type?: T }

export function createServiceToken<T>(key: string): ServiceToken<T> {
  return { key }
}

export type SidecarSpec = {
  id: string
  /** e.g. 'python', 'python-mcp', 'process'. Free-form; the host interprets it. */
  kind: string
  /** Python module name or executable, depending on kind. */
  module?: string
  description?: string
  /**
   * When the host spawns the sidecar: 'startup' (default) starts it during
   * app startup in registration order; 'demand' leaves spawning to the owner
   * (for lazily-started daemons). Only meaningful when the host manages the
   * sidecar's lifecycle.
   */
  startOn?: 'startup' | 'demand'
}

export type MainHost = {
  /** The module currently registering; stamped by the host. */
  readonly moduleId: string
  /** Raw Electron ipcMain; typed `unknown` to keep the SDK Electron-free. */
  readonly ipcMain: unknown
  registerIpc(channel: string, handler: IpcInvokeHandler): void
  provideService<T>(token: ServiceToken<T>, factory: (host: MainHost) => T): T
  getService<T>(token: ServiceToken<T>): T | undefined
  requireService<T>(token: ServiceToken<T>): T
  onStartup(hook: StartupHook): void
  onShutdown(hook: ShutdownHook): void
  registerSidecar(spec: SidecarSpec): void
  /**
   * Surface a user-visible status notification. Identity is stamped from this
   * host's scope; emission is flood-bounded per module.
   */
  notify(input: ModuleNotifyInput): void
}

/** The export contract of `entry.main`: `export function registerMain(host) { … }`. */
export type RegisterMain = (host: MainHost) => void

// ── Workspace service (host-provided, consumed via the service bridge) ────────

export type WorkspaceCreateInput = {
  /** Workspace display name. */
  name?: string
  /** Absolute folder to open in the workspace. */
  folderPath?: string
  /** Layout template id; defaults to the standard template when omitted. */
  templateId?: string
}

export type WorkspaceCreateResult =
  | { ok: true; workspaceId: string }
  | { ok: false; code: string; message: string }

/**
 * Programmatic workspace creation, provided by the app core. A creation runs
 * the same renderer flow the UI uses and is confirmed on the workspace-sync bus
 * before it resolves, so the returned id is always a real, observed workspace.
 */
export type WorkspaceService = {
  create(input: WorkspaceCreateInput): Promise<WorkspaceCreateResult>
}

/**
 * Resolve with `host.requireService(WorkspaceServiceToken)` from a module's
 * `entry.main`. Always available — provided by the always-on agent-runtime core.
 */
export const WorkspaceServiceToken: ServiceToken<WorkspaceService> =
  createServiceToken<WorkspaceService>('core.workspace')

// ── Automations providers (host-provided, consumed via the service bridge) ────

export type JsonSchema = Record<string, unknown>

export type AutomationStatus = 'enabled' | 'paused' | 'blocked'

export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'

export type TriggerKind = 'schedule' | string

export type ScheduleTriggerConfig = {
  kind: 'schedule'
  cadence:
    | { type: 'interval'; everyMinutes: number }
    | { type: 'daily'; timeLocal: string }
    | { type: 'weekly'; timeLocal: string; daysOfWeek: number[] }
    | { type: 'cron'; expression: string }
  timezone: string
}

export type AutomationTriggerPollContext = {
  getSharedValue<T>(key: string, factory: () => Promise<T>): Promise<T>
}

export type AutomationTriggerPollEvent = {
  id: string
  occurredAt: string
  payload: Record<string, unknown>
}

export type AutomationTriggerPollResult =
  | { ok: true; events: AutomationTriggerPollEvent[] }
  | { ok: false; blockedReason: string }

export type AutomationTriggerProvider = {
  kind: TriggerKind
  configSchema: JsonSchema
  requiredIntegrations?: string[]
  validateConfig?(config: unknown): { ok: true } | { ok: false; error: string }
  subscribe(input: {
    config: unknown
    fire: (payload: Record<string, unknown>) => void
    now: () => number
  }): () => void
  computeNextRun?(config: unknown, after: number): number | null
  poll?(input: {
    config: unknown
    workspaceRoot: string
    now: () => number
    context?: AutomationTriggerPollContext
  }): Promise<AutomationTriggerPollResult>
}

export type ActionKind = 'spawn-agent' | 'run-command' | 'run-skill-loop' | string

export type AutomationRun = {
  id: string
  automationId: string
  status: AutomationRunStatus
  dueAt: string
  startedAt: string | null
  completedAt: string | null
  blockedReason?: string
  workspaceId?: string
  agentId?: string
  promptFingerprint?: string
  touchedFiles?: string[]
  commandsRan?: string[]
  summary?: string
}

export type ActionContext = {
  automationId: string
  runId: string
  workspaceRoot: string
  triggerPayload: Record<string, unknown>
  spawnAgent(input: {
    workspaceId?: string
    folderPath: string
    cli?: string
    name?: string
    prompt: string
  }): Promise<{ workspaceId: string; agentId: string }>
  runCommand(input: { command: string[]; cwd: string }): Promise<{ code: number; output: string }>
  reportProgress(patch: Partial<AutomationRun>): void
  requireIntegration(id: string): void
}

export type AutomationActionProvider = {
  kind: ActionKind
  configSchema: JsonSchema
  requiredIntegrations?: string[]
  run(config: unknown, ctx: ActionContext): Promise<Partial<AutomationRun>>
}

export type AutomationsProviderRegistry = {
  registerTriggerProvider(moduleId: string, provider: AutomationTriggerProvider): string
  registerActionProvider(moduleId: string, provider: AutomationActionProvider): string
}

/**
 * Service token for modules that need lower-level access to Automations provider
 * registration. Prefer `registerAutomationTrigger` and `registerAutomationAction`.
 */
export const AutomationsProviderRegistryToken: ServiceToken<AutomationsProviderRegistry> =
  createServiceToken<AutomationsProviderRegistry>('automations.provider-registry')

export function registerAutomationTrigger(host: MainHost, provider: AutomationTriggerProvider): string {
  return host.requireService(AutomationsProviderRegistryToken).registerTriggerProvider(host.moduleId, provider)
}

export function registerAutomationAction(host: MainHost, provider: AutomationActionProvider): string {
  return host.requireService(AutomationsProviderRegistryToken).registerActionProvider(host.moduleId, provider)
}

// ── Renderer host (entry.renderer) ───────────────────────────────────────────

/**
 * Props passed to a contributed workspace panel. (The app may pass additional
 * shell-internal props not in the v1 SDK surface.)
 */
export type WorkspacePanelProps = {
  workspaceId: string
}

/** Eager component or React.lazy() wrapper; both render the same way. */
export type WorkspacePanelComponent =
  | ComponentType<WorkspacePanelProps>
  | LazyExoticComponent<ComponentType<WorkspacePanelProps>>

export type WorkspaceTypeIconComponent = ComponentType<{ className?: string }>

export type WorkspaceTypeTopBarView = {
  component: string
  name: string
}

export type PreviewSlot = {
  x: number
  y: number
  w: number
  h: number
  type: 'agent' | 'editor' | 'explorer'
  label: string
}

// A conservative subset of the FlexLayout JSON model the app's workspace
// layouts use. Anything expressible here is a valid app layout; the app
// accepts more (borders, extra attributes) than the SDK exposes in v1.
export type LayoutTabJson = {
  type: 'tab'
  id?: string
  name?: string
  component?: string
  config?: unknown
}

export type LayoutTabSetJson = {
  type: 'tabset'
  id?: string
  weight?: number
  enableTabStrip?: boolean
  children: LayoutTabJson[]
}

export type LayoutRowJson = {
  type: 'row'
  id?: string
  weight?: number
  children: Array<LayoutRowJson | LayoutTabSetJson>
}

export type LayoutGlobalJson = {
  tabSetEnableDrop?: boolean
  tabEnableClose?: boolean
}

export type WorkspaceLayoutJson = {
  global?: LayoutGlobalJson
  layout: LayoutRowJson
}

export type WorkspaceLayoutTemplate = {
  id: string
  name: string
  description: string
  previewSlots: PreviewSlot[]
  layout: WorkspaceLayoutJson
}

/**
 * A contributed workspace type. Advanced shell hooks (top-bar supervisors,
 * run-glyph providers) are not part of the v1 SDK surface.
 */
export type WorkspaceTypeDefinition = {
  id: string
  label: string
  description: string
  icon: WorkspaceTypeIconComponent
  accentToken?: string
  searchTerms?: string[]
  createTemplate(): WorkspaceLayoutTemplate
  topBarViews?: {
    label: string
    views: WorkspaceTypeTopBarView[]
  }
  creationStepsId?: string
  pickerOrder?: number
}

// ── Backlog contributions ────────────────────────────────────────────────────

export type BacklogItemStatus = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
export type BacklogItemLinkStatus = 'active' | 'completed' | 'failed' | 'unknown'

export type BacklogItemLink = {
  id: string
  moduleId: string
  type: 'execution' | 'issue' | 'review' | 'artifact' | 'external' | 'agent'
  label: string
  target: {
    kind: string
    id: string
    path?: string
    url?: string
  }
  status?: BacklogItemLinkStatus
  updatedAt?: string
}

export type BacklogResolvedLink = BacklogItemLink & {
  status: BacklogItemLinkStatus
  unavailableReason?: string
  canOpen?: boolean
}

/**
 * Read view of a Backlog item as handed to module callbacks. Enumerated app
 * internals (item kind, triage axes) are widened to `string` so new app values
 * never break compiled modules.
 */
export type BacklogItemView = {
  id: string
  path: string
  relativePath: string
  title: string
  kind: string
  status: BacklogItemStatus
  type?: string
  difficulty?: string
  criticality?: string
  metadata: Record<string, unknown>
  links: BacklogItemLink[]
  excerpt: string
  sourceContent: string
}

export type BacklogItemActionCategory = 'execute' | 'analyze' | 'transform' | 'publish' | 'review' | 'organize'

export type BacklogItemActionContext = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItemView
  readSource(): Promise<string>
  updateStatus(status: BacklogItemStatus): Promise<void>
  addLink(link: BacklogItemLink): Promise<void>
  updateModuleMetadata(moduleId: string, value: unknown): Promise<void>
}

export type BacklogItemActionState = 'enabled' | 'disabled'

export type BacklogItemAction = {
  id: string
  label: string
  category: BacklogItemActionCategory
  order?: number
  isVisible?: (context: BacklogItemActionContext) => boolean
  getState?: (context: BacklogItemActionContext) => BacklogItemActionState
  run: (context: BacklogItemActionContext) => void | Promise<void>
}

export type BacklogLinkProviderInput = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItemView
  link: BacklogItemLink
}

export type BacklogLinkProvider = {
  /** Must equal the registering module's id. */
  moduleId: string
  /** Link target kinds this provider owns; a kind has exactly one owner. */
  targetKinds: string[]
  resolveLinkStatus(input: BacklogLinkProviderInput): Promise<BacklogResolvedLink>
  openLink?(input: BacklogLinkProviderInput): Promise<void | boolean>
}

// ── Commands ─────────────────────────────────────────────────────────────────

export type CommandScope =
  | 'global'
  | 'workspace'
  | 'workspace-navigation'
  | 'editor'
  | 'terminal'
  | 'panel'
  | 'panel:sprintengine'
  | 'panel:multiloop'
  | 'panel:watchtower'
  | 'panel:switchboard'

export type CommandAvailability =
  | 'always'
  | 'activeWorkspace'
  | 'activeFile'
  | 'voiceDictationEnabled'
  | 'sprintengineWorkspace'
  | 'sprintengineHasArchitect'
  | 'sprintengineFocusAgentVisible'
  | 'multiloopWorkspace'
  | 'multiloopStateLoaded'
  | 'switchboardWorkspace'
  | 'memoryGraphEnabled'
  | 'sprintEngineEnabled'
  | 'gitPanelActive'
  | 'terminalActive'
  | 'diagnosticsEnabled'

/**
 * A command contributed by a module. The registered id is namespaced
 * `<moduleId>.<id>`; the handler callback travels with the definition.
 */
export type ModuleCommandDefinition = {
  /** Bare command id; the registered id becomes `<moduleId>.<id>`. */
  id: string
  title: string
  /** Grouping label in the palette and Shortcuts settings. */
  category: string
  scopes: readonly CommandScope[]
  defaultKeybindings?: readonly string[]
  availability?: readonly CommandAvailability[]
  allowInEditableTarget?: boolean
  run: () => void | Promise<void>
}

// ── Settings sections ────────────────────────────────────────────────────────

export type SettingsSectionProps = {
  values: Readonly<Record<string, unknown>>
  /** Persist one value in the module's namespace; `undefined` deletes the key. */
  setValue: (key: string, value: unknown) => void
}

export type SettingsSectionComponent =
  | ComponentType<SettingsSectionProps>
  | LazyExoticComponent<ComponentType<SettingsSectionProps>>

/** Icons follow the house glyph pattern: 24×24 viewBox, currentColor strokes. */
export type SettingsSectionIconComponent = ComponentType<{ className?: string }>

export type SettingsSectionDefinition = {
  id: string
  label: string
  description?: string
  icon: SettingsSectionIconComponent
  Component: SettingsSectionComponent
  order?: number
}

// ── Renderer host registration contract ──────────────────────────────────────

export type RendererHost = {
  registerPanel(componentId: string, component: WorkspacePanelComponent): void
  registerWorkspaceType(definition: WorkspaceTypeDefinition): void
  registerBacklogItemAction(action: BacklogItemAction): void
  registerBacklogLinkProvider(provider: BacklogLinkProvider): void
  registerCommand(definition: ModuleCommandDefinition): void
  registerSettingsSection(definition: SettingsSectionDefinition): void
}

/** The export contract of `entry.renderer`: `export function registerRenderer(host) { … }`. */
export type RegisterRenderer = (host: RendererHost) => void

// ── Manifest validation + canonical signing payload ──────────────────────────
// Pure (no Node APIs) and safe in any runtime. The ed25519 sign/verify
// functions need node:crypto and live behind the `./signing` subpath export.

export {
  canonicalManifestPayload,
  parseThirdPartyModuleManifest,
  validateCapabilityPermissions,
  validateThirdPartyModuleManifest,
  type PermissionValidationIssue,
  type PermissionValidationResult,
  type ThirdPartyManifestIssue,
  type ThirdPartyManifestResult,
} from './manifest-validate.js'

// ── BYO-CLI plugin authoring (kind: 'cli') ───────────────────────────────────
// A CLI plugin is a separate artifact from a capability module: a `plugin.json`
// dropped into ~/.multicode/plugins/<id>/ that teaches Multicode a new agent
// CLI. Pure validator + types, safe in any runtime.

export {
  parseCliPluginManifest,
  validateCliPluginManifest,
  type CliArgvToken,
  type CliCapabilities,
  type CliCompletionMode,
  type CliCompletionSpec,
  type CliLaunchSpec,
  type CliManifestIssue,
  type CliManifestResult,
  type CliMcpConfigFormat,
  type CliMcpConfigSpec,
  type CliModelOption,
  type CliModelSelectionSpec,
  type CliPermissionPreset,
  type CliPluginManifest,
  type CliPromptInjection,
  type CliPromptInjectionMode,
  type CliReadinessSignal,
  type CliResumeSpec,
  type CliSkillFormat,
  type CliSkillInstallScope,
  type CliSkillInstallTarget,
  type CliSkillIntegration,
  type CliSkillInvocation,
  type CliSkillSupport,
  type CliSoulsSpec,
  type CliVariableDecl,
  type CliVariableType,
} from './cli-manifest.js'

// ── Marketplace plugin bundle authoring ─────────────────────────────────────
// A marketplace plugin is a signed bundle manifest (`plugin.json`) that points
// at existing primitives: MCP configs, skill directories, capability modules,
// and BYO-CLI plugin folders. The app re-exports these helpers from its shared
// marketplace module, so SDK authors and Multicode verify the same shape.

export {
  MARKETPLACE_COMPONENT_KINDS,
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  validateMarketplacePluginAuthoringManifest,
  validateMarketplacePluginManifest,
  type MarketplaceComponent,
  type MarketplaceComponentFileDigest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
  type MarketplacePluginAuthoringManifestResult,
  type MarketplacePluginComponents,
  type MarketplacePluginManifest,
  type MarketplacePluginManifestResult,
} from './plugin-manifest.js'
