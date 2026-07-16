/**
 * Sprint Engine auto-run planner + dispatch grammar, shared by the renderer
 * and the main process.
 *
 * Relocated from `src/renderer/src/utils/sprintengineAutoRun.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). The renderer file remains as a
 * re-export shim (it also injects the perf logger below), so every existing
 * import site and test keeps working unchanged. The only deltas from the
 * renderer original: `logPerfEvent` became the injectable
 * `setSprintEngineAutoRunPerfLogger` seam, and `Workspace` parameters became
 * the structural `SprintEngineWorkspaceView` (full renderer `Workspace`
 * objects remain assignable). Pure with respect to side effects: no
 * `window.api`, React, or store access may be added here.
 */
import type {
  AgentId,
  SprintEngineAllowedRuntime,
  SprintEngineArtifact,
  SprintEngineCurrentDispatch,
  SprintEngineEvent,
  SprintEngineRoleId,
  SprintEngineRuntimeAgent,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineWorkspaceView,
} from './run-types'
import type { SprintEngineAutoPendingSpawn } from './automation-types'
import type { SprintEngineToolName } from '../sprintengineToolNames.generated'
import {
  buildSprintEngineAgentRosterForState,
  getNextSprintEngineAgentId,
  getReviewableSprintEngineArtifacts,
  getSprintEngineArtifactAutoApprovalEligibility,
  getSprintEngineArtifactsByTaskId,
  isSprintEngineArtifactAutoApprovableKind,
  isSprintEngineTaskLaunchable,
  sprintEngineAutoApprovalBlockingSiblingsAllReviewable,
} from './state'
import { isSprintEnginePlanningRole } from './initial-spawns'

/**
 * Injectable perf-log seam. This module is shared with the main process, so it
 * cannot import the renderer's `perfDiagnostics` directly; the renderer shim
 * (`src/renderer/src/utils/sprintengineAutoRun.ts`) injects `logPerfEvent` at
 * module load, keeping renderer behavior unchanged, while other hosts default
 * to a no-op.
 */
let autoRunPerfLogger: (scope: string, event: string, payload?: Record<string, unknown>) => void = () => {}

export function setSprintEngineAutoRunPerfLogger(
  logger: (scope: string, event: string, payload?: Record<string, unknown>) => void
): void {
  autoRunPerfLogger = logger
}

/**
 * Emit through the injected perf seam. Exported so the sibling shared modules
 * (`auto-run-cycle.ts`) log through the SAME seam the renderer shim wires to
 * `logPerfEvent` — one injection point covers the whole shared auto-run corpus.
 */
export function sprintEngineAutoRunPerfLog(
  scope: string,
  event: string,
  payload?: Record<string, unknown>
): void {
  autoRunPerfLogger(scope, event, payload)
}

export const AUTO_RUN_ROLE_CONTINUATION_GRACE_MS = 30000

export const NEEDS_INPUT_AUTO_APPROVAL_STATUSES = new Set<SprintEngineArtifact['status']>([
  'ready_for_review',
  'changes_requested',
])

export type AutoRunCandidate = {
  agentId: string
  label: string
  role: SprintEngineRoleId
  taskId: string
  startupPromptOverride?: string
  /**
   * MC-1543 premium review: force the spawn onto this runtime instead of the
   * role's resolved `roleRuntimes` binding. Set only for a phase-session Birth
   * (an `awaitingPhaseSession` task), so the operator's stronger review model
   * runs even though the task's role default is a cheaper build model.
   */
  runtimeOverride?: SprintEngineAllowedRuntime
}

export type RoleContinuationGrace = {
  startedAt: number
}

/**
 * Where a sprint session's terminal should cwd, plus the execution mode the
 * spawn metadata records. `worktreeRelativePath` is project-root-relative; the
 * spawn path joins it onto the workspace folder.
 */
export type SprintEngineSessionCwd = {
  executionMode: 'current_workspace' | 'worktree'
  worktreeRelativePath?: string
}

/**
 * MC-1615 single cwd choke point. THE one reader of `vcs.worktreePath` in the
 * TS spawn path — every sprint session cwd resolves through here, so a caller
 * never dereferences the vcs seam directly. Today the run has one shared
 * worktree, so `_taskOrRepoId` is unused; it stays in the signature as the
 * routing key multi-repo sprints (MC-1610) key on to select a per-repo
 * worktree, swapping this body without touching a single caller.
 */
export function resolveSprintEngineSessionCwd(
  state: Pick<SprintEngineState, 'vcs'>,
  _taskOrRepoId: string | null | undefined
): SprintEngineSessionCwd {
  const vcs = state.vcs
  if (vcs?.mode === 'run_worktree' && vcs.worktreePath) {
    return { executionMode: 'worktree', worktreeRelativePath: vcs.worktreePath }
  }
  return { executionMode: 'current_workspace' }
}

/**
 * MC-1615 demand grouping key. The reconciler groups ready work by this key to
 * compute per-group session demand; today one key per role, so pooling is
 * per-role. Kept a function (not an inline `task.role`) so (role, repo) —
 * multi-repo sprints, MC-1610 — becomes a one-line body change rather than a
 * reconciler redesign.
 */
export function sprintEngineDemandKey(task: Pick<SprintEngineTask, 'role'>): string {
  return task.role
}

/**
 * The reconciler's demand computation: ready, launchable, unowned work grouped
 * by `sprintEngineDemandKey`, each group's task ids oldest-first. This is the
 * "desired pool" input — how many sessions each group wants before the
 * concurrency cap and already-working sessions are subtracted (MC-1592).
 */
export function computeSprintEngineDemand(
  sprintEngineState: SprintEngineState,
  keyFn: (task: SprintEngineTask) => string = sprintEngineDemandKey
): Map<string, SprintEngineTask[]> {
  const demand = new Map<string, SprintEngineTask[]>()
  for (const task of sprintEngineState.tasks) {
    if (!isSprintEngineTaskLaunchable(task, sprintEngineState)) continue
    if (task.ownerAgentId) continue
    const key = keyFn(task)
    const group = demand.get(key)
    if (group) group.push(task)
    else demand.set(key, [task])
  }
  return demand
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

export type SprintEngineClaimToolName = Extract<
  SprintEngineToolName,
  'sprintengine.task.next' | 'sprintengine.triage.needs_input'
>

/**
 * Canonical dispatch grammar: every renderer dispatch (wake, continuation,
 * notification reconcile, durable-dispatch reconcile) instructs the claim
 * tool directly. The server-side claim is the arbiter — it resumes active
 * work, claims the next ready item, or returns no work, and enforces
 * retirement/authorization itself. There is no directive hop for the agent
 * to interpret.
 */
export function buildSprintEngineClaimInstructionBlock(
  tool: SprintEngineClaimToolName,
  role: SprintEngineRoleId | string,
  agentId: string
): string {
  // The managed Sprint Engine MCP server resolves run and workspace routing
  // from the HTTP run context. Agents do not pass statePath or
  // workspaceRoot in tool payloads.
  const payload: Record<string, string> = tool === 'sprintengine.triage.needs_input'
    ? { id: agentId }
    : { role: String(role), id: agentId }
  return [
    `Call \`${tool}\` once to claim or resume this work:`,
    `\`${tool}\``,
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    'Work what it returns. If it returns no claim, reply that no work was claimed and stop — Multicode re-engages this terminal when work is ready.',
  ].join('\n')
}

export function artifactApprovalMessageKey(workspace: SprintEngineWorkspaceView, artifact: SprintEngineArtifact): string {
  return [
    workspace.id,
    artifact.id,
    artifact.fingerprint ?? '',
    artifact.updatedAt ?? '',
  ].join(':')
}

export function describeNeedsInputAutoApprovalState(sprintEngineState: SprintEngineState): string[] {
  const needsInputTasks = sprintEngineState.tasks
    .filter((task) => task.status === 'needs_input')
    .map((task) => `${task.id} (${task.role}) owner=${task.ownerAgentId ?? 'none'}`)
  const readyArtifacts = sprintEngineState.artifacts
    .filter((artifact) => artifact.status === 'ready_for_review')
    .map((artifact) => `${artifact.id} kind=${artifact.kind} task=${artifact.taskId || 'none'} createdBy=${artifact.createdBy || 'none'} path=${artifact.path || 'none'}`)

  return [
    `Needs-input tasks: ${needsInputTasks.join(', ') || 'none'}`,
    `Ready artifacts: ${readyArtifacts.join(', ') || 'none'}`,
  ]
}

export function getArchitectActionableNeedsInputTasks(sprintEngineState: SprintEngineState): SprintEngineTask[] {
  return sprintEngineState.tasks.filter((task) =>
    task.status === 'needs_input' && task.needsInput?.kind === 'architect'
  )
}

export function getAutoApprovalIntentArtifacts(sprintEngineState: SprintEngineState): SprintEngineArtifact[] {
  const tasksById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))
  const hasNeedsInputTask = sprintEngineState.tasks.some((task) => task.status === 'needs_input')
  const reviewArtifactsByTaskId = getSprintEngineArtifactsByTaskId(
    getReviewableSprintEngineArtifacts(sprintEngineState.artifacts)
  )
  return sprintEngineState.artifacts.filter((artifact) => {
    const task = tasksById.get(artifact.taskId)
    if (!task) return false
    if (!artifact.createdBy.trim() && !task.ownerAgentId?.trim()) return false

    // The artifact itself must be approvable: either ready-for-review eligible,
    // or (when a sibling task awaits input) an auto-approvable kind in an
    // approvable review status with a file. Unknown kinds stay visible for
    // manual review but must never become intents — the gate rejects them, so
    // proposing one loops warning -> cooldown -> warning forever.
    const selfApprovable =
      getSprintEngineArtifactAutoApprovalEligibility(artifact).eligible
      || (hasNeedsInputTask
        && isSprintEngineArtifactAutoApprovableKind(artifact.kind)
        && NEEDS_INPUT_AUTO_APPROVAL_STATUSES.has(artifact.status)
        && Boolean(artifact.path.trim()))
    if (!selfApprovable) return false

    // Agree with the main-process gate: a distinct-file pending sibling that is
    // not yet approvable still vetoes this intent, but a stale same-file
    // duplicate of this artifact does not. Without this the supervisor would
    // propose an artifact the gate rejects (or skip one it would accept).
    return sprintEngineAutoApprovalBlockingSiblingsAllReviewable(
      artifact,
      reviewArtifactsByTaskId[artifact.taskId] ?? []
    )
  })
}

export function isSprintEngineRunBlockedOnExternalInput(sprintEngineState: SprintEngineState): boolean {
  const incompleteTasks = sprintEngineState.tasks.filter((task) => task.status !== 'done')
  if (incompleteTasks.length === 0) return false

  const tasksById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))
  const externallyBlockedTaskIds = new Set(
    incompleteTasks
      .filter((task) =>
        task.status === 'needs_input'
        && task.needsInput?.kind === 'user'
      )
      .map((task) => task.id)
  )
  if (externallyBlockedTaskIds.size === 0) return false

  const hasActiveDispatch = Object.values(sprintEngineState.sprintEngineAgents).some((agent) =>
    agent.status === 'running' || Boolean(agent.currentDispatch)
  )
  if (hasActiveDispatch) return false

  const hasRunnableImplementationTask = sprintEngineState.tasks.some((task) =>
    isSprintEngineTaskLaunchable(task, sprintEngineState)
  )
  if (hasRunnableImplementationTask) return false

  const hasReadyArtifactApproval = getAutoApprovalIntentArtifacts(sprintEngineState)
    .some((artifact) => artifact.status === 'ready_for_review')
  if (hasReadyArtifactApproval) return false

  const isBlockedByExternalInput = (taskId: string, seen = new Set<string>()): boolean => {
    if (externallyBlockedTaskIds.has(taskId)) return true
    if (seen.has(taskId)) return false
    seen.add(taskId)
    const task = tasksById.get(taskId)
    if (!task || task.status === 'done') return false
    if (task.status !== 'todo' && task.status !== 'needs_input') return false
    return task.dependsOn.some((dependencyId) => isBlockedByExternalInput(dependencyId, seen))
  }

  return incompleteTasks.every((task) => isBlockedByExternalInput(task.id))
}

