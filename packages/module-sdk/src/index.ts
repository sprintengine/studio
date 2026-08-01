// @multicode/module-sdk — the published contract surface external authors
// compile against when building Multicode capability modules.
//
// The repository is the consumer-of-record: a drift guard inside the Multicode
// repo (packages/module-sdk/drift/sdk-drift-guard.ts) type-checks that these
// declarations stay equivalent to (or sound narrowings of) the in-app
// contracts, and that mirrored value exports stay identical. The SDK never
// imports application code, so the published tarball is self-contained.
//
// Some shapes are deliberately narrowed for external publication (for
// example, run-glyph providers receive a minimal input view rather than the
// shell's internal workspace shape). Every narrowing is listed in README.md.

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
  'design',
  'dev-tools',
  'git',
  'memory-graph',
  'switchboard',
  'sprint-engine',
  'review',
  'automations',
  'roadmap',
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
  | 'backlog.read'
  | 'backlog.write'
  | 'backlog.link.open'
  // Create and manage the module's own automations through the SDK's scoped
  // Automations service. Disclosure-level like every other scope: the service
  // does not runtime-check it.
  | 'automations.manage'
  // Attach workspace-bound background (companion) agents through the SDK's
  // Companion Agents service. Unlike the disclosure-only scopes above, the
  // companion service checks this one explicitly at attach time.
  | 'agents:companion'
  // Persist the module's own data through the SDK's scoped storage service
  // (host-placed: workspace `.multi-code/modules/<id>/` or per-user app data).
  | 'storage'
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
  'backlog.read',
  'backlog.write',
  'backlog.link.open',
  'automations.manage',
  'agents:companion',
  'storage',
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
export type ShutdownBeginHook = () => void | Promise<void>
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
  /**
   * Run early, before the host tears down shared infrastructure. Use it to stop
   * self-scheduled loops and flip a shutting-down flag so no new work is
   * dispatched during teardown; defer awaiting in-flight work to `onShutdown`.
   * Begin hooks run in registration order, opposite `onShutdown`.
   */
  onShutdownBegin(hook: ShutdownBeginHook): void
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
 * `entry.main`. Provided by the agent-runtime core — declare
 * `dependsOn: ['agent-runtime']` (or a chain reaching it) or resolve inside
 * handlers rather than at the top of `registerMain`, so registration order
 * can't race the provider.
 */
export const WorkspaceServiceToken: ServiceToken<WorkspaceService> =
  createServiceToken<WorkspaceService>('core.workspace')

/**
 * Read-only workspace snapshot: the id → root/name/mode resolution modules
 * need for per-workspace persistence keys and scoped services. A snapshot,
 * not a subscription — live session/workspace observation is a separate
 * surface.
 */
export type ModuleWorkspaceView = {
  id: string
  name: string
  /**
   * Absolute folder the workspace opened (its primary checkout); null for
   * folderless workspaces. Note for Sprint-run worktree-backed workspaces:
   * the run's agents work in a git worktree under this folder — this
   * snapshot deliberately reports the durable project root (the right base
   * for persistence and scoped services), not the transient worktree.
   */
  folderPath: string | null
  /** Workspace type id ('standard' or a module-registered type). */
  mode: string
}

/**
 * Resolve a workspace id to its read-only view from `entry.main`. A null
 * resolution means "not currently resolvable" — an unknown id, or workspace
 * state that has not re-hydrated yet (e.g. right after app launch). Never a
 * throw, and never a deletion signal: retry later instead of discarding
 * per-workspace state. Declare the `ipc:workspace-read` permission
 * (install-time disclosure). The renderer twin is `RendererHost.getWorkspace`.
 */
export type WorkspaceContextService = {
  get(workspaceId: string): Promise<ModuleWorkspaceView | null>
}

/**
 * Resolve with `host.requireService(WorkspaceContextToken)` from a module's
 * `entry.main`. Provided by the agent-runtime core — declare
 * `dependsOn: ['agent-runtime']` (or a chain reaching it) or resolve inside
 * handlers rather than at the top of `registerMain`, so registration order
 * can't race the provider.
 */
export const WorkspaceContextToken: ServiceToken<WorkspaceContextService> =
  createServiceToken<WorkspaceContextService>('core.workspace-context')

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
    /**
     * One-shot: run once at `datetime` — ISO-8601 local wall-clock
     * (`YYYY-MM-DDTHH:mm`, seconds optional and ignored, NO trailing `Z` or
     * offset; the config's `timezone` field is the sole timezone authority,
     * matching daily/weekly). Once the fire time passes, `computeNextRun`
     * returns null and the automation never fires again — it stays listed
     * with no upcoming run. A past datetime is valid and simply never fires.
     * A wall-clock that falls in a DST spring-forward gap resolves to the
     * first instant after the gap, the same rule daily/weekly use.
     */
    | { type: 'at'; datetime: string }
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

