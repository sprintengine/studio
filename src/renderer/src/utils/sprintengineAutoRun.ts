import type {
  SprintEngineArtifact,
  SprintEngineAutoPendingSpawn,
  SprintEngineCurrentDispatch,
  SprintEngineEvent,
  SprintEngineQualityGate,
  SprintEngineRoleId,
  SprintEngineState,
  SprintEngineTask,
  Workspace,
} from '../types/workspace'
import type { SprintEngineToolName } from '../../../shared/sprintengineToolNames.generated'
import {
  buildSprintEngineAgentRosterForState,
  getOpenSprintEngineQualityGates,
  getReviewableSprintEngineArtifacts,
  getSprintEngineArtifactAutoApprovalEligibility,
  getSprintEngineArtifactsByTaskId,
  getSprintEngineTaskBoardColumn,
  isSprintEngineArtifactAutoApprovableKind,
  isSprintEngineTaskLaunchable,
  sprintEngineAutoApprovalBlockingSiblingsAllReviewable,
} from './sprintengine'
import { isSprintEnginePlanningRole } from './sprintengineInitialSpawns'
import { logPerfEvent } from './perfDiagnostics'

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
  gateId?: string
  startupPromptOverride?: string
}

export type RoleContinuationGrace = {
  startedAt: number
}

export type SprintEngineAutoRunActiveGateClaim = {
  gate: SprintEngineQualityGate
  claimedBy: string
}

export function sprintEngineAutoRunWorkKey(input: { taskId: string; gateId?: string | null }): string {
  return input.gateId ? `gate:${input.taskId}:${input.gateId}` : `task:${input.taskId}`
}

export function getClaimableSprintEngineAutoRunGates(
  task: SprintEngineTask,
  tasks: SprintEngineTask[]
): SprintEngineQualityGate[] {
  const taskColumn = getSprintEngineTaskBoardColumn(task, tasks)
  return getOpenSprintEngineQualityGates(task).filter(
    (gate) => gate.status === 'pending' && gate.phase === taskColumn
  )
}

export function getActiveSprintEngineAutoRunGateClaims(
  task: SprintEngineTask,
  tasks: SprintEngineTask[]
): SprintEngineAutoRunActiveGateClaim[] {
  const taskColumn = getSprintEngineTaskBoardColumn(task, tasks)
  return getOpenSprintEngineQualityGates(task).flatMap((gate) => {
    if (gate.status !== 'in_progress' || gate.phase !== taskColumn) return []
    const attempt = [...gate.attempts].reverse().find((candidate) =>
      candidate.status === 'in_progress' && typeof candidate.claimedBy === 'string' && candidate.claimedBy
    )
    return attempt?.claimedBy ? [{ gate, claimedBy: attempt.claimedBy }] : []
  })
}

export function isSprintEngineAutoPendingSpawnStillRelevant(
  pending: SprintEngineAutoPendingSpawn,
  task: SprintEngineTask | undefined,
  tasks: SprintEngineTask[]
): boolean {
  if (!task) return false
  if (!pending.gateId) return false
  const taskColumn = getSprintEngineTaskBoardColumn(task, tasks)
  return getOpenSprintEngineQualityGates(task).some((gate) =>
    gate.id === pending.gateId
      && gate.phase === taskColumn
      && (gate.status === 'pending' || gate.status === 'in_progress')
  )
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
  'sprintengine.task.next' | 'sprintengine.gate.next' | 'sprintengine.triage.needs_input'
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

export function artifactApprovalMessageKey(workspace: Workspace, artifact: SprintEngineArtifact): string {
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
    isSprintEngineAutoRunImplementationWakeCandidate(task, sprintEngineState)
  )
  if (hasRunnableImplementationTask) return false

  const hasOpenGateWork = sprintEngineState.tasks.some((task) => {
    const taskColumn = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
    return getOpenSprintEngineQualityGates(task).some((gate) =>
      gate.phase === taskColumn && (gate.status === 'pending' || gate.status === 'in_progress')
    )
  })
  if (hasOpenGateWork) return false

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

export function continuationMessageKey(workspace: Workspace, taskId: string, agentId: string): string {
  return [
    workspace.id,
    workspace.sprintEngineContext?.statePath ?? '',
    taskId,
    agentId,
  ].join(':')
}

export function sprintEngineDispatchDeliveryKey(
  workspace: Workspace,
  agentId: string,
  dispatch: SprintEngineCurrentDispatch | null | undefined
): string {
  const durableDispatchId = dispatch?.dispatchId?.trim()
  const fallbackTarget = [
    dispatch?.targetKind ?? 'dispatch',
    dispatch?.taskId ?? '',
    dispatch?.gateId ?? '',
    dispatch?.artifactId ?? '',
    dispatch?.attemptId ?? '',
    dispatch?.reason ?? '',
  ].join(':')
  return [
    workspace.sprintEngineContext?.statePath ?? workspace.id,
    agentId,
    durableDispatchId || fallbackTarget,
  ].join(':')
}

export function architectTriageMessageKey(workspace: Workspace, taskIds: string[], agentId: string): string {
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
    input.dispatch.gateId ? `Gate: ${input.dispatch.gateId}` : null,
    input.dispatch.reason ? `Reason: ${input.dispatch.reason}` : null,
    '',
    buildSprintEngineClaimInstructionBlock(
      input.dispatch.targetKind === 'gate' ? 'sprintengine.gate.next' : 'sprintengine.task.next',
      input.role,
      input.agentId
    ),
  ].filter((line): line is string => line !== null).join('\n')
}

export function agentNotificationDeliveryKey(workspace: Workspace, event: SprintEngineEvent): string {
  return [
    workspace.sprintEngineContext?.statePath ?? workspace.id,
    event.id,
  ].join(':')
}

function isSprintEngineAutoRunImplementationWakeCandidate(
  task: SprintEngineTask,
  sprintEngineState: SprintEngineState
): boolean {
  return isSprintEngineTaskLaunchable(task, sprintEngineState)
    || (task.status === 'changes_requested' && getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks) === 'changes_requested')
}