export function describeSprintEngineExternalInputAutoRunBlock(
  sprintEngineState: SprintEngineState
): { message: string; details: string; taskId?: string; agentId?: string } {
  const blockedTasks = sprintEngineState.tasks.filter((task) =>
    task.status === 'needs_input'
    && task.needsInput?.kind === 'user'
  )
  const primary = blockedTasks[0]
  if (!primary) {
    return {
      message: 'A task needs user input before agents can continue.',
      details: 'No user-routed needs_input task was present when the notification was built.',
    }
  }

  const dependentTaskIds = sprintEngineState.tasks
    .filter((task) => task.status !== 'done' && task.dependsOn.includes(primary.id))
    .map((task) => task.id)
  const question = primary.needsInput?.question?.trim()
  const reason = primary.needsInput?.reason?.trim()
  const owner = primary.ownerAgentId?.trim()
  const details = [
    `Blocking task: ${primary.id} - ${primary.title}`,
    `Needs input from: ${primary.needsInput?.kind ?? 'unknown'}`,
    reason ? `Reason: ${reason}` : null,
    question ? `Question: ${question}` : null,
    owner ? `Owner: ${owner}` : null,
    dependentTaskIds.length > 0 ? `Blocked dependents: ${dependentTaskIds.join(', ')}` : null,
    blockedTasks.length > 1 ? `Other input-blocked tasks: ${blockedTasks.slice(1).map((task) => task.id).join(', ')}` : null,
  ].filter((line): line is string => Boolean(line))

  return {
    message: question
      ? `Waiting on ${primary.id}: ${question}`
      : `Waiting on ${primary.id} (${primary.needsInput?.kind ?? 'input'}).`,
    details: details.join('\n'),
    taskId: primary.id,
    ...(owner ? { agentId: owner } : {}),
  }
}

export function continuationMessageKey(workspace: SprintEngineWorkspaceView, taskId: string, agentId: string): string {
  return [
    workspace.id,
    workspace.sprintEngineContext?.statePath ?? '',
    taskId,
    agentId,
  ].join(':')
}

export function sprintEngineDispatchDeliveryKey(
  workspace: SprintEngineWorkspaceView,
  agentId: string,
  dispatch: SprintEngineCurrentDispatch | null | undefined
): string {
  const durableDispatchId = dispatch?.dispatchId?.trim()
  const fallbackTarget = [
    dispatch?.targetKind ?? 'dispatch',
    dispatch?.taskId ?? '',
    dispatch?.artifactId ?? '',
    dispatch?.reason ?? '',
  ].join(':')
  return [
    workspace.sprintEngineContext?.statePath ?? workspace.id,
    agentId,
    durableDispatchId || fallbackTarget,
  ].join(':')
}

export function architectTriageMessageKey(workspace: SprintEngineWorkspaceView, taskIds: string[], agentId: string): string {
  return [
    workspace.id,
    workspace.sprintEngineContext?.statePath ?? '',
    agentId,
    taskIds.slice().sort().join(','),
  ].join(':')
}

export function buildSprintEngineDispatchPrompt(input: {
  role: SprintEngineRoleId
  agentId: string
  dispatch: SprintEngineCurrentDispatch
}): string {
  return [
    'Sprint Engine dispatch is ready for this terminal.',
    input.dispatch.dispatchId ? `Dispatch: ${input.dispatch.dispatchId}` : null,
    input.dispatch.targetKind ? `Target: ${input.dispatch.targetKind}` : null,
    input.dispatch.taskId ? `Task: ${input.dispatch.taskId}` : null,
    input.dispatch.reason ? `Reason: ${input.dispatch.reason}` : null,
    '',
    // Single-owner tasks: a dispatch target is always a task, so the claim tool
    // is always `sprintengine.task.next` — it resumes the agent's own task
    // through review, or claims the next ready one.
    buildSprintEngineClaimInstructionBlock('sprintengine.task.next', input.role, input.agentId),
  ].filter((line): line is string => line !== null).join('\n')
}

export function agentNotificationDeliveryKey(workspace: SprintEngineWorkspaceView, event: SprintEngineEvent): string {
  return [
    workspace.sprintEngineContext?.statePath ?? workspace.id,
    event.id,
  ].join(':')
}

/**
 * Tasks an idle roster agent could wake onto: launchable ready work only.
 * Single-owner tasks (MC-1542) have no rework column — a task that already has
 * an owner stays with that owner from claim to `done`, so it is never a wake
 * candidate for anyone. Shared by the continuation-prompt path and the
 * stalled-agent restart path so both agree on what counts as claimable wake
 * work for a live-idle agent.
 */
export function getSprintEngineWakeCandidateTasks(
  sprintEngineState: SprintEngineState
): SprintEngineTask[] {
  return sprintEngineState.tasks.filter((task) =>
    isSprintEngineTaskLaunchable(task, sprintEngineState)
  )
}

/**
 * Task-scoped wake restriction (MC-1444): a live implementation agent that has
 * owned a task may only be woken for that same task (e.g. after it is released
 * back to `ready`); new tasks go to fresh sessions so cross-task context never
 * accumulates in one terminal. Planning roles (architect/general) run whole
 * sprints in one terminal and are exempt, as is an agent that never owned a
 * task. Returns the task id the agent is restricted to, or null when
 * unrestricted. A disposed agent is unaffected: respawns start a fresh session,
 * so the spawn path may hand its roster id any task.
 */
export function sprintEngineWakeRestrictionTaskId(
  runtimeAgent: SprintEngineState['sprintEngineAgents'][string] | undefined
): string | null {
  if (!runtimeAgent?.lastOwnedTaskId) return null
  if (isSprintEnginePlanningRole(runtimeAgent.role)) return null
  return runtimeAgent.lastOwnedTaskId
}

export function findSprintEngineWakeCandidateTaskForAgent(
  wakeTasks: SprintEngineTask[],
  role: SprintEngineRoleId,
  agentId: string,
  reservedTaskIds: ReadonlySet<string>,
  // Required (no default) so a call site can never silently drop the
  // task-scoped reuse guard: pass sprintEngineWakeRestrictionTaskId(agent),
  // or null for contexts with no runtime agent.
  restrictToTaskId: string | null
): SprintEngineTask | undefined {
  return wakeTasks.find((candidate) =>
    candidate.role === role
    && !reservedTaskIds.has(candidate.id)
    // An owned task is never wake-able by another agent: single-owner tasks stay
    // with their owner until `done`, and the owner is re-engaged by the dispatch,
    // notification, or respawn paths — never by a wake handout.
    && (!candidate.ownerAgentId || candidate.ownerAgentId === agentId)
    && (!restrictToTaskId || candidate.id === restrictToTaskId)
  )
}

export const AUTO_RUN_ROLE_CONTINUATION_RETRY_MS = 60_000
export const AUTO_RUN_DISPATCH_PROMPT_RETRY_MS = 5 * 60_000
export const AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS = 60 * 60_000
export const AUTO_RUN_ACTIVE_ASSIGNMENT_MAX_PROMPTS = 2
export const AUTO_RUN_ACTIVE_ASSIGNMENT_PROMPT = 'Continue.'
/**
 * Idle retirement window. Long enough that a warm terminal is still reused
 * for back-to-back work via wake prompts; past it, a terminal with no
 * claimable role work is parked, and the operator invariant is visible
 * terminals = active work. Lazy spawn revives the role when work appears.
 */
export const AUTO_RUN_IDLE_RETIREMENT_MS = 5 * 60_000
/**
 * Per-agent cooldown after an idle terminal is retired. The retirement window
 * only counts uninterrupted idleness, which resets every time a parked role is
 * respawned (lazy spawn, roster replenishment, or a ready task that the agent
 * then cannot progress). Without a cooldown that respawn idles straight back
 * into the window and is retired again every few minutes — an unbounded
 * kill/respawn storm that spawns a fresh CLI process each cycle. The cooldown is
 * keyed by the stable roster agent id, so it survives the kill/respawn and caps
 * re-retirement of the same agent: a genuinely parked role is retired once, then
 * left parked. Long because SprintEngine is a background runner — a parked
 * terminal is far cheaper than a respawn storm, so we err toward not churning.
 */
export const AUTO_RUN_RETIREMENT_COOLDOWN_MS = 15 * 60_000
/**
 * Cooldown for task-scoped retirements (MC-1444): a worker retired because its
 * task reached terminal state, not because it was parked. Much shorter than the
 * idle cooldown — the same roster id is legitimately respawned fresh for the
 * next ready task and may finish it within minutes, and the long cooldown would
 * park that live terminal (blocking the role) until it elapsed. One minute
 * still caps a pathological kill/respawn cycle at one kill per minute; the
 * wake-prompt retry budgets bound the respawn side.
 */
export const AUTO_RUN_TASK_SCOPED_RETIREMENT_COOLDOWN_MS = 60_000
export const AUTO_RUN_MAX_PROMPT_RETRIES = 5
export const AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES = 3

export type SprintEngineDispatchAttempt = { sentAt: number; attempts?: number; exhaustedAt?: number }

export function promptRetryLimitReached(
  attempt: SprintEngineDispatchAttempt | undefined,
  maxRetries = AUTO_RUN_MAX_PROMPT_RETRIES
): boolean {
  return (attempt?.attempts ?? 0) >= maxRetries
}

export function recordPromptRetry<T extends SprintEngineDispatchAttempt>(
  attempts: Map<string, T>,
  key: string,
  sentAt: number
): void {
  const previous = attempts.get(key)
  attempts.set(key, { sentAt, attempts: (previous?.attempts ?? 0) + 1 } as T)
}

export function runtimeAgentAlreadyOwnsDispatchTarget(
  runtimeAgent: SprintEngineState['sprintEngineAgents'][string],
  dispatch: NonNullable<SprintEngineState['sprintEngineAgents'][string]['currentDispatch']>
): boolean {
  if (runtimeAgent.status !== 'running') return false
  if (!dispatch.taskId || runtimeAgent.currentTaskId !== dispatch.taskId) return false
  // Single-owner tasks (MC-1542): a dispatch target is always a task, so owning
  // the dispatch's task is owning the target. Any other targetKind is a record
  // from an older run and is never treated as already-owned.
  return dispatch.targetKind === 'task'
}

export type SprintEngineDispatchPath =
  | 'notification'
  | 'dispatch'
  | 'task_wake'
  | 'active_assignment'
  | 'restart'
  | 'respawn'
  | 'idle_retire'

/**
 * Notification kinds that may spawn a terminal for a target with no live
 * session. Everything else stays pending until the target has a terminal.
 */
export const SPAWNABLE_NOTIFICATION_KINDS = new Set([
  'task_resume_requested',
  'task_changes_requested_after_artifact_review',
])

export type SprintEngineDispatchPasteAction = {
  agentId: string
  prompt: string
  ledger: 'continuation' | 'dispatch'
  key: string
  event: string
  data: Record<string, unknown>
}

export type SprintEngineDispatchRestartAction = {
  agentId: string
  key: string
  data: Record<string, unknown>
  diagnostic: { title: string; message: string; details: string; taskId: string }
}

/**
 * Respawn a dead claimant: an in-progress task whose owner has no live terminal
 * can never be re-engaged by a paste, and server-side claim expiry only runs
 * inside agent tool calls — so after an app restart a run with zero live agents
 * deadlocks. The fix is to spawn the claimant's own terminal again; the claim
 * tool resumes its own claim, or triggers expiry and re-arbitration, either of
 * which recovers the run.
 */
export type SprintEngineDispatchRespawnAction = {
  agentId: string
  label: string
  role: SprintEngineRoleId
  taskId: string
  key: string
  data: Record<string, unknown>
  diagnostic: { title: string; message: string; details: string; taskId: string }
}

