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
import { DEFAULT_SPRINTENGINE_TASK_REPO } from './run-types'
import type {
  AgentId,
  SprintEngineArtifact,
  SprintEngineCurrentDispatch,
  SprintEngineEvent,
  SprintEngineRoleId,
  SprintEngineRuntimeAgent,
  SprintEngineState,
  SprintEngineTask,
  SprintEngineWorkspaceView,
} from './run-types'
import type { SprintEngineToolName } from '../sprintengineToolNames.generated'
import {
  buildSprintEngineAgentRosterForState,
  getNextSprintEngineAgentId,
  getReviewableSprintEngineArtifacts,
  getSprintEngineArtifactAutoApprovalEligibility,
  getSprintEngineArtifactsByTaskId,
  isSprintEngineArtifactAutoApprovableKind,
  isSprintEngineCoordinatorAgent,
  isSprintEngineTaskLaunchable,
  sprintEngineAutoApprovalBlockingSiblingsAllReviewable,
  sprintEngineCoordinatorSeat,
  sprintEngineRoleKey,
  sprintEngineTaskRoutesToCoordinator,
} from './state'
import { pathJoin, samePath } from '../paths'

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

export const NEEDS_INPUT_AUTO_APPROVAL_STATUSES = new Set<SprintEngineArtifact['status']>([
  'ready_for_review',
  'changes_requested',
])