/**
 * Tasks an idle roster agent could wake onto: launchable ready work plus
 * ownerless/own `changes_requested` rework. Shared by the continuation-prompt
 * path and the stalled-agent restart path so both agree on what counts as
 * claimable wake work for a live-idle agent.
 */
export function getSprintEngineWakeCandidateTasks(
  sprintEngineState: SprintEngineState
): SprintEngineTask[] {
  return sprintEngineState.tasks.filter((task) =>
    isSprintEngineAutoRunImplementationWakeCandidate(task, sprintEngineState)
  )
}

/**
 * Task-scoped wake restriction (MC-1444): a live implementation agent that has
 * owned a task may only be woken for that same task (its rework); new tasks go
 * to fresh sessions so cross-task context never accumulates in one terminal.
 * Planning roles (architect/general) run whole sprints in one terminal and are
 * exempt, as is an agent that never owned a task. Returns the task id the
 * agent is restricted to, or null when unrestricted. A disposed agent is
 * unaffected: respawns start a fresh session, so the spawn path may hand its
 * roster id any task.
 */
export function sprintEngineWakeRestrictionTaskId(
  runtimeAgent: SprintEngineState['sprintEngineAgents'][string] | undefined
): string | null {
  if (!runtimeAgent?.lastOwnedTaskId) return null
  if (isSprintEnginePlanningRole(runtimeAgent.role)) return null
  return runtimeAgent.lastOwnedTaskId
}

/**
 * Cheap trigger for the task-scoped assignment op (B1/B2): true when at least
 * one ready implementation task for a non-planning role is not already covered
 * by its bound previous owner. It decides only WHETHER to call
 * `roster replenish --queue-depth`; the Python command owns the mint/capacity
 * decision authoritatively under the run lock, so the renderer keeps no
 * per-role capacity math. A covered `changes_requested` task (its previous
 * owner still exists) and a triage-pending task add nothing to mint, so both
 * are excluded to avoid a guaranteed no-op call every tick.
 */
export function sprintEngineHasUnownedReadyTask(
  sprintEngineState: SprintEngineState
): boolean {
  const boundTaskIds = new Set(
    Object.values(sprintEngineState.sprintEngineAgents)
      .filter((agent) => agent.status !== 'retired' && agent.lastOwnedTaskId)
      .map((agent) => agent.lastOwnedTaskId as string)
  )
  for (const task of getSprintEngineWakeCandidateTasks(sprintEngineState)) {
    if (isSprintEnginePlanningRole(task.role)) continue
    if (task.status === 'changes_requested' && boundTaskIds.has(task.id)) continue
    // Python's task_is_ready excludes triage-pending tasks; the TS task type
    // does not model needsTriage, but the projection always carries it —
    // counting those tasks would report a deficit Python refuses to fill,
    // one no-op CLI call per tick until the architect triages.
    if ((task as SprintEngineTask & { needsTriage?: boolean }).needsTriage === true) continue
    return true
  }
  return false
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
    && (!candidate.ownerAgentId || candidate.ownerAgentId === agentId || candidate.status === 'changes_requested')
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
  if (dispatch.targetKind === 'task') return true
  if (dispatch.targetKind !== 'gate') return false

  const currentGate = runtimeAgent.currentGate
  return Boolean(
    dispatch.gateId
    && (
      (
        currentGate
        && currentGate.taskId === dispatch.taskId
        && currentGate.gateId === dispatch.gateId
        && (!dispatch.attemptId || currentGate.attemptId === dispatch.attemptId)
      )
      || (!dispatch.attemptId && runtimeAgent.currentGateId === dispatch.gateId)
    )
  )
}

export function runtimeAgentAlreadyOwnsGateClaim(
  runtimeAgent: SprintEngineState['sprintEngineAgents'][string] | undefined,
  taskId: string,
  gateId: string,
  attemptId: string | null | undefined
): boolean {
  if (!runtimeAgent || runtimeAgent.status !== 'running') return false
  if (runtimeAgent.currentTaskId !== taskId) return false

  const currentGate = runtimeAgent.currentGate
  return Boolean(
    (
      currentGate
      && currentGate.taskId === taskId
      && currentGate.gateId === gateId
      && (!attemptId || currentGate.attemptId === attemptId)
    )
    || (!currentGate && runtimeAgent.currentGateId === gateId)
  )
}

export type SprintEngineDispatchPath =
  | 'notification'
  | 'dispatch'
  | 'task_wake'
  | 'gate'
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
 * Respawn a dead claimant: claimed work (in-progress task or gate attempt)
 * whose owner has no live terminal can never be re-engaged by a paste, and
 * server-side claim expiry only runs inside agent tool calls — so after an
 * app restart a run with zero live agents deadlocks. The fix is to spawn the
 * claimant's own terminal again; the claim tools resume their own claims, or
 * trigger expiry and re-arbitration, either of which recovers the run.
 */
export type SprintEngineDispatchRespawnAction = {
  agentId: string
  label: string
  role: SprintEngineRoleId
  taskId: string
  gateId?: string
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
   * Window disposal (MC-1444 Phase 2): the agent's own task is still in its
   * publish→verdict window, so the executor keeps the agent's resume state
   * (`cliSessionId`/`cliResumeAvailable`) when clearing launch flags — a late
   * `changes_requested` respawn then resumes the original conversation
   * (`--resume`) instead of starting from a fresh brief. Terminal-state
   * retirements leave this unset: the next task must get a fresh session.
   */
  retainResumeState?: boolean
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

export function sprintEngineIdleClockKey(workspace: Workspace, agentId: string): string {
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
    && !runtimeAgent.currentGateId
    && !runtimeAgent.currentGate
  )
}