/**
 * One decided agent-notification delivery: paste into the target's live
 * terminal, or spawn the target's terminal with the notification as its
 * startup prompt (spawnable kinds only). Resolutions mark an event delivered
 * without any terminal action (e.g. retired targets).
 */
export type SprintEngineDispatchNotificationDelivery = {
  kind: 'paste' | 'spawn'
  deliveryKey: string
  agentId: string
  label: string
  role?: SprintEngineRoleId
  taskId: string
  prompt: string
  completion: boolean
  data: Record<string, unknown>
}

export type SprintEngineDispatchRetirementAction = {
  agentId: string
  /**
   * Window disposal (MC-1444 Phase 2): the agent still holds its own task
   * (single-owner tasks stay with their owner through `review` and
   * `needs_input`), so the executor keeps the agent's resume state
   * (`cliSessionId`/`cliResumeAvailable`) when clearing launch flags — a later
   * respawn then resumes the original conversation (`--resume`) instead of
   * starting from a fresh brief. Terminal-state retirements leave this unset:
   * the next task must get a fresh session.
   */
  retainResumeState?: boolean
  /**
   * Departed-worker teardown (MC-1444 B4): the agent's task is terminal
   * (`done`), so it is permanently departed. Instead of the kill-only
   * retirement — which left the panel to respawn and lost the resume token —
   * the executor runs the record + remove teardown
   * (`tearDownDepartedTaskScopedWorker`): record the resumable session, dispose
   * the PTY, then remove the panel and agent. Removing the panel unmounts its
   * TerminalView so nothing respawns, killing the idle reap ↔ respawn loop; the
   * recorded session lets a re-open from the role group resume. Mutually
   * exclusive with `retainResumeState` (that keeps a live record for an owner
   * that still holds its task).
   */
  teardown?: boolean
  data: Record<string, unknown>
  diagnostic: { title: string; message: string; details: string }
}

export type SprintEngineDispatchDiagnosticAction = {
  agentId?: string
  ledger?: 'continuation' | 'dispatch'
  key?: string
  markExhausted?: boolean
  event: string
  data: Record<string, unknown>
  diagnostic: {
    level: 'info' | 'warning' | 'error'
    title: string
    message: string
    details: string
    taskId?: string
  }
}

export type SprintEngineDispatchPlan = {
  ledgerDeletes: Array<{ ledger: 'continuation' | 'dispatch'; key: string }>
  skips: Array<{ event: string; data: Record<string, unknown> }>
  pastes: SprintEngineDispatchPasteAction[]
  restarts: SprintEngineDispatchRestartAction[]
  respawns: SprintEngineDispatchRespawnAction[]
  diagnostics: SprintEngineDispatchDiagnosticAction[]
  notificationDeliveries: SprintEngineDispatchNotificationDelivery[]
  notificationResolutions: Array<{ deliveryKey: string; event: string; data: Record<string, unknown> }>
  retirements: SprintEngineDispatchRetirementAction[]
}

/**
 * The agents a plan engages (paste, restart, respawn, notification delivery,
 * or retirement). Canonical derivation for callers that must not engage the
 * same terminal again in the same tick outside the planner (e.g. architect
 * triage).
 */
export function getSprintEngineDispatchPlanEngagedAgentIds(plan: SprintEngineDispatchPlan): Set<string> {
  const engaged = new Set<string>()
  for (const paste of plan.pastes) engaged.add(paste.agentId)
  for (const restart of plan.restarts) engaged.add(restart.agentId)
  for (const respawn of plan.respawns) engaged.add(respawn.agentId)
  for (const delivery of plan.notificationDeliveries) engaged.add(delivery.agentId)
  for (const retirement of plan.retirements) engaged.add(retirement.agentId)
  return engaged
}

export function sprintEngineIdleClockKey(workspace: SprintEngineWorkspaceView, agentId: string): string {
  return `${workspace.sprintEngineContext?.statePath ?? workspace.id}:${agentId}`
}

function isUnclaimedIdleRuntimeAgent(
  runtimeAgent: SprintEngineState['sprintEngineAgents'][string] | undefined
): boolean {
  return Boolean(
    runtimeAgent
    && runtimeAgent.status === 'idle'
    && !runtimeAgent.currentTaskId
    && !runtimeAgent.currentDispatch
  )
}

export function getSprintEngineAssignedAgentIds(sprintEngineState: SprintEngineState): Set<string> {
  const assigned = new Set<string>()
  const taskById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))
  for (const task of sprintEngineState.tasks) {
    if (
      task.ownerAgentId
      && (task.status === 'in_progress' || task.status === 'needs_input')
    ) {
      assigned.add(task.ownerAgentId)
    }
  }
  for (const [agentId, runtimeAgent] of Object.entries(sprintEngineState.sprintEngineAgents)) {
    if (
      runtimeAgent.status === 'needs_input'
      || runtimeAgent.currentDispatch
    ) {
      assigned.add(agentId)
      continue
    }
    if (runtimeAgent.currentTaskId) {
      const currentTask = taskById.get(runtimeAgent.currentTaskId)
      if (!currentTask || currentTask.status !== 'done') {
        assigned.add(agentId)
      }
    }
  }
  return assigned
}

export function isSprintEngineAgentAvailableForWake(
  sprintEngineState: SprintEngineState,
  agentId: string,
  assignedAgentIds: ReadonlySet<string> = getSprintEngineAssignedAgentIds(sprintEngineState)
): boolean {
  const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
  if (!runtimeAgent) return false
  if (runtimeAgent.status === 'needs_input' || runtimeAgent.status === 'retired') return false
  return !assignedAgentIds.has(agentId)
}

/**
 * Maintains the per-agent idle clock the `idle_retire` path reads: an entry
 * is set the first tick an agent is observed live, idle, and holding no
 * claim, and removed as soon as that stops being true (engaged, claimed,
 * retired, or its terminal is gone), so the retirement window only counts
 * uninterrupted idleness.
 */
export function updateSprintEngineIdleClock(input: {
  workspace: SprintEngineWorkspaceView
  sprintEngineState: SprintEngineState
  idleAgentIds: ReadonlySet<string>
  now: number
  clock: Map<string, number>
}): void {
  const { workspace, sprintEngineState } = input
  const activeKeys = new Set<string>()
  for (const agentId of input.idleAgentIds) {
    if (!isUnclaimedIdleRuntimeAgent(sprintEngineState.sprintEngineAgents[agentId])) continue
    const key = sprintEngineIdleClockKey(workspace, agentId)
    activeKeys.add(key)
    if (!input.clock.has(key)) input.clock.set(key, input.now)
  }
  const prefix = `${workspace.sprintEngineContext?.statePath ?? workspace.id}:`
  for (const key of [...input.clock.keys()]) {
    if (key.startsWith(prefix) && !activeKeys.has(key)) input.clock.delete(key)
  }
}

export type SprintEngineDispatchNotificationInput = {
  deliveredKeys: ReadonlySet<string>
  sentKeys: ReadonlySet<string>
  /**
   * Agents with any live terminal session, regardless of runtime status —
   * completion notifications must still reach a `done` agent's live terminal,
   * which `runningAgentIds` deliberately excludes.
   */
  liveSessionAgentIds: ReadonlySet<string>
  canSpawnTargets: boolean
}

/**
 * The ledger work segment for a task. The `task:` prefix contains ':', which is
 * what exempts the namespaced ledger keys below from the ready-task
 * wake-candidate ledger sweep (which only owns bare `<taskId>` work keys).
 */
function sprintEngineAutoRunTaskWorkKey(work: { taskId: string }): string {
  return `task:${work.taskId}`
}

export function sprintEngineRespawnLedgerKey(
  workspace: SprintEngineWorkspaceView,
  work: { taskId: string },
  agentId: string
): string {
  // The `respawn:` work segment contains ':', which exempts these keys from
  // the ready-task wake-candidate ledger sweep.
  return continuationMessageKey(workspace, `respawn:${sprintEngineAutoRunTaskWorkKey(work)}`, agentId)
}

export function sprintEngineActiveAssignmentLedgerKey(
  workspace: SprintEngineWorkspaceView,
  work: { taskId: string },
  agentId: string
): string {
  // The `active:` work segment contains ':', which keeps active-assignment
  // rescue budgets separate from normal ready-task wake prompt budgets.
  return continuationMessageKey(workspace, `active:${sprintEngineAutoRunTaskWorkKey(work)}`, agentId)
}

// MC-1592 collapsed the separate `revive:` recovery ledger into the single
// `respawn:` namespace: claimed-work respawns and departed-owner revivals now
// share one ledger, cap, and sweep (see sprintEngineRespawnLedgerKey and the
// unified recovery sweep in planSprintEngineDispatch), so there is no longer a
// distinct revive ledger key.

function sprintEngineTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function addSprintEngineTimestamp(max: number | null, value: string | null | undefined): number | null {
  const parsed = sprintEngineTimestampMs(value)
  if (parsed === null) return max
  return max === null ? parsed : Math.max(max, parsed)
}

function getSprintEngineAssignmentActivityAt(
  sprintEngineState: SprintEngineState,
  task: SprintEngineTask,
  options: {
    agentId: string
  }
): number | null {
  let activityAt: number | null = null
  activityAt = addSprintEngineTimestamp(activityAt, task.startedAt)
  activityAt = addSprintEngineTimestamp(activityAt, task.completedAt)
  for (const entry of task.activity ?? []) {
    activityAt = addSprintEngineTimestamp(activityAt, entry.timestamp)
  }
  for (const comment of task.comments ?? []) {
    activityAt = addSprintEngineTimestamp(activityAt, comment.createdAt)
  }
  for (const comment of task.latestComments ?? []) {
    activityAt = addSprintEngineTimestamp(activityAt, comment.createdAt)
  }
  for (const comment of task.latestOpenFeedback ?? []) {
    activityAt = addSprintEngineTimestamp(activityAt, comment.createdAt)
  }
  for (const artifact of sprintEngineState.artifacts) {
    if (artifact.taskId !== task.id) continue
    activityAt = addSprintEngineTimestamp(activityAt, artifact.createdAt)
    activityAt = addSprintEngineTimestamp(activityAt, artifact.updatedAt)
    for (const entry of artifact.reviewHistory) {
      activityAt = addSprintEngineTimestamp(activityAt, entry.timestamp)
    }
    activityAt = addSprintEngineTimestamp(activityAt, artifact.approvedAt)
    activityAt = addSprintEngineTimestamp(activityAt, artifact.changesRequestedAt)
  }

  const runtimeAgent = sprintEngineState.sprintEngineAgents[options.agentId]
  const dispatch = runtimeAgent?.currentDispatch
  if (dispatch?.taskId === task.id && dispatch.targetKind === 'task') {
    activityAt = addSprintEngineTimestamp(activityAt, dispatch.assignedAt)
  }
  return activityAt
}

/**
 * The reconciler core: one pure pass that decides every re-engagement action
 * for live terminals — durable-dispatch reconcile prompts, ready-task wake
 * prompts, active-assignment rescues, and stalled-agent restarts — against a
 * unified attempt ledger. The supervisor executes the returned plan (find
 * session, paste, record, log); it makes no decisions.
 */
