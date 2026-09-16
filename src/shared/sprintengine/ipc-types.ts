/**
 * Sprint Engine IPC request/response shapes.
 *
 * These used to live on `shared/electron-api.ts` because the preload spread
 * every channel onto `window.api`. The channels now belong to the Sprint Engine
 * module (`MainHost.registerIpc` / `RendererHost.invoke`), so the contract
 * lives with the module rather than on core's Electron API.
 */
import type { SprintEngineAutomationIntentRecord } from './automation-intent'
import type {
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
} from './automation-types'
import type { AgentLaunchSettingsRecord } from './launch-settings'

export type SprintEngineMutationEventMetadata = {
  id?: string
  type?: string
  timestamp?: string
  actor?: string
  message?: string
}

export type SprintEngineMutationRefreshData = {
  projectionContent?: string
  projectionToken?: string
  events?: SprintEngineMutationEventMetadata[]
  latestEvent?: SprintEngineMutationEventMetadata
  latestEventId?: string
  [key: string]: unknown
}

export type SprintEngineArtifactCommandResult =
  | { ok: true; data: SprintEngineMutationRefreshData }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

export type SprintEngineProjectionReadResult =
  // `token` is a cheap file-change fingerprint (mtime:size) the caller can pass
  // back as `knownToken` to skip re-reading an unchanged projection. When the
  // token matches, `unchanged` is true and `data` is null (no read/parse done).
  | { ok: true; data: unknown; token?: string; unchanged?: boolean }
  // `permanent` marks a failure no retry can heal — the run directory is gone
  // (archived or deleted) or the store predates the schema this build reads —
  // so pollers stop retrying instead of re-failing every tick.
  | { ok: false; message: string; permanent?: boolean }

export type SprintEngineRegistryRolesReadInput = {
  workspaceRoot: string
  includeShadowed?: boolean
}

export type SprintEngineRegistryRoleReadInput = {
  workspaceRoot: string
  roleId: string
}

export type SprintEngineMcpReadResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | string }

export type SprintEngineTaskMutationRole =
  | 'architect'
  | 'product'
  | 'developer'
  | 'frontend'
  | 'tester'
  | 'security'
  | 'performance'
  | 'production_readiness_reviewer'
  | 'cross_platform'

export type SprintEngineTaskUpdateInput = {
  statePath: string
  taskId: string
  title?: string
  description?: string
  role?: SprintEngineTaskMutationRole
  acceptanceCriteria?: string[]
  implementationNotes?: string[]
  notes?: string[]
}

export type SprintEngineTaskCreateInput = {
  statePath: string
  title: string
  description?: string
  role: SprintEngineTaskMutationRole
  acceptanceCriteria?: string[]
  implementationNotes?: string[]
  notes?: string[]
}

export type SprintEngineTaskCommentInput = {
  statePath: string
  taskId: string
  body: string
}

export type SprintEngineTaskResolveInput = {
  statePath: string
  taskId: string
  resolution: string
  complete?: boolean
}

export type SprintEngineTaskStatusSetInput = {
  statePath: string
  taskId: string
  // A value from the engine's task-status vocabulary (todo, in_progress,
  // review, needs_input, done, canceled). The backend rejects illegal
  // transitions, so the renderer only sends legal targets — today `in_progress`,
  // which reopens a reviewed/done task for rework under its original owner.
  status: string
}

// The resolved sprint source seed, mirroring the shape the Python handover
// command writes to run.yaml. App-created (reference-mode) runs pass this into
// init so the seed is persisted at t=0 and the Sprint Inbox shows an honest
// "Started from" before any agent runs handover.
export type SprintEngineStateInitializeSource = {
  kind: string
  origin: string
  path: string
  planKind?: string
  originalPath?: string
  capturedAt?: string
}

