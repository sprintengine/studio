import type { SwitchboardImportProvider } from '../switchboard'

export type JsonSchema = Record<string, unknown>

// CLI permission preset for a spawned automation agent. Mirrors
// SprintEngineCliPermissionPreset (src/shared/electron-api.ts) so the automations
// contract stays self-contained; kept in sync as a closed union.
export type AutomationCliPermissionPreset = 'default' | 'auto_workspace' | 'bypass_all'

export const AUTOMATIONS_LIST_CHANNEL = 'automations:list'
export const AUTOMATIONS_GET_CHANNEL = 'automations:get'
export const AUTOMATIONS_CREATE_CHANNEL = 'automations:create'
export const AUTOMATIONS_UPDATE_CHANNEL = 'automations:update'
export const AUTOMATIONS_DELETE_CHANNEL = 'automations:delete'
export const AUTOMATIONS_RUN_NOW_CHANNEL = 'automations:run-now'
export const AUTOMATIONS_RUNS_LIST_CHANNEL = 'automations:runs:list'
export const AUTOMATIONS_RUN_FINALIZE_CHANNEL = 'automations:run:finalize'
export const AUTOMATIONS_PROVIDERS_LIST_CHANNEL = 'automations:providers:list'
export const AUTOMATIONS_ENGINE_STATUS_CHANNEL = 'automations:engine-status'
export const AUTOMATIONS_RUN_EVENT_CHANNEL = 'automations:run-event'
export const AUTOMATIONS_DEFINITIONS_CHANGED_CHANNEL = 'automations:definitions-changed'

export type AutomationStatus = 'enabled' | 'paused' | 'blocked'

export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'

export type AutomationRunEventStatus = Extract<AutomationRunStatus, 'completed' | 'failed' | 'blocked'>
export type AutomationRunEventTrigger = 'timer' | 'manual'

// Broadcast to every window after any definition write — user IPC or the
// module-scoped service — so an open Automations panel refreshes when a
// module (or another window) creates, updates, or deletes an automation.
export type AutomationsDefinitionsChangedEvent = {
  workspaceRoot: string
}

export type AutomationsRunEvent = {
  automationId: string
  runId: string
  workspaceId: string
  agentId?: string
  definitionName: string
  status: AutomationRunEventStatus
  trigger: AutomationRunEventTrigger
}

// Trigger/action kinds are open strings — third-party providers register their
// own — so the built-in kinds get named constants and helpers compare against a
// symbol, never a bare literal. Each built-in config type pins `kind` to its
// constant.
export const SCHEDULE_TRIGGER_KIND = 'schedule'
export const REPO_EVENT_TRIGGER_KIND = 'repo-event'
export const WEBHOOK_TRIGGER_KIND = 'webhook'

export type TriggerKind = string