export function planSprintEngineDispatch(input: {
  workspace: SprintEngineWorkspaceView
  sprintEngineState: SprintEngineState
  now: number
  runningAgentIds: ReadonlySet<string>
  idleAgentIds: ReadonlySet<string>
  continuationLedger: ReadonlyMap<string, SprintEngineDispatchAttempt>
  dispatchLedger: ReadonlyMap<string, SprintEngineDispatchAttempt>
  paths?: ReadonlySet<SprintEngineDispatchPath>
  notifications?: SprintEngineDispatchNotificationInput
  idleClock?: ReadonlyMap<string, number>
  /** Per-agent timestamp of the last idle retirement; suppresses re-retiring the same agent within AUTO_RUN_RETIREMENT_COOLDOWN_MS. */
  retirementCooldown?: ReadonlyMap<string, number>
  /**
   * Per-agent (idle-clock key) task id of the last task-scoped retirement.
   * Bounds the retire→respawn loop: a repeat retirement for the SAME done
   * task uses the slow idle-window cadence instead of the 60s fast path.
   */
  taskScopedRetirementTaskIds?: ReadonlyMap<string, string>
}): SprintEngineDispatchPlan {
  const { workspace, sprintEngineState, now } = input
  const include = (path: SprintEngineDispatchPath): boolean => !input.paths || input.paths.has(path)
  const plan: SprintEngineDispatchPlan = {
    ledgerDeletes: [],
    skips: [],
    pastes: [],
    restarts: [],
    respawns: [],
    diagnostics: [],
    notificationDeliveries: [],
    notificationResolutions: [],
    retirements: [],
  }
  // One engagement per agent per pass: a terminal must never receive two
  // dispatch instructions — or a paste and a kill — from the same plan.
  // Paths run in priority order (notification, dispatch, task wake,
  // active assignment, restart, respawn, idle retire); the first action
  // planned for an agent wins the pass. Enforced structurally: every
  // terminal-touching action is planned through one of the helpers below,
  // which record the engagement.
  // Paths still pre-check `engagedAgentIds` where they want a path-specific
  // skip event or to fall through to the next candidate.
  const engagedAgentIds = new Set<string>()
  const planPaste = (paste: SprintEngineDispatchPasteAction): void => {
    plan.pastes.push(paste)
    engagedAgentIds.add(paste.agentId)
  }
  const planNotificationDelivery = (delivery: SprintEngineDispatchNotificationDelivery): void => {
    plan.notificationDeliveries.push(delivery)
    engagedAgentIds.add(delivery.agentId)
  }
  const planRestart = (restart: SprintEngineDispatchRestartAction): void => {
    plan.restarts.push(restart)
    engagedAgentIds.add(restart.agentId)
  }
  const planRespawn = (respawn: SprintEngineDispatchRespawnAction): void => {
    plan.respawns.push(respawn)
    engagedAgentIds.add(respawn.agentId)
  }
  const planDiagnostic = (diagnostic: SprintEngineDispatchDiagnosticAction): void => {
    plan.diagnostics.push(diagnostic)
  }
  const planRetirement = (retirement: SprintEngineDispatchRetirementAction): void => {
    plan.retirements.push(retirement)
    engagedAgentIds.add(retirement.agentId)
  }

  if (include('notification') && input.notifications) {
    // Notifications carry their own claim-reconcile instruction, so a target
    // engaged here is not also pasted by a later path this pass. Decisions
    // mirror the historical delivery loop: retired targets resolve without a
    // terminal action, live targets get a paste (unless busy on a different
    // task), spawnable kinds spawn a missing terminal, everything else stays
    // pending until the target has a terminal.
    const config = input.notifications
    const pendingEvents = getPendingAgentNotificationEvents(
      workspace,
      sprintEngineState,
      config.deliveredKeys,
      config.sentKeys
    )
    // The roster scan only pays off when there is something to deliver; the
    // common zero-event tick must stay cheap.
    const rosterById = pendingEvents.length === 0
      ? new Map<string, ReturnType<typeof buildSprintEngineAgentRosterForState>[number]>()
      : new Map(buildSprintEngineAgentRosterForState(sprintEngineState).map((agent) => [agent.id, agent]))
    for (const event of pendingEvents) {
      const targetAgentId = event.targetAgentId
      if (!targetAgentId) continue
      const deliveryKey = agentNotificationDeliveryKey(workspace, event)
      const runtimeAgent = sprintEngineState.sprintEngineAgents[targetAgentId]
      const eventData = {
        eventId: event.id,
        agentId: targetAgentId,
        taskId: event.taskId ?? null,
        notificationKind: event.notificationKind ?? null,
      }
      if (runtimeAgent?.status === 'retired') {
        plan.notificationResolutions.push({ deliveryKey, event: 'agent-notification-skipped-retired', data: eventData })
        continue
      }
      // One engagement per agent per pass applies inside this path too: a
      // second pending event for an already-engaged target stays pending
      // (not delivered) and lands on the next tick, instead of stacking a
      // second instruction into the same terminal this pass.
      if (engagedAgentIds.has(targetAgentId)) {
        plan.skips.push({ event: 'agent-notification-deferred-agent-engaged', data: eventData })
        continue
      }
      const rosterAgent = rosterById.get(targetAgentId)
      const role = rosterAgent?.role ?? runtimeAgent?.role
      const label = workspace.agents[targetAgentId]?.name ?? rosterAgent?.label ?? targetAgentId
      const prompt = buildAgentNotificationPrompt(event, { agentId: targetAgentId, role })
      const completion = isAgentNotificationCompletionEvent(event)
      const taskId = event.taskId ?? `notification-${event.id}`
      if (config.liveSessionAgentIds.has(targetAgentId)) {
        if (event.taskId && runtimeAgent?.currentTaskId && runtimeAgent.currentTaskId !== event.taskId) {
          plan.skips.push({
            event: 'agent-notification-skipped-active-different-task',
            data: { ...eventData, eventTaskId: event.taskId, activeTaskId: runtimeAgent.currentTaskId },
          })
          continue
        }
        planNotificationDelivery({
          kind: 'paste',
          deliveryKey,
          agentId: targetAgentId,
          label,
          ...(role ? { role } : {}),
          taskId,
          prompt,
          completion,
          data: eventData,
        })
        continue
      }
      if (
        !config.canSpawnTargets
        || !SPAWNABLE_NOTIFICATION_KINDS.has(event.notificationKind ?? '')
      ) {
        plan.skips.push({ event: 'agent-notification-pending-no-session', data: eventData })
        continue
      }
      if (!role) continue
      planNotificationDelivery({
        kind: 'spawn',
        deliveryKey,
        agentId: targetAgentId,
        label,
        role,
        taskId,
        prompt,
        completion,
        data: eventData,
      })
    }
  }

  if (include('dispatch')) {
    const activeKeys = new Set<string>()
    for (const [agentId, runtimeAgent] of Object.entries(sprintEngineState.sprintEngineAgents)) {
      const dispatch = runtimeAgent.currentDispatch
      if (!dispatch || runtimeAgent.status === 'retired') continue
      const key = sprintEngineDispatchDeliveryKey(workspace, agentId, dispatch)
      activeKeys.add(key)
      const dispatchData = {
        agentId,
        role: dispatch.role ?? runtimeAgent.role,
        dispatchId: dispatch.dispatchId ?? null,
        targetKind: dispatch.targetKind ?? null,
        taskId: dispatch.taskId ?? null,
      }
      if (runtimeAgent.status === 'needs_input') {
        plan.ledgerDeletes.push({ ledger: 'dispatch', key })
        plan.skips.push({ event: 'dispatch-prompt-skipped-needs-input', data: dispatchData })
        continue
      }
      if (!input.runningAgentIds.has(agentId)) continue
      if (engagedAgentIds.has(agentId)) continue
      const previous = input.dispatchLedger.get(key)
      if (promptRetryLimitReached(previous)) {
        plan.skips.push({
          event: 'dispatch-prompt-retry-limit-reached',
          data: { ...dispatchData, attempts: previous?.attempts ?? 0, maxRetries: AUTO_RUN_MAX_PROMPT_RETRIES },
        })
        continue
      }
      if (previous && now - previous.sentAt < AUTO_RUN_DISPATCH_PROMPT_RETRY_MS) continue
      if (dispatch.taskId && runtimeAgent.currentTaskId && runtimeAgent.currentTaskId !== dispatch.taskId) {
        plan.skips.push({
          event: 'dispatch-prompt-skipped-active-different-task',
          data: { ...dispatchData, dispatchTaskId: dispatch.taskId, activeTaskId: runtimeAgent.currentTaskId },
        })
        continue
      }
      if (runtimeAgentAlreadyOwnsDispatchTarget(runtimeAgent, dispatch)) {
        plan.ledgerDeletes.push({ ledger: 'dispatch', key })
        plan.skips.push({ event: 'dispatch-prompt-skipped-active-target', data: dispatchData })
        continue
      }
      planPaste({
        agentId,
        prompt: buildSprintEngineDispatchPrompt({ role: dispatch.role ?? runtimeAgent.role, agentId, dispatch }),
        ledger: 'dispatch',
        key,
        event: 'dispatch-prompt-sent',
        data: dispatchData,
      })
    }
    input.dispatchLedger.forEach((_, key) => {
      if (!key.startsWith(`${workspace.sprintEngineContext?.statePath ?? workspace.id}:`)) return
      if (!activeKeys.has(key)) plan.ledgerDeletes.push({ ledger: 'dispatch', key })
    })
  }

  const wakeTasks = getSprintEngineWakeCandidateTasks(sprintEngineState)
  let assignedAgentIds: Set<string> | null = null
  const getAssignedAgentIdsForWake = (): ReadonlySet<string> => {
    assignedAgentIds ??= getSprintEngineAssignedAgentIds(sprintEngineState)
    return assignedAgentIds
  }

  if (include('task_wake') && input.idleAgentIds.size > 0 && wakeTasks.length > 0) {
    const readyTaskIds = new Set(wakeTasks.map((task) => task.id))
    input.continuationLedger.forEach((_, key) => {
      const workKey = getSprintEngineContinuationMessageWorkKey(workspace, key)
      if (!workKey || workKey.includes(':')) return
      if (!readyTaskIds.has(workKey)) plan.ledgerDeletes.push({ ledger: 'continuation', key })
    })

    const reservedWakeCandidateTaskIds = new Set<string>()
    for (const agentId of input.idleAgentIds) {
      if (engagedAgentIds.has(agentId)) continue
      const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
      if (!runtimeAgent) continue
      if (!isSprintEngineAgentAvailableForWake(sprintEngineState, agentId, getAssignedAgentIdsForWake())) {
        plan.skips.push({
          event: 'continuation-prompt-skipped-agent-assigned',
          data: { agentId, role: runtimeAgent.role, status: runtimeAgent.status, currentTaskId: runtimeAgent.currentTaskId ?? null },
        })
        continue
      }
      const task = findSprintEngineWakeCandidateTaskForAgent(
        wakeTasks,
        runtimeAgent.role,
        agentId,
        reservedWakeCandidateTaskIds,
        sprintEngineWakeRestrictionTaskId(runtimeAgent)
      )
      if (!task) continue
      const key = continuationMessageKey(workspace, task.id, agentId)
      const previous = input.continuationLedger.get(key)
      if (promptRetryLimitReached(previous, AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES)) {
        plan.skips.push({
          event: 'continuation-prompt-retry-limit-reached',
          data: { agentId, role: runtimeAgent.role, taskId: task.id, attempts: previous?.attempts ?? 0, maxRetries: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES },
        })
        continue
      }
      if (previous && now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) {
        reservedWakeCandidateTaskIds.add(task.id)
        continue
      }
      planPaste({
        agentId,
        prompt: buildSprintEngineContinuationPrompt(task, agentId),
        ledger: 'continuation',
        key,
        event: 'continuation-prompt-sent',
        data: { agentId, role: runtimeAgent.role, taskId: task.id },
      })
      reservedWakeCandidateTaskIds.add(task.id)
    }
  }

  if (include('active_assignment')) {
    const activeKeys = new Set<string>()
    const activeAssignments: Array<{
      agentId: string
      role: SprintEngineRoleId
      task: SprintEngineTask
    }> = []
    for (const task of sprintEngineState.tasks) {
      if (task.status === 'in_progress' && task.ownerAgentId) {
        activeAssignments.push({ agentId: task.ownerAgentId, role: task.role, task })
      }
    }

    for (const assignment of activeAssignments) {
      const runtimeAgent = sprintEngineState.sprintEngineAgents[assignment.agentId]
      const key = sprintEngineActiveAssignmentLedgerKey(
        workspace,
        { taskId: assignment.task.id },
        assignment.agentId
      )
      activeKeys.add(key)
      const rescueData = {
        agentId: assignment.agentId,
        role: assignment.role,
        taskId: assignment.task.id,
        assignmentKind: 'task' as const,
      }
      if (!input.runningAgentIds.has(assignment.agentId)) continue
      if (engagedAgentIds.has(assignment.agentId)) continue
      if (
        !runtimeAgent
        || runtimeAgent.status === 'needs_input'
        || runtimeAgent.status === 'retired'
        || runtimeAgent.status === 'done'
      ) {
        plan.skips.push({
          event: 'active-assignment-rescue-skipped-agent-status',
          data: { ...rescueData, status: runtimeAgent?.status ?? 'missing' },
        })
        continue
      }
      const activityAt = getSprintEngineAssignmentActivityAt(sprintEngineState, assignment.task, {
        agentId: assignment.agentId,
      })
      if (activityAt === null) {
        plan.skips.push({ event: 'active-assignment-rescue-skipped-no-activity-clock', data: rescueData })
        continue
      }

      let previous = input.continuationLedger.get(key)
      if (previous && activityAt > Math.max(previous.sentAt, previous.exhaustedAt ?? 0)) {
        plan.ledgerDeletes.push({ ledger: 'continuation', key })
        previous = undefined
      }
      if (now - activityAt < AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS) continue
      if (promptRetryLimitReached(previous, AUTO_RUN_ACTIVE_ASSIGNMENT_MAX_PROMPTS)) {
        if (!previous?.exhaustedAt) {
          planDiagnostic({
            agentId: assignment.agentId,
            ledger: 'continuation',
            key,
            markExhausted: true,
            event: 'active-assignment-rescue-exhausted',
            data: {
              ...rescueData,
              attempts: previous?.attempts ?? 0,
              maxPrompts: AUTO_RUN_ACTIVE_ASSIGNMENT_MAX_PROMPTS,
              inactiveMs: now - activityAt,
            },
            diagnostic: {
              level: 'warning',
              title: 'Sprint agent needs operator attention',
              message: 'A live assigned agent has not recorded sprint activity after two continuation prompts. Automatic rescue has stopped for this assignment.',
              details: [
                `Workspace: ${workspace.name}`,
                `Agent: ${assignment.agentId} (${assignment.role})`,
                `Task: ${assignment.task.id} - ${assignment.task.title}`,
                `Last sprint activity: ${new Date(activityAt).toISOString()}`,
                `Continuation prompts attempted: ${previous?.attempts ?? 0}`,
              ].join('\n'),
              taskId: assignment.task.id,
            },
          })
        }
        continue
      }
      if (previous && now - previous.sentAt < AUTO_RUN_ACTIVE_ASSIGNMENT_INACTIVITY_MS) continue
      planPaste({
        agentId: assignment.agentId,
        prompt: AUTO_RUN_ACTIVE_ASSIGNMENT_PROMPT,
        ledger: 'continuation',
        key,
        event: 'active-assignment-continuation-prompt-sent',
        data: {
          ...rescueData,
          inactiveMs: now - activityAt,
        },
      })
    }

    input.continuationLedger.forEach((_, key) => {
      const workKey = getSprintEngineContinuationMessageWorkKey(workspace, key)
      if (!workKey || !workKey.startsWith('active:')) return
      if (!activeKeys.has(key)) plan.ledgerDeletes.push({ ledger: 'continuation', key })
    })
  }

  if (include('restart') && input.idleAgentIds.size > 0 && wakeTasks.length > 0) {
    for (const agentId of input.idleAgentIds) {
      const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
      if (!runtimeAgent) continue
      if (!isSprintEngineAgentAvailableForWake(sprintEngineState, agentId, getAssignedAgentIdsForWake())) {
        plan.skips.push({
          event: 'restart-skipped-agent-assigned',
          data: { agentId, role: runtimeAgent.role, status: runtimeAgent.status, currentTaskId: runtimeAgent.currentTaskId ?? null },
        })
        continue
      }
      if (runtimeAgent.status !== 'idle' || runtimeAgent.currentTaskId || runtimeAgent.currentDispatch) continue
      const task = findSprintEngineWakeCandidateTaskForAgent(
        wakeTasks,
        runtimeAgent.role,
        agentId,
        new Set(),
        sprintEngineWakeRestrictionTaskId(runtimeAgent)
      )
      if (!task) continue
      // Any engagement planned this pass (wake, dispatch, notification) supersedes
      // a restart; in per-path mode the executed paste's ledger record trips the
      // cooldown check below instead. Either way an agent is never killed in
      // the same pass that re-engages it.
      if (engagedAgentIds.has(agentId)) continue
      const key = continuationMessageKey(workspace, task.id, agentId)
      const previous = input.continuationLedger.get(key)
      if (!previous || (previous.attempts ?? 0) < AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES) continue
      if (now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) continue
      planRestart({
        agentId,
        key,
        data: { agentId, role: runtimeAgent.role, taskId: task.id, attempts: previous.attempts ?? 0 },
        diagnostic: {
          title: 'Restarted a stalled sprint agent',
          message: `${runtimeAgent.role} had ready work on ${task.id} but its terminal stayed idle and stopped responding to wake prompts. Restarting it so the work can be claimed.`,
          details: [
            `Workspace: ${workspace.name}`,
            `Agent: ${agentId} (${runtimeAgent.role})`,
            `Task: ${task.id} - ${task.title}`,
            `Wake prompts attempted before restart: ${previous.attempts ?? 0}`,
          ].join('\n'),
          taskId: task.id,
        },
      })
    }
  }

  if (include('respawn')) {
    // Single recovery path (MC-1592): a lease whose worker has no live session
    // gets one resume attempt on the recorded session; when its retry cap is
    // spent, the engine's lease expiry returns the task to the queue and the
    // desired-pool loop covers it with a fresh session. Claimed work whose
    // claimant has no live terminal can never be re-engaged by a paste, and with
    // zero live agents server-side claim expiry never runs — after an app
    // restart this deadlocks the run. Both the claimed-work respawn and the
    // departed-owner revival below share ONE `respawn:` ledger, cap, and sweep
    // (the unified retry cap), so recovery is one resume-then-expire path.
    const liveAgentIds = new Set([...input.runningAgentIds, ...input.idleAgentIds])
    const claims: Array<{ agentId: string; role: SprintEngineRoleId; taskId: string }> = []
    for (const task of sprintEngineState.tasks) {
      if (task.status !== 'in_progress' || !task.ownerAgentId) continue
      claims.push({ agentId: task.ownerAgentId, role: task.role, taskId: task.id })
    }

    const plannedRespawnAgentIds = new Set<string>()
    for (const claim of claims) {
      if (plannedRespawnAgentIds.has(claim.agentId) || engagedAgentIds.has(claim.agentId)) continue
      if (liveAgentIds.has(claim.agentId)) continue
      const respawnData = {
        agentId: claim.agentId,
        role: claim.role,
        taskId: claim.taskId,
      }
      // Only Multicode-managed roster agents can be respawned; headless CLI
      // claimants have no renderer-owned terminal to recover.
      if (!workspace.agents[claim.agentId]) {
        plan.skips.push({ event: 'respawn-skipped-unmanaged-claimant', data: respawnData })
        continue
      }
      const runtimeAgent = sprintEngineState.sprintEngineAgents[claim.agentId]
      if (
        !runtimeAgent
        || runtimeAgent.status === 'retired'
        || runtimeAgent.status === 'needs_input'
        || runtimeAgent.status === 'done'
      ) {
        plan.skips.push({
          event: 'respawn-skipped-agent-status',
          data: { ...respawnData, status: runtimeAgent?.status ?? 'missing' },
        })
        continue
      }
      plannedRespawnAgentIds.add(claim.agentId)
      const key = sprintEngineRespawnLedgerKey(workspace, claim, claim.agentId)
      const previous = input.continuationLedger.get(key)
      if (promptRetryLimitReached(previous, AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES)) {
        plan.skips.push({
          event: 'respawn-retry-limit-reached',
          data: { ...respawnData, attempts: previous?.attempts ?? 0, maxRetries: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES },
        })
        continue
      }
      if (previous && now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) continue
      planRespawn({
        agentId: claim.agentId,
        label: workspace.agents[claim.agentId]?.name ?? claim.agentId,
        role: claim.role,
        taskId: claim.taskId,
        key,
        data: respawnData,
        diagnostic: {
          title: 'Respawned a sprint agent for claimed work',
          message: `${claim.role} owns in-progress task ${claim.taskId} but its terminal is not running. Respawning the terminal so the claim can resume.`,
          details: [
            `Workspace: ${workspace.name}`,
            `Agent: ${claim.agentId} (${claim.role})`,
            `Task: ${claim.taskId}`,
            `Respawn attempts before this one: ${previous?.attempts ?? 0}`,
          ].join('\n'),
          taskId: claim.taskId,
        },
      })
    }

    // Revive a DEPARTED owner for the task that is still waiting for it.
    // Liveness is derived, not stored (T1): a departed agent reads as plain
    // `idle`, so revival can no longer key off a `left`/`dead` status. Instead it
    // keys off task OWNERSHIP — a NO-live-agent role and a managed roster id
    // whose retained `lastOwnedTaskId` is either a claimable ready task (it was
    // released back to the queue) or a task the id still owns: respawn that id so
    // its fresh session resumes the original conversation. Under single-owner
    // tasks (MC-1542) "still owns" spans the whole publish→done tail — `review`
    // (owner reviewing its own diff), `needs_input` (owner-bound hold), and
    // `in_progress` re-bound by a human rework request. The in-progress case is
    // already covered by the claimed-work respawn above (which runs first and
    // records `plannedRespawnAgentIds`); it stays in the predicate so a claim
    // that pass skipped is not silently dropped here. A fresh ready task with no
    // prior owner is minted a never-owned id by the candidate picker instead. This
    // shares the one `respawn:` ledger + retry-limit + retry-interval machinery
    // (the unified recovery cap). Scoped to roles with NO live agent: a role whose
    // agent is merely busy/stalled is a capacity/restart concern handled by other
    // paths, not a revival.
    const liveRoles = new Set<SprintEngineRoleId>()
    for (const liveId of liveAgentIds) {
      const liveRole = sprintEngineState.sprintEngineAgents[liveId]?.role
      if (liveRole) liveRoles.add(liveRole)
    }
    const claimableWakeTaskIds = new Set<string>()
    for (const task of sprintEngineState.tasks) {
      if (isSprintEngineTaskLaunchable(task, sprintEngineState)) claimableWakeTaskIds.add(task.id)
    }
    const taskById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))
    // A task still bound to `agentId` and waiting on it to act: the owner keeps
    // its task from claim to `done`, so every non-terminal owner-held status
    // qualifies.
    const taskAwaitsOwner = (taskId: string, agentId: string): boolean => {
      const task = taskById.get(taskId)
      if (!task) return false
      if (task.status === 'review' || task.status === 'needs_input') return true
      return task.status === 'in_progress' && task.ownerAgentId === agentId
    }
    // Pass 1: a managed roster id whose retained `lastOwnedTaskId` is claimable
    // ready work or still owner-bound, and whose role has no live agent, is a
    // revival target — no status read on the agent, pure owner affinity. Keyed
    // off the agent (not one task per role) so a fresh ready task sharing the
    // role can't mask a departed owner's task. One revival per role per pass for
    // storm safety; a same-role second departed owner is recovered on a later
    // pass (once the first is live). Collected first so the sweep below knows
    // which revival keys are active.
    const revivalTargets: Array<{ role: SprintEngineRoleId; work: { taskId: string }; agentId: string }> = []
    const plannedRevivalRoles = new Set<SprintEngineRoleId>()
    for (const [agentId, runtimeAgent] of Object.entries(sprintEngineState.sprintEngineAgents)) {
      if (liveRoles.has(runtimeAgent.role)) continue // a live agent of this role will claim it
      if (plannedRevivalRoles.has(runtimeAgent.role)) continue // one revival per role per pass
      if (plannedRespawnAgentIds.has(agentId) || engagedAgentIds.has(agentId)) continue
      if (!workspace.agents[agentId]) continue // unmanaged claimant — nothing to spawn
      // Owner affinity: revive the id for its own retained task when that task is
      // claimable ready work, or is still waiting on this owner.
      const ownTaskId = runtimeAgent.lastOwnedTaskId
      let reviveTaskId = ownTaskId
        && (claimableWakeTaskIds.has(ownTaskId) || taskAwaitsOwner(ownTaskId, agentId))
        ? ownTaskId
        : null
      // Planning roles (architect/general) are persistent, not task-scoped: one
      // architect drives the whole sprint, so a departed planner is revived under
      // its SAME id for the NEXT ready task of its role, not only its own task
      // (MC-1454). Keeps the id stable across sequential planning tasks so no
      // architect-N is minted while it is away.
      if (!reviveTaskId && isSprintEnginePlanningRole(runtimeAgent.role)) {
        reviveTaskId = sprintEngineState.tasks.find(
          (candidate) => candidate.role === runtimeAgent.role && claimableWakeTaskIds.has(candidate.id)
        )?.id ?? null
      }
      if (!reviveTaskId) continue
      plannedRevivalRoles.add(runtimeAgent.role)
      revivalTargets.push({ role: runtimeAgent.role, work: { taskId: reviveTaskId }, agentId })
    }

    // Unified recovery sweep (MC-1592): claimed-work respawns and departed-owner
    // revivals share the one `respawn:` namespace, so a single sweep frees the
    // budget of any recovery target that is no longer active this pass (work
    // resolved, or the role acquired a live agent) while preserving the retry
    // cap of every still-active target — claims AND revivals. Keeping a spent
    // target's entry is deliberate: a broken CLI that spawns and immediately
    // exits must keep consuming the same capped budget, not reset it on every
    // short-lived "alive" observation.
    const activeRecoveryKeys = new Set([
      ...claims.map((claim) => sprintEngineRespawnLedgerKey(workspace, claim, claim.agentId)),
      ...revivalTargets.map((target) => sprintEngineRespawnLedgerKey(workspace, target.work, target.agentId)),
    ])
    input.continuationLedger.forEach((_, ledgerKey) => {
      const workKey = getSprintEngineContinuationMessageWorkKey(workspace, ledgerKey)
      if (!workKey || !workKey.startsWith('respawn:')) return
      if (!activeRecoveryKeys.has(ledgerKey)) plan.ledgerDeletes.push({ ledger: 'continuation', key: ledgerKey })
    })

    // Pass 2: plan each revival, capped by the retry limit + retry interval on
    // the shared `respawn:` ledger key (the unified recovery cap).
    for (const { role, work, agentId: reviveAgentId } of revivalTargets) {
      const respawnData = {
        agentId: reviveAgentId,
        role,
        taskId: work.taskId,
        reason: 'revive-departed-worker-for-own-task',
      }
      const key = sprintEngineRespawnLedgerKey(workspace, work, reviveAgentId)
      const previous = input.continuationLedger.get(key)
      if (promptRetryLimitReached(previous, AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES)) {
        plan.skips.push({
          event: 'revive-retry-limit-reached',
          data: { ...respawnData, attempts: previous?.attempts ?? 0, maxRetries: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES },
        })
        continue
      }
      if (previous && now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) continue
      plannedRespawnAgentIds.add(reviveAgentId)
      planRespawn({
        agentId: reviveAgentId,
        label: workspace.agents[reviveAgentId]?.name ?? reviveAgentId,
        role,
        taskId: work.taskId,
        key,
        data: respawnData,
        diagnostic: {
          title: 'Revived a departed sprint agent for its own task',
          message: `${role} still has work to finish on ${work.taskId} but its terminal is not running. Reviving the id that last owned the task so its session resumes.`,
          details: [
            `Workspace: ${workspace.name}`,
            `Agent: ${reviveAgentId} (${role})`,
            `Task: ${work.taskId}`,
            `Revive attempts before this one: ${previous?.attempts ?? 0}`,
          ].join('\n'),
          taskId: work.taskId,
        },
      })
    }
  }

  if (
    include('idle_retire')
    && input.idleClock
    && sprintEngineState.tasks.length > 0
    && sprintEngineState.tasks.some((task) => task.status !== 'done')
  ) {
    // Operator invariant: visible terminals = active work. A terminal that
    // has been live, idle, and unclaimed past the retirement window — with no
    // claimable work for its role that the wake/restart paths would engage it
    // on — is parked and gets retired. Lazy spawn revives the role when work
    // appears. Pre-plan runs (no tasks) and completed runs are excluded:
    // bootstrap and the all-tasks-done closure own those terminals.
    //
    // Triage (signalArchitectForNeedsInputTriage) runs outside this plan and
    // re-engages the architect whenever architect-actionable needs_input tasks
    // exist. Retiring that architect here would make triage respawn it next
    // tick and idle_retire retire it again — an unbounded kill/respawn storm.
    // The architect owns that triage work, so it is not "parked": skip it.
    const hasArchitectTriageWork =
      getArchitectActionableNeedsInputTasks(sprintEngineState).length > 0
    for (const agentId of input.idleAgentIds) {
      if (engagedAgentIds.has(agentId)) continue
      const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
      if (!runtimeAgent || !isUnclaimedIdleRuntimeAgent(runtimeAgent)) continue
      if (runtimeAgent.role === 'architect' && hasArchitectTriageWork) continue
      // Task-scoped workers (MC-1444) only ever wake for their own task, so the
      // claimable-work skip below no longer parks them on unrelated ready tasks
      // — a completed worker retires even while its role has a full queue; fresh
      // sessions take the queue.
      const restrictToTaskId = sprintEngineWakeRestrictionTaskId(runtimeAgent)
      if (findSprintEngineWakeCandidateTaskForAgent(wakeTasks, runtimeAgent.role, agentId, new Set(), restrictToTaskId)) continue
      const idleClockKey = sprintEngineIdleClockKey(workspace, agentId)
      // Task-scoped terminal state: the worker's own task is finished, so its
      // session has nothing left to return for. Retires without the 5-minute
      // idle window, on the next tick the agent is authoritatively idle (the
      // idle-clock precondition below is the deliberate safety floor — never
      // kill a terminal not observed unclaimed-idle). Only 'done' counts —
      // a `canceled` task, or a missing record, safely falls back to the idle
      // window. The publish→done tail is NOT terminal: a task in
      // review/needs_input still belongs to this owner and keeps the
      // idle-window path, so a fast resume lands in the warm terminal.
      const lastOwnedTask = restrictToTaskId
        ? sprintEngineState.tasks.find((candidate) => candidate.id === restrictToTaskId)
        : undefined
      // Storm bound (review finding): the short cooldown only applies to the
      // FIRST task-scoped retirement per completed task. A respawn that fails
      // to claim its next task keeps the stale done lastOwnedTaskId, so
      // without this check it would be killed and respawned every 60 seconds
      // indefinitely (the spawn path has no retry budget). A repeat for the
      // SAME done task falls back to the slow pre-change cadence (5-minute
      // idle window + 15-minute cooldown); a genuinely new completion always
      // gets the prompt path because its task id differs.
      const repeatTaskScopedRetirement = Boolean(
        restrictToTaskId
        && input.taskScopedRetirementTaskIds?.get(idleClockKey) === restrictToTaskId
      )
      const taskScopedComplete = lastOwnedTask?.status === 'done' && !repeatTaskScopedRetirement
      // Storm guard: a recently retired agent that was respawned (and idled
      // again) must not be retired a second time until the cooldown elapses.
      // Task-scoped retirements use the short cooldown: the same roster id is
      // legitimately respawned for the next task and may finish within minutes.
      const cooldownMs = taskScopedComplete
        ? AUTO_RUN_TASK_SCOPED_RETIREMENT_COOLDOWN_MS
        : AUTO_RUN_RETIREMENT_COOLDOWN_MS
      const retiredAt = input.retirementCooldown?.get(idleClockKey)
      if (retiredAt !== undefined && now - retiredAt < cooldownMs) continue
      const since = input.idleClock.get(idleClockKey)
      if (!since) continue
      if (taskScopedComplete) {
        // Departed permanently: its task is done and new work goes to fresh
        // sessions. Tear the panel down (record + remove) rather than kill it in
        // place — the kill-only path left the panel to auto-respawn (idle
        // reap ↔ respawn loop) and dropped the resume token.
        planRetirement({
          agentId,
          teardown: true,
          data: {
            agentId,
            role: runtimeAgent.role,
            idleMs: now - since,
            reason: 'task_scoped_terminal_state',
            taskId: restrictToTaskId,
          },
          diagnostic: {
            title: 'Closed a finished sprint worker',
            message: `${runtimeAgent.role} finished ${restrictToTaskId}, so its panel was closed. Re-open the role from its group to resume that conversation; new work spawns a fresh session.`,
            details: [
              `Workspace: ${workspace.name}`,
              `Agent: ${agentId} (${runtimeAgent.role})`,
              `Completed task: ${restrictToTaskId}`,
              'One agent session per task keeps worker context small; the recorded session resumes on re-open, and new ready work spawns a fresh session.',
            ].join('\n'),
          },
        })
        continue
      }
      if (now - since < AUTO_RUN_IDLE_RETIREMENT_MS) continue
      // Window disposal: the owner still holds its task (single-owner tasks stay
      // with their owner from claim to `done`), so keep its resume state — the
      // respawn that finishes `review`, answers a `needs_input` hold, or picks up
      // a human rework request resumes the original conversation with the diff
      // context that feedback references (MC-1444 Phase 2). `in_progress` is
      // qualified by ownership because a released task keeps its old
      // `lastOwnedTaskId` on this agent while a different owner works it.
      const ownerStillHoldsTask = Boolean(
        lastOwnedTask
        && (lastOwnedTask.status === 'review'
          || lastOwnedTask.status === 'needs_input'
          || (lastOwnedTask.status === 'in_progress' && lastOwnedTask.ownerAgentId === agentId))
      )
      const idleMinutes = Math.round((now - since) / 60_000)
      planRetirement({
        agentId,
        ...(ownerStillHoldsTask ? { retainResumeState: true } : {}),
        data: { agentId, role: runtimeAgent.role, idleMs: now - since, reason: 'idle_window', retainResumeState: ownerStillHoldsTask },
        diagnostic: {
          title: 'Retired an idle sprint terminal',
          message: `${runtimeAgent.role} had no claimable work for ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}, so its terminal was closed. The role respawns automatically when work is ready.`,
          details: [
            `Workspace: ${workspace.name}`,
            `Agent: ${agentId} (${runtimeAgent.role})`,
            `Idle for: ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}`,
            'Lazy spawning revives this role as soon as claimable work appears.',
          ].join('\n'),
        },
      })
    }
  }

  return plan
}