export type SprintEngineStateInitializeSourceBundleItem = {
  kind: string
  origin: string
  path: string
  originalPath?: string
  capturedAt?: string
  // This entry is one of the launched epic's child items (a unit of work the
  // planner mints one task for), not supporting reading material sharing the
  // bundle. See SprintEngineSourceBundleItem.epicChild.
  epicChild?: boolean
  // A directly-selected work item on a `selection` launch (MC-2060). See
  // SprintEngineSourceBundleItem.selectedItem.
  selectedItem?: boolean
}

export type SprintEngineStateInitializeInput = {
  statePath: string
  name: string
  goal: string
  agents: Record<string, unknown>
  tasks?: unknown[]
  events?: unknown[]
  artifacts?: unknown[]
  // The root source seed and its bundle, persisted into run.yaml at creation.
  // Set only for app-created reference-mode launches (backlog/plan-sourced);
  // copy-mode and CLI/headless paths seed the source through handover instead.
  source?: SprintEngineStateInitializeSource
  sourceBundle?: SprintEngineStateInitializeSourceBundleItem[]
  // How this run gets its task graph (MC-2128). `direct` imports it from the
  // source epic's child items at init — one task per open child, ordered by the
  // items' own `dependsOn`, with no planning agent and no plan-approval gate.
  // `planned` runs a planning agent behind the plan gate. Omit to let the engine
  // apply its per-source default: `direct` for an epic, `planned` for everything
  // else. Fixed at run creation.
  intake?: 'direct' | 'planned'
  // When true, Sprint Engine creates one shared git worktree + branch for the
  // whole team before any task runs, and all agents work and commit there.
  useWorktrees?: boolean
  // When true, every TASK also gets its own worktree branched off the run branch
  // and merged back at publish (MC-2130), instead of the whole run sharing one
  // checkout per project. Layered on `useWorktrees` — the engine rejects it
  // without run worktrees — and fixed at creation like every other vcs choice.
  // Omitted/false is the normal mode: one worktree per sprint (MC-2136).
  taskIsolation?: boolean
  // The OTHER projects this run also changes (MC-1613), beyond the workspace's own.
  // Each entry becomes one `--repo <id>=<root>` at init: its own worktree, branch,
  // commit lock, and pull request. `root` is relative to the workspace folder and
  // must be a separate git repository outside it; `id` is the short handle tasks
  // target ('primary' is reserved for the workspace's own project).
  //
  // Fixed at creation and immutable after, exactly like `useWorktrees` — every
  // task, lock, commit, and worktree resolves through this list for the life of
  // the run. Requires `useWorktrees`: a run can only span projects when each gets
  // its own worktree, and the engine rejects the combination otherwise. Omitted
  // (not `[]`) for a single-project run.
  repos?: Array<{ id: string; root: string }>
  // Commit-ish the primary repo's run worktree branches FROM, for chained sprints
  // whose local branch may be behind its remote (the chain action fetches first
  // and passes e.g. `origin/main`). Start point only: the stored `vcs.baseRef` —
  // and therefore the `gh pr create --base` value — stays the plain branch name.
  // Only meaningful alongside `useWorktrees`.
  baseStartPoint?: string
  // The roster's per-role CLI model selection, recorded into run state at init
  // so each claimed task can be stamped with the model that worked it. A role
  // with no explicit model (CLI default) is omitted / left null. `reasoning` is
  // the seat's reasoning-effort level (MC-1885), absent for the CLI's own default.
  roleRuntimes?: Record<string, { model?: string | null; cli?: string | null; reasoning?: string | null }>
  // The enabled role ids (architect always included) the user turned on for
  // this run. Written to run.yaml `configuredRoles` at init so Python knows
  // which roles the architect may seat under the lazy (architect-only) roster.
  enabledRoles?: string[]
  // The post-implementation phases every task inherits (MC-1542). Written to
  // run.yaml `defaultPhases` via `--default-phases-json`. It is the DEFAULT and
  // the CEILING: a task may trim its phases, never add one outside this set, so
  // "agents on this run don't review their own work" (`[]`) is an operator
  // guarantee. `undefined` leaves the key absent and the engine default
  // (`['review']`) applies; `[]` is a meaningful, recorded value.
  defaultPhases?: string[]
}