export type AutoRunCandidate = {
  agentId: string
  label: string
  /** Absent when the task carries no role (MC-2057). */
  role?: SprintEngineRoleId
  taskId: string
  startupPromptOverride?: string
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
 * The repo a routing key names when nothing says otherwise: the run's primary
 * repo. A single-repo run's every task reads this, so its keys and cwds are
 * exactly what they were before repo joined the key (MC-1610).
 */
export function sprintEngineSessionRepoId(repo: string | null | undefined): string {
  return repo?.trim() || DEFAULT_SPRINTENGINE_TASK_REPO
}

/**
 * Which declared repo a routing key refers to. Accepts either a task id (what
 * the spawn path carries) or a repo id directly; a task id wins, because a
 * task's `repo` is the authority on the tree its session must work in. An
 * unknown value resolves to the primary repo rather than guessing a sibling —
 * landing a session in the wrong tree is worse than landing it in the default
 * one, which is where every single-repo session already goes.
 */
function repoIdForRouting(
  state: Pick<SprintEngineState, 'vcs' | 'tasks'>,
  taskOrRepoId: string | null | undefined
): string {
  const value = taskOrRepoId?.trim()
  if (!value) return DEFAULT_SPRINTENGINE_TASK_REPO
  const task = state.tasks?.find((candidate) => candidate.id === value)
  if (task) return sprintEngineSessionRepoId(task.repo)
  const declared = state.vcs?.repos?.some((repo) => repo.id === value)
  return declared ? value : DEFAULT_SPRINTENGINE_TASK_REPO
}

/**
 * The recorded worktree of the task a routing key names, under per-task
 * isolation. Only a TASK id can carry one — a bare repo id names the shared run
 * tree by definition — so an unmatched key yields nothing rather than the tree
 * of some other task.
 */
function optionalTaskWorktreePath(
  state: Pick<SprintEngineState, 'tasks'>,
  taskOrRepoId: string | null | undefined
): string | undefined {
  const value = taskOrRepoId?.trim()
  if (!value) return undefined
  const task = state.tasks?.find((candidate) => candidate.id === value)
  return task?.worktreePath?.trim() || undefined
}

/**
 * MC-1615 single cwd choke point. THE one reader of the vcs worktree paths in
 * the TS spawn path — every sprint session cwd resolves through here, so a
 * caller never dereferences the vcs seam directly.
 *
 * Multi-repo (MC-1610): `taskOrRepoId` selects WHICH declared repo's worktree
 * the session opens in, so a task targeting the mobile repo spawns its session
 * in the mobile worktree. A run declaring one repo has a one-entry `repos` list
 * whose worktree is the flat `worktreePath`, so its sessions resolve exactly
 * where they did before. A declared SIBLING missing its own worktree path is not
 * resolvable: the session skips to the main checkout rather than borrowing the
 * primary's tree, which would silently run it against the wrong repo (backlog
 * 1722). Only the primary repo falls back to the run's flat worktree.
 *
 * Per-task isolation (MC-2136): when the run gives every task its own worktree,
 * the session opens in THE TASK'S tree rather than its repo's shared one — the
 * engine commits a task's work from that tree, so an agent editing anywhere else
 * would have its changes committed by nobody. The path is read from the task
 * (the engine records it when it provisions the tree), never computed here; a
 * task with no recorded tree has none yet, and falls back to the run worktree
 * exactly as the engine's own `worktree_for_task` does.
 */
export function resolveSprintEngineSessionCwd(
  state: Pick<SprintEngineState, 'vcs' | 'tasks'>,
  taskOrRepoId: string | null | undefined,
  options: {
    /**
     * A task worktree the spawn path just provisioned, which the projection in
     * hand predates. It wins over the recorded value for exactly that reason —
     * it is the same field, one refresh newer.
     */
    provisionedTaskWorktreePath?: string | null
  } = {}
): SprintEngineSessionCwd {
  const vcs = state.vcs
  if (vcs?.mode !== 'run_worktree') return { executionMode: 'current_workspace' }
  if (vcs.taskIsolation === true) {
    const taskWorktree =
      options.provisionedTaskWorktreePath?.trim() || optionalTaskWorktreePath(state, taskOrRepoId)
    if (taskWorktree) return { executionMode: 'worktree', worktreeRelativePath: taskWorktree }
  }
  const repoId = repoIdForRouting(state, taskOrRepoId)
  const declaredWorktree = vcs.repos?.find((repo) => repo.id === repoId)?.worktreePath
  const worktreePath = declaredWorktree
    || (repoId === DEFAULT_SPRINTENGINE_TASK_REPO ? vcs.worktreePath : undefined)
  if (!worktreePath) return { executionMode: 'current_workspace' }
  return { executionMode: 'worktree', worktreeRelativePath: worktreePath }
}

/**
 * The declared repo a live session is working in, recovered from the cwd it was
 * spawned into (`resolveSprintEngineSessionCwd`, joined onto the workspace
 * folder). The inverse of that resolver, and the only repo signal a booting
 * session has: the engine binds no runtime record — and therefore no lease and
 * no repo — until the session's first claim.
 *
 * Null when the session is not in any declared repo's worktree (a
 * non-worktree run, or a terminal opened in the main checkout), which reads as
 * "no repo evidence", never as the primary repo.
 *
 * Task trees are matched first (MC-2136): under isolation a session sits in its
 * TASK's worktree, which is no repo's tree, so matching repos alone would read a
 * perfectly bound session as repo-less evidence. The task is the authority on
 * the project it works in.
 */
export function sprintEngineRepoIdForSessionCwd(
  state: Pick<SprintEngineState, 'vcs' | 'tasks'>,
  workspaceFolderPath: string | null | undefined,
  sessionCwd: string | null | undefined
): string | null {
  const vcs = state.vcs
  if (!sessionCwd || !workspaceFolderPath) return null
  if (vcs?.taskIsolation === true) {
    for (const candidate of state.tasks ?? []) {
      const taskWorktree = candidate.worktreePath?.trim()
      if (!taskWorktree) continue
      if (samePath(pathJoin(workspaceFolderPath, taskWorktree), sessionCwd)) {
        return sprintEngineSessionRepoId(candidate.repo)
      }
    }
  }
  if (!vcs?.repos?.length) return null
  for (const repo of vcs.repos) {
    if (!repo.worktreePath) continue
    if (samePath(pathJoin(workspaceFolderPath, repo.worktreePath), sessionCwd)) return repo.id
  }
  return null
}

/**
 * The declared repo a worker is working in (MC-1610) — the tree its live session
 * sits in, and therefore the only tree it can claim from.
 *
 * Read from the lease the engine minted at claim; a worker between tasks holds
 * no lease, so it falls back to the repo of the task it is on or last owned,
 * which is what its session's cwd was resolved from. A worker that holds no lease
 * and has never owned a task can still have a live session — the pool spawns one
 * into a repo's worktree before its first claim — so prefer the repo recovered
 * from that session's cwd (`sessionRepoId`) before the primary default. Binding
 * such a worker to primary would wake it for primary work its session cannot
 * claim, producing no-op wake spam (backlog 1722). The primary default is only
 * reached when there is no session evidence either — a single-repo run, where it
 * is the right answer.
 */
export function sprintEngineWorkerRepoId(
  sprintEngineState: Pick<SprintEngineState, 'workers' | 'sprintEngineAgents' | 'tasks'>,
  agentId: string,
  sessionRepoId?: string | null
): string {
  const leaseRepo = sprintEngineState.workers?.[agentId]?.repo
  if (leaseRepo) return sprintEngineSessionRepoId(leaseRepo)
  const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
  const taskId = runtimeAgent?.currentTaskId || runtimeAgent?.lastOwnedTaskId
  const task = taskId ? sprintEngineState.tasks.find((candidate) => candidate.id === taskId) : undefined
  if (task) return sprintEngineSessionRepoId(task.repo)
  if (sessionRepoId) return sprintEngineSessionRepoId(sessionRepoId)
  return DEFAULT_SPRINTENGINE_TASK_REPO
}

/**
 * How an agent is NAMED in prose — diagnostics, notifications, prompts. Its role
 * when it has one, its own id otherwise (MC-2057). Every one of these strings
 * used to interpolate `role` directly, which renders `undefined` on a roleless
 * run — the exact "never `String(undefined)`" failure the item calls out.
 */
function describeSprintEngineActor(role: SprintEngineRoleId | undefined, agentId: string): string {
  return role ?? agentId
}

/** The task fields a demand key may read: the (role, repo) pair it groups by. */
export type SprintEngineDemandKeyInput = Pick<SprintEngineTask, 'role' | 'repo'>

/**
 * MC-1615 demand grouping key, now (role, repo) — multi-repo sprints, MC-1610.
 * The reconciler groups ready work by this key to compute per-group session
 * demand, and a session is spawned with its group's repo worktree as its cwd,
 * so repo must be part of the key: a developer session sitting in the mobile
 * worktree cannot work a task that lives in the desktop tree.
 *
 * Repo FILTERS which sessions exist, it is not a budget — the concurrency cap
 * stays global and is applied across all groups by the picker. A single-repo
 * run keys every task to the same `<role>` group it always did, so its
 * grouping — and therefore its spawning — is unchanged.
 *
 * Roleless work groups under its own stable key (MC-2057), separate from every
 * named role: a run staffing `developer` alone carries both kinds of task, and
 * merging them would spawn a developer session to serve work no developer is
 * meant to take.
 */
export function sprintEngineDemandKey(task: SprintEngineDemandKeyInput): string {
  const repo = sprintEngineSessionRepoId(task.repo)
  const role = sprintEngineRoleKey(task.role)
  return repo === DEFAULT_SPRINTENGINE_TASK_REPO ? role : `${role}@${repo}`
}

/**
 * The reconciler's demand computation: ready, launchable, unowned work grouped
 * by `sprintEngineDemandKey`, each group's task ids oldest-first. This is the
 * "desired pool" input — how many sessions each group wants before the
 * concurrency cap and already-working sessions are subtracted (MC-1592).
 */
export function computeSprintEngineDemand(
  sprintEngineState: SprintEngineState,
  keyFn: (task: SprintEngineDemandKeyInput) => string = sprintEngineDemandKey
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
  // Absent on a roleless run: the claim payload then carries only the agent id,
  // because `role` is not a field the engine can be given an honest value for.
  role: SprintEngineRoleId | string | undefined,
  agentId: string
): string {
  // The managed Sprint Engine MCP server resolves run and workspace routing
  // from the HTTP run context. Agents do not pass statePath or
  // workspaceRoot in tool payloads.
  // A roleless claim omits `role` entirely rather than sending a stand-in:
  // `optional_configured_role` (roles.py) reads absent as "no role" and still
  // rejects a role that is named but unconfigured.
  const claimRole = String(role ?? '').trim()
  const payload: Record<string, string> = tool === 'sprintengine.triage.needs_input'
    ? { id: agentId }
    : claimRole
      ? { role: claimRole, id: agentId }
      : { id: agentId }
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
    .map((task) => `${task.id} (${task.role ?? 'no role'}) owner=${task.ownerAgentId ?? 'none'}`)
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
  role?: SprintEngineRoleId
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
 * accumulates in one terminal. The COORDINATOR runs a whole sprint in one
 * terminal and is exempt, as is an agent that never owned a task.
 *
 * The exemption is the seat, not a role name (MC-2050): a minted roleless
 * worker carries no role, exactly like the roleless coordinator, so a role
 * comparison would read it as exempt and wake it for another task's work —
 * precisely the cross-task context accumulation MC-1444 removed.
 *
 * Returns the task id the agent is restricted to, or null when unrestricted. A disposed agent is unaffected: respawns start a fresh session,
 * so the spawn path may hand its roster id any task.
 */
export function sprintEngineWakeRestrictionTaskId(
  agentId: string,
  runtimeAgent: SprintEngineState['sprintEngineAgents'][string] | undefined,
  sprintEngineState: Pick<SprintEngineState, 'configuredRoles'>
): string | null {
  if (!runtimeAgent?.lastOwnedTaskId) return null
  if (isSprintEngineCoordinatorAgent(agentId, sprintEngineState)) return null
  return runtimeAgent.lastOwnedTaskId
}

/**
 * Wake asks the run's ONE routing rule, exactly as dispatch does — MC-2050's
 * defect reaching a second path.
 *
 * A role comparison alone answered the same question differently on the two
 * paths. On a role-based run it agreed by construction — the seat's role is
 * `architect`, so role equality offered it exactly the architect work
 * `sprintEngineTaskRoutesToCoordinator`'s named clause also routes there. On a
 * ROLELESS run the seat and every work task both carry no role, so
 * `absent === absent` matched and the (deliberately unrestricted, MC-1454) seat
 * was offered ordinary work that dispatch fans out to task-scoped workers —
 * re-serialising the graph onto the one persistent session, which is the
 * accumulation MC-1444 and MC-2050 removed.
 *
 * So the pairing is the rule, not the role: coordinator-routed work is offered
 * to the seat and to nobody else, and everything else is offered to a matching
 * non-seat worker. `sprintEngineWakeRestrictionTaskId` is untouched — the
 * seat's exemption from MC-1444 task-scoping is what lets a departed seat be
 * revived for the NEXT coordination task, and it was never the defect; its
 * BOUND was.
 */
function sprintEngineWakeCandidateMatchesAgent(
  candidate: SprintEngineTask,
  role: SprintEngineRoleId | undefined,
  agentIsCoordinator: boolean,
  sprintEngineState: Pick<SprintEngineState, 'artifacts' | 'configuredRoles'>
): boolean {
  if (sprintEngineTaskRoutesToCoordinator(candidate, sprintEngineState)) return agentIsCoordinator
  // Absent matches absent: a roleless worker is offered roleless work only.
  return !agentIsCoordinator && candidate.role === role
}

export function findSprintEngineWakeCandidateTaskForAgent(
  wakeTasks: SprintEngineTask[],
  role: SprintEngineRoleId | undefined,
  agentId: string,
  reservedTaskIds: ReadonlySet<string>,
  // Required (no default) so a call site can never silently drop the
  // task-scoped reuse guard: pass sprintEngineWakeRestrictionTaskId(agent),
  // or null for contexts with no runtime agent.
  restrictToTaskId: string | null,
  // The repo the agent's live session sits in (MC-1610). Required for the same
  // reason: a wake paste tells a LIVE session to claim, and `task.next` only
  // offers that session its own tree's work — so waking it for another repo's
  // task produces an agent that reports "no ready tasks" while the board shows
  // work. Pass sprintEngineWorkerRepoId(state, agentId).
  repoId: string,
  // Required for the same reason again: the routing rule is a property of the
  // RUN (its seat and its live plan artifact), so it cannot be derived from a
  // task and an id alone.
  sprintEngineState: Pick<SprintEngineState, 'artifacts' | 'configuredRoles'>
): SprintEngineTask | undefined {
  const agentIsCoordinator = isSprintEngineCoordinatorAgent(agentId, sprintEngineState)
  return wakeTasks.find((candidate) =>
    sprintEngineWakeCandidateMatchesAgent(candidate, role, agentIsCoordinator, sprintEngineState)
    && sprintEngineSessionRepoId(candidate.repo) === repoId
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
 * respawned (lazy spawn, pool reconcile, or a ready task that the agent
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
/**
 * Ghost-session boot allowance (MC-1750): a live session whose agent id has NO
 * engine runtime record is either still booting (spawn → join/claim takes tens
 * of seconds) or a failed spawn that will never claim (the immortal
 * developer-17 from the post-merge-hardening run — invisible to the
 * lease-derived roster and to every record-guarded dispatch path). Past this
 * allowance it is reaped; within it, it is left alone and merely occupies a
 * concurrency slot.
 */
export const AUTO_RUN_GHOST_SESSION_BOOT_ALLOWANCE_MS = 5 * 60_000
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
  role?: SprintEngineRoleId
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
    const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
    // No runtime record = ghost candidate (MC-1750): age it on the same clock
    // so the reaper can tell a booting session from a spawn that will never
    // claim. Agents WITH a record keep the unclaimed-idle precondition.
    if (runtimeAgent && !isUnclaimedIdleRuntimeAgent(runtimeAgent)) continue
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

// An in-progress claim whose owner may need recovering: the (agent, role, task)
// triple the recovery pass groups its work by.
type SprintEngineRecoveryClaim = { agentId: string; role?: SprintEngineRoleId; taskId: string }

// The shared context the recovery pass (claimed-work respawns + departed-owner
// revivals) reads. Both halves share one `respawn:` ledger, cap, and sweep, so
// they take the same context and thread `claims`/`plannedRespawnAgentIds`
// between them. `planRespawn` records the engagement into `plan` and
// `engagedAgentIds` exactly as the inline pass did.
type SprintEngineRecoveryDispatchContext = {
  workspace: SprintEngineWorkspaceView
  sprintEngineState: SprintEngineState
  now: number
  continuationLedger: ReadonlyMap<string, SprintEngineDispatchAttempt>
  sessionRepoIds?: ReadonlyMap<string, string>
  liveAgentIds: ReadonlySet<string>
  engagedAgentIds: ReadonlySet<string>
  plan: SprintEngineDispatchPlan
  planRespawn: (respawn: SprintEngineDispatchRespawnAction) => void
}

/**
 * Respawn the managed roster terminal of every in-progress claim whose owner has
 * no live session. Claimed work whose claimant has no live terminal can never be
 * re-engaged by a paste, and with zero live agents server-side claim expiry never
 * runs — after an app restart this deadlocks the run. Returns the claims it
 * considered and the ids it planned a respawn for, so the departed-owner revival
 * pass (which shares the one `respawn:` ledger, cap, and sweep) can skip them and
 * preserve the unified retry budget.
 */
function planSprintEngineClaimedWorkRespawns(
  ctx: SprintEngineRecoveryDispatchContext,
): { claims: SprintEngineRecoveryClaim[]; plannedRespawnAgentIds: Set<string> } {
  const { workspace, sprintEngineState, now, plan, planRespawn, liveAgentIds, engagedAgentIds } = ctx
  const claims: SprintEngineRecoveryClaim[] = []
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
    const previous = ctx.continuationLedger.get(key)
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
        message: `${describeSprintEngineActor(claim.role, claim.agentId)} owns in-progress task ${claim.taskId} but its terminal is not running. Respawning the terminal so the claim can resume.`,
        details: [
          `Workspace: ${workspace.name}`,
          `Agent: ${claim.agentId}${claim.role ? ` (${claim.role})` : ''}`,
          `Task: ${claim.taskId}`,
          `Respawn attempts before this one: ${previous?.attempts ?? 0}`,
        ].join('\n'),
        taskId: claim.taskId,
      },
    })
  }
  return { claims, plannedRespawnAgentIds }
}

/**
 * Revive a DEPARTED owner for the task that is still waiting for it.
 * Liveness is derived, not stored (T1): a departed agent reads as plain
 * `idle`, so revival can no longer key off a `left`/`dead` status. Instead it
 * keys off task OWNERSHIP — a NO-live-agent role and a managed roster id
 * whose retained `lastOwnedTaskId` is either a claimable ready task (it was
 * released back to the queue) or a task the id still owns: respawn that id so
 * its fresh session resumes the original conversation. Under single-owner
 * tasks (MC-1542) "still owns" spans the whole publish→done tail — `review`
 * (owner reviewing its own diff), `needs_input` (owner-bound hold), and
 * `in_progress` re-bound by a human rework request. The in-progress case is
 * already covered by the claimed-work respawn above (which runs first and
 * records `plannedRespawnAgentIds`); it stays in the predicate so a claim
 * that pass skipped is not silently dropped here. A fresh ready task with no
 * prior owner is minted a never-owned id by the candidate picker instead. This
 * shares the one `respawn:` ledger + retry-limit + retry-interval machinery
 * (the unified recovery cap). Scoped to roles with NO live agent: a role whose
 * agent is merely busy/stalled is a capacity/restart concern handled by other
 * paths, not a revival.
 */
function planSprintEngineDepartedOwnerRevivals(
  ctx: SprintEngineRecoveryDispatchContext,
  claims: SprintEngineRecoveryClaim[],
  plannedRespawnAgentIds: Set<string>,
): void {
  const { workspace, sprintEngineState, now, plan, planRespawn, liveAgentIds, engagedAgentIds } = ctx
  // Covered groups, keyed like demand ((role, repo) — MC-1610). A live agent
  // only covers work in ITS OWN tree: since `task.next` filters by the
  // session's repo, a live desktop developer can never claim a mobile task, so
  // treating the role alone as covered would leave a departed mobile owner
  // unrevived while the pool pass defers its task to it — starving the task
  // until the unrelated desktop session happens to die. A single-repo run has
  // one key per role, exactly as before.
  const liveDemandKeys = new Set<string>()
  for (const liveId of liveAgentIds) {
    const liveRole = sprintEngineState.sprintEngineAgents[liveId]?.role
    if (liveRole) {
      liveDemandKeys.add(sprintEngineDemandKey({
        role: liveRole,
        repo: sprintEngineWorkerRepoId(sprintEngineState, liveId, ctx.sessionRepoIds?.get(liveId)),
      }))
    }
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
    // Owner-qualified for EVERY owner-held status (MC-1751): an unowned
    // review/needs_input task awaits triage or the pool, not this agent —
    // the unqualified check revived developer-4 for a task nobody owned.
    if (task.status === 'review' || task.status === 'needs_input') {
      return task.ownerAgentId === agentId
    }
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
  const revivalTargets: Array<{ role?: SprintEngineRoleId; work: { taskId: string }; agentId: string }> = []
  // One revival per demand group per pass, not per role: a mobile revival must
  // not consume the pass's only slot for a departed desktop owner, since
  // neither can ever claim the other's work.
  const plannedRevivalKeys = new Set<string>()
  for (const [agentId, runtimeAgent] of Object.entries(sprintEngineState.sprintEngineAgents)) {
    // Revival is for DEPARTED ids only: a live id has a session already, and
    // respawning it would dispose the very terminal it is working in. Kept as
    // its own guard, per agent id — the group check below answers a different
    // question ("is this work already covered?"), and conflating the two is
    // what let a live planner be revived for another repo's ready task.
    if (liveAgentIds.has(agentId)) continue
    if (plannedRespawnAgentIds.has(agentId) || engagedAgentIds.has(agentId)) continue
    if (!workspace.agents[agentId]) continue // unmanaged claimant — nothing to spawn
    // Owner affinity: revive the id for its own retained task when that task is
    // claimable ready work, or is still waiting on this owner.
    const ownTaskId = runtimeAgent.lastOwnedTaskId
    let reviveTaskId = ownTaskId
      && (claimableWakeTaskIds.has(ownTaskId) || taskAwaitsOwner(ownTaskId, agentId))
      ? ownTaskId
      : null
    // The coordinator is persistent, not task-scoped: it drives the whole
    // sprint, so a departed coordinator is revived under its SAME id for the
    // NEXT ready task that ROUTES TO IT, not only its own task (MC-1454). Keeps
    // the id stable across the seat's ABSENCE, so a run whose coordinator ended
    // its session re-engages that same id rather than minting a `<role>-N`
    // beside it. (Not "across sequential coordination tasks": a run has at most
    // one, since the live plan artifact binds to exactly one task — ruled
    // correct as designed, MC-2053.) Both halves ask the seat, never a role name
    // (MC-2050): a minted roleless worker carries no role and would otherwise
    // read as the roleless coordinator and be revived onto another task's work,
    // and the roleless coordinator itself would be revived onto ordinary work
    // that belongs to a task-scoped agent.
    if (!reviveTaskId && isSprintEngineCoordinatorAgent(agentId, sprintEngineState)) {
      // Skip work whose group already has a live agent: a coordinator following
      // its role across repos (MC-1610) must be revived for a tree that has
      // nobody in it, not for one another coordination session is already serving.
      reviveTaskId = sprintEngineState.tasks.find((candidate) =>
        sprintEngineTaskRoutesToCoordinator(candidate, sprintEngineState)
        && claimableWakeTaskIds.has(candidate.id)
        && !liveDemandKeys.has(sprintEngineDemandKey(candidate))
      )?.id ?? null
    }
    if (!reviveTaskId) continue
    // Liveness is judged against the group the revived session would actually
    // work in — the repo of the task it is being revived FOR — because that is
    // the queue a live agent would have to share to make this revival
    // redundant.
    const reviveTask = taskById.get(reviveTaskId)
    const reviveKey = sprintEngineDemandKey({
      role: runtimeAgent.role,
      repo: sprintEngineSessionRepoId(reviveTask?.repo),
    })
    if (liveDemandKeys.has(reviveKey)) continue // a live agent in that tree will claim it
    if (plannedRevivalKeys.has(reviveKey)) continue // one revival per group per pass
    plannedRevivalKeys.add(reviveKey)
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
  ctx.continuationLedger.forEach((_, ledgerKey) => {
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
    const previous = ctx.continuationLedger.get(key)
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
        message: `${describeSprintEngineActor(role, reviveAgentId)} still has work to finish on ${work.taskId} but its terminal is not running. Reviving the id that last owned the task so its session resumes.`,
        details: [
          `Workspace: ${workspace.name}`,
          `Agent: ${reviveAgentId}${role ? ` (${role})` : ''}`,
          `Task: ${work.taskId}`,
          `Revive attempts before this one: ${previous?.attempts ?? 0}`,
        ].join('\n'),
        taskId: work.taskId,
      },
    })
  }
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
  /**
   * Repo each live session was spawned into, keyed by agent id and recovered from
   * the session cwd (`sprintEngineRepoIdForSessionCwd`). Lets `sprintEngineWorkerRepoId`
   * bind a lease-less, never-owned worker to its actual tree instead of the primary
   * default — the honest wake filter for a sibling-repo session (backlog 1722).
   */
  sessionRepoIds?: ReadonlyMap<string, string>
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
        sprintEngineWakeRestrictionTaskId(agentId, runtimeAgent, sprintEngineState),
        sprintEngineWorkerRepoId(sprintEngineState, agentId, input.sessionRepoIds?.get(agentId)),
        sprintEngineState
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
      role?: SprintEngineRoleId
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
                `Agent: ${assignment.agentId}${assignment.role ? ` (${assignment.role})` : ''}`,
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
        sprintEngineWakeRestrictionTaskId(agentId, runtimeAgent, sprintEngineState),
        sprintEngineWorkerRepoId(sprintEngineState, agentId, input.sessionRepoIds?.get(agentId)),
        sprintEngineState
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
          message: `${describeSprintEngineActor(runtimeAgent.role, agentId)} had ready work on ${task.id} but its terminal stayed idle and stopped responding to wake prompts. Restarting it so the work can be claimed.`,
          details: [
            `Workspace: ${workspace.name}`,
            `Agent: ${agentId}${runtimeAgent.role ? ` (${runtimeAgent.role})` : ''}`,
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
    // restart this deadlocks the run. Both halves below share ONE `respawn:`
    // ledger, cap, and sweep (the unified retry cap), so recovery is one
    // resume-then-expire path; the claimed-work pass runs first and hands its
    // `claims` + `plannedRespawnAgentIds` to the revival pass.
    const recoveryCtx: SprintEngineRecoveryDispatchContext = {
      workspace,
      sprintEngineState,
      now,
      continuationLedger: input.continuationLedger,
      sessionRepoIds: input.sessionRepoIds,
      liveAgentIds: new Set([...input.runningAgentIds, ...input.idleAgentIds]),
      engagedAgentIds,
      plan,
      planRespawn,
    }
    const { claims, plannedRespawnAgentIds } = planSprintEngineClaimedWorkRespawns(recoveryCtx)
    planSprintEngineDepartedOwnerRevivals(recoveryCtx, claims, plannedRespawnAgentIds)
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
    // Triage (signalPlannerForNeedsInputTriage) runs outside this plan and
    // re-engages the coordinator seat whenever architect-KIND needs_input tasks
    // exist. Retiring that seat here would make triage respawn it next tick and
    // idle_retire retire it again — an unbounded kill/respawn storm. The seat
    // owns that triage work, so it is not "parked": skip it.
    const hasArchitectTriageWork =
      getArchitectActionableNeedsInputTasks(sprintEngineState).length > 0
    for (const agentId of input.idleAgentIds) {
      if (engagedAgentIds.has(agentId)) continue
      const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
      if (!runtimeAgent) {
        // Ghost session (MC-1750): live terminal, no engine runtime record —
        // the spawn never joined/claimed. Within the boot allowance it is a
        // normally-booting session and is left alone (it already occupies a
        // concurrency slot); past it, it will never claim and is torn down.
        const ghostClockKey = sprintEngineIdleClockKey(workspace, agentId)
        const ghostSince = input.idleClock.get(ghostClockKey)
        if (!ghostSince) continue
        if (now - ghostSince < AUTO_RUN_GHOST_SESSION_BOOT_ALLOWANCE_MS) continue
        const ghostRetiredAt = input.retirementCooldown?.get(ghostClockKey)
        if (ghostRetiredAt !== undefined && now - ghostRetiredAt < AUTO_RUN_RETIREMENT_COOLDOWN_MS) continue
        planRetirement({
          agentId,
          teardown: true,
          data: {
            agentId,
            role: workspace.agents[agentId]?.name ?? '',
            idleMs: now - ghostSince,
            reason: 'ghost_session_never_claimed',
          },
          diagnostic: {
            title: 'Closed a sprint session that never started work',
            message: `${agentId} was spawned but never claimed a task, so its terminal was closed. Ready work spawns a fresh session.`,
            details: [
              `Workspace: ${workspace.name}`,
              `Agent: ${agentId}`,
              `Live without claiming for: ${Math.round((now - ghostSince) / 60_000)} minute(s)`,
              'A session with no engine runtime record cannot be dispatched, woken, or retired by the normal paths; reaping it frees its concurrency slot.',
            ].join('\n'),
          },
        })
        continue
      }
      // Skip-reason instrumentation (MC-1751): every kept-alive idle agent
      // states WHY each pass, so a retirement stall is diagnosable from the
      // perf log instead of another live post-mortem.
      const skipRetire = (reason: string): void => {
        plan.skips.push({
          event: 'idle-retire-skipped',
          data: { agentId, role: runtimeAgent.role, reason },
        })
      }
      if (!isUnclaimedIdleRuntimeAgent(runtimeAgent)) {
        skipRetire('not-unclaimed-idle')
        continue
      }
      // The seat, not the role name (MC-2057): the agent kept alive for pending
      // `architect`-KIND triage is whoever holds the coordinator seat. Under the
      // role comparison a roleless coordinator was retired WHILE its own triage
      // work waited, and a needs_input task carries an owner so no dispatch,
      // wake, or revival path re-engages anyone — the blocker stuck for good.
      if (isSprintEngineCoordinatorAgent(agentId, sprintEngineState) && hasArchitectTriageWork) {
        skipRetire('architect-triage-work')
        continue
      }
      // Task-scoped workers (MC-1444) only ever wake for their own task, so the
      // claimable-work skip below no longer parks them on unrelated ready tasks
      // — a completed worker retires even while its role has a full queue; fresh
      // sessions take the queue.
      const restrictToTaskId = sprintEngineWakeRestrictionTaskId(agentId, runtimeAgent, sprintEngineState)
      // Scoped to the agent's own repo (MC-1610): work it cannot claim is not
      // work it is waiting for, so a session whose tree is drained retires even
      // while another repo's queue is full — fresh sessions take that queue.
      if (findSprintEngineWakeCandidateTaskForAgent(
        wakeTasks,
        runtimeAgent.role,
        agentId,
        new Set(),
        restrictToTaskId,
        sprintEngineWorkerRepoId(sprintEngineState, agentId, input.sessionRepoIds?.get(agentId)),
        sprintEngineState
      )) {
        skipRetire('wake-candidate-available')
        continue
      }
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
      if (retiredAt !== undefined && now - retiredAt < cooldownMs) {
        skipRetire('retirement-cooldown')
        continue
      }
      const since = input.idleClock.get(idleClockKey)
      if (!since) {
        skipRetire('no-idle-clock-entry')
        continue
      }
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
            message: `${describeSprintEngineActor(runtimeAgent.role, agentId)} finished ${restrictToTaskId}, so its panel was closed. Re-open it from its group to resume that conversation; new work spawns a fresh session.`,
            details: [
              `Workspace: ${workspace.name}`,
              `Agent: ${agentId}${runtimeAgent.role ? ` (${runtimeAgent.role})` : ''}`,
              `Completed task: ${restrictToTaskId}`,
              'One agent session per task keeps worker context small; the recorded session resumes on re-open, and new ready work spawns a fresh session.',
            ].join('\n'),
          },
        })
        continue
      }
      if (now - since < AUTO_RUN_IDLE_RETIREMENT_MS) {
        skipRetire('inside-idle-window')
        continue
      }
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
          message: `${describeSprintEngineActor(runtimeAgent.role, agentId)} had no claimable work for ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}, so its terminal was closed. It respawns automatically when work is ready.`,
          details: [
            `Workspace: ${workspace.name}`,
            `Agent: ${agentId}${runtimeAgent.role ? ` (${runtimeAgent.role})` : ''}`,
            `Idle for: ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}`,
            'Lazy spawning revives it as soon as claimable work appears.',
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
 * Run-start bootstrap decision, and it applies to exactly one state: a run with
 * NO tasks. There `pickNextAutoRuns` has nothing to select, so the run's
 * COORDINATOR SEAT (the architect on a role-based run, the roleless
 * `coordinator` otherwise) is spawned here, carrying its stored handoff prompt
 * when one exists. Once any task exists this decides `none` (MC-2179) and every
 * spawn is work-driven: ready tasks flow through `pickNextAutoRuns` under the
 * concurrency cap, notification targets through notification delivery, and
 * needs-input triage through the architect triage path.
 *
 * The seat is resolved by id, not by matching a planning ROLE (MC-2050): a
 * roleless run staffs a coordinator with no role, which no role match can find,
 * and this site — not dispatch — is where such a run would otherwise stall
 * `no_planner` before dispatch is ever reached.
 *
 * A coordinator terminal that exited after its startup prompt was delivered is
 * not respawned blindly (a broken CLI would spawn/exit loop); that pre-plan
 * stall is reported as a decision so the supervisor can surface it once.
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
  const seat = sprintEngineCoordinatorSeat(sprintEngineState)
  const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
  // The rostered coordinator seat: the deterministic id creation seeds, else any
  // id the seat answers for — a NAMED seat also answers for `architect-1`, which
  // is how older rosters seat their architect, and `isSprintEngineCoordinatorAgent`
  // is what stops that second lookup from matching a minted roleless worker.
  // `no_planner` survives for the state it was written for: a roster that seats
  // no coordinator at all, which is a broken store rather than a roleless run.
  const planner =
    roster.find((candidate) => candidate.id === seat.agentId)
    ?? roster.find((candidate) => isSprintEngineCoordinatorAgent(candidate.id, sprintEngineState))
  if (!planner) {
    return runHasTasks ? { kind: 'none' } : { kind: 'stall', reason: 'no_planner' }
  }

  // RUN STATE alone decides whether anything is left to plan, and an undelivered
  // handoff prompt no longer overrides it (MC-2179). A run that arrives
  // PRE-PLANNED — an epic or selection whose graph the engine mints at init,
  // before any agent exists — has no planning left to do, but creation composes
  // a handoff prompt onto the coordinator seat regardless. The old
  // `&& !hasUndeliveredStartupPrompt` read that as "tasks exist, but the prompt
  // is still undelivered" and spawned a planner that booted, read a complete
  // task list, and exited: a wasted CLI launch and model session per
  // epic-sourced sprint (once per horizon step), and on the board
  // indistinguishable from an agent that crashed.
  //
  // Neither case that needs the prompt loses it. A goal-only run has no tasks
  // and bootstraps below, unchanged. A run that must still be planned by an
  // agent opens with its plan-gate task, which `pickNextAutoRuns` routes to this
  // same seat work-driven, and `spawnAutoRunCandidate` spawns it with the stored
  // prompt in place of the generated one.
  if (runHasTasks) return { kind: 'none' }

  const currentAgent = workspace.agents[planner.id]
  const hasUndeliveredStartupPrompt =
    Boolean(currentAgent?.cliStartupPrompt?.trim()) && !currentAgent?.cliOnboardingPromptSent
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
  inFlightSpawnKeys: Iterable<string>
  workspaceId: string
  runningAgentIds?: ReadonlySet<string>
  /**
   * Live sessions that have not yet claimed their first task (MC-1750). A
   * spawned CLI takes tens of seconds to boot and claim; during that window it
   * holds neither a lease nor an in-flight spawn entry (the entry is dropped
   * when the spawn IPC resolves), so without this set the concurrency cap
   * degrades into "N new spawns per tick" — the 17-terminal burst. Every
   * booting session occupies a slot until its claim lands (at which point the
   * lease-owner clause takes over) or it is reaped as a ghost.
   */
  bootingAgentIds?: Iterable<string>
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
  ])
  for (const spawnKey of input.inFlightSpawnKeys) {
    if (!spawnKey.startsWith(`${input.workspaceId}:`)) continue
    occupiedAgentIds.add(spawnKey.slice(input.workspaceId.length + 1))
  }
  for (const agentId of input.bootingAgentIds ?? []) {
    occupiedAgentIds.add(agentId)
  }
  return occupiedAgentIds
}