export type ScheduleTriggerConfig = {
  kind: typeof SCHEDULE_TRIGGER_KIND
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

export type RepoEventType = 'created' | 'updated'

// Repo-event trigger wire config (Switchboard GitHub/Jira import events). Shared
// so producer (src/main/automations/triggers/repo-event.ts) and the renderer
// editor build/parse it typed, instead of as Record<string, unknown>.
export type RepoEventTriggerConfig = {
  kind: typeof REPO_EVENT_TRIGGER_KIND
  provider?: SwitchboardImportProvider | 'any'
  eventTypes?: RepoEventType[]
  externalKey?: string
  label?: string
}

// Webhook trigger wire config. The renderer receives it with `secret` redacted
// (the form carries a `hasSecret` marker instead), so `secret` is optional here.
export type WebhookTriggerConfig = {
  kind: typeof WEBHOOK_TRIGGER_KIND
  enabled?: boolean
  port?: number
  path?: string
  secret?: string
  eventType?: string
  label?: string
}

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

export type ActionKind = string

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

export type AutomationDefinition = {
  id: string
  name: string
  status: AutomationStatus
  trigger: { kind: TriggerKind; config: unknown }
  condition?: { kind: string; config: unknown }
  action: { kind: ActionKind; config: unknown }
  autonomyDefault: 'review_only' | 'allow_changes'
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
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

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
   * time. Correlates an agent-lifecycle exit back to this run so finalization can
   * be driven from the agent terminating, not only the run-status signal file.
   * Optional: historical runs and resolution misses degrade to the poll-scan.
   */
  executionId?: string
  promptFingerprint?: string
  touchedFiles?: string[]
  commandsRan?: string[]
  summary?: string
  /** Git worktree the agent-backed run executes in (per-run isolation). */
  worktreePath?: string
  /** Branch the run's worktree is checked out on. */
  branch?: string
  /** Pull request opened for the run's branch on completion, when available. */
  pullRequestUrl?: string
  /**
   * Report files the run produced, project-relative and contained under
   * `reports/` (validated via {@link normalizeReportPath}). Absent on historical
   * runs; the renderer falls back to scanning {@link summary} for those.
   */
  reportPaths?: string[]
}

export type AutomationDefinitionDraft = {
  id?: string
  name: string
  status: AutomationStatus
  trigger: { kind: TriggerKind; config: unknown }
  condition?: { kind: string; config: unknown }
  action: { kind: ActionKind; config: unknown }
  autonomyDefault: AutomationDefinition['autonomyDefault']
  runInWorktree?: boolean
  /**
   * Owning module for drafts created through the SDK's scoped Automations
   * service. Optional echo of the creating module's own id — a draft claiming
   * a different module is refused, and ownership is always stamped by the
   * host. The user-facing IPC create path ignores it entirely.
   */
  ownerModuleId?: string
}

export type AutomationDefinitionPatch = Partial<Omit<AutomationDefinitionDraft, 'id' | 'ownerModuleId'>>

// ── Scoped Automations service for capability modules ────────────────────────
// A module's entry.main consumes this via the SDK's `getAutomationsService`
// helper (service token 'automations.module-service'); every method is
// pre-scoped to the calling module's id, and mutations refuse records the
// module does not own. Mirrored exactly by the SDK; the drift guard enforces.

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

export type AutomationsWorkspaceInput = {
  workspaceRoot: string
  workspaceId?: string
}

export type AutomationsDefinitionInput = AutomationsWorkspaceInput & {
  automationId: string
}

export type AutomationsCreateInput = AutomationsWorkspaceInput & {
  definition: AutomationDefinitionDraft
}

export type AutomationsUpdateInput = AutomationsDefinitionInput & {
  patch: AutomationDefinitionPatch
}

export type AutomationsRunsListInput = AutomationsDefinitionInput

export type AutomationsRunFinalizeInput = AutomationsDefinitionInput & {
  runId: string
  outcome: 'completed' | 'failed'
  summary?: string
  reports?: string[]
}

export type AutomationsProviderView = {
  kind: string
  configSchema: JsonSchema
  requiredIntegrations: string[]
  missingIntegrations: string[]
  blockedReason?: string
}

export type AutomationsProviders = {
  triggers: AutomationsProviderView[]
  actions: AutomationsProviderView[]
}

// Read-only health of the Automations engine/scheduler sidecar, surfaced to the
// renderer so the control center can show an engine indicator. Mirrors the
// kernel's SidecarRunState (src/main/module-host/main-host.ts) plus
// 'unavailable' for when the sidecar is absent (module disabled / not wired).
export type AutomationsEngineSidecarState =
  | 'declared'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'failed'
  | 'unavailable'

export type AutomationsEngineStatus = {
  state: AutomationsEngineSidecarState
  /** Sidecar error when present, e.g. the webhook-receiver failure. */
  error?: string
}

export type AutomationsResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

/**
 * Containment guard for automation report paths. Reports are addressed relative
 * to the project root and must live under the fixed `reports/` directory.
 *
 * Returns the normalized project-relative path (forward slashes, no `.`/empty
 * segments) when `rawPath` is project-relative and stays under `reports/`, or
 * `null` for anything absolute, containing a `..` segment, or resolving outside
 * `reports/`. The single source of truth shared by the engine finalize guard
 * (main) and the renderer report extraction so neither forks divergent rules.
 */
export function normalizeReportPath(rawPath: string): string | null {
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (trimmed.length === 0) return null
  // Reject absolute paths: POSIX (/…), Windows drive (C:\…), and UNC (\\…).
  if (/^(?:\/|\\|[A-Za-z]:)/.test(trimmed)) return null
  const normalized: string[] = []
  for (const segment of trimmed.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    normalized.push(segment)
  }
  // Must address a file under reports/, i.e. at least `reports/<name>`.
  if (normalized.length < 2 || normalized[0] !== 'reports') return null
  return normalized.join('/')
}

export type AutomationsListResult = AutomationsResult<AutomationDefinition[]>
export type AutomationsDefinitionResult = AutomationsResult<AutomationDefinition>
export type AutomationsDeleteResult = AutomationsResult<{ automationId: string }>
export type AutomationsRunNowResult = AutomationsResult<{
  definition: AutomationDefinition
  run: AutomationRun
}>
export type AutomationsRunsListResult = AutomationsResult<AutomationRun[]>
export type AutomationsRunFinalizeResult = AutomationsResult<AutomationRun>
export type AutomationsProvidersResult = AutomationsResult<AutomationsProviders>
export type AutomationsEngineStatusResult = AutomationsResult<AutomationsEngineStatus>