export function getSprintEngineContinuationMessageWorkKey(workspace: SprintEngineWorkspaceView, key: string): string | null {
  const prefix = `${workspace.id}:${workspace.sprintEngineContext?.statePath ?? ''}:`
  if (!key.startsWith(prefix)) return null
  const agentSeparatorIndex = key.lastIndexOf(':')
  if (agentSeparatorIndex <= prefix.length) return null
  return key.slice(prefix.length, agentSeparatorIndex)
}

export type SprintEngineBootstrapDecision =
  | { kind: 'spawn'; candidate: AutoRunCandidate }
  | { kind: 'stall'; reason: 'no_planner' | 'architect_exited_before_plan' }
  | { kind: 'none' }

/**
 * Run-start bootstrap decision. Before a plan exists there are no tasks, so
 * `pickNextAutoRuns` has nothing to select — the run's planning-capable agent
 * (the architect, or a soulless General when no architect is rostered) is
 * spawned here, carrying its stored handoff prompt when one exists. Every other
 * spawn is work-driven: ready tasks flow through `pickNextAutoRuns` under the
 * concurrency cap, notification targets through notification delivery, and
 * needs-input triage through the architect triage path.
 *
 * A planner terminal that exited after its startup prompt was delivered is not
 * respawned blindly (a broken CLI would spawn/exit loop); that pre-plan stall is
 * reported as a decision so the supervisor can surface it once.
 */