export type AutomationRunIsolation = 'worktree' | 'workspace-checkout'

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
  /**
   * Terminal-session executionId of the spawned agent, resolved at launch-confirm
   * time. Correlates an agent-lifecycle exit back to this run. Optional: historical
   * runs and resolution misses degrade to the poll-scan.
   */
  executionId?: string
  promptFingerprint?: string
  touchedFiles?: string[]
  commandsRan?: string[]
  summary?: string
  /**
   * Isolation the run actually got, stamped by the built-in agent-backed actions
   * at launch. `worktree` is the contained shape: its own worktree, its own
   * branch, and a pull request on completion. `workspace-checkout` is the
   * deliberate opt-out (`runInWorktree: false`): the agent ran in the user's own
   * checkout, so the run has no branch and opens no pull request. Absent on
   * historical runs and on runs that never launched an agent — read it, not the
   * absence of {@link worktreePath}, to tell a contained run from an uncontained
   * one without re-reading the definition.
   */
  isolation?: AutomationRunIsolation
  /** Git worktree the agent-backed run executes in (per-run isolation). */
  worktreePath?: string
  /** Branch the run's worktree is checked out on. */
  branch?: string
  /** Pull request opened for the run's branch on completion, when available. */
  pullRequestUrl?: string
  /** Report files the run produced, project-relative and contained under `reports/`. */
  reportPaths?: string[]
}

export type AutomationCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'