export type SprintEngineTaskWorktreeInput = {
  statePath: string
  taskId: string
}

export type SprintEngineTaskWorktreeResult = {
  ok: boolean
  /** Whether this run gives every task its own worktree at all. */
  isolated: boolean
  /** Project-root-relative path to the task's tree; null when there is none. */
  worktreePath: string | null
  message?: string
}

export type SprintEngineCliWatchPolling = 'enabled' | 'disabled'

export type SprintEngineRunnerSetInput = {
  statePath: string
  // Automation-mode hint recorded on the run. The CLI watch loop it once
  // configured is gone (MC-1827); the studio reads it back to derive the run's
  // automation mode.
  cliWatchPolling: SprintEngineCliWatchPolling
}

export type SprintEngineAutomationReadInput = {
  statePath: string
}

export type SprintEngineAutomationSetModeInput = {
  statePath: string
  mode: SprintEngineAutomationMode
  // Per-window token echoed back on the broadcast so the pushing window can
  // recognize (and drop) its own echo — the broadcast is delivered before the
  // push's IPC response resolves, so a revision guard alone cannot.
  clientToken?: string
  reason?: string
  details?: string
  suppressManualAudit?: boolean
  workspaceId?: string
  workspaceName?: string
  taskId?: string
  agentId?: string
}

export type SprintEngineAutomationHydrateInput = {
  statePath: string
  mode: SprintEngineAutomationMode
}

// MC-1799: the CLI permission preset is an engine-level control like the mode,
// so it is written by statePath and never by workspace id — the Sprints door
// mounts a run with no resident workspace and must still be able to set it.
export type SprintEngineCliPermissionPresetSetInput = {
  statePath: string
  preset: SprintEngineCliPermissionPreset
  /** Echoed on the broadcast so the pushing window drops its own echo. */
  clientToken?: string
}

export type SprintEngineAutomationReadResult =
  | { ok: true; record: SprintEngineAutomationIntentRecord | null }
  | { ok: false; message: string }

export type SprintEngineAutomationWriteResult =
  | { ok: true; record: SprintEngineAutomationIntentRecord; changed: boolean }
  | { ok: false; message: string }

/**
 * Acknowledgement of a launch-settings push: the authoritative record main now
 * holds (the pusher reconciles its revision floor against it) and whether the
 * push actually changed anything — an unchanged blob is not a new revision.
 */
export type AgentLaunchSettingsWriteAck = {
  ok: true
  record: AgentLaunchSettingsRecord
  changed: boolean
}

export type SprintEngineAutomationChangedEvent = {
  statePath: string
  record: SprintEngineAutomationIntentRecord
  // The clientToken of the write that produced this event, when the writer
  // supplied one (renderer pushes). Absent for mobile/system writers.
  sourceClientToken?: string
}

export type SprintEngineRosterRuntimeInput = {
  statePath: string
  /** Registry role id; the CLI canonicalizes it and rejects unknown/off-roster roles. */
  role: string
  /** CLI id, e.g. `claude-code`. Required — pass the role's current CLI when changing only the model. */
  cli: string
  /** Model id; null/absent pins the CLI's default model (launches with no --model flag). */
  model?: string | null
}

export type SprintEngineRosterEnableInput = {
  statePath: string
  /** Registry role id; the CLI canonicalizes it and rejects unknown roles. */
  role: string
  /** Optional CLI id to seed the role's runtime in the same write. */
  cli?: string | null
  /** Model id; only meaningful with `cli`. */
  model?: string | null
}

export const SPRINT_ENGINE_MODULE_DISABLED_CODE = 'sprint_engine_module_disabled'
export const SPRINT_ENGINE_MODULE_DISABLED_MESSAGE = 'The Sprint Engine module is disabled.'