function getGateClaimHolderAgentIds(sprintEngineState: SprintEngineState): Set<string> {
  const holders = new Set<string>()
  for (const task of sprintEngineState.tasks) {
    for (const claim of getActiveSprintEngineAutoRunGateClaims(task, sprintEngineState.tasks)) {
      holders.add(claim.claimedBy)
    }
  }
  return holders
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
    for (const gate of task.qualityGates ?? []) {
      if (gate.status !== 'in_progress') continue
      for (let index = gate.attempts.length - 1; index >= 0; index -= 1) {
        const attempt = gate.attempts[index]
        if (attempt.status !== 'in_progress' || typeof attempt.claimedBy !== 'string' || !attempt.claimedBy) continue
        assigned.add(attempt.claimedBy)
        break
      }
    }
  }
  for (const [agentId, runtimeAgent] of Object.entries(sprintEngineState.sprintEngineAgents)) {
    if (
      runtimeAgent.status === 'needs_input'
      || runtimeAgent.currentDispatch
      || runtimeAgent.currentGateId
      || runtimeAgent.currentGate
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
  workspace: Workspace
  sprintEngineState: SprintEngineState
  idleAgentIds: ReadonlySet<string>
  now: number
  clock: Map<string, number>
}): void {
  const { workspace, sprintEngineState } = input
  // Gate-attempt claims are deliberately not scanned here: an agent actively
  // working a gate has running status or currentGate set (both fail the
  // unclaimed-idle check), and the idle_retire decision re-checks gate claim
  // holders at decision time. Skipping the scan keeps the per-tick clock
  // update cheap.
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

export function sprintEngineRespawnLedgerKey(
  workspace: Workspace,
  work: { taskId: string; gateId?: string | null },
  agentId: string
): string {
  // The `respawn:` work segment contains ':', which exempts these keys from
  // the ready-task wake-candidate ledger sweep (same protection gate keys use).
  return continuationMessageKey(workspace, `respawn:${sprintEngineAutoRunWorkKey(work)}`, agentId)
}

export function sprintEngineActiveAssignmentLedgerKey(
  workspace: Workspace,
  work: { taskId: string; gateId?: string | null },
  agentId: string
): string {
  // The `active:` work segment contains ':', which keeps active-assignment
  // rescue budgets separate from normal ready-task wake prompt budgets.
  return continuationMessageKey(workspace, `active:${sprintEngineAutoRunWorkKey(work)}`, agentId)
}

export function sprintEngineReviveLedgerKey(
  workspace: Workspace,
  work: { taskId: string; gateId?: string | null },
  agentId: string
): string {
  // The `revive:` prefix keeps left-agent revival budgets in their own namespace,
  // distinct from `respawn:` (claimed-work recovery). Critical: the respawn sweep
  // only preserves keys backed by a live server-side claim, which a revival never
  // has — sharing the `respawn:` prefix would let that sweep delete revival
  // entries every pass, nullifying the retry cap. The revival path runs its own
  // sweep keyed on still-active revival targets instead.
  return continuationMessageKey(workspace, `revive:${sprintEngineAutoRunWorkKey(work)}`, agentId)
}

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
    gateId?: string | null
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

  if (options.gateId) {
    const gate = task.qualityGates?.find((candidate) => candidate.id === options.gateId)
    for (const attempt of gate?.attempts ?? []) {
      activityAt = addSprintEngineTimestamp(activityAt, attempt.startedAt)
      activityAt = addSprintEngineTimestamp(activityAt, attempt.completedAt)
    }
  }

  const runtimeAgent = sprintEngineState.sprintEngineAgents[options.agentId]
  const dispatch = runtimeAgent?.currentDispatch
  if (
    dispatch?.taskId === task.id
    && (
      (!options.gateId && dispatch.targetKind === 'task')
      || (options.gateId && dispatch.targetKind === 'gate' && dispatch.gateId === options.gateId)
    )
  ) {
    activityAt = addSprintEngineTimestamp(activityAt, dispatch.assignedAt)
  }
  return activityAt
}

/**
 * The reconciler core: one pure pass that decides every re-engagement action
 * for live terminals — durable-dispatch reconcile prompts, ready-task wake
 * prompts, claimed/unclaimed gate continuation prompts, active-assignment
 * rescues, and stalled-agent restarts — against a unified attempt ledger. The
 * supervisor executes the returned plan (find session, paste, record, log);
 * it makes no decisions.
 */