export function pickSprintEngineBootstrapCandidate(
  workspace: SprintEngineWorkspaceView,
  sprintEngineState: SprintEngineState,
  options: {
    runningAgentIds: ReadonlySet<string>
    inFlightSpawnKeys: ReadonlySet<string>
  }
): SprintEngineBootstrapDecision {
  const runHasTasks = sprintEngineState.tasks.length > 0
  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  // Prefer the architect when one is rostered; otherwise a General plans the
  // run itself. Either is a planning-capable bootstrap candidate.
  const planner =
    roster.find((candidate) => candidate.role === 'architect')
    ?? roster.find((candidate) => isSprintEnginePlanningRole(candidate.role))
  if (!planner) {
    return runHasTasks ? { kind: 'none' } : { kind: 'stall', reason: 'no_planner' }
  }

  const currentAgent = workspace.agents[planner.id]
  const hasUndeliveredStartupPrompt =
    Boolean(currentAgent?.cliStartupPrompt?.trim()) && !currentAgent?.cliOnboardingPromptSent
  if (runHasTasks && !hasUndeliveredStartupPrompt) return { kind: 'none' }

  const runtimeAgent = sprintEngineState.sprintEngineAgents[planner.id]
  if (runtimeAgent?.status === 'retired') return { kind: 'none' }
  if (options.runningAgentIds.has(planner.id)) return { kind: 'none' }
  if (options.inFlightSpawnKeys.has(`${workspace.id}:${planner.id}`)) return { kind: 'none' }

  if (currentAgent?.cliLastExitedAt && !hasUndeliveredStartupPrompt) {
    return { kind: 'stall', reason: 'architect_exited_before_plan' }
  }

  return {
    kind: 'spawn',
    candidate: {
      agentId: planner.id,
      label: currentAgent?.name ?? planner.label,
      role: planner.role,
      taskId: `bootstrap-${planner.id}`,
    },
  }
}