export type ActionContext = {
  automationId: string
  runId: string
  workspaceRoot: string
  triggerPayload: Record<string, unknown>
  spawnAgent(input: {
    workspaceId?: string
    folderPath: string
    cli?: string
    cliModel?: string
    permissionPreset?: AutomationCliPermissionPreset
    specialistId?: string
    worktreePath?: string
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

type AutomationsProviderRegistry = {
  registerTriggerProvider(moduleId: string, provider: AutomationTriggerProvider): string
  registerActionProvider(moduleId: string, provider: AutomationActionProvider): string
}

const automationsProviderRegistryToken: ServiceToken<AutomationsProviderRegistry> =
  createServiceToken<AutomationsProviderRegistry>('automations.provider-registry')

export function registerAutomationTrigger(host: MainHost, provider: AutomationTriggerProvider): string {
  return host.requireService(automationsProviderRegistryToken).registerTriggerProvider(host.moduleId, provider)
}

export function registerAutomationAction(host: MainHost, provider: AutomationActionProvider): string {
  return host.requireService(automationsProviderRegistryToken).registerActionProvider(host.moduleId, provider)
}

// ── Scoped Automations service (owned CRUD + run events) ─────────────────────

export type AutomationDefinition = {
  id: string
  name: string
  status: AutomationStatus
  trigger: { kind: TriggerKind; config: unknown }
  condition?: { kind: string; config: unknown }
  action: { kind: ActionKind; config: unknown }
  /**
   * The capability module that created this automation through the SDK's
   * scoped Automations service; absent ⇒ user-owned. Stamped server-side from
   * the creating module's identity — never accepted from the renderer — and
   * immutable thereafter (patches cannot carry it). The user outranks the
   * module: panel edits to module-owned automations stay allowed; only the
   * module service enforces ownership.
   */
  ownerModuleId?: string
  /**
   * Whether an agent-backed run executes in its own per-run git worktree (branch
   * isolation from the user's checkout, and the prerequisite for opening a PR —
   * a non-worktree run has no branch to review). Absent ⇒ true, so existing
   * automations keep running in a worktree.
   */
  runInWorktree?: boolean
  /**
   * Runtime-only bridge for definitions written before `autonomyDefault` was
   * retired (2026-07-30) whose author set it to `review_only`. That intent —
   * report, do not fix — now lives in the automation's prompt, so the store read
   * translates the retired key into this marker and the launch prompt carries a
   * write-up-only instruction. Host-populated and never persisted: a module must
   * not send it, and it is stripped again on write, so it exists only between a
   * legacy file's read and the run it starts.
   */
  legacyWriteUpOnly?: true
  /**
   * Run once, then pause: after one triggered fire (schedule due-run, skipped
   * overdue run, webhook or polling trigger event) the definition transitions to
   * `status: 'paused'`; re-enabling arms it again. A manual "Run now" never
   * consumes the shot — the flag means "after one *triggered* fire". Absent ⇒
   * false. Works for every trigger kind; orthogonal to the `at` cadence's own
   * natural exhaustion.
   */
  disableAfterRun?: boolean
  /**
   * The marketplace catalogue entry this automation was added from, and that
   * entry's publisher. Provenance only: stamped once by the marketplace install
   * path and immutable thereafter (patches cannot carry either field), so the
   * shelf can answer "is this already added" for a project and open the record
   * the entry produced. Distinct from `ownerModuleId`, which is module identity
   * and governs who may write the record — a catalogue automation is the user's
   * the moment it lands, and survives uninstalling the plugin that shipped it.
   */
  sourceCatalogueId?: string
  sourcePublisher?: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

export type AutomationDefinitionDraft = {
  id?: string
  name: string
  status: AutomationStatus
  trigger: { kind: TriggerKind; config: unknown }
  condition?: { kind: string; config: unknown }
  action: { kind: ActionKind; config: unknown }
  runInWorktree?: boolean
  disableAfterRun?: boolean
  /**
   * Owning module for drafts created through the SDK's scoped Automations
   * service. Optional echo of the creating module's own id — a draft claiming
   * a different module is refused, and ownership is always stamped by the
   * host. The user-facing IPC create path ignores it entirely.
   */
  ownerModuleId?: string
  /**
   * Catalogue provenance for drafts created by the marketplace install path.
   * Stamped by the host from the bundle being installed — like `ownerModuleId`,
   * never read off a caller-supplied payload.
   */
  sourceCatalogueId?: string
  sourcePublisher?: string
}

export type AutomationDefinitionPatch = Partial<
  Omit<AutomationDefinitionDraft, 'id' | 'ownerModuleId' | 'sourceCatalogueId' | 'sourcePublisher'>
>

export type AutomationRunEventStatus = Extract<AutomationRunStatus, 'completed' | 'failed' | 'blocked'>
export type AutomationRunEventTrigger = 'timer' | 'manual'

export type AutomationsRunEvent = {
  automationId: string
  runId: string
  workspaceId: string
  agentId?: string
  definitionName: string
  status: AutomationRunEventStatus
  trigger: AutomationRunEventTrigger
}

export type ModuleAutomationsError =
  | 'invalid_draft'
  | 'invalid_workspace'
  | 'not_found'
  | 'not_owner'
  | 'store_error'
  | 'engine_unavailable'

export type ModuleAutomationsResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: ModuleAutomationsError; message: string }

/**
 * Owned automation CRUD + run events for a module's `entry.main`, obtained via
 * `getAutomationsService(host)`. Every method is pre-scoped to your module:
 * `create` stamps `ownerModuleId`, mutations refuse records your module does
 * not own (`not_owner` — user-created automations included), `list` returns
 * only owned records, and `onRunEvent` fires only for owned automations.
 * Declare the `automations.manage` permission (install-time disclosure) and
 * `dependsOn: ['automations']` so the service exists before your entry runs.
 */
export type ModuleAutomationsService = {
  /** Create an automation owned by this module (`ownerModuleId` is stamped). */
  create(input: {
    workspaceRoot: string
    draft: AutomationDefinitionDraft
  }): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  update(input: {
    workspaceRoot: string
    automationId: string
    patch: AutomationDefinitionPatch
  }): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  delete(input: {
    workspaceRoot: string
    automationId: string
  }): Promise<ModuleAutomationsResult<object>>
  /** Automations this module owns in the workspace (never other modules' or the user's). */
  list(input: {
    workspaceRoot: string
  }): Promise<ModuleAutomationsResult<{ automations: AutomationDefinition[] }>>
  listRuns(input: {
    workspaceRoot: string
    automationId: string
  }): Promise<ModuleAutomationsResult<{ runs: AutomationRun[] }>>
  /** Subscribe to run events for automations this module owns. Returns the unsubscriber; call it in `onShutdown`. */
  onRunEvent(listener: (event: AutomationsRunEvent) => void): () => void
}

type AutomationsModuleRegistry = {
  create(
    moduleId: string,
    input: { workspaceRoot: string; draft: unknown }
  ): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  update(
    moduleId: string,
    input: { workspaceRoot: string; automationId: string; patch: unknown }
  ): Promise<ModuleAutomationsResult<{ automation: AutomationDefinition }>>
  delete(
    moduleId: string,
    input: { workspaceRoot: string; automationId: string }
  ): Promise<ModuleAutomationsResult<object>>
  list(
    moduleId: string,
    input: { workspaceRoot: string }
  ): Promise<ModuleAutomationsResult<{ automations: AutomationDefinition[] }>>
  listRuns(
    moduleId: string,
    input: { workspaceRoot: string; automationId: string }
  ): Promise<ModuleAutomationsResult<{ runs: AutomationRun[] }>>
  onRunEvent(moduleId: string, listener: (event: AutomationsRunEvent) => void): () => void
}

const automationsModuleServiceToken: ServiceToken<AutomationsModuleRegistry> =
  createServiceToken<AutomationsModuleRegistry>('automations.module-service')

/**
 * The scoped Automations service for `host`'s module. The raw host registry
 * takes a module id on every call; this helper closes over `host.moduleId`
 * exactly like `registerAutomationTrigger`/`registerAutomationAction`.
 */
export function getAutomationsService(host: MainHost): ModuleAutomationsService {
  const registry = host.requireService(automationsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    create: (input) => registry.create(moduleId, input),
    update: (input) => registry.update(moduleId, input),
    delete: (input) => registry.delete(moduleId, input),
    list: (input) => registry.list(moduleId, input),
    listRuns: (input) => registry.listRuns(moduleId, input),
    onRunEvent: (listener) => registry.onRunEvent(moduleId, listener),
  }
}

// ── Companion agents (host-provided, consumed via the service bridge) ─────────

/**
 * A companion agent's status: the conversation-session vocabulary plus
 * `absent` — never spawned, or already disposed (not present in the projection).
 */
export type CompanionAgentStatus =
  | 'starting'
  | 'ready'
  | 'active'
  | 'awaiting_approval'
  | 'stopped'
  | 'failed'
  | 'absent'

/**
 * A canonical conversation event as delivered to a companion's `onEvent`.
 * Secret-shaped payload keys are redacted before delivery. `type` is widened to
 * `string` so new app event kinds never break compiled modules.
 */
export type CompanionAgentEvent = {
  id: string
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  type: string
  createdAt: number
  payload?: Record<string, unknown>
}

export type CompanionAgentSpec = {
  workspaceId: string
  /** Stable, module-chosen id (e.g. 'review-guide'); the projection key. */
  agentId: string
  /** Display name in the Sessions popover / Attention Queue. */
  name: string
  /** Absolute workspace folder (the main process has no id → folder registry). */
  workspaceRoot: string
  /** Engine selection; defaults resolve to the workspace's harness CLI/model. */
  engine?: { cli?: string; model?: string }
  /** Advisory context roots; the provider resolves knowledge from workspaceRoot. */
  contextRoots?: { knowledge?: boolean }
  /** Role instructions, delivered as a preamble on the first turn. */
  systemPrompt: string
}

export type CompanionValidateResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export type CompanionRunStructuredOptions<T> = {
  prompt: string
  validate: (raw: unknown) => CompanionValidateResult<T>
  /** Validator errors are fed back to the agent and the turn retried. Default 1. */
  retries?: number
  onPhase?: (phase: string) => void
}

export type CompanionAgentHandle = {
  readonly workspaceId: string
  readonly agentId: string
  /** Folds from the same conversation-session projection the Sessions popover reads. */
  status(): CompanionAgentStatus
  onStatus(cb: (status: CompanionAgentStatus) => void): () => void
  /** Run a structured JSON task: extract final JSON, validate, retry-once, return typed. */
  runStructured<T>(opts: CompanionRunStructuredOptions<T>): Promise<T>
  /** A chat turn on the session's own transport. */
  send(message: string): Promise<void>
  onEvent(cb: (event: CompanionAgentEvent) => void): () => void
  interrupt(): void
  /** Ends the session; the handle becomes inert. Re-attach spawns a fresh one. */
  dispose(): void
}

/**
 * Workspace-bound background agents for a module's `entry.main`, obtained via
 * `getCompanionAgentsService(host)`. `attach` NEVER spawns — it returns a handle
 * in `absent` status; the first `runStructured`/`send` (a live user intent)
 * spawns, so reopening a workspace never auto-starts a companion. A second
 * `attach` with the same (workspaceId, agentId) returns the SAME handle.
 *
 * Declare the `agents:companion` permission (the service checks it at attach
 * time and throws if absent) and `dependsOn: ['agent-runtime']` so the service
 * exists before your entry runs.
 */
export type CompanionAgentsService = {
  attach(spec: CompanionAgentSpec): CompanionAgentHandle
}

type CompanionAgentsRegistry = {
  attach(moduleId: string, spec: CompanionAgentSpec): CompanionAgentHandle
}

const companionAgentsModuleServiceToken: ServiceToken<CompanionAgentsRegistry> =
  createServiceToken<CompanionAgentsRegistry>('companion-agents.module-service')

/**
 * The scoped Companion Agents service for `host`'s module. The raw host registry
 * takes a module id on every call; this helper closes over `host.moduleId`
 * exactly like `getAutomationsService`.
 */
export function getCompanionAgentsService(host: MainHost): CompanionAgentsService {
  const registry = host.requireService(companionAgentsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    attach: (spec) => registry.attach(moduleId, spec),
  }
}

// ── Module storage (host-provided, consumed via the service bridge) ──────────

export type ModuleStorageErrorCode =
  | 'invalid_key'
  | 'invalid_value'
  | 'value_too_large'
  | 'invalid_workspace_root'
  | 'io_error'

export type ModuleStorageResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: ModuleStorageErrorCode; message: string }

/**
 * Per-module, per-workspace JSON storage, scoped to your module by
 * `getModuleStorage(host)`. The host owns file placement — workspace-scoped
 * keys live in the workspace folder (`.multi-code/modules/<moduleId>/`),
 * global keys under the app's per-user data — so modules stop inventing
 * locations (home-dir files, raw localStorage). Keys match
 * `^[a-z0-9][a-z0-9._-]{0,63}$`; values must be JSON-serializable and at most
 * 1 MB; writes are atomic (write-then-rename). Pass `workspaceRoot` (absolute;
 * resolve it via the workspace context) for workspace-scoped keys, omit it for
 * the module's global store. Declare the `storage` permission (install-time
 * disclosure). Renderer panels reach storage through the module's own
 * `host.invoke` channels.
 */
export type ModuleStorageService = {
  /** `found: false` (with `value: undefined`) when the key has never been set. */
  get(input: { key: string; workspaceRoot?: string }): Promise<ModuleStorageResult<{ value: unknown; found: boolean }>>
  set(input: { key: string; value: unknown; workspaceRoot?: string }): Promise<ModuleStorageResult<object>>
  delete(input: { key: string; workspaceRoot?: string }): Promise<ModuleStorageResult<{ deleted: boolean }>>
  /** Keys in the scope, sorted; an empty store lists `[]`, never an error. */
  list(input?: { workspaceRoot?: string }): Promise<ModuleStorageResult<{ keys: string[] }>>
}

// The moduleId-first registry the app provides; derived from the published
// service so the two shapes cannot drift.
type ModuleStorageRegistry = {
  [K in keyof ModuleStorageService]: (
    moduleId: string,
    ...args: Parameters<ModuleStorageService[K]>
  ) => ReturnType<ModuleStorageService[K]>
}

const moduleStorageToken: ServiceToken<ModuleStorageRegistry> =
  createServiceToken<ModuleStorageRegistry>('core.module-storage')

/**
 * The scoped storage service for `host`'s module. The raw host registry takes
 * a module id on every call; this helper closes over `host.moduleId` exactly
 * like `getAutomationsService`. Provided by the agent-runtime core — declare
 * `dependsOn: ['agent-runtime']` (a chain that reaches it, e.g.
 * `['automations']`, also works) so your `entry.main` registers after the
 * provider; without the dependency edge, load order is alphabetical and a
 * top-of-registerMain call can race the provider and fail your module's load.
 */
export function getModuleStorage(host: MainHost): ModuleStorageService {
  const registry = host.requireService(moduleStorageToken)
  const moduleId = host.moduleId
  return {
    get: (input) => registry.get(moduleId, input),
    set: (input) => registry.set(moduleId, input),
    delete: (input) => registry.delete(moduleId, input),
    list: (input) => registry.list(moduleId, input),
  }
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
 * A supervisor is a render-nothing React component the shell mounts for your
 * workspace type — the home for background renderer logic (auto-run loops,
 * pollers, sync). Lifecycle: `'global'` mounts one instance in the primary
 * window while your module is enabled (whether or not one of your workspaces
 * is open); `'all-windows'` mounts one instance per window. Unmounted when
 * the module is disabled. The shell mounts supervisors inside a crash
 * boundary and a display:none host: a throw is contained (logged, supervisor
 * unmounted) and returned markup is never shown — return null. A
 * supervisor may only touch published SDK surfaces — its power is exactly
 * what the rest of the SDK exposes.
 */
export type WorkspaceTypeSupervisorScope = 'global' | 'all-windows'

export type WorkspaceTypeSupervisorComponent = ComponentType | LazyExoticComponent<ComponentType>

export type WorkspaceTypeSupervisor = {
  Component: WorkspaceTypeSupervisorComponent
  scope: WorkspaceTypeSupervisorScope
}

/**
 * The published, stable subset of the shell's sidebar-status vocabulary. The
 * app's own vocabulary is wider and grows; module glyphs stick to this core
 * so a compiled module never emits a state the running shell can't draw.
 */
export type WorkspaceRunGlyphState =
  | 'todo'
  | 'ready'
  | 'in_progress'
  | 'paused'
  | 'review'
  | 'needs_input'
  | 'done'
  | 'failed'
  | 'archived'

/** The sidebar row's one status slot: lifecycle state, liveness, plain label. */
export type WorkspaceRunGlyph = {
  state: WorkspaceRunGlyphState
  /** Adds the live pulse — only while something is actually running. */
  live: boolean
  /** Plain-language status, e.g. "2 scheduled today" or "Reviewing PR #12". */
  label: string
}

/**
 * The read view a run-glyph provider derives from. Deliberately minimal: the
 * provider owns its module's state and consults it synchronously (e.g. a
 * cache its supervisor maintains); the shell supplies only the identity.
 */
export type WorkspaceRunGlyphInput = {
  mode: string
}

/**
 * A module-owned config step in the workspace-creation hub. One step per type
 * (v1): the hub renders it as the flow's one config page after the shared
 * name/folder fields, holds the value for the pane's lifetime only (nothing
 * persists shell-side), and hands it to `createTemplate(context)` on create.
 * A throwing Component degrades to the type's zero-config flow with an inline
 * notice — it never blocks the hub.
 */
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

/** Context handed to `createTemplate` on create. */
export type WorkspaceTypeCreateContext = {
  /** The module creation step's collected value; undefined without a step. */
  stepValue?: unknown
}

/**
 * A contributed workspace type.
 */
export type WorkspaceTypeDefinition = {
  id: string
  label: string
  description: string
  icon: WorkspaceTypeIconComponent
  accentToken?: string
  searchTerms?: string[]
  createTemplate(context?: WorkspaceTypeCreateContext): WorkspaceLayoutTemplate
  topBarViews?: {
    label: string
    views: WorkspaceTypeTopBarView[]
  }
  /**
   * Background renderer components the shell mounts for this type (see
   * WorkspaceTypeSupervisor). Useful together with the live-runtime surfaces —
   * a supervisor with nothing observable is a no-op.
   */
  supervisors?: WorkspaceTypeSupervisor[]
  /**
   * Sidebar status for workspaces of this type. Called for workspaces whose
   * mode equals this type's id (the mode's own provider always wins the
   * dispatch); return null for "no run signal" — the shell falls back to its
   * recency text. Note: while your type ships this hook, collapsed sidebar
   * rows defer their terminal-derived attention dot to your provider — a
   * null return reads as "genuinely resting", so return a `needs_input`
   * glyph when your module wants the user's attention. Synchronous — derive
   * from module state you already hold, not from IPC.
   */
  deriveRunGlyph?(workspace: WorkspaceRunGlyphInput): WorkspaceRunGlyph | null
  /** The type's config step in the creation hub (one per type in v1). */
  creationStep?: WorkspaceTypeCreationStep
  creationStepsId?: string
  pickerOrder?: number
}

// ── Backlog contributions ────────────────────────────────────────────────────

export type BacklogItemStatus = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
// `pending` is lifecycle-neutral: the work is recorded but has not started.
export type BacklogItemLinkStatus = 'pending' | 'active' | 'completed' | 'canceled' | 'failed' | 'unknown'

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
    /**
     * The one task inside the target that owns this item, when the target is
     * a run and the item is one of its epic children.
     */
    taskId?: string
  }
  status?: BacklogItemLinkStatus
  /**
   * The item status to restore if this link's work is abandoned. Written when
   * an epic-child link is created and consumed when the run or its task is
   * canceled.
   */
  priorStatus?: BacklogItemStatus
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
  | 'panel:watchtower'
  // Open scope family: `panel:<moduleId>` is active while a workspace whose
  // mode belongs to that module is active — the shell derives it from the
  // workspace-type registry, so your module's commands can gate on "my
  // workspace is active" without a shell enum change.
  | (string & {})

export type CommandAvailability =
  | 'always'
  | 'activeWorkspace'
  | 'activeFile'
  | 'voiceDictationEnabled'
  | 'sprintengineWorkspace'
  | 'sprintengineHasArchitect'
  | 'sprintengineFocusAgentVisible'
  | 'memoryGraphEnabled'
  | 'sprintEngineEnabled'
  | 'gitPanelActive'
  | 'terminalActive'
  | 'diagnosticsEnabled'
  | 'automationsEnabled'
  // Open at the type level so new shell conditions never break a compiled
  // module; an unknown condition reads as unsatisfied (fail closed). Prefer
  // an availability predicate for module-specific gating.
  | (string & {})

/**
 * The published context view a module availability predicate is evaluated
 * against. Deliberately tiny — extended only by demonstrated need; anything a
 * module knows about its own state it checks inside the predicate itself.
 */
export type ModuleCommandContext = {
  activeWorkspaceId: string | null
  activeWorkspaceMode: string | null
}

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
  /**
   * `panel:<moduleId>` gates on "a workspace whose mode belongs to my module
   * is active" — derived by the shell from the workspace-type registry.
   */
  scopes: readonly CommandScope[]
  defaultKeybindings?: readonly string[]
  /**
   * Either shell availability preconditions, or a predicate over the
   * published `ModuleCommandContext` view — "offer this only when…" without
   * a shell enum change. With no context wired (early boot) a
   * predicate-gated command is unavailable, never a silent no-op.
   */
  availability?: readonly CommandAvailability[] | ((context: ModuleCommandContext) => boolean)
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

// ── Sidebar nav entries ──────────────────────────────────────────────────────

export type SidebarNavEntryRenderProps = {
  /** The sidebar is collapsed to the icon rail; render icon-only with a tooltip. */
  collapsed: boolean
}

export type SidebarNavEntryComponent =
  | ComponentType<SidebarNavEntryRenderProps>
  | LazyExoticComponent<ComponentType<SidebarNavEntryRenderProps>>

/**
 * A top-nav door your module contributes to the workspace sidebar's
 * instance-level nav cluster (the band holding New chat, Automations, Sprints,
 * Connectors). The entry is a self-contained row component that owns its full
 * behavior — a status dot, an open action against the local window's store,
 * active state. The sidebar shows it only while your module is enabled and
 * places it by `order`, so the toggle adds/removes the door without a reload.
 */
export type SidebarNavEntryDefinition = {
  id: string
  /** Sort key in the top-nav cluster; lower renders first. Built-in doors reserve 0–30. */
  order: number
  Component: SidebarNavEntryComponent
}

// ── Renderer host registration contract ──────────────────────────────────────

export type RendererHost = {
  registerPanel(componentId: string, component: WorkspacePanelComponent): void
  registerWorkspaceType(definition: WorkspaceTypeDefinition): void
  registerBacklogItemAction(action: BacklogItemAction): void
  registerBacklogLinkProvider(provider: BacklogLinkProvider): void
  registerCommand(definition: ModuleCommandDefinition): void
  registerSettingsSection(definition: SettingsSectionDefinition): void
  /**
   * Contribute a top-nav door to the workspace sidebar. Registered once at
   * boot; the sidebar filters by your module's enablement and orders by
   * `order`, so toggling your module shows/hides the door without a reload.
   */
  registerSidebarNavEntry(definition: SidebarNavEntryDefinition): void
  /**
   * The workspace's Backlog items as read-only views. Declare the
   * `backlog.read` permission (install-time disclosure). Mutations go through
   * `BacklogItemActionContext` (Backlog actions) or the item's file — never
   * through this read surface. Rejects when the backlog module is disabled.
   */
  listBacklogItems(workspaceId: string): Promise<BacklogItemView[]>
  /**
   * Observe the workspace's Backlog: `cb` fires once with the current
   * snapshot, then on every change (scans are debounced ~300ms behind file
   * edits). Returns the unsubscriber — call it when your panel unmounts.
   * Throws when the backlog module is disabled. Declare `backlog.read`.
   */
  watchBacklogItems(workspaceId: string, cb: (items: BacklogItemView[]) => void): () => void
  /**
   * Resolve a workspace id (e.g. from `WorkspacePanelProps.workspaceId`) to
   * its read-only view — the supported way to get a workspace's folder root,
   * name, and mode. A null resolution means "not currently resolvable" (an
   * unknown id, or the shell hasn't wired workspace state yet at early
   * boot) — never a throw, and never a deletion signal: retry later instead
   * of discarding per-workspace state. Declare the `ipc:workspace-read`
   * permission (install-time disclosure). The `entry.main` twin is
   * `WorkspaceContextToken`.
   */
  getWorkspace(workspaceId: string): Promise<ModuleWorkspaceView | null>
  /**
   * Invoke an IPC channel this module's own `entry.main` registered via
   * `MainHost.registerIpc`, e.g. `host.invoke('my-module:save', data)`.
   *
   * The channel MUST start with `<moduleId>:` (your own module id); other
   * channel names throw before IPC happens. The host additionally routes only
   * to channels owned by third-party modules whose manifest declares the
   * `ipc:invoke` permission. A refused invoke rejects with an Error whose
   * `code` property carries the `ModuleBridgeRefusalCode`, so callers can
   * branch on the refusal kind without parsing the message.
   *
   * This bridge is a contract, not a security boundary: all renderer code
   * shares one world. Trust gating (only `trusted` modules execute) remains
   * the actual boundary.
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>
}

/**
 * Why the host refused a `RendererHost.invoke`, attached as `code` on the
 * rejection Error: the channel was never registered (`unknown_channel`), it is
 * not `<ownerModuleId>:`-prefixed or not owned by a third-party module
 * (`not_bridgeable`), or the owner does not declare `ipc:invoke`
 * (`permission_missing`).
 */
export type ModuleBridgeRefusalCode = 'unknown_channel' | 'not_bridgeable' | 'permission_missing'

// ── File-drop drag-and-drop contract ─────────────────────────────────────────
// The payload the Backlog panel and Files tree put on a drag (and the terminal
// accepts). Published so a module can accept those drags — or originate
// compatible ones — against a drift-guarded contract instead of an internal
// MIME string. Self-contained mirror of the app's terminalDrop contract.

export const MULTICODE_FILE_DROP_MIME = 'application/x-multicode-file-drop'

export type FileDropPayload = {
  version: 1
  workspaceId: string | null
  rootPath: string
  files: Array<{
    path: string
    name: string
    isDir?: boolean
  }>
}

/** Put a file-drop payload on a drag the app's drop targets (terminals) accept. */
export function setFileDropData(dataTransfer: DataTransfer, payload: FileDropPayload): void {
  const fileText = payload.files.map((file) => file.path).join('\n')
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(MULTICODE_FILE_DROP_MIME, JSON.stringify(payload))
  dataTransfer.setData('text/plain', fileText)
}

/**
 * Whether a drag carries the Multicode file-drop payload (or native OS files).
 * Use this during `dragover` — the HTML DnD protected mode blanks `getData`
 * there, so `readFileDropPayload` only works inside the `drop` handler.
 */
export function hasFileDropData(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(MULTICODE_FILE_DROP_MIME) || types.includes('Files')
}

/**
 * Read a Multicode file-drop payload off a drop event's dataTransfer. Returns
 * null — never throws — when the MIME entry is absent, the JSON is
 * unparseable, the version is unknown (future versions ⇒ null; handle it), or
 * the shape is invalid. A Backlog-item drag carries the item's markdown file
 * path in `files[0].path`, resolvable back to the item.
 */
export function readFileDropPayload(dataTransfer: DataTransfer): FileDropPayload | null {
  const raw = dataTransfer.getData(MULTICODE_FILE_DROP_MIME)
  if (!raw) return null

  try {
    const value = JSON.parse(raw) as Partial<FileDropPayload>
    if (
      value.version !== 1
      || (value.workspaceId !== null && typeof value.workspaceId !== 'string')
      || typeof value.rootPath !== 'string'
    ) {
      return null
    }
    if (!Array.isArray(value.files)) return null

    // Entries are rebuilt, never passed through: an invalid or non-boolean
    // isDir is skipped, and unknown extra properties are dropped.
    const files: FileDropPayload['files'] = []
    for (const file of value.files) {
      if (
        !file
        || typeof file.path !== 'string'
        || file.path.trim().length === 0
        || typeof file.name !== 'string'
        || (file.isDir !== undefined && typeof file.isDir !== 'boolean')
      ) {
        continue
      }
      files.push({
        path: file.path,
        name: file.name,
        ...(file.isDir === undefined ? {} : { isDir: file.isDir }),
      })
    }

    if (!files.length) return null
    return {
      version: 1,
      workspaceId: value.workspaceId,
      rootPath: value.rootPath,
      files,
    }
  } catch {
    return null
  }
}

// ── Theme tokens ─────────────────────────────────────────────────────────────

/**
 * The theme CSS custom properties guaranteed present in every app theme.
 * Consume them as CSS variables — Tailwind arbitrary values
 * (`bg-[var(--bg-surface)]`) or plain `var()` — so module UI re-skins with the
 * active theme automatically. Only the NAMES are contract: values differ per
 * theme and may be retuned in each release; never read or cache resolved values
 * in JS, and never hard-code a hex. `--focus-ring` is a full box-shadow value,
 * not a color. Presence is enforced per theme by a repo gate
 * (test:sdk:theme-tokens).
 */
export const THEME_TOKENS = [
  // Chrome (backgrounds)
  '--bg-app',
  '--bg-surface',
  '--bg-surface-raised',
  '--bg-hover',
  '--bg-selected',
  // Borders
  '--border-subtle',
  '--border-default',
  '--border-strong',
  // Text
  '--text-strong',
  '--text-default',
  '--text-muted',
  '--text-subtle',
  '--text-disabled',
  '--text-on-accent',
  // Accent + focus
  '--accent-primary',
  '--accent-primary-soft',
  '--focus-ring',
  // Semantic tones
  '--tone-neutral',
  '--tone-accent',
  '--tone-warn',
  '--tone-good',
  '--tone-error',
  '--tone-merged',
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

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
  type CliAuthSpec,
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
