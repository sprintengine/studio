import { access, realpath, rm } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import {
  idempotencyKeyForCommand,
  rememberedCommandResult,
  rememberCommandResult,
  requestHashFor,
} from './command-cache'
import { validateMobileControlCommand } from './command-validation'
import {
  mobileActorId,
  safeSlug,
  uniqueResolved,
} from './path-utils'
import {
  createSprintEngineToolExecutor,
  defaultSprintEngineToolPath,
  parseToolJson,
  redactToolArgs,
  type SprintEngineToolExecutor,
} from './tool-runner'
import {
  getMobileSprintEngineCommandErrorMessage,
  MobileSprintEngineCommandError,
} from './command-error'
import {
  validateSprintEngineStatePath,
  type ValidSprintEngineStatePath,
} from './state-path'
import { normalizeFollowUpText } from './follow-up-text'
import {
  assertKnownActiveSprintEngineAgent,
  findReadySprintEngineTask,
  findSprintEngineArtifact,
} from './state-reader'
import { MobileSprintEngineCommandResultRecorder } from './command-results'
import {
  assertExpectedSnapshotVersion,
  resolveStateForSprintEngine,
  validateMobileWorkspacePath,
} from './workspace'
import { assertBacklogRelativePath, resolveBacklogStartContext } from './backlog'
import {
  attachSprintEnginePullRequestLink,
  recordSprintEngineExecutionLink,
} from '../../sprintengine-backlog-links'
import { teamSlugFromStatePath } from '../../../shared/backlog/sprintengine-links'
import { workspaceRootFromStatePath } from './workspace-id'
import {
  createBacklogItem,
  updateBacklogModuleMetadata,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from '../../backlog-service'
import type {
  BacklogCriticalityPayload,
  BacklogDifficultyPayload,
  BacklogItemStatusPayload,
  BacklogMutationResult,
  BacklogObjectStorePayload,
  BacklogTypePayload,
} from '../../../shared/electron-api'

export { MobileSprintEngineCommandError } from './command-error'

// Wire schema is owned by packages/mobile-control-protocol/src/index.ts. Import the
// command types from there and re-export them so this module stays the public
// surface for consumers, without re-declaring (and risking drift from) the
// protocol. Adding a new command type is an edit to protocol.ts alone.
export { mobileControlProtocolVersion } from '../../../../packages/mobile-control-protocol/src/index'

import type {
  MobileControlCommand,
  MobileControlCommandType,
  MobileControlError,
} from '../../../../packages/mobile-control-protocol/src/index'

export type { MobileControlCommand, MobileControlCommandType, MobileControlError }

export type MobileSprintEngineTaskStartRequest = {
  sprintEngineId: string
  statePath: string
  teamDirectory: string
  workspaceRoot: string
  taskId: string
  role: string
  deviceId: string
  commandId: string
}

export type MobileSprintEngineTaskStartResult = {
  sessionId: string
  agentId: string
  executionMode: 'current_workspace' | 'worktree'
}

export type MobileSprintEngineFollowUpRequest = {
  sprintEngineId: string
  statePath: string
  teamDirectory: string
  workspaceRoot: string
  agentId: string
  text: string
  deviceId: string
  commandId: string
}

export type MobileSprintEngineFollowUpResult = {
  sessionId: string
  agentId: string
  acceptedAt: string
}

type SprintEngineAutomationMode = 'manual' | 'run_agents' | 'run_agents_and_approve_artifacts'

export type MobileSprintEngineSetAutomationModeRequest = {
  sprintEngineId: string
  statePath: string
  teamDirectory: string
  workspaceRoot: string
  mode: SprintEngineAutomationMode
  deviceId: string
  commandId: string
}

export type MobileSprintEngineSetAutomationModeResult = {
  mode: SprintEngineAutomationMode
  appliedAt: string
}

// The desktop's automations seam for `automations.control` (item 47). Narrow on
// purpose: the engine's own types carry trigger/action config — provider-owned
// `unknown` that can hold local paths and webhook secrets — and NONE of that may
// reach a command result, which the relay rejects outright if it contains a local
// path (multiauth result-summary.ts). So the adapter hands back only what the
// phone asked about.
type MobileAutomationControlRequest = {
  workspaceRoot: string
  automationId: string
  deviceId: string
  commandId: string
}

export type MobileAutomationControlResult =
  | { ok: true; value: MobileAutomationControlAccepted }
  // `code` is the engine's / write core's own rejection code, mapped onto the
  // mobile error vocabulary by mobileAutomationError below. The adapter must not
  // pre-judge it: the engine is the authority on what it will refuse.
  | { ok: false; error: { code: string; message: string } }

type MobileAutomationControlAccepted = {
  automationId: string
  status: 'enabled' | 'paused' | 'blocked'
  runId?: string
  runStatus?: string
}

export type MobileAutomationsController = {
  setStatus(request: MobileAutomationControlRequest & { status: 'enabled' | 'paused' }): Promise<MobileAutomationControlResult>
  runNow(request: MobileAutomationControlRequest): Promise<MobileAutomationControlResult>
}

export type MobileSprintEngineSessionOrchestrator = {
  startTask(request: MobileSprintEngineTaskStartRequest): Promise<MobileSprintEngineTaskStartResult>
  sendFollowUp(request: MobileSprintEngineFollowUpRequest): Promise<MobileSprintEngineFollowUpResult>
  // Main-owned automation intent (MC-1497 via MC-1567). Optional so a service
  // built without the adapter (test harnesses) rejects the command instead of
  // pretending to write the authoritative store.
  setAutomationMode?(request: MobileSprintEngineSetAutomationModeRequest): Promise<MobileSprintEngineSetAutomationModeResult>
}

const defaultCommandTtlMs = 30_000
const maxProductPromptCharacters = 20_000
const maxFeedbackCharacters = 8_000
const allowedCommandTypes = new Set<MobileControlCommandType>([
  'sprintengine.create',
  'task.start',
  'agent.followUp',
  'artifact.approve',
  'artifact.requestChanges',
  'backlog.update',
  'backlog.startSprintEngine',
  'backlog.create',
  'sprintengine.openPullRequest',
  'sprintengine.setAutomationMode',
  'automations.control',
])
export type SprintEngineArtifactReviewAction = 'approve' | 'request-changes'

// How the automations engine's rejections reach the phone. Every one of them is
// SURFACED, never swallowed: the engine is the authority on what it will refuse
// (a non-schedule trigger, a run already in flight), and a command the desktop
// refused must say so rather than report a success the user cannot see.
//
// Mapped onto the existing vocabulary rather than extended with automation-shaped
// codes, because MobileControlErrorCode is a CLOSED union the client validates
// (`isOneOf(errorCodes)`, protocol.ts) — unlike `snapshot.commands`, which is
// `string[]` precisely so it CAN grow. A new error code would be rejected by an
// already-paired phone's own validator, turning a rejection it should have shown
// the user into a result it cannot parse at all.
function mobileAutomationError(code: string): { code: MobileControlError['code']; retryable: boolean } {
  switch (code) {
    // engine.runNow: the trigger is not `schedule`. No retry will ever help.
    case 'unsupported_trigger':
    // The write core refuses a definition whose provider this desktop cannot honour
    // (definition-write.ts prepareDefinitionForWrite) — a missing integration, or a
    // provider no module registers. This is the `blocked` status' own cause, so it is
    // exactly what the phone hits when it enables a blocked automation, and
    // `invalid_schedule` is the same shape: the automation cannot run AS CONFIGURED
    // on this desktop. None of them is a fault the user can retry away, and none is
    // an internal error — reporting them as one would say "something broke" when the
    // truth is "this desktop cannot do that with this automation". The provider's own
    // reason ("Requires the <name> module") rides along in the message.
    case 'provider_blocked':
    case 'unknown_trigger':
    case 'unknown_action':
    case 'invalid_schedule':
      return { code: 'command_not_supported', retryable: false }
    // engine.runNow: a run is already going. This same command succeeds once it ends.
    case 'in_flight':
      return { code: 'task_not_ready', retryable: true }
    // The phone acted on a snapshot naming an automation the desktop no longer has.
    case 'missing':
      return { code: 'stale_snapshot', retryable: false }
    // The automations module is not loaded on this desktop build.
    case 'automations_unavailable':
      return { code: 'command_not_supported', retryable: false }
    // The front door's own gate (definition-write.ts validateKnownWorkspaceRoot):
    // the automations store is only reachable for a workspace the desktop actually
    // has open. A root that survives the mobile scope check can still fail this
    // one, and refusing to touch the folder is exactly what path_not_allowed says.
    case 'workspace_root_untrusted':
    case 'workspace_root_unverified':
      return { code: 'path_not_allowed', retryable: false }
    case 'invalid_input':
      return { code: 'invalid_payload', retryable: false }
    // Store failures, an invalid schedule, a failed next-run recompute: real
    // desktop-side faults the phone cannot act on beyond seeing the message.
    default:
      return { code: 'internal_error', retryable: false }
  }
}

export function buildSprintEngineArtifactReviewArgs(input: {
  statePath: string
  action: SprintEngineArtifactReviewAction
  artifactId: string
  actorId: string
  feedback?: string
}): string[] {
  return [
    '--state',
    input.statePath,
    'artifact',
    input.action,
    '--artifact-id',
    input.artifactId,
    '--id',
    input.actorId,
    ...(input.action === 'request-changes' && input.feedback ? ['--feedback', input.feedback] : []),
  ]
}

type MobileSprintEngineCommandServiceOptions = {
  workspaceRoot?: string
  allowedWorkspaceRoots?: string[]
  statePaths?: string[]
  sprintEngineToolPath?: string
  commandTtlMs?: number
  now?: () => Date
  execute?: SprintEngineToolExecutor
  sessionOrchestrator?: MobileSprintEngineSessionOrchestrator
  automationsController?: MobileAutomationsController
  auditSink?: (entry: MobileSprintEngineCommandAuditEntry) => void
}

export type MobileSprintEngineCommandDispatchOptions = {
  allowedWorkspaceRoots?: string[]
  statePaths?: string[]
}

type MobileSprintEngineCommandScope = {
  allowedWorkspaceRoots: string[]
  statePaths: string[]
}

export type MobileSprintEngineCommandAuditEntry = {
  auditId: string
  commandId: string
  commandType: MobileControlCommandType | 'unknown'
  deviceId: string | null
  idempotencyKey?: string
  status: 'accepted' | 'rejected' | 'failed'
  code?: MobileControlError['code']
  message: string
  recordedAt: string
  statePath?: string
  artifactId?: string
  workspacePath?: string
  toolArgs?: string[]
  exitCode?: number | null
}

export type MobileSprintEngineCommandResult =
  | {
      ok: true
      commandId: string
      commandType: MobileControlCommandType
      idempotencyKey?: string
      executedAt: string
      data: unknown
      stdout: string
      stderr: string
      audit: MobileSprintEngineCommandAuditEntry
    }
  | {
      ok: false
      commandId: string | null
      commandType: MobileControlCommandType | 'unknown'
      idempotencyKey?: string
      error: MobileControlError
      audit: MobileSprintEngineCommandAuditEntry
    }

// A run worktree is branched from the workspace root (the engine records
// `repoRoot: "."`), so worktree mode is only possible where that root is a git
// repository. `.git` is a directory in a normal clone and a file inside a
// worktree — either answers the question.
async function isGitRepositoryRoot(workspaceRoot: string): Promise<boolean> {
  try {
    await access(join(workspaceRoot, '.git'))
    return true
  } catch {
    return false
  }
}

// Roll back a run store this command just bootstrapped, after a later step failed.
//
// Deliberately narrow: it removes the team directory only when the path really is
// `<workspaceRoot>/.multi-code/sprintengine/<team>/run.yaml` — the layout the
// engine just wrote — so a malformed or out-of-tree state path can never turn this
// into an arbitrary recursive delete. Best-effort: a failure to clean up must not
// mask the original error the caller is about to report.
//
// A run that got as far as registering a git worktree before failing may leave the
// worktree registration behind; `git worktree prune` clears it. In practice init
// fails before that point (the common cause — no repository to branch from — is
// already screened off before `handover` runs).
async function discardBootstrappedRunStore(workspaceRoot: string, statePath: string): Promise<void> {
  const teamSlug = teamSlugFromStatePath(statePath)
  if (!teamSlug) return
  // Resolve symlinks on both sides before comparing: the engine hands back a
  // fully-resolved state path, while the workspace root arrives merely
  // normalized. Comparing them raw would fail on macOS (/var -> /private/var) and
  // the guard would quietly never fire.
  const [realRoot, realState] = await Promise.all([
    realpath(resolve(workspaceRoot)).catch(() => resolve(workspaceRoot)),
    realpath(resolve(statePath)).catch(() => resolve(statePath)),
  ])
  const expected = join(realRoot, '.multi-code', 'sprintengine', teamSlug, 'run.yaml')
  if (realState !== expected) return
  try {
    await rm(dirname(expected), { force: true, recursive: true })
  } catch {
    // Leave the orphan rather than lose the real error.
  }
}

// `handover` answers with the absolute run.yaml it just bootstrapped. Read it from
// the tool's own output rather than re-deriving it: the engine re-slugifies the
// team name with its own rules, so a locally-derived path is a guess.
function statePathFromHandover(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const statePath = (data as { statePath?: unknown }).statePath
  return typeof statePath === 'string' && statePath.trim().length > 0 ? statePath : null
}

// `vcs pr` answers with the pull request it opened (or the one already open — it
// is idempotent).
function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// One project's pull request, as `vcs pr` reported it.
type MobileSprintEnginePullRequest = {
  repo: string
  url: string
  /** The project's name as a person says it; absent on a single-project run. */
  repoLabel?: string
}

/**
 * The pull requests `vcs pr` opened, one per project the run delivered (MC-1612).
 *
 * The engine reports every project under `repos` and keeps the primary's url at the
 * top level, where every surface that predates the list still reads it. Read the list
 * when it is there and fall back to the flat field, so a run whose store predates the
 * list still yields its one pull request.
 *
 * Projects with no url are not pull requests and are not returned: a project the run
 * never committed to, or one whose open failed (the engine records the reason on that
 * repo's entry and never pairs it with a url). The phone reads why from the run
 * snapshot's per-repo state, which is where that already lives.
 */
function pullRequestsFromVcsPr(data: unknown): MobileSprintEnginePullRequest[] {
  if (typeof data !== 'object' || data === null) return []
  const repos = (data as { repos?: unknown }).repos
  if (!Array.isArray(repos)) {
    const url = trimmedString((data as { pullRequestUrl?: unknown }).pullRequestUrl)
    return url ? [{ repo: 'primary', url }] : []
  }
  const pullRequests: MobileSprintEnginePullRequest[] = []
  for (const entry of repos) {
    if (typeof entry !== 'object' || entry === null) continue
    const repo = trimmedString((entry as { repo?: unknown }).repo)
    const url = trimmedString((entry as { pullRequestUrl?: unknown }).pullRequestUrl)
    if (!repo || !url) continue
    pullRequests.push({
      repo,
      url,
      // The project's name only means something next to another project's. On a
      // single-project run there is nothing to tell apart, and the label it has
      // always had is the right one.
      ...(repos.length > 1 ? { repoLabel: trimmedString((entry as { project?: unknown }).project) ?? repo } : {}),
    })
  }
  return pullRequests
}

export class MobileSprintEngineCommandService {
  private readonly workspaceRoot: string
  private readonly configuredAllowedWorkspaceRoots: string[]
  private readonly configuredStatePaths: string[]
  private readonly commandTtlMs: number
  private readonly now: () => Date
  private readonly execute: SprintEngineToolExecutor
  private readonly sessionOrchestrator?: MobileSprintEngineSessionOrchestrator
  private readonly automationsController?: MobileAutomationsController
  private readonly resultRecorder: MobileSprintEngineCommandResultRecorder

  constructor(options: MobileSprintEngineCommandServiceOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
    this.configuredAllowedWorkspaceRoots = uniqueResolved([
      this.workspaceRoot,
      ...(options.allowedWorkspaceRoots ?? []),
    ])
    this.configuredStatePaths = (options.statePaths ?? []).map((statePath) => validateSprintEngineStatePath(statePath).statePath)
    this.commandTtlMs = Math.max(1, options.commandTtlMs ?? defaultCommandTtlMs)
    this.now = options.now ?? (() => new Date())
    this.execute = options.execute ?? createSprintEngineToolExecutor(options.sprintEngineToolPath ?? defaultSprintEngineToolPath())
    this.sessionOrchestrator = options.sessionOrchestrator
    this.automationsController = options.automationsController
    this.resultRecorder = new MobileSprintEngineCommandResultRecorder(this.now, options.auditSink)
  }

  getAuditLog(): MobileSprintEngineCommandAuditEntry[] {
    return this.resultRecorder.getAuditLog()
  }

  async dispatch(input: unknown, options: MobileSprintEngineCommandDispatchOptions = {}): Promise<MobileSprintEngineCommandResult> {
    const validated = validateMobileControlCommand(input)
    if (!validated.ok) {
      return this.resultRecorder.rejectUnknown(validated.error)
    }

    const command = validated.value
    if (!allowedCommandTypes.has(command.type)) {
      return this.resultRecorder.reject(command, 'command_not_supported', `Mobile command ${command.type} is not supported by the Sprint Engine command service.`, false)
    }

    if (!command.idempotencyKey) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'idempotencyKey is required for Sprint Engine mutation commands.', false)
    }

    const idempotencyKey = idempotencyKeyForCommand(this.workspaceRoot, command)
    const requestHash = requestHashFor(command)
    const cachedResult = this.replayCachedResult(command, idempotencyKey, requestHash)
    if (cachedResult) {
      return cachedResult
    }

    const ttlError = this.validateCommandTtl(command)
    if (ttlError) {
      return this.resultRecorder.reject(command, 'command_expired', ttlError, false)
    }

    try {
      const scope = this.commandScope(options)
      const result = await this.executeCommand(command, scope)
      rememberCommandResult(idempotencyKey, requestHash, result)
      return result
    } catch (error) {
      if (error instanceof MobileSprintEngineCommandError) {
        const result = this.resultRecorder.reject(command, error.code, error.message, error.retryable)
        rememberCommandResult(idempotencyKey, requestHash, result)
        return result
      }
      const result = this.resultRecorder.reject(command, 'internal_error', getMobileSprintEngineCommandErrorMessage(error), false)
      rememberCommandResult(idempotencyKey, requestHash, result)
      return result
    }
  }

  private async executeCommand(
    command: MobileControlCommand,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    switch (command.type) {
      case 'artifact.approve':
        return this.executeArtifactReviewCommand(command, 'approve', scope)
      case 'artifact.requestChanges':
        return this.executeArtifactReviewCommand(command, 'request-changes', scope)
      case 'sprintengine.create':
        return this.executeSprintEngineCreateCommand(command, scope)
      case 'backlog.update':
        return this.executeBacklogUpdateCommand(command, scope)
      case 'backlog.startSprintEngine':
        return this.executeBacklogStartSprintEngineCommand(command, scope)
      case 'backlog.create':
        return this.executeBacklogCreateCommand(command, scope)
      case 'sprintengine.openPullRequest':
        return this.executeOpenPullRequestCommand(command, scope)
      case 'sprintengine.setAutomationMode':
        return this.executeSetAutomationModeCommand(command, scope)
      case 'task.start':
        return this.executeTaskStartCommand(command, scope)
      case 'agent.followUp':
        return this.executeAgentFollowUpCommand(command, scope)
      case 'automations.control':
        return this.executeAutomationsControlCommand(command, scope)
      case 'snapshot.request':
      case 'artifact.read':
      case 'device.revoke':
        return this.resultRecorder.reject(command, 'command_not_supported', `Mobile command ${command.type} is not supported by the Sprint Engine command service.`, false)
    }
  }

  private async executeTaskStartCommand(
    command: Extract<MobileControlCommand, { type: 'task.start' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    if (!this.sessionOrchestrator) {
      return this.resultRecorder.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile task starts.', false)
    }

    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId, scope)
    await assertExpectedSnapshotVersion({
      expectedSnapshotVersion: command.expectedSnapshotVersion,
      statePath: state.statePath,
    })
    const task = await findReadySprintEngineTask(state, command.payload.taskId, command.payload.role)

    const data = await this.sessionOrchestrator.startTask({
      sprintEngineId: command.payload.sprintEngineId,
      statePath: state.statePath,
      teamDirectory: state.teamDirectory,
      workspaceRoot: state.workspaceRoot,
      taskId: task.id,
      role: task.role,
      deviceId: command.deviceId,
      commandId: command.commandId,
    })

    return this.resultRecorder.acceptSessionCommand(
      command,
      data,
      state,
      'Mobile task start was accepted by desktop session orchestration.'
    )
  }

  private async executeAgentFollowUpCommand(
    command: Extract<MobileControlCommand, { type: 'agent.followUp' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    if (!this.sessionOrchestrator) {
      return this.resultRecorder.reject(command, 'command_not_supported', 'Desktop session orchestration is not configured for mobile follow-up messages.', false)
    }

    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId, scope)
    await assertExpectedSnapshotVersion({
      expectedSnapshotVersion: command.expectedSnapshotVersion,
      statePath: state.statePath,
    })
    const text = normalizeFollowUpText(command.payload.text)
    await assertKnownActiveSprintEngineAgent(state, command.payload.agentId)

    const data = await this.sessionOrchestrator.sendFollowUp({
      sprintEngineId: command.payload.sprintEngineId,
      statePath: state.statePath,
      teamDirectory: state.teamDirectory,
      workspaceRoot: state.workspaceRoot,
      agentId: command.payload.agentId,
      text,
      deviceId: command.deviceId,
      commandId: command.commandId,
    })

    return this.resultRecorder.acceptSessionCommand(
      command,
      data,
      state,
      'Mobile follow-up was accepted by desktop session orchestration.'
    )
  }

  private async executeArtifactReviewCommand(
    command: Extract<MobileControlCommand, { type: 'artifact.approve' | 'artifact.requestChanges' }>,
    action: 'approve' | 'request-changes',
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId, scope)
    await assertExpectedSnapshotVersion({
      expectedSnapshotVersion: command.expectedSnapshotVersion,
      statePath: state.statePath,
    })
    const artifact = await findSprintEngineArtifact(state, command.payload.artifactId)

    const actorId = mobileActorId(command.deviceId)
    let feedback: string | undefined

    if (action === 'request-changes') {
      feedback = typeof command.payload.feedback === 'string' ? command.payload.feedback.trim() : ''
      if (!feedback) {
        return this.resultRecorder.reject(command, 'invalid_payload', 'Artifact change requests require feedback.', false, state, artifact.id)
      }
      if (feedback.length > maxFeedbackCharacters) {
        return this.resultRecorder.reject(command, 'invalid_payload', `Artifact feedback must be ${maxFeedbackCharacters} characters or less.`, false, state, artifact.id)
      }
    }

    const args = buildSprintEngineArtifactReviewArgs({
      statePath: state.statePath,
      action,
      artifactId: artifact.id,
      actorId,
      feedback,
    })

    return this.invokeTool(command, args, state.workspaceRoot, state, artifact.id)
  }

  // MC-1496: open (or return the existing) pull request for the run. The Sprint
  // Engine CLI `vcs pr` owns the PR lifecycle and is the single source of truth:
  // it is idempotent (a second call returns the same URL without a second PR),
  // refuses a run with no worktree branch, and records `pullRequestError` on
  // failure. `vcs pr` rebuilds the projection, so the follow-up snapshot carries
  // the new PR URL/status — no separate `pr-status` refresh is needed here.
  //
  // MC-1612: a run spanning projects opens ONE PULL REQUEST PER PROJECT, so the
  // result carries the list. The added `pullRequests` field is additive and the
  // legacy `pullRequestUrl` the engine keeps at the top level is untouched: relay
  // scopes freeze at pair time, so the protocol stays v2 and a phone that only
  // knows the single-PR shape keeps working against a multi-project run.
  private async executeOpenPullRequestCommand(
    command: Extract<MobileControlCommand, { type: 'sprintengine.openPullRequest' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId, scope)
    await assertExpectedSnapshotVersion({
      expectedSnapshotVersion: command.expectedSnapshotVersion,
      statePath: state.statePath,
    })

    const args = ['--state', state.statePath, 'vcs', 'pr', '--id', mobileActorId(command.deviceId)]
    const result = await this.invokeTool(command, args, state.workspaceRoot, state)
    if (!result.ok) {
      return result
    }

    // Attach every project's PR to the backlog item that started this run. The
    // renderer does this on a projection tick, but that tick only runs with the
    // desktop UI mounted on the workspace — and a phone-driven run has nobody at the
    // desktop. Best-effort: the PRs are already open, so a store hiccup must not fail
    // the command (and `vcs pr` is idempotent, so a retry re-attaches).
    const pullRequests = pullRequestsFromVcsPr(result.data)
    if (pullRequests.length) {
      const linked = await attachSprintEnginePullRequestLink({
        workspaceRoot: state.workspaceRoot,
        statePath: state.statePath,
        pullRequests: pullRequests.map((pullRequest) => ({
          repoId: pullRequest.repo,
          url: pullRequest.url,
          repoLabel: pullRequest.repoLabel,
        })),
        now: this.now,
      })
      if (!linked.ok) {
        const urls = pullRequests.map((pullRequest) => pullRequest.url).join(', ')
        console.warn(`[mobile] Opened pull request(s) ${urls} but could not link them to their backlog item: ${linked.message}`)
      }
    }

    return {
      ...result,
      data:
        typeof result.data === 'object' && result.data !== null
          ? { ...(result.data as Record<string, unknown>), pullRequests }
          : result.data,
    }
  }

  // MC-1497: set the run's three-state automation mode. The authoritative mode
  // intent is main-owned and folder-store-persisted (MC-1567 Option B:
  // `sprintengine-automation-service.ts` writes `automation.json` beside
  // run.yaml); the orchestrator adapter writes it directly, so this works
  // headless with no renderer round-trip. The guard below only fires for a
  // service built without the adapter (test harnesses).
  private async executeSetAutomationModeCommand(
    command: Extract<MobileControlCommand, { type: 'sprintengine.setAutomationMode' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    if (!this.sessionOrchestrator?.setAutomationMode) {
      return this.resultRecorder.reject(
        command,
        'command_not_supported',
        'Setting the automation mode is not supported by this desktop build.',
        false
      )
    }

    const state = await this.resolveStateForSprintEngine(command.payload.sprintEngineId, scope)
    await assertExpectedSnapshotVersion({
      expectedSnapshotVersion: command.expectedSnapshotVersion,
      statePath: state.statePath,
    })

    const data = await this.sessionOrchestrator.setAutomationMode({
      sprintEngineId: command.payload.sprintEngineId,
      statePath: state.statePath,
      teamDirectory: state.teamDirectory,
      workspaceRoot: state.workspaceRoot,
      mode: command.payload.mode,
      deviceId: command.deviceId,
      commandId: command.commandId,
    })

    return this.resultRecorder.acceptSessionCommand(
      command,
      data,
      state,
      'Mobile automation-mode change was accepted by desktop session orchestration.'
    )
  }

  // Item 47: enable, pause, or fire one desktop automation from the phone.
  //
  // The engine is the authority on what it will accept, so this does NOT re-derive
  // its rules. It calls the engine and surfaces what comes back: run-now on a
  // non-schedule trigger returns `unsupported_trigger`, and a second run while one
  // is in flight returns `in_flight` (engine.ts runNow). Both become honest
  // rejections rather than a swallowed no-op. The phone's job is to not ask in the
  // first place — it gates the affordance on `triggerKind` and `runInFlight`, which
  // the snapshot projection carries for exactly this purpose — but a phone acting
  // on a snapshot that has since gone stale must still be told the truth.
  //
  // There is deliberately no cancel for AUTOMATION runs: no cancel primitive
  // exists on that surface, and the nearest thing (finalizing a run as failed)
  // tears down the worktree and disposes the agent — destruction, not
  // cancellation. (Sprint runs DO have a cancel op since MC-1604, but that is a
  // desktop decision by design; the phone follows the snapshot.)
  private async executeAutomationsControlCommand(
    command: Extract<MobileControlCommand, { type: 'automations.control' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    if (!this.automationsController) {
      return this.resultRecorder.reject(
        command,
        'command_not_supported',
        'Controlling automations is not supported by this desktop build.',
        false
      )
    }

    // The phone sends the `ws_…` token it read off the automation's projectKey —
    // absolute paths never cross the relay — so resolve it back to a root this
    // desktop already knows, and fail closed with path_not_allowed otherwise.
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })

    const { automationId, action } = command.payload
    const request: MobileAutomationControlRequest = {
      workspaceRoot: workspacePath,
      automationId,
      deviceId: command.deviceId,
      commandId: command.commandId,
    }

    const result = action === 'runNow'
      ? await this.automationsController.runNow(request)
      : await this.automationsController.setStatus({
        ...request,
        status: action === 'enable' ? 'enabled' : 'paused',
      })

    if (!result.ok) {
      const { code, retryable } = mobileAutomationError(result.error.code)
      return this.resultRecorder.reject(command, code, result.error.message, retryable, undefined, undefined, workspacePath)
    }

    return this.resultRecorder.acceptWorkspaceCommand(
      command,
      result.value,
      workspacePath,
      'Mobile automation control was applied by the desktop automations engine.'
    )
  }

  // Resolves the optional sprint config. teamName is slugified here (safeSlug) so
  // bookkeeping (module metadata, audit args) records the same name the engine
  // derives. Under leases (MC-1591) roleCounts no longer mint seats: the desired-
  // pool supervisor spawns workers on demand, so the phone's roster is expressed
  // as the run's `configuredRoles` — its legal role set, enforced by
  // plan.add_task — and applied at init (see configuredRolesInitArgs). Seat COUNTS
  // ("concurrency") have no CLI honor path (the supervisor's concurrency cap is
  // desktop runner state, per SprintEngineCreateConfig), so they are dropped
  // rather than turned into `--agent role:role-N` seat specs. Automation mode /
  // permission presets / worktrees are likewise not on this wire (MC-1497 et al.).
  private sprintEngineConfigArgs(
    config: { teamName?: string; roleCounts?: Record<string, number> } | undefined,
    fallbackTeamName: string
  ): { teamName: string; configuredRoles: string[] } {
    const requestedName = config?.teamName?.trim()
    const teamName = requestedName ? safeSlug(requestedName) : fallbackTeamName
    // Distinct role ids in request order; seat counts are intentionally ignored.
    const configuredRoles: string[] = []
    for (const role of Object.keys(config?.roleCounts ?? {})) {
      const roleId = role.trim()
      if (roleId && !configuredRoles.includes(roleId)) configuredRoles.push(roleId)
    }
    return { teamName, configuredRoles }
  }

  // The `init` args that persist a phone-composed roster: the run's
  // `configuredRoles` (its legal role set) plus a single rosterConfigured marker.
  // init flips `rosterConfigured` on any `--agent` presence, and leases mint no
  // seats, so this is ONE marker (role:role, never a numbered role:role-N seat).
  // Empty when the phone named no roles — the architect then picks the team.
  private configuredRolesInitArgs(configuredRoles: string[]): string[] {
    if (configuredRoles.length === 0) return []
    return [
      '--configured-roles-json',
      JSON.stringify(configuredRoles),
      '--agent',
      `${configuredRoles[0]}:${configuredRoles[0]}`,
    ]
  }

  private async executeSprintEngineCreateCommand(
    command: Extract<MobileControlCommand, { type: 'sprintengine.create' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })
    const productPrompt = command.payload.productPrompt.trim()
    if (!productPrompt) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'Sprint creation requires a product prompt.', false, undefined, undefined, workspacePath)
    }
    if (productPrompt.length > maxProductPromptCharacters) {
      return this.resultRecorder.reject(command, 'invalid_payload', `Product prompt must be ${maxProductPromptCharacters} characters or less.`, false, undefined, undefined, workspacePath)
    }

    const { teamName, configuredRoles } = this.sprintEngineConfigArgs(
      command.payload.config,
      `mobile-${safeSlug(command.commandId)}`
    )
    const args = [
      'handover',
      '--name',
      teamName,
      '--goal',
      productPrompt,
      '--handover-text',
      productPrompt,
      '--actor',
      mobileActorId(command.deviceId),
    ]

    const result = await this.invokeTool(command, args, workspacePath, undefined, undefined, workspacePath)
    if (!result.ok) {
      return result
    }

    // Persist a phone-composed roster as the run's configuredRoles. `handover`
    // only bootstraps the store (it records rosterConfigured, not which roles),
    // so the role set is applied by a follow-up `init` — exactly as the backlog-
    // start path and the desktop creation flow do. The architect's own later
    // init is idempotent and leaves configuredRoles intact. With no roles named
    // there is nothing to apply, so create stays a single handover call.
    const roleArgs = this.configuredRolesInitArgs(configuredRoles)
    const statePath = statePathFromHandover(result.data)
    if (statePath && roleArgs.length > 0) {
      const init = await this.invokeTool(
        command,
        ['--state', statePath, 'init', ...roleArgs],
        workspacePath,
        undefined,
        undefined,
        workspacePath
      )
      if (!init.ok) {
        // Roll back the store this command just bootstrapped so a retry is clean
        // (handover refuses to overwrite bootstrap files without --force).
        await discardBootstrappedRunStore(workspacePath, statePath)
        return init
      }
    }

    return result
  }

  private async executeBacklogUpdateCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.update' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })
    const relativePath = assertBacklogRelativePath(command.payload.relativePath)
    const { status, type, difficulty, criticality } = command.payload
    if (status === undefined && type === undefined && difficulty === undefined && criticality === undefined) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'Backlog updates require at least one of status, type, difficulty, or criticality.', false, undefined, undefined, workspacePath)
    }

    // The store mutations are sequential on purpose: each one is a full
    // read-modify-write of items.json, so running them concurrently would
    // race on the file.
    const mutations: Array<() => Promise<BacklogMutationResult>> = []
    if (status !== undefined) {
      mutations.push(() => updateBacklogStatus({ workspaceRoot: workspacePath, relativePath, status: status as BacklogItemStatusPayload }))
    }
    if (type !== undefined) {
      mutations.push(() => updateBacklogType({ workspaceRoot: workspacePath, relativePath, type: type as BacklogTypePayload }))
    }
    if (difficulty !== undefined || criticality !== undefined) {
      mutations.push(() => updateBacklogTriage({
        workspaceRoot: workspacePath,
        relativePath,
        ...(difficulty !== undefined ? { difficulty: difficulty as BacklogDifficultyPayload } : {}),
        ...(criticality !== undefined ? { criticality: criticality as BacklogCriticalityPayload } : {}),
      }))
    }

    let store: BacklogObjectStorePayload | null = null
    for (const mutation of mutations) {
      const result = await mutation()
      if (!result.ok) {
        return this.resultRecorder.reject(command, 'invalid_payload', result.message, false, undefined, undefined, workspacePath)
      }
      store = result.store
    }

    const item = store?.items.find((record) => record.source.relativePath.toLowerCase() === relativePath.toLowerCase()) ?? null
    return this.resultRecorder.acceptWorkspaceCommand(
      command,
      { item },
      workspacePath,
      'Mobile backlog update was applied to the workspace backlog store.'
    )
  }

  private async executeBacklogStartSprintEngineCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.startSprintEngine' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })
    const relativePath = assertBacklogRelativePath(command.payload.relativePath)
    const start = await resolveBacklogStartContext(workspacePath, relativePath)

    const { teamName, configuredRoles } = this.sprintEngineConfigArgs(
      command.payload.config,
      `backlog-${safeSlug(command.commandId)}`
    )

    // Worktree mode defaults ON for a backlog start wherever it is possible. A
    // non-worktree run has no branch, so the engine refuses `vcs pr` on it
    // outright ("no branch to open a pull request from") — and a backlog start
    // exists to reach a pull request. It defaults OFF in a workspace with no git
    // repository at its root, because there is nothing there to branch from and
    // failing the start would be a pointless regression for those workspaces. An
    // explicit `useWorktrees` always wins, and is allowed to fail loudly.
    const useWorktrees = command.payload.useWorktrees ?? (await isGitRepositoryRoot(workspacePath))

    // Launch an epic as an epic unless the phone says otherwise. Children are the
    // source bundle; the epic itself stays the root source.
    const asEpic = (command.payload.epic ?? start.isEpic) && start.isEpic
    const children = asEpic ? start.children : []

    const args = [
      'handover',
      '--name',
      teamName,
      '--goal',
      start.title,
      // Reference the item in place rather than inlining its body. `--handover-text`
      // records the source with no path, and the engine grants the multicode_backlog
      // lifecycle skill only to runs whose source path sits under backlog/ — so an
      // inlined start produced an agent that never knew it came from a backlog item
      // and never kept that item's status truthful.
      '--handover',
      start.absolutePath,
      '--reference-sources',
      ...(asEpic ? ['--source-plan-kind', 'epic'] : []),
      ...children.flatMap((child) => ['--source', `generic_context:${child.absolutePath}`]),
      '--actor',
      mobileActorId(command.deviceId),
    ]

    const result = await this.invokeTool(command, args, workspacePath, undefined, undefined, workspacePath)
    if (!result.ok) {
      return result
    }

    const statePath = statePathFromHandover(result.data)

    // `handover` bootstraps the run store but does NOT establish worktree mode:
    // its parser accepts --use-worktrees and its handler ignores it — only `init`
    // calls ensure_run_worktree. So the run only gets a branch (and therefore can
    // only ever open a pull request) if we init it here, exactly as the desktop's
    // creation flow does. The architect's own `init` later is idempotent: it
    // re-reads the prompt and leaves the existing vcs block and tasks alone. Any
    // phone-composed roster (configuredRoles) is applied on this same init.
    if (statePath) {
      const init = await this.invokeTool(
        command,
        ['--state', statePath, 'init', '--use-worktrees', useWorktrees ? 'true' : 'false', ...this.configuredRolesInitArgs(configuredRoles)],
        workspacePath,
        undefined,
        undefined,
        workspacePath
      )
      if (!init.ok) {
        // The run store now exists but has no plan gate and no branch, and
        // `handover` refuses to write over existing bootstrap files without
        // --force. Left behind, that half-built team would wedge every retry that
        // reuses its name (an explicitly named team can never be started again)
        // and would surface on the phone as a phantom run with no tasks. Roll it
        // back so a retry is clean, then surface the engine's real reason rather
        // than reporting a start that cannot produce the pull request it was
        // asked for.
        await discardBootstrappedRunStore(workspacePath, statePath)
        return init
      }
    }

    // Best-effort lifecycle bookkeeping after the run started: the start already
    // succeeded, so a store hiccup must not fail the command.
    if (statePath) {
      // The execution link is load-bearing, not bookkeeping: it is the only
      // backlog -> run correspondence there is, and the PR write later finds this
      // item by scanning for it. It also moves the item to in_progress.
      const linked = await recordSprintEngineExecutionLink({
        workspaceRoot: workspacePath,
        relativePath,
        statePath,
        childRelativePaths: children,
      })
      if (!linked.ok) {
        console.warn(`[mobile] Sprint Engine start could not link ${relativePath} to its run: ${linked.message}`)
      }
    } else {
      // No state path came back from the tool, so no link can be written. Still
      // move the item, so the phone at least reflects that work started.
      await updateBacklogStatus({ workspaceRoot: workspacePath, relativePath, status: 'in_progress' })
    }

    await updateBacklogModuleMetadata({
      workspaceRoot: workspacePath,
      relativePath,
      moduleId: 'mobile-companion',
      value: {
        startedAt: this.now().toISOString(),
        commandId: command.commandId,
        deviceId: command.deviceId,
        teamName,
        useWorktrees,
        epic: asEpic,
        ...(statePath ? { statePath } : {}),
      },
    })

    return result
  }

  private async executeBacklogCreateCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.create' }>,
    scope: MobileSprintEngineCommandScope
  ): Promise<MobileSprintEngineCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })
    const title = command.payload.title.trim()
    if (!title) {
      return this.resultRecorder.reject(command, 'invalid_payload', 'Backlog item creation requires a non-empty title.', false, undefined, undefined, workspacePath)
    }

    const result = await createBacklogItem({
      workspaceRoot: workspacePath,
      title,
      ...(command.payload.description !== undefined ? { description: command.payload.description } : {}),
      ...(command.payload.type !== undefined ? { type: command.payload.type } : {}),
      ...(command.payload.difficulty !== undefined ? { difficulty: command.payload.difficulty } : {}),
      ...(command.payload.criticality !== undefined ? { criticality: command.payload.criticality } : {}),
    })
    if (!result.ok) {
      return this.resultRecorder.reject(command, 'invalid_payload', result.message, false, undefined, undefined, workspacePath)
    }

    const item = result.store.items.find((record) => record.source.relativePath === result.relativePath) ?? null
    return this.resultRecorder.acceptWorkspaceCommand(
      command,
      { id: result.id, relativePath: result.relativePath, item },
      workspacePath,
      'Mobile backlog item was created in the workspace backlog store.'
    )
  }

  private commandScope(options: MobileSprintEngineCommandDispatchOptions): MobileSprintEngineCommandScope {
    const configuredStates = this.configuredStatePaths.map((statePath) => validateSprintEngineStatePath(statePath))
    const dispatchStates = (options.statePaths ?? []).map((statePath) => validateSprintEngineStatePath(statePath))
    const statePaths = uniqueResolved([...configuredStates, ...dispatchStates].map((state) => state.statePath))
    const allowedWorkspaceRoots = uniqueResolved([
      ...this.configuredAllowedWorkspaceRoots,
      ...(options.allowedWorkspaceRoots ?? []),
    ])

    return { allowedWorkspaceRoots, statePaths }
  }

  // Roots a phone-supplied workspace token may resolve to: the allowed roots plus
  // the workspace root of every known Sprint Engine state path, so workspaces
  // nested under a configured parent root still resolve. Token resolution is
  // still re-validated against allowedWorkspaceRoots, so widening this set does
  // not relax the security boundary.
  private workspaceRootCandidates(scope: MobileSprintEngineCommandScope): string[] {
    return uniqueResolved([
      ...scope.allowedWorkspaceRoots,
      ...scope.statePaths.map((statePath) => workspaceRootFromStatePath(statePath)),
    ])
  }

  private async resolveStateForSprintEngine(
    sprintEngineId: string,
    scope: MobileSprintEngineCommandScope
  ): Promise<ValidSprintEngineStatePath> {
    return resolveStateForSprintEngine({
      sprintEngineId,
      statePaths: scope.statePaths,
      workspaceRoot: this.workspaceRoot,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
    })
  }

  private async invokeTool(
    command: MobileControlCommand,
    args: string[],
    cwd: string,
    state?: ValidSprintEngineStatePath,
    artifactId?: string,
    workspacePath?: string
  ): Promise<MobileSprintEngineCommandResult> {
    const toolResult = await this.execute({ args, cwd })
    const parsed = parseToolJson(toolResult.stdout)

    if (toolResult.exitCode !== 0 || !parsed.ok) {
      const message = parsed.message ?? parsed.error ?? (toolResult.stderr.trim() || 'The Sprint Engine tool command failed.')
      return this.resultRecorder.reject(command, 'python_tool_failed', message, true, state, artifactId, workspacePath, args, toolResult.exitCode)
    }

    const audit = this.resultRecorder.recordAudit({
      command,
      status: 'accepted',
      message: 'Mobile Sprint Engine command executed through the canonical Sprint Engine tool.',
      state,
      artifactId,
      workspacePath,
      toolArgs: redactToolArgs(args),
      exitCode: toolResult.exitCode,
    })

    return {
      ok: true,
      commandId: command.commandId,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      executedAt: audit.recordedAt,
      data: parsed.data,
      stdout: toolResult.stdout,
      stderr: toolResult.stderr,
      audit,
    }
  }

  private validateCommandTtl(command: MobileControlCommand): string | null {
    const issuedAt = Date.parse(command.issuedAt)
    const now = this.now().getTime()
    if (issuedAt > now + 5_000) {
      return 'Command issue time is too far in the future.'
    }
    if (now - issuedAt > this.commandTtlMs) {
      return 'Command has expired.'
    }
    return null
  }

  private replayCachedResult(
    command: MobileControlCommand,
    key: string,
    requestHash: string
  ): MobileSprintEngineCommandResult | null {
    const remembered = rememberedCommandResult(key, requestHash)
    if (remembered.status === 'miss') return null

    if (remembered.status === 'conflict') {
      return this.resultRecorder.reject(command, 'duplicate_idempotency_key', 'This idempotency key was already used for a different command body.', false)
    }

    const replayed = remembered.result
    const replayStatus = replayed.ok ? 'accepted' : replayed.audit.status
    const audit = this.resultRecorder.recordAudit({
      command,
      status: replayStatus,
      code: replayed.ok ? undefined : replayed.error.code,
      message: 'Mobile Sprint Engine command result was replayed for a matching idempotency key.',
    })

    return replayed.ok
      ? {
          ...replayed,
          commandId: command.commandId,
          commandType: command.type,
          idempotencyKey: command.idempotencyKey,
          audit,
        }
      : {
          ...replayed,
          commandId: command.commandId,
          commandType: command.type,
          idempotencyKey: command.idempotencyKey,
          audit,
        }
  }

}