export function getSprintEngineAutoRunOccupiedAgentIds(input: {
  tasks: SprintEngineTask[]
  pendingSpawns: SprintEngineAutoPendingSpawn[]
  inFlightSpawnKeys: Iterable<string>
  workspaceId: string
  runningAgentIds?: ReadonlySet<string>
}): Set<string> {
  const occupiedAgentIds = new Set<string>([
    ...input.tasks
      .filter((task) =>
        (
          task.status === 'in_progress'
          || (task.status === 'needs_input' && (!input.runningAgentIds || input.runningAgentIds.has(task.ownerAgentId ?? '')))
        )
        && Boolean(task.ownerAgentId)
      )
      .map((task) => task.ownerAgentId!),
    ...input.pendingSpawns.map((pending) => pending.agentId),
  ])
  for (const spawnKey of input.inFlightSpawnKeys) {
    if (!spawnKey.startsWith(`${input.workspaceId}:`)) continue
    occupiedAgentIds.add(spawnKey.slice(input.workspaceId.length + 1))
  }
  return occupiedAgentIds
}

export function buildSprintEngineContinuationPrompt(
  task: SprintEngineTask,
  agentId: string
): string {
  return [
    `Sprint Engine roster runner found a wake candidate for a ready ${task.role} task in this available terminal.`,
    `Task: ${task.id} - ${task.title}`,
    buildSprintEngineClaimInstructionBlock('sprintengine.task.next', task.role, agentId),
  ].join('\n')
}

/**
 * MC-1543 phase-session Birth prompt. The engine has released this task to a
 * bound runtime (`awaitingPhaseSession`); this fresh session claims it through
 * `task next`, which returns the diff-seeded review brief inline — so the prompt
 * only has to point the session at the claim, not carry the diff itself.
 */
export function buildSprintEnginePhaseSessionPrompt(
  task: SprintEngineTask,
  agentId: string,
  phase: string
): string {
  // Claim BY TASK ID via task.claim — pinned to this session so a concurrent
  // cheaper same-role session cannot grab the review off the bound runtime (a
  // plain task.next never claims a phase session). The claim returns the
  // diff-seeded brief inline.
  return [
    `Sprint Engine assigned you the ${phase} phase of a ${task.role} task on this runtime.`,
    `Task: ${task.id} - ${task.title}`,
    'Call `sprintengine.task.claim` once to take over this phase:',
    '`sprintengine.task.claim`',
    '```json',
    JSON.stringify({ taskId: task.id, id: agentId }, null, 2),
    '```',
    `It returns the published diff and the ${phase} directive; review that diff, fix what you find in place, then advance the phase.`,
  ].join('\n')
}

export const AGENT_COMPLETION_NOTIFICATION_KINDS = new Set<string>([
  'task_completed_after_artifact_approval',
  'task_completed_after_input_resolution',
])

const MAX_AGENT_NOTIFICATION_MESSAGE_CHARS = 320

export function isAgentNotificationCompletionEvent(event: SprintEngineEvent): boolean {
  return AGENT_COMPLETION_NOTIFICATION_KINDS.has(event.notificationKind ?? '')
}

function compactNotificationMessage(message: string | null | undefined): string {
  const compact = (message ?? '').replace(/\s+/g, ' ').trim()
  if (compact.length <= MAX_AGENT_NOTIFICATION_MESSAGE_CHARS) return compact
  return `${compact.slice(0, MAX_AGENT_NOTIFICATION_MESSAGE_CHARS - 3).trimEnd()}...`
}

function buildCompactAgentNotificationMessage(event: SprintEngineEvent): string {
  switch (event.notificationKind) {
    case 'task_resume_requested':
      return 'Input was resolved for this task. Re-read the task card before continuing.'
    case 'task_completed_after_input_resolution':
      return 'Input was resolved and this sprint task is complete.'
    case 'task_released_from_owner':
      return 'This task was released from its previous owner. Re-read the task card before continuing.'
    case 'task_changes_requested_after_artifact_review':
      return event.artifactId
        ? `Changes were requested after artifact review for ${event.artifactId}.`
        : 'Changes were requested after artifact review.'
    case 'task_completed_after_artifact_approval':
      return event.artifactId
        ? `Artifact ${event.artifactId} was approved and this sprint task is complete.`
        : 'The linked artifact was approved and this sprint task is complete.'
    default:
      return compactNotificationMessage(event.message) || 'Review the current task card for details.'
  }
}

export function buildAgentNotificationPrompt(
  event: SprintEngineEvent,
  options: { agentId?: string; role?: SprintEngineRoleId } = {}
): string {
  const isCompletion = isAgentNotificationCompletionEvent(event)
  const taskReadCall = !isCompletion && event.taskId
    ? `Re-read the current task card via \`sprintengine.task.get\` with \`{ taskId: "${event.taskId}" }\`, then review its feedback comments, notes, acceptance criteria, and evidence before continuing. Do not claim a new task.`
    : isCompletion
      ? 'Your sprint task is complete. Do not claim another task in this terminal unless explicitly instructed.'
      : 'Re-read the current task card via `sprintengine.task.get`, then review its feedback comments, notes, acceptance criteria, and evidence before continuing. Do not claim a new task.'
  const reconcileBlock = !isCompletion && options.agentId && options.role
    ? [
      'Then reconcile through the claim tool — it returns your active task while you still own one; if it returns different work or no claim, follow what it returns instead of this notification:',
      buildSprintEngineClaimInstructionBlock('sprintengine.task.next', options.role, options.agentId),
    ].join('\n')
    : null

  return [
    'Sprint notification.',
    event.taskId ? `Task: ${event.taskId}` : null,
    event.artifactId ? `Artifact: ${event.artifactId}` : null,
    event.notificationKind ? `Type: ${event.notificationKind}` : null,
    '',
    buildCompactAgentNotificationMessage(event),
    '',
    taskReadCall,
    reconcileBlock,
  ].filter((line): line is string => line !== null).join('\n')
}

export function buildArchitectNeedsInputTriagePrompt(input: {
  workspaceFolderPath: string
  sprintEngineStatePath: string
  taskIds: string[]
}): string {
  // The managed Sprint Engine MCP server resolves run routing from the HTTP
  // run context.
  const triagePayload = {
    id: 'architect',
  }
  return [
    'Fetch the canonical Sprint Engine architect triage instructions from the managed Sprint Engine MCP server.',
    `Worker cwd: ${input.workspaceFolderPath}`,
    `Architect-actionable needs_input tasks detected: ${input.taskIds.join(', ')}.`,
    'Call the triage tool through MCP:',
    ['`sprintengine.triage.needs_input`', '```json', JSON.stringify(triagePayload, null, 2), '```'].join('\n'),
    'Follow the returned directive. Resolve planning or task-card blockers only; do not edit application source in this triage mode. Add task notes via `sprintengine.task.note` when the original worker can continue, then stop.',
  ].join('\n\n')
}

export function getPendingAgentNotificationEvents(
  workspace: SprintEngineWorkspaceView,
  sprintEngineState: SprintEngineState,
  deliveredKeys: ReadonlySet<string>,
  alreadySentKeys: ReadonlySet<string>
): SprintEngineEvent[] {
  const seenKeys = new Set<string>()
  const pending: SprintEngineEvent[] = []
  for (const event of sprintEngineState.events) {
    if (event.type !== 'agent_notification_requested') continue
    if (!event.id || !event.targetAgentId) continue
    const deliveryKey = agentNotificationDeliveryKey(workspace, event)
    if (deliveredKeys.has(deliveryKey) || alreadySentKeys.has(deliveryKey)) continue
    // Duplicate event observations (same id appearing more than once in the
    // events array) collapse to a single pending delivery so the supervisor
    // never writes the same notification twice in one tick.
    if (seenKeys.has(deliveryKey)) continue
    seenKeys.add(deliveryKey)
    pending.push(event)
  }
  return pending
}

export type PickNextAutoRunsOptions = {
  limit: number
  pendingSpawns: SprintEngineAutoPendingSpawn[]
  runningAgentIds: ReadonlySet<string>
  inFlightSpawns: ReadonlySet<string>
  continuationCapacityByRole: ReadonlyMap<SprintEngineRoleId, number>
  continuationGraceByTask: Map<string, RoleContinuationGrace>
  /** Read-only access to existing agent name overrides; defaults to label fallback when absent. */
  agentLabelById?: (agentId: string) => string | undefined
}