export function buildSprintEngineContinuationPrompt(
  task: SprintEngineTask,
  agentId: string
): string {
  return [
    `Sprint Engine roster runner found a wake candidate for a ready ${task.role ? `${task.role} ` : ''}task in this available terminal.`,
    `Task: ${task.id} - ${task.title}`,
    buildSprintEngineClaimInstructionBlock('sprintengine.task.next', task.role, agentId),
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

/**
 * The triage prompt pasted into (or spawned onto) the coordinator's terminal.
 *
 * `architect` in the name and the copy is the needs_input KIND — a wire value
 * this epic deliberately does not rename. The AGENT is whoever holds the
 * coordinator seat, so its id is threaded in rather than hardcoded: the
 * hardcoded `architect` named an id that does not exist on a roleless run, and
 * the triage tool resolves the actor from it. Mirrors the join-time directive
 * in `sprintengine_core/tool/commands/run.py`, which interpolates the same id.
 */
export function buildArchitectNeedsInputTriagePrompt(input: {
  workspaceFolderPath: string
  sprintEngineStatePath: string
  agentId: string
  taskIds: string[]
}): string {
  // The managed Sprint Engine MCP server resolves run routing from the HTTP
  // run context.
  const triagePayload = {
    id: input.agentId,
  }
  return [
    'Fetch the canonical Sprint Engine triage instructions from the managed Sprint Engine MCP server.',
    `Worker cwd: ${input.workspaceFolderPath}`,
    `You are agent \`${input.agentId}\`, this run's coordinator.`,
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
  runningAgentIds: ReadonlySet<string>
  inFlightSpawns: ReadonlySet<string>
  /**
   * Demand grouping key for the pool pass; defaults to `sprintEngineDemandKey`
   * ((role, repo) — MC-1610). The key function is load-bearing for spawning,
   * not telemetry: it decides which groups get sessions.
   */
  demandKeyFn?: (task: SprintEngineDemandKeyInput) => string
  /**
   * Live sprint sessions whose worker id has no runtime record yet — spawned,
   * still booting toward their first claim (the engine binds the id at claim).
   * They are per-key SUPPLY: the pool pass counts them against their group's
   * demand so the tick cadence never double-covers work a booting session is
   * about to pull. `taskId` is the spawn's routing exemplar
   * (`agentSession.workId`) used to key the worker through the demand key
   * function; phase-session births dedup on it directly (their task binding is
   * a sanctioned exception).
   *
   * `repo` is the declared repo the session was spawned into (MC-1610). It
   * keys the worker when its exemplar task is gone — without it a sibling-repo
   * session would fall back to its bare role and count as supply for the
   * PRIMARY group, leaving its own group looking uncovered and double-spawned.
   */
  unboundLiveWorkers?: ReadonlyArray<{
    agentId: string
    role: string
    taskId?: string | null
    repo?: string | null
  }>
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
    runningAgentCount: options.runningAgentIds.size,
    inFlightSpawnCount: options.inFlightSpawns.size,
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
  const unboundLiveWorkers = options.unboundLiveWorkers ?? []
  const selectedTaskIds = new Set<string>()
  const selectedAgentIds = new Set<string>()
  const candidates: AutoRunCandidate[] = []

  const hasInFlightSpawn = (agentId: string) =>
    options.inFlightSpawns.has(`${workspace.id}:${agentId}`)

  const isEligibleRoleAgent = (
    candidateId: string,
    // Absent matches absent: a roleless task is only eligible for a roleless
    // agent, never for a named specialist that happens to be idle.
    candidateRole: SprintEngineRoleId | undefined,
    role: SprintEngineRoleId | undefined
  ): boolean => {
    const runtime = sprintEngineState.sprintEngineAgents[candidateId]
    return candidateRole === role
      && runtime?.status === 'idle'
      && !runtime.currentTaskId
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
  const pickOrMintTaskAgent = (role: SprintEngineRoleId | undefined): AutoRunCandidate['agentId'] => {
    const reusable = roster.find((candidate) =>
      isEligibleRoleAgent(candidate.id, candidate.role, role)
      && !sprintEngineState.sprintEngineAgents[candidate.id]?.lastOwnedTaskId
    )
    if (reusable) return reusable.id
    // Mint. Mirror the phase-session birth below: seed the allocator with every
    // id a concurrent spawn already holds (projection roster, selected, running,
    // in-flight) so a minted `<role>-N` never collides with live
    // capacity or another mint this pass. Placeholders only need to occupy the
    // id in the allocator's used-id set; a role matching no real role keeps them
    // out of its per-role index scan so they never distort a `<role>-N` value.
    const reserved: Record<AgentId, SprintEngineRuntimeAgent> = { ...sprintEngineState.sprintEngineAgents }
    const reserve = (id: string) => {
      if (!reserved[id]) reserved[id] = { role: '' as SprintEngineRoleId } as SprintEngineRuntimeAgent
    }
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
  // planSprintEngineDispatch and defeating its storm cap. The pool pass
  // therefore DEFERS any task whose previous owner is still bound to it (see
  // `boundTaskIds` below): a live owner is woken via the wake paste, a departed
  // owner is respawned by the revival pass — the single throttled authority.
  // Both routes call spawnAutoRunCandidate, which resumes the retained
  // conversation, so owner affinity is preserved.

  // Persistent coordination identity (MC-1454): the coordinator is NOT
  // task-scoped — one seat drives the whole sprint, so its id is reused across
  // sequential coordination tasks instead of minting `<role>-N`. The task-scoped
  // mint above would hand each of them a fresh id, so coordinator-routed work
  // targets the seat's deterministic id instead — `architect` on a role-based
  // run, `coordinator` on a roleless one, in both cases the id creation seeds
  // (`buildSprintEngineAgentRoster`) rather than an invented fallback, and
  // reused regardless of its retained lastOwnedTaskId. Resolving the id is not
  // reserving it: a busy coordinator is filtered by `addCandidate`'s
  // running/in-flight/selected guards, not by role-wide "someone holds the
  // role, so wait" bookkeeping (MC-1592 review: seat-like waits starve work).
  const coordinatorSeat = sprintEngineCoordinatorSeat(sprintEngineState)
  const findCoordinatorAgent = (): AutoRunCandidate['agentId'] => {
    // An already-seated id the seat answers for wins over the deterministic one:
    // a NAMED seat also answers for `architect-2`, so a run whose bare seat id
    // was retired still dispatches its coordination work. `isSprintEngineCoordinatorAgent`
    // is what keeps this off a minted roleless worker, which matches the seat's
    // absent role but is not the seat.
    const seated = roster.find((candidate) =>
      isSprintEngineCoordinatorAgent(candidate.id, sprintEngineState)
      && isEligibleRoleAgent(candidate.id, candidate.role, coordinatorSeat.role)
    )
    return seated?.id ?? coordinatorSeat.agentId
  }

  const addCandidate = (
    task: SprintEngineTask,
    agentId: string,
    fallbackLabel: string
  ) => {
    if (candidates.length >= options.limit) return false
    const runtimeAgent = sprintEngineState.sprintEngineAgents[agentId]
    if (runtimeAgent?.status === 'retired') return false
    if (selectedTaskIds.has(task.id)) return false
    if (
      selectedAgentIds.has(agentId)
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

  // Desired-pool pass (MC-1592/MC-1615): ready, unowned, launchable work is
  // grouped by the demand key — (role, repo) since MC-1610 — and each group
  // gets fresh sessions up to the remaining slots. Groups drain round-robin so
  // a scarce slot budget covers every demand group before doubling up on one:
  // that, and nothing per-repo here, is why repo filters selection without
  // becoming a per-repo budget — `options.limit` is the run's one global cap
  // and every group competes for it. A pool spawn is never pre-bound to a task — the session pulls its
  // own work via `task.next`; the candidate's `taskId` is the group's oldest
  // uncovered task, carried as the routing/attribution exemplar (cwd
  // resolution, spawn diagnostics), not a claim. Dedup is by key-count (one
  // spawn per uncovered task in the group), not per-task bookkeeping — the
  // per-task exceptions (bound-owner recovery, active-owner rescue) keep their
  // task binding by design.
  const demandKeyFn = options.demandKeyFn ?? sprintEngineDemandKey
  const demandByKey = computeSprintEngineDemand(sprintEngineState, demandKeyFn)

  // Per-key supply: each booting session (spawned, no runtime record yet)
  // covers one unit of its group's demand until its first claim binds it —
  // in-flight coverage lives in the session list itself, not in a persisted
  // pending-spawn ledger. A worker keys through its routing exemplar when that
  // task still exists, else through its recorded (role, repo) — the pair the
  // session was actually spawned on, which is what its group is keyed by.
  const taskById = new Map(sprintEngineState.tasks.map((task) => [task.id, task]))
  const suppliedByKey = new Map<string, number>()
  for (const worker of unboundLiveWorkers) {
    const exemplar = worker.taskId ? taskById.get(worker.taskId) : undefined
    const workerKey = exemplar
      ? demandKeyFn(exemplar)
      : demandKeyFn({ role: worker.role as SprintEngineRoleId, repo: sprintEngineSessionRepoId(worker.repo) })
    suppliedByKey.set(workerKey, (suppliedByKey.get(workerKey) ?? 0) + 1)
  }

  autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-demand', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    demandGroups: demandByKey.size,
    demandByKey: Object.fromEntries([...demandByKey].map(([key, tasks]) => [key, tasks.length])),
    suppliedByKey: Object.fromEntries(suppliedByKey),
  })

  // Defer any task whose previous owner is still bound to it (retained
  // lastOwnedTaskId). Owner respawn/resume has a single authority: a LIVE owner
  // is woken via the wake paste this same supervise cycle; a DEPARTED (now
  // idle, session-less) owner gets one resume attempt through the retry-limited
  // revival pass in planSprintEngineDispatch, after which the engine's lease
  // expiry returns the task to the queue for this pool pass. This is a
  // bound-owner check, not a time-based reservation: an unbound ready task is
  // spawnable immediately. Acting here instead would either double-dispatch the
  // task (a cold fresh agent racing the warm owner) or, for a departed owner,
  // respawn it every cycle with no cross-cycle retry cap — a crash-loop
  // spawn-storm that defeats the revive ledger (review finding).
  const boundTaskIds = new Set(
    Object.values(sprintEngineState.sprintEngineAgents)
      .map((runtime) => runtime.lastOwnedTaskId)
      .filter((taskId): taskId is string => Boolean(taskId))
  )
  const groupQueues = [...demandByKey.entries()].map(([key, tasks]) => {
    const uncovered = tasks.filter((task) => {
      if (selectedTaskIds.has(task.id)) return false
      if (boundTaskIds.has(task.id)) {
        autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-ready-task-deferred-to-bound-owner', {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          taskId: task.id,
          role: task.role,
        })
        return false
      }
      return true
    })
    // Key-count dedup: drain the group's supplied units (booting sessions)
    // before spawning more — never per-task bookkeeping for the pool.
    const supplied = suppliedByKey.get(key) ?? 0
    const covered = Math.min(supplied, uncovered.length)
    if (covered > 0) {
      autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-demand-covered-by-booting-workers', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        demandKey: key,
        covered,
        uncoveredTaskCount: uncovered.length,
      })
    }
    return { key, tasks: uncovered.slice(covered) }
  })

  let poolProgressed = true
  while (candidates.length < options.limit && poolProgressed) {
    poolProgressed = false
    for (const group of groupQueues) {
      if (candidates.length >= options.limit) break
      const task = group.tasks.shift()
      if (!task) continue
      poolProgressed = true

      autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-ready-task', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        demandKey: group.key,
        role: task.role,
        dependsOnCount: task.dependsOn.length,
      })

      // The run's one routing rule (MC-2050), asked of the task rather than of
      // its role name: coordinator-routed work keeps the seat's persistent id so
      // sequential coordination tasks share one identity; everything else is
      // task-scoped, and its worker id is minted here for the engine to bind at
      // claim. A roleless run's work tasks therefore fan out one agent each
      // instead of queueing behind the single seat.
      const agentId = sprintEngineTaskRoutesToCoordinator(task, sprintEngineState)
        ? findCoordinatorAgent()
        : pickOrMintTaskAgent(task.role)
      const agent = rosterById[agentId] ?? { id: agentId, label: agentId, role: task.role }

      addCandidate(task, agent.id, agent.label)
      autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-ready-task-result', {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        demandKey: group.key,
        selectedAgentId: agent.id,
        selectedAgentRole: agent.role,
        candidateCount: candidates.length,
      })
    }
  }

  autoRunPerfLogger('SprintEngineAutoRun', 'candidate-pick-end', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    candidateCount: candidates.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  })
  return candidates
}