export function planSprintEngineDispatch(input: {
  workspace: Workspace
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
  // Paths run in priority order (notification, dispatch, task wake, gate,
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
        gateId: dispatch.gateId ?? null,
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

  if (include('gate')) {
    const usedIdleAgentIds = new Set<string>()
    const gatedPhaseTasks = sprintEngineState.tasks.filter((task) => {
      const column = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
      return column === 'review' || column === 'testing' || column === 'product'
    })
    for (const task of gatedPhaseTasks) {
      for (const claim of getActiveSprintEngineAutoRunGateClaims(task, sprintEngineState.tasks)) {
        const agentId = claim.claimedBy
        if (engagedAgentIds.has(agentId)) continue
        if (!input.runningAgentIds.has(agentId)) continue
        const key = continuationMessageKey(workspace, `${task.id}:${claim.gate.id}`, agentId)
        const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
        const attemptId = claim.gate.attempts.find((attempt) =>
          attempt.status === 'in_progress' && attempt.claimedBy === agentId
        )?.id
        const dispatch = runtimeAgent?.currentDispatch
        const gateData = { agentId, role: claim.gate.role, taskId: task.id, gateId: claim.gate.id, claimed: true }
        if (
          (dispatch?.targetKind === 'gate' && dispatch.taskId === task.id && dispatch.gateId === claim.gate.id)
          || runtimeAgentAlreadyOwnsGateClaim(runtimeAgent, task.id, claim.gate.id, attemptId)
        ) {
          plan.ledgerDeletes.push({ ledger: 'continuation', key })
          plan.skips.push({ event: 'gate-continuation-prompt-skipped', data: { ...gateData, reason: 'matching-current-dispatch' } })
          continue
        }
        const previous = input.continuationLedger.get(key)
        if (promptRetryLimitReached(previous)) {
          plan.skips.push({
            event: 'gate-continuation-prompt-retry-limit-reached',
            data: { ...gateData, attempts: previous?.attempts ?? 0, maxRetries: AUTO_RUN_MAX_PROMPT_RETRIES },
          })
          continue
        }
        if (previous && now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) continue
        planPaste({
          agentId,
          prompt: buildSprintEngineGateContinuationPrompt(task, claim.gate, agentId, true),
          ledger: 'continuation',
          key,
          event: 'gate-continuation-prompt-sent',
          data: gateData,
        })
      }

      for (const gate of getClaimableSprintEngineAutoRunGates(task, sprintEngineState.tasks)) {
        // Gate claiming is deliberately NOT restricted by the task-scoped wake
        // restriction (MC-1444): reviewers keep the reuse-preferring lifecycle
        // by decision, and that must include roles that also own tasks — the
        // product agent owns the intake task yet reviews every task's product
        // gate; restricting it here starves product review while the intake
        // sits in its rework window. The restriction only governs handing out
        // TASKS to a used terminal.
        const agentId = [...input.idleAgentIds].find((candidateId) => {
          if (usedIdleAgentIds.has(candidateId) || engagedAgentIds.has(candidateId)) return false
          const runtimeAgent = sprintEngineState.sprintEngineAgents[candidateId]
          return runtimeAgent?.role === gate.role
            && isSprintEngineAgentAvailableForWake(sprintEngineState, candidateId, getAssignedAgentIdsForWake())
        })
        if (!agentId) continue
        const key = continuationMessageKey(workspace, `${task.id}:${gate.id}`, agentId)
        const previous = input.continuationLedger.get(key)
        const gateData = { agentId, role: gate.role, taskId: task.id, gateId: gate.id, claimed: false }
        if (promptRetryLimitReached(previous, AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES)) {
          plan.skips.push({
            event: 'gate-continuation-prompt-retry-limit-reached',
            data: { ...gateData, attempts: previous?.attempts ?? 0, maxRetries: AUTO_RUN_MAX_WAKE_CANDIDATE_PROMPT_RETRIES },
          })
          continue
        }
        if (previous && now - previous.sentAt < AUTO_RUN_ROLE_CONTINUATION_RETRY_MS) {
          usedIdleAgentIds.add(agentId)
          continue
        }
        planPaste({
          agentId,
          prompt: buildSprintEngineGateContinuationPrompt(task, gate, agentId, false),
          ledger: 'continuation',
          key,
          event: 'gate-continuation-prompt-sent',
          data: gateData,
        })
        usedIdleAgentIds.add(agentId)
      }
    }
  }

  if (include('active_assignment')) {
    const activeKeys = new Set<string>()
    const activeAssignments: Array<{
      agentId: string
      role: SprintEngineRoleId
      task: SprintEngineTask
      gate?: SprintEngineQualityGate
      kind: 'task' | 'gate'
    }> = []
    for (const task of sprintEngineState.tasks) {
      if (task.status === 'in_progress' && task.ownerAgentId) {
        activeAssignments.push({ agentId: task.ownerAgentId, role: task.role, task, kind: 'task' })
      }
    }
    for (const task of sprintEngineState.tasks) {
      for (const claim of getActiveSprintEngineAutoRunGateClaims(task, sprintEngineState.tasks)) {
        activeAssignments.push({ agentId: claim.claimedBy, role: claim.gate.role, task, gate: claim.gate, kind: 'gate' })
      }
    }

    for (const assignment of activeAssignments) {
      const runtimeAgent = sprintEngineState.sprintEngineAgents[assignment.agentId]
      const gateId = assignment.gate?.id
      const key = sprintEngineActiveAssignmentLedgerKey(
        workspace,
        { taskId: assignment.task.id, ...(gateId ? { gateId } : {}) },
        assignment.agentId
      )
      activeKeys.add(key)
      const rescueData = {
        agentId: assignment.agentId,
        role: assignment.role,
        taskId: assignment.task.id,
        gateId: gateId ?? null,
        assignmentKind: assignment.kind,
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
        gateId,
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
                gateId ? `Gate: ${gateId}` : null,
                `Last sprint activity: ${new Date(activityAt).toISOString()}`,
                `Continuation prompts attempted: ${previous?.attempts ?? 0}`,
              ].filter((line): line is string => Boolean(line)).join('\n'),
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
      // Any engagement planned this pass (wake, gate, dispatch) supersedes a
      // restart; in per-path mode the executed paste's ledger record trips the
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
    // Claimed work whose claimant has no live terminal can never be re-engaged
    // by a paste, and with zero live agents server-side claim expiry never
    // runs — after an app restart this deadlocks the run. Respawn the
    // claimant's terminal; the claim tools resume their own claims.
    const liveAgentIds = new Set([...input.runningAgentIds, ...input.idleAgentIds])
    const claims: Array<{ agentId: string; role: SprintEngineRoleId; taskId: string; gateId?: string }> = []
    for (const task of sprintEngineState.tasks) {
      if (task.status !== 'in_progress' || !task.ownerAgentId) continue
      claims.push({ agentId: task.ownerAgentId, role: task.role, taskId: task.id })
    }
    for (const task of sprintEngineState.tasks) {
      for (const claim of getActiveSprintEngineAutoRunGateClaims(task, sprintEngineState.tasks)) {
        claims.push({ agentId: claim.claimedBy, role: claim.gate.role, taskId: task.id, gateId: claim.gate.id })
      }
    }

    // Sweep respawn ledger entries whose claim no longer exists, so a
    // resolved claim frees the budget for a future, unrelated recovery.
    // Entries for still-live claims are kept on purpose: a broken CLI that
    // spawns and immediately exits must keep consuming the same capped
    // budget, not reset it on every short-lived "alive" observation.
    const activeRespawnKeys = new Set(
      claims.map((claim) => sprintEngineRespawnLedgerKey(workspace, claim, claim.agentId))
    )
    input.continuationLedger.forEach((_, ledgerKey) => {
      const workKey = getSprintEngineContinuationMessageWorkKey(workspace, ledgerKey)
      if (!workKey || !workKey.startsWith('respawn:')) return
      if (!activeRespawnKeys.has(ledgerKey)) plan.ledgerDeletes.push({ ledger: 'continuation', key: ledgerKey })
    })

    const plannedRespawnAgentIds = new Set<string>()
    for (const claim of claims) {
      if (plannedRespawnAgentIds.has(claim.agentId) || engagedAgentIds.has(claim.agentId)) continue
      if (liveAgentIds.has(claim.agentId)) continue
      const respawnData = {
        agentId: claim.agentId,
        role: claim.role,
        taskId: claim.taskId,
        gateId: claim.gateId ?? null,
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
        ...(claim.gateId ? { gateId: claim.gateId } : {}),
        key,
        data: respawnData,
        diagnostic: {
          title: 'Respawned a sprint agent for claimed work',
          message: claim.gateId
            ? `${claim.role} holds gate ${claim.gateId} on ${claim.taskId} but its terminal is not running. Respawning the terminal so the claim can resume.`
            : `${claim.role} owns in-progress task ${claim.taskId} but its terminal is not running. Respawning the terminal so the claim can resume.`,
          details: [
            `Workspace: ${workspace.name}`,
            `Agent: ${claim.agentId} (${claim.role})`,
            `Task: ${claim.taskId}`,
            claim.gateId ? `Gate: ${claim.gateId}` : null,
            `Respawn attempts before this one: ${previous?.attempts ?? 0}`,
          ].filter((line): line is string => Boolean(line)).join('\n'),
          taskId: claim.taskId,
        },
      })
    }

    // Revive a LEFT/disposed roster agent when its role has CLAIMABLE work but no
    // live agent of that role. The claimed-work respawn above only recovers work
    // an agent already owns; once idle-retirement disposes a role's last terminal
    // (agent -> 'left'), a newly-pending gate or a freshly-ready task would
    // otherwise strand forever — the gate/ready-task pickers only match `idle`
    // agents, so they skip the work with no live agent. We reuse the same
    // ledger + retry-limit + retry-interval machinery as the claimed-work respawn
    // for storm safety. Scoped to roles with NO live agent: a role whose agent is
    // merely busy/stalled is a capacity/restart concern handled by other paths,
    // not a revival.
    const liveRoles = new Set<SprintEngineRoleId>()
    for (const liveId of liveAgentIds) {
      const liveRole = sprintEngineState.sprintEngineAgents[liveId]?.role
      if (liveRole) liveRoles.add(liveRole)
    }
    const revivalByRole = new Map<SprintEngineRoleId, { taskId: string; gateId?: string }>()
    for (const task of sprintEngineState.tasks) {
      for (const gate of getClaimableSprintEngineAutoRunGates(task, sprintEngineState.tasks)) {
        if (!revivalByRole.has(gate.role)) revivalByRole.set(gate.role, { taskId: task.id, gateId: gate.id })
      }
      if (
        isSprintEngineAutoRunImplementationWakeCandidate(task, sprintEngineState)
        && !revivalByRole.has(task.role)
      ) {
        revivalByRole.set(task.role, { taskId: task.id })
      }
    }
    // Pass 1: select one left/dead, managed roster agent per role that has
    // claimable work and no live agent. Collected first so the sweep below knows
    // exactly which revival ledger keys are still active this pass.
    const revivalTargets: Array<{ role: SprintEngineRoleId; work: { taskId: string; gateId?: string }; agentId: string }> = []
    for (const [role, work] of revivalByRole) {
      if (liveRoles.has(role)) continue // a live agent of this role will claim it
      let reviveAgentId: string | null = null
      for (const [agentId, runtimeAgent] of Object.entries(sprintEngineState.sprintEngineAgents)) {
        if (runtimeAgent.role !== role) continue
        if (runtimeAgent.status !== 'left' && runtimeAgent.status !== 'dead') continue
        if (plannedRespawnAgentIds.has(agentId) || engagedAgentIds.has(agentId)) continue
        if (!workspace.agents[agentId]) continue // unmanaged claimant — nothing to spawn
        reviveAgentId = agentId
        break
      }
      if (reviveAgentId) revivalTargets.push({ role, work, agentId: reviveAgentId })
    }

    // Sweep stale `revive:` ledger entries — any whose revival is no longer an
    // active target this pass (work resolved, or the role acquired a live agent).
    // This is the revival analogue of the `respawn:` sweep above, scoped to the
    // `revive:` namespace so the two retry budgets stay independent; without it a
    // maxed-out retry entry would permanently block a later legitimate revival.
    const activeReviveKeys = new Set(
      revivalTargets.map((target) => sprintEngineReviveLedgerKey(workspace, target.work, target.agentId))
    )
    input.continuationLedger.forEach((_, ledgerKey) => {
      const workKey = getSprintEngineContinuationMessageWorkKey(workspace, ledgerKey)
      if (!workKey || !workKey.startsWith('revive:')) return
      if (!activeReviveKeys.has(ledgerKey)) plan.ledgerDeletes.push({ ledger: 'continuation', key: ledgerKey })
    })

    // Pass 2: plan each revival, capped by the retry limit + retry interval on the
    // `revive:` ledger key (now sweep-stable, so the cap actually holds).
    for (const { role, work, agentId: reviveAgentId } of revivalTargets) {
      const respawnData = {
        agentId: reviveAgentId,
        role,
        taskId: work.taskId,
        gateId: work.gateId ?? null,
        reason: 'revive-left-for-claimable-work',
      }
      const key = sprintEngineReviveLedgerKey(workspace, work, reviveAgentId)
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
        ...(work.gateId ? { gateId: work.gateId } : {}),
        key,
        data: respawnData,
        diagnostic: {
          title: 'Revived a left sprint agent for claimable work',
          message: work.gateId
            ? `${role} has a pending ${work.gateId} gate on ${work.taskId} but every ${role} agent has left. Reviving one so the gate can be claimed.`
            : `${role} has ready work on ${work.taskId} but every ${role} agent has left. Reviving one so the task can be claimed.`,
          details: [
            `Workspace: ${workspace.name}`,
            `Agent: ${reviveAgentId} (${role})`,
            `Task: ${work.taskId}`,
            work.gateId ? `Gate: ${work.gateId}` : null,
            `Revive attempts before this one: ${previous?.attempts ?? 0}`,
          ].filter((line): line is string => Boolean(line)).join('\n'),
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
    // claimable work for its role that the wake/gate/restart paths would
    // engage it on — is parked and gets retired. Lazy spawn revives the role
    // when work appears. Pre-plan runs (no tasks) and completed runs are
    // excluded: bootstrap and the all-tasks-done closure own those terminals.
    const gateClaimHolders = getGateClaimHolderAgentIds(sprintEngineState)
    // Per-gate records (not just a role set): the parking decision below must
    // ask "could THIS agent claim one of these gates?" — a self-review-barred
    // gate on the agent's own task must not park it forever (review finding:
    // with the task-scoped wake restriction, the old role-level skip turned a
    // same-role own-task gate into a permanent zombie terminal).
    const claimableGates: Array<{ role: SprintEngineRoleId; ownerAgentId: string | null; allowSelfReview: boolean }> = []
    for (const task of sprintEngineState.tasks) {
      for (const gate of getClaimableSprintEngineAutoRunGates(task, sprintEngineState.tasks)) {
        claimableGates.push({
          role: gate.role,
          ownerAgentId: task.ownerAgentId ?? null,
          allowSelfReview: gate.allowSelfReview !== false,
        })
      }
    }
    const roleHasGateClaimableByAgent = (role: SprintEngineRoleId, agentId: string): boolean =>
      claimableGates.some((gate) =>
        gate.role === role && (gate.allowSelfReview || gate.ownerAgentId !== agentId)
      )
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
      if (gateClaimHolders.has(agentId)) continue
      if (runtimeAgent.role === 'architect' && hasArchitectTriageWork) continue
      // Task-scoped workers (MC-1444) only ever wake for their own task's
      // rework, so the claimable-work skip below no longer parks them on
      // unrelated ready tasks — a completed worker retires even while its role
      // has a full queue; fresh sessions take the queue.
      const restrictToTaskId = sprintEngineWakeRestrictionTaskId(runtimeAgent)
      if (findSprintEngineWakeCandidateTaskForAgent(wakeTasks, runtimeAgent.role, agentId, new Set(), restrictToTaskId)) continue
      if (roleHasGateClaimableByAgent(runtimeAgent.role, agentId)) continue
      const idleClockKey = sprintEngineIdleClockKey(workspace, agentId)
      // Task-scoped terminal state: the worker's own task is finished, so its
      // session has nothing left to return for. Retires without the 5-minute
      // idle window, on the next tick the agent is authoritatively idle (the
      // idle-clock precondition below is the deliberate safety floor — never
      // kill a terminal not observed unclaimed-idle). Only 'done' counts —
      // TS task statuses carry no 'canceled'; anything else, including a
      // missing record, safely falls back to the idle window. The
      // publish→verdict window is NOT terminal: a task in
      // review/testing/product/changes_requested keeps the idle-window path,
      // so fast rework still lands in the warm terminal.
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
        planRetirement({
          agentId,
          data: {
            agentId,
            role: runtimeAgent.role,
            idleMs: now - since,
            reason: 'task_scoped_terminal_state',
            taskId: restrictToTaskId,
          },
          diagnostic: {
            title: 'Retired a task-scoped sprint terminal',
            message: `${runtimeAgent.role} finished ${restrictToTaskId}, so its terminal was closed. The next task gets a fresh session; rework respawns this role automatically.`,
            details: [
              `Workspace: ${workspace.name}`,
              `Agent: ${agentId} (${runtimeAgent.role})`,
              `Completed task: ${restrictToTaskId}`,
              'One agent session per task keeps worker context small; ready work respawns the role with a fresh session.',
            ].join('\n'),
          },
        })
        continue
      }
      if (now - since < AUTO_RUN_IDLE_RETIREMENT_MS) continue
      // Window disposal: the agent's own task is published but not terminal
      // (review/testing/product/changes_requested), so keep its resume state —
      // a late changes_requested verdict resumes the original conversation
      // with the diff context the gate feedback references (MC-1444 Phase 2).
      // needs_input included (review finding): a needs_input hold keeps its
      // owner server-side exactly like the four verdict-window statuses, and
      // the eventual resolution respawn benefits from the same conversation
      // context (the question the answer references).
      const inReworkWindow = Boolean(
        lastOwnedTask
        && (lastOwnedTask.status === 'review'
          || lastOwnedTask.status === 'testing'
          || lastOwnedTask.status === 'product'
          || lastOwnedTask.status === 'changes_requested'
          || lastOwnedTask.status === 'needs_input')
      )
      const idleMinutes = Math.round((now - since) / 60_000)
      planRetirement({
        agentId,
        ...(inReworkWindow ? { retainResumeState: true } : {}),
        data: { agentId, role: runtimeAgent.role, idleMs: now - since, reason: 'idle_window', retainResumeState: inReworkWindow },
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

export function getSprintEngineContinuationMessageWorkKey(workspace: Workspace, key: string): string | null {
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
 * spawn is work-driven: ready tasks, rework, and quality gates flow through
 * `pickNextAutoRuns` under the concurrency cap, notification targets through
 * notification delivery, and needs-input triage through the architect triage
 * path.
 *
 * A planner terminal that exited after its startup prompt was delivered is not
 * respawned blindly (a broken CLI would spawn/exit loop); that pre-plan stall is
 * reported as a decision so the supervisor can surface it once.
 */
export function pickSprintEngineBootstrapCandidate(
  workspace: Workspace,
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

export function buildSprintEngineGateContinuationPrompt(
  task: SprintEngineTask,
  gate: SprintEngineQualityGate,
  agentId: string,
  claimed: boolean
): string {
  return [
    claimed
      ? 'Sprint Engine roster runner found an active quality gate already claimed by this terminal.'
      : 'Sprint Engine roster runner found a wake candidate for a quality gate in this available terminal.',
    `Task: ${task.id} - ${task.title}`,
    `Gate: ${gate.id} (${gate.phase} / ${gate.role})`,
    buildSprintEngineClaimInstructionBlock('sprintengine.gate.next', gate.role, agentId),
    'Record the verdict through MCP with `sprintengine.gate.verdict` when the review is complete.',
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
  workspace: Workspace,
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
  workspace: Workspace,
  sprintEngineState: SprintEngineState,
  options: PickNextAutoRunsOptions
): AutoRunCandidate[] {
  if (options.limit <= 0) return []

  const startedAt = performance.now()
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-start', {
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
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-roster', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    rosterCount: roster.length,
  })
  const rosterById = Object.fromEntries(roster.map((agent) => [agent.id, agent]))
  const labelFor = (agentId: string, fallback: string): string =>
    options.agentLabelById?.(agentId) ?? workspace.agents[agentId]?.name ?? fallback
  const workKeyForCandidate = (task: SprintEngineTask, gateId?: string) =>
    sprintEngineAutoRunWorkKey({ taskId: task.id, gateId })
  const pendingWorkKeys = new Set(options.pendingSpawns.map((pending) => sprintEngineAutoRunWorkKey(pending)))
  const pendingAgentIds = new Set(options.pendingSpawns.map((pending) => pending.agentId))
  const selectedTaskIds = new Set<string>()
  const selectedWorkKeys = new Set<string>()
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

  // New-claim task binding (B1/B2, task-scoped roster ids): a fresh ready task
  // may only be handed to a NEVER-OWNED idle roster id — the engine assignment
  // op (`roster replenish --queue-depth`) mints exactly one such id per
  // uncovered ready task and never recycles a spent id. A used/`left` id (one
  // that has ever owned a task) is never eligible for a new claim; its only
  // reuse is the owner-keyed rework respawn below.
  const findFreshTaskAgent = (role: SprintEngineRoleId): AutoRunCandidate['agentId'] | null => {
    const fresh = roster.find((candidate) =>
      isEligibleRoleAgent(candidate.id, candidate.role, role)
      && !sprintEngineState.sprintEngineAgents[candidate.id]?.lastOwnedTaskId
    )
    return fresh?.id ?? null
  }

  // Owner-keyed rework respawn (MC-1444 Phase 2): a changes_requested task
  // returns to the roster id that previously owned it so its respawn resumes
  // the original conversation. This is the only path that reuses a spent id,
  // and only for its OWN task.
  const findReworkOwnerAgent = (
    role: SprintEngineRoleId,
    taskId: string
  ): AutoRunCandidate['agentId'] | null => {
    const owner = roster.find((candidate) =>
      isEligibleRoleAgent(candidate.id, candidate.role, role)
      && sprintEngineState.sprintEngineAgents[candidate.id]?.lastOwnedTaskId === taskId
    )
    return owner?.id ?? null
  }

  // Ids bound to a still-pending changes_requested task: their retained
  // conversation is the whole point of owner affinity, so the gate reviewer
  // pick below must not burn them on an unrelated same-role gate while another
  // eligible id exists — the pre-ready-task general gate pass can run before
  // the ready-task loop reserves the owner for its own rework (MC-1444 Phase 2
  // regression guard). The new-claim task pick needs no such set: it is already
  // restricted to never-owned ids, which excludes every rework owner.
  const reworkOwnerAgentIds = new Set(
    Object.entries(sprintEngineState.sprintEngineAgents)
      .filter(([, runtime]) =>
        runtime.lastOwnedTaskId
        && sprintEngineState.tasks.some((candidate) =>
          candidate.id === runtime.lastOwnedTaskId && candidate.status === 'changes_requested')
      )
      .map(([agentId]) => agentId)
  )

  // Gate reviewer selection: an eligible idle roster agent of the reviewer
  // role. Reviewers persist across gates and are never task-owned, and a mixed
  // role that owns a task may still review its gates — a gate claim is not a
  // task claim, so the task-scoped never-owned restriction does not apply here.
  // Two-tier so a rework owner keeps its own task: prefer an id not bound to a
  // pending changes_requested task, falling back to any eligible id only when
  // none exists (throughput over a stalled gate).
  const findGateReviewerAgent = (role: SprintEngineRoleId): AutoRunCandidate['agentId'] | null => {
    const unreserved = roster.find((candidate) =>
      isEligibleRoleAgent(candidate.id, candidate.role, role) && !reworkOwnerAgentIds.has(candidate.id)
    )
    if (unreserved) return unreserved.id
    const agent = roster.find((candidate) => isEligibleRoleAgent(candidate.id, candidate.role, role))
    return agent?.id ?? null
  }

  const addCandidate = (
    task: SprintEngineTask,
    agentId: string,
    fallbackLabel: string,
    addOptions: { allowSharedTask?: boolean; agentRole?: SprintEngineRoleId; gateId?: string } = {}
  ) => {
    if (candidates.length >= options.limit) return false
    const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
    if (runtimeAgent?.status === 'retired') return false
    const workKey = workKeyForCandidate(task, addOptions.gateId)
    if (pendingWorkKeys.has(workKey) || selectedWorkKeys.has(workKey)) return false
    if (!addOptions.allowSharedTask && selectedTaskIds.has(task.id)) return false
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
      role: addOptions.agentRole ?? task.role,
      taskId: task.id,
      ...(addOptions.gateId ? { gateId: addOptions.gateId } : {}),
    })
    selectedTaskIds.add(task.id)
    selectedWorkKeys.add(workKey)
    selectedAgentIds.add(agentId)
    return true
  }

  const activeTasks = sprintEngineState.tasks.filter((task) =>
    task.status === 'in_progress' && Boolean(task.ownerAgentId)
  )
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-active-tasks', {
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

  const readyTasks = sprintEngineState.tasks.filter((task) =>
    isSprintEngineAutoRunImplementationWakeCandidate(task, sprintEngineState)
  )
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-tasks', {
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

  // Lifecycle phase tasks (review/testing/product) whose pending gates can be
  // claimed by an idle roster agent. Computed before the ready-task loop so a
  // General's own pending gates can be ordered ahead of new ready work.
  const gatedPhaseTasks = sprintEngineState.tasks.filter((task) => {
    const column = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
    return column === 'review' || column === 'testing' || column === 'product'
  })
  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-gated-tasks', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    gatedTaskCount: gatedPhaseTasks.length,
  })

  // Spawn an idle roster agent for each pending gate on a task. We never claim
  // the gate from the renderer — that stays an MCP mutation through
  // `sprintengine.gate.next` / `sprintengine.gate.claim`; the spawned terminal
  // claims it directly. `roleFilter` restricts selection to a single gate role
  // (used to order General self-review/testing gates ahead of ready tasks).
  const selectGatesForTask = (task: SprintEngineTask, roleFilter?: SprintEngineRoleId): void => {
    const activeGateClaims = getActiveSprintEngineAutoRunGateClaims(task, sprintEngineState.tasks)
    for (const claim of activeGateClaims) {
      if (candidates.length >= options.limit) break
      if (roleFilter && claim.gate.role !== roleFilter) continue
      const reviewerAgent = rosterById[claim.claimedBy] ?? {
        id: claim.claimedBy,
        label: claim.claimedBy,
        role: claim.gate.role,
      }
      addCandidate(task, reviewerAgent.id, reviewerAgent.label, {
        allowSharedTask: true,
        agentRole: claim.gate.role,
        gateId: claim.gate.id,
      })
      logPerfEvent('SprintEngineAutoRun', 'candidate-pick-gated-resume-result', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        gateId: claim.gate.id,
        gateRole: claim.gate.role,
        selectedAgentId: reviewerAgent.id,
      })
    }

    const claimableGates = getClaimableSprintEngineAutoRunGates(task, sprintEngineState.tasks)
    for (const gate of claimableGates) {
      if (candidates.length >= options.limit) break
      if (roleFilter && gate.role !== roleFilter) continue
      const reviewerAgentId = findGateReviewerAgent(gate.role)
      // Missing roster roles do not create dead launch queues — we simply skip
      // the gate and the CLI verdict path stays the only completion route.
      if (!reviewerAgentId) {
        logPerfEvent('SprintEngineAutoRun', 'candidate-pick-gated-no-roster-agent', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          taskId: task.id,
          gateId: gate.id,
          gateRole: gate.role,
        })
        continue
      }
      const reviewerAgent = rosterById[reviewerAgentId] ?? {
        id: reviewerAgentId,
        label: reviewerAgentId,
        role: gate.role,
      }
      addCandidate(task, reviewerAgent.id, reviewerAgent.label, {
        allowSharedTask: true,
        agentRole: gate.role,
        gateId: gate.id,
      })
      logPerfEvent('SprintEngineAutoRun', 'candidate-pick-gated-result', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        gateId: gate.id,
        gateRole: gate.role,
        selectedAgentId: reviewerAgent.id,
      })
    }
  }

  // General-aware ordering: an idle General reviews/tests its own work before
  // taking new ready tasks, so order pending `general` gates (self-review and
  // testing gates on a General's just-finished tasks) ahead of the ready-task
  // loop. This mirrors the server `cmd_join` gate-first priority and load-
  // balances multiple Generals for free — once one General is routed to the
  // gate, the next idle General finds no claimable `general` gate and falls
  // through to a ready task. Specialist runs have no `general` agent, so this
  // pre-pass is a no-op for them and their dispatch order is unchanged.
  if (roster.some((agent) => agent.role === 'general')) {
    for (const task of gatedPhaseTasks) {
      if (candidates.length >= options.limit) break
      selectGatesForTask(task, 'general')
    }
  }

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
        logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-task-reserved-for-continuation', {
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

    logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-task', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: task.id,
      role: task.role,
      ownerAgentId: task.ownerAgentId ?? null,
      dependsOnCount: task.dependsOn.length,
    })

    // A live idle previous owner is engaged for this rework via the wake
    // paste in the same supervise cycle — spawning a second agent here would
    // double-dispatch the task and let a cold fresh agent race the warm owner
    // for the claim (review finding).
    const hasLiveBoundOwner = Object.entries(sprintEngineState.sprintEngineAgents).some(([ownerId, runtime]) =>
      runtime.lastOwnedTaskId === task.id
      && runtime.status === 'idle'
      && !runtime.currentTaskId
      && options.runningAgentIds.has(ownerId)
    )
    if (hasLiveBoundOwner) {
      logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-task-deferred-to-live-owner', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        role: task.role,
      })
      continue
    }

    // New claims come only from engine-minted never-owned capacity; a
    // changes_requested task first tries its owner-keyed rework respawn.
    const reusableAgentId = findReworkOwnerAgent(task.role, task.id) ?? findFreshTaskAgent(task.role)
    if (!reusableAgentId) {
      logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-task-waiting-for-roster-agent', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        role: task.role,
      })
      continue
    }

    const agent = rosterById[reusableAgentId] ?? { id: reusableAgentId, label: reusableAgentId, role: task.role }

    addCandidate(task, agent.id, agent.label)
    logPerfEvent('SprintEngineAutoRun', 'candidate-pick-ready-task-result', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      taskId: task.id,
      selectedAgentId: agent.id,
      selectedAgentRole: agent.role,
      candidateCount: candidates.length,
    })
  }

  // Lifecycle phase gates keep auto-run running even when no implementation
  // task is ready: each pending gate maps to a reviewer/tester/product role and
  // we spawn an idle roster agent for it. (General `general`-role gates already
  // had a first pass above; `addCandidate` dedups by work key so this re-pass
  // skips any already selected, and picks up the remaining specialist gates.)
  for (const task of gatedPhaseTasks) {
    if (candidates.length >= options.limit) break
    selectGatesForTask(task)
  }

  logPerfEvent('SprintEngineAutoRun', 'candidate-pick-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    candidateCount: candidates.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  })
  return candidates
}
