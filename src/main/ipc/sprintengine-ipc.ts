import type { IpcInvokeHandler } from '../module-host/main-host'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineMcpReadResult,
  SprintEngineProjectionReadResult,
  SprintEngineRegistryRolesReadInput,
  SprintEngineRosterRuntimeInput,
  SprintEngineRosterEnableInput,
  SprintEngineRunnerSetInput,
  SprintEngineStateInitializeInput,
  SprintEngineTaskCommentInput,
  SprintEngineTaskResolveInput,
  SprintEngineTaskStatusSetInput,
  SprintEngineTaskWorktreeInput,
  SprintEngineTaskWorktreeResult,
} from '../../shared/sprintengine/ipc-types'
import { SPRINT_ENGINE_CHANNELS } from '../../shared/sprintengine/ipc-channels'
import type { SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage'
import type { SprintRunSummary } from '../../shared/sprintengine/runSummary'

export type SprintEngineArtifactOpenPayload = {
  statePath: string
  artifactPath: string
}

export type SprintEngineArtifactReviewPayload = {
  statePath: string
  artifactId: string
  feedback?: string
}

export type SprintEngineVcsPayload = {
  statePath: string
}

export type SprintEngineVcsMergePayload = {
  statePath: string
  /**
   * The declared project whose pull request to merge (MC-1612). Omitted merges the
   * run's own project, which is the only one a single-project run has.
   */
  repo?: string
}

type SprintEngineRunsListPayload = {
  // Known project roots (main derives distinct roots to scan). The renderer sends
  // the roots of the workspaces it knows about; main dedupes and scans each.
  roots: string[]
}

export type SprintEngineProjectionReadPayload = {
  statePath: string
  // When provided, the reader returns an `unchanged` result without reading or
  // parsing the projection file if its current token matches.
  knownToken?: string
}

export type SprintEngineArtifactReviewAction = 'approve' | 'request-changes'
export type SprintEngineArtifactReviewMode = 'user' | 'auto-run'

export type SprintEngineIpcHost = {
  registerIpc(channel: string, handler: IpcInvokeHandler): void
}

type SprintEngineIpcDependencies = {
  reviewArtifact(
    payload: SprintEngineArtifactReviewPayload,
    action: SprintEngineArtifactReviewAction,
    mode: SprintEngineArtifactReviewMode
  ): Promise<SprintEngineArtifactCommandResult>
  initializeSprintEngineState(payload: SprintEngineStateInitializeInput): Promise<SprintEngineArtifactCommandResult>
  commentTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>
  resolveTaskInput(payload: SprintEngineTaskResolveInput): Promise<SprintEngineArtifactCommandResult>
  setTaskStatus(payload: SprintEngineTaskStatusSetInput): Promise<SprintEngineArtifactCommandResult>
  setRunnerMode(payload: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>
  cancelRun(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  createPullRequest(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  mergePullRequest(payload: SprintEngineVcsMergePayload): Promise<SprintEngineArtifactCommandResult>
  refreshPullRequestStatus(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  ensureTaskWorktree(payload: SprintEngineTaskWorktreeInput): Promise<SprintEngineTaskWorktreeResult>
  setRoleRuntime(payload: SprintEngineRosterRuntimeInput): Promise<SprintEngineArtifactCommandResult>
  enableRole(payload: SprintEngineRosterEnableInput): Promise<SprintEngineArtifactCommandResult>
  readProjection(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineProjectionReadResult>
  readRegistryRoles(payload: SprintEngineRegistryRolesReadInput): Promise<SprintEngineMcpReadResult>
  summarizeFeedback(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineMcpReadResult>
  readTokenUsage(payload: SprintEngineVcsPayload): Promise<SprintEngineTokenUsageReport>
  listRuns(payload: SprintEngineRunsListPayload): Promise<SprintRunSummary[]>
}

export function registerSprintEngineIpc(host: SprintEngineIpcHost, deps: SprintEngineIpcDependencies): void {
  host.registerIpc(SPRINT_ENGINE_CHANNELS.artifactApprove, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.reviewArtifact(payload as SprintEngineArtifactReviewPayload, 'approve', 'user')
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.artifactAutoApprove, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.reviewArtifact(payload as SprintEngineArtifactReviewPayload, 'approve', 'auto-run')
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.artifactRequestChanges, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.reviewArtifact(payload as SprintEngineArtifactReviewPayload, 'request-changes', 'user')
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.stateInitialize, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.initializeSprintEngineState(payload as SprintEngineStateInitializeInput)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.taskComment, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.commentTask(payload as SprintEngineTaskCommentInput)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.taskResolveInput, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.resolveTaskInput(payload as SprintEngineTaskResolveInput)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.taskSetStatus, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.setTaskStatus(payload as SprintEngineTaskStatusSetInput)
  })

  // User-initiated sprint cancellation (MC-1604b): runs the engine `cancel` op
  // and parks the automation runtime (the dep composes both in the module).
  host.registerIpc(SPRINT_ENGINE_CHANNELS.runCancel, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.cancelRun(payload as SprintEngineVcsPayload)
  })

  // `sprintengine:runner:set-mode` was removed (MC-1567): the renderer no
  // longer writes the cliWatchPolling hint — the main automation service's
  // set-mode path bridges it in-process (`deps.setRunnerMode` is still the
  // in-process seam it and the automations front door use).

  host.registerIpc(SPRINT_ENGINE_CHANNELS.vcsPr, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.createPullRequest(payload as SprintEngineVcsPayload)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.vcsPrStatus, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.refreshPullRequestStatus(payload as SprintEngineVcsPayload)
  })

  // Merging is user-initiated and per project (MC-1612); the engine refuses an
  // out-of-order merge. Nothing here decides WHEN to merge.
  host.registerIpc(SPRINT_ENGINE_CHANNELS.vcsPrMerge, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.mergePullRequest(payload as SprintEngineVcsMergePayload)
  })

  // Per-task isolation (MC-2136): provision one task's worktree BEFORE its agent
  // spawns, because a terminal cannot be moved into it afterwards. A no-op with
  // `isolated: false` on every run that shares one worktree.
  host.registerIpc(SPRINT_ENGINE_CHANNELS.vcsTaskWorktree, async (_event, payload: unknown): Promise<SprintEngineTaskWorktreeResult> => {
    return deps.ensureTaskWorktree(payload as SprintEngineTaskWorktreeInput)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.rosterRuntime, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.setRoleRuntime(payload as SprintEngineRosterRuntimeInput)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.rosterEnable, async (_event, payload: unknown): Promise<SprintEngineArtifactCommandResult> => {
    return deps.enableRole(payload as SprintEngineRosterEnableInput)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.projectionRead, async (_event, payload: unknown): Promise<SprintEngineProjectionReadResult> => {
    return deps.readProjection(payload as SprintEngineProjectionReadPayload)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.registryRolesRead, async (_event, payload: unknown): Promise<SprintEngineMcpReadResult> => {
    return deps.readRegistryRoles(payload as SprintEngineRegistryRolesReadInput)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.feedbackSummarize, async (_event, payload: unknown): Promise<SprintEngineMcpReadResult> => {
    return deps.summarizeFeedback(payload as SprintEngineProjectionReadPayload)
  })

  host.registerIpc(SPRINT_ENGINE_CHANNELS.tokenUsageRead, async (_event, payload: unknown): Promise<SprintEngineTokenUsageReport> => {
    return deps.readTokenUsage(payload as SprintEngineVcsPayload)
  })

  // Cross-project run index (MC-1761): every sprint run under the given project
  // roots as a compact summary, live and historical, with no resident workspace.
  host.registerIpc(SPRINT_ENGINE_CHANNELS.runsList, async (_event, payload: unknown): Promise<SprintRunSummary[]> => {
    return deps.listRuns(payload as SprintEngineRunsListPayload)
  })
}