export function pickNextAutoRuns(
  workspace: SprintEngineWorkspaceView,
  sprintEngineState: SprintEngineState,
  options: PickNextAutoRunsOptions
): AutoRunCandidate[] {
  if (options.limit <= 0) return []

  const startedAt = performance.now()
  autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-start', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    limit: options.limit,
    taskCount: sprintEngineState.tasks.length,
    agentCount: Object.keys(sprintEngineState.sprintEngineAgents).length,
    pendingSpawnCount: options.pendingSpawns.length,
    runningAgentCount: options.runningAgentIds.size,
    inFlightSpawnCount: options.inFlightSpawns.size,
    continuationCapacity: Object.fromEntries(options.continuationCapacityByRole),
  })
  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-roster', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    rosterCount: roster.length,
  })
  const rosterById = Object.fromEntries(roster.map((agent) => [agent.id, agent]))
  const labelFor = (agentId: string, fallback: string): string =>
    options.agentLabelById?.(agentId) ?? workspace.agents[agentId]?.name ?? fallback
  const pendingTaskIds = new Set(options.pendingSpawns.map((pending) => pending.taskId))
  const pendingAgentIds = new Set(options.pendingSpawns.map((pending) => pending.agentId))
  const selectedTaskIds = new Set<string>()
  const selectedAgentIds = new Set<string>()
  const candidates: AutoRunCandidate[] = []

  const hasInFlightSpawn = (agentId: string) =>
    options.inFlightSpawns.has(`${workspace.id}:${agentId}`)

  const isEligibleRoleAgent = (
    candidateId: string,
    candidateRole: SprintEngineRoleId,
    role: SprintEngineRoleId
  ): boolean => {
    const runtime = sprintEngineState.sprintEngineAgents[candidateId]
    return candidateRole === role
      && runtime?.status === 'idle'
      && !runtime.currentTaskId
      && !pendingAgentIds.has(candidateId)
      && !selectedAgentIds.has(candidateId)
      && !options.runningAgentIds.has(candidateId)
      && !hasInFlightSpawn(candidateId)
  }

  // New-claim capacity for a task-scoped (non-planning) role. A fresh ready task
  // may only be handed to a NEVER-OWNED idle roster id — a spawned-but-unclaimed
  // or seeded worker — which we reuse when one exists (restart-in-place, no id
  // churn). MC-1591 leases: the engine no longer pre-mints that capacity, so
  // when none is reusable the spawner MINTS the task-scoped id itself and the
  // engine binds it at claim. A used id (one that has ever owned a task) is
  // never eligible for a new claim; its only reuse is the owner-keyed respawn.
  const pickOrMintTaskAgent = (role: SprintEngineRoleId): AutoRunCandidate['agentId'] => {
    const reusable = roster.find((candidate) =>
      isEligibleRoleAgent(candidate.id, candidate.role, role)
      && !sprintEngineState.sprintEngineAgents[candidate.id]?.lastOwnedTaskId
    )
    if (reusable) return reusable.id
    // Mint. Mirror the phase-session birth below: seed the allocator with every
    // id a concurrent spawn already holds (projection roster, pending, selected,
    // running, in-flight) so a minted `<role>-N` never collides with live
    // capacity or another mint this pass. Placeholders only need to occupy the
    // id in the allocator's used-id set; a role matching no real role keeps them
    // out of its per-role index scan so they never distort a `<role>-N` value.
    const reserved: Record<AgentId, SprintEngineRuntimeAgent> = { ...sprintEngineState.sprintEngineAgents }
    const reserve = (id: string) => {
      if (!reserved[id]) reserved[id] = { role: '' as SprintEngineRoleId } as SprintEngineRuntimeAgent
    }
    for (const id of pendingAgentIds) reserve(id)
    for (const id of selectedAgentIds) reserve(id)
    for (const id of options.runningAgentIds) reserve(id)
    for (const spawnKey of options.inFlightSpawns) {
      if (spawnKey.startsWith(`${workspace.id}:`)) reserve(spawnKey.slice(workspace.id.length + 1))
    }
    return getNextSprintEngineAgentId(role, reserved)
  }

  // Owner-keyed respawn (MC-1444 Phase 2) is NOT a picker responsibility:
  // a departed owner now reads as `idle` (T1), so a picker respawn here would be
  // an UNTHROTTLED second authority racing the retry-limited revival pass in
  // planSprintEngineDispatch and defeating its storm cap. The ready-task loop
  // therefore DEFERS any task whose previous owner is still bound to it (see
  // `hasBoundOwner` below): a live owner is woken via the wake paste, a departed
  // owner is respawned by the revival pass — the single throttled authority.
  // Both routes call spawnAutoRunCandidate, which resumes the retained
  // conversation, so owner affinity is preserved.

  // Persistent planning identity (MC-1454): planning roles (architect/general)
  // are NOT task-scoped — one planner drives the whole sprint, so its id is
  // reused across sequential planning tasks instead of minting `<planner>-N`.
  // The task-scoped mint above would hand each planning task a fresh id, so
  // planning roles route here instead. Reuse an eligible seated planning id
  // regardless of its retained lastOwnedTaskId, else target the deterministic
  // bare `<role>` persistent planning id (the id creation seeds for the
  // architect) so the supervisor spawns it. If an agent of the role already
  // exists we do NOT mint: a busy one will free up, and a departed one is
  // revived through the retry-limited revival path — no second spawn racing it.
  const findPlanningRoleAgent = (role: SprintEngineRoleId): AutoRunCandidate['agentId'] | null => {
    const seated = roster.find((candidate) => isEligibleRoleAgent(candidate.id, candidate.role, role))
    if (seated) return seated.id
    const roleHasAgent = Object.values(sprintEngineState.sprintEngineAgents).some(
      (candidate) => candidate.role === role
    )
    if (roleHasAgent) return null
    return role
  }

  const addCandidate = (
    task: SprintEngineTask,
    agentId: string,
    fallbackLabel: string
  ) => {
    if (candidates.length >= options.limit) return false
    const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
    if (runtimeAgent?.status === 'retired') return false
    if (pendingTaskIds.has(task.id) || selectedTaskIds.has(task.id)) return false
    if (
      pendingAgentIds.has(agentId)
      || selectedAgentIds.has(agentId)
      || options.runningAgentIds.has(agentId)
      || hasInFlightSpawn(agentId)
    ) {
      return false
    }

    candidates.push({
      agentId,
      label: labelFor(agentId, fallbackLabel),
      role: task.role,
      taskId: task.id,
    })
    selectedTaskIds.add(task.id)
    selectedAgentIds.add(agentId)
    return true
  }

  const activeTasks = sprintEngineState.tasks.filter((task) =>
    task.status === 'in_progress' && Boolean(task.ownerAgentId)
  )
  autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-active-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    activeTaskCount: activeTasks.length,
  })

  for (const task of activeTasks) {
    if (candidates.length >= options.limit) break
    const ownerAgentId = task.ownerAgentId
    if (!ownerAgentId) continue
    const agentId = ownerAgentId
    const rosterAgent = rosterById[agentId]
    addCandidate(task, agentId, rosterAgent?.label ?? agentId)
  }

  // MC-1543 phase-session Birth. A task the engine released to a bound runtime
  // has no owner and sits at its review phase — a non-claimable board column, so
  // the ready-task loop below never sees it. It needs a FRESH task-scoped id
  // spawned on the phase's bound runtime (the operator's stronger review model);
  // that session claims the phase through `task next` (`claim_phase_session`) and
  // gets its diff-seeded brief inline. Absent `phaseRuntimes` no task ever
  // carries this marker, so zero extra sessions are created — the cost invariant.
  const awaitingPhaseTasks = sprintEngineState.tasks.filter(
    (task) => !task.ownerAgentId && Boolean(task.awaitingPhaseSession)
  )
  if (awaitingPhaseTasks.length > 0) {
    // Seed the id allocator with every id a concurrent spawn already reserved
    // (pending/selected/running/in-flight) so a minted <role>-N never collides;
    // getNextSprintEngineAgentId otherwise only avoids ids in sprintEngineAgents.
    // getNextSprintEngineAgentId reads only an entry's id + role, so a role-only
    // placeholder is enough to make the allocator skip a reserved id.
    const phaseSessionAgents: Record<AgentId, SprintEngineRuntimeAgent> = {
      ...sprintEngineState.sprintEngineAgents,
    }
    const reserveId = (id: string, role: SprintEngineRoleId) => {
      if (!phaseSessionAgents[id]) phaseSessionAgents[id] = { role } as SprintEngineRuntimeAgent
    }
    for (const id of pendingAgentIds) reserveId(id, 'developer')
    for (const id of selectedAgentIds) reserveId(id, 'developer')
    for (const id of options.runningAgentIds) reserveId(id, 'developer')
    for (const spawnKey of options.inFlightSpawns) {
      if (spawnKey.startsWith(`${workspace.id}:`)) reserveId(spawnKey.slice(workspace.id.length + 1), 'developer')
    }
    for (const task of awaitingPhaseTasks) {
      if (candidates.length >= options.limit) break
      const awaiting = task.awaitingPhaseSession
      if (!awaiting) continue
      if (pendingTaskIds.has(task.id) || selectedTaskIds.has(task.id)) continue
      const agentId = getNextSprintEngineAgentId(task.role, phaseSessionAgents)
      reserveId(agentId, task.role)
      candidates.push({
        agentId,
        label: labelFor(agentId, agentId),
        role: task.role,
        taskId: task.id,
        runtimeOverride: awaiting.runtime,
        startupPromptOverride: buildSprintEnginePhaseSessionPrompt(task, agentId, awaiting.phase),
      })
      selectedTaskIds.add(task.id)
      selectedAgentIds.add(agentId)
      autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-phase-session-birth', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        role: task.role,
        phase: awaiting.phase,
        selectedAgentId: agentId,
        runtimeCli: awaiting.runtime.cli,
        runtimeModel: awaiting.runtime.model,
      })
    }
  }

  const readyTasks = sprintEngineState.tasks.filter((task) =>
    isSprintEngineTaskLaunchable(task, sprintEngineState)
  )
  autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-ready-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    readyTaskCount: readyTasks.length,
  })
  const continuationKeyForTask = (taskId: string) =>
    [
      workspace.id,
      workspace.sprintEngineContext?.statePath ?? '',
      taskId,
    ].join(':')
  const readyTaskKeys = new Set(readyTasks.map((task) => continuationKeyForTask(task.id)))
  for (const taskKey of options.continuationGraceByTask.keys()) {
    if (taskKey.startsWith(`${workspace.id}:`) && !readyTaskKeys.has(taskKey)) {
      options.continuationGraceByTask.delete(taskKey)
    }
  }
  const reservedContinuationByRole = new Map<SprintEngineRoleId, number>()

  for (const task of readyTasks) {
    if (candidates.length >= options.limit) break
    const continuationCapacity = options.continuationCapacityByRole.get(task.role) ?? 0
    const reservedForRole = reservedContinuationByRole.get(task.role) ?? 0
    if (reservedForRole < continuationCapacity) {
      const taskKey = continuationKeyForTask(task.id)
      const grace = options.continuationGraceByTask.get(taskKey) ?? { startedAt: Date.now() }
      options.continuationGraceByTask.set(taskKey, grace)
      const elapsedMs = Date.now() - grace.startedAt
      if (elapsedMs < AUTO_RUN_ROLE_CONTINUATION_GRACE_MS) {
        reservedContinuationByRole.set(task.role, reservedForRole + 1)
        autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-ready-task-reserved-for-continuation', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          taskId: task.id,
          role: task.role,
          elapsedMs,
          graceMs: AUTO_RUN_ROLE_CONTINUATION_GRACE_MS,
        })
        continue
      }
    }

    autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-ready-task', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: task.id,
      role: task.role,
      ownerAgentId: task.ownerAgentId ?? null,
      dependsOnCount: task.dependsOn.length,
    })

    // Defer any task whose previous owner is still bound to it (retained
    // lastOwnedTaskId). Owner respawn/resume has a single authority: a LIVE owner
    // is woken via the wake paste this same supervise cycle; a DEPARTED (now
    // idle, session-less) owner is respawned by the retry-limited revival pass in
    // planSprintEngineDispatch. Acting here would either double-dispatch the task
    // (a cold fresh agent racing the warm owner) or, for a departed owner,
    // respawn it every cycle with no cross-cycle retry cap — a crash-loop
    // spawn-storm that defeats the revive ledger (review finding).
    const hasBoundOwner = Object.values(sprintEngineState.sprintEngineAgents).some(
      (runtime) => runtime.lastOwnedTaskId === task.id
    )
    if (hasBoundOwner) {
      autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-ready-task-deferred-to-bound-owner', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        role: task.role,
      })
      continue
    }

    // Planning roles keep a persistent identity — reuse the seated planner or
    // the bare `<role>` seed so sequential planning tasks share one id and no
    // `<planner>-N` is ever minted. Non-planning work is task-scoped: its worker
    // id is minted here and the engine binds it to the task at claim.
    let reusableAgentId: AutoRunCandidate['agentId'] | null
    if (isSprintEnginePlanningRole(task.role)) {
      reusableAgentId = findPlanningRoleAgent(task.role)
      if (!reusableAgentId) {
        autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-ready-task-waiting-for-planning-agent', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          taskId: task.id,
          role: task.role,
        })
        continue
      }
    } else {
      reusableAgentId = pickOrMintTaskAgent(task.role)
    }

    const agent = rosterById[reusableAgentId] ?? { id: reusableAgentId, label: reusableAgentId, role: task.role }

    addCandidate(task, agent.id, agent.label)
    autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-ready-task-result', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: task.id,
      selectedAgentId: agent.id,
      selectedAgentRole: agent.role,
      candidateCount: candidates.length,
    })
  }

  autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    candidateCount: candidates.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  })
  return candidates
}
