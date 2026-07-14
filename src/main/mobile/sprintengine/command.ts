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

// Wire schema is owned by src/shared/mobile-control/protocol.ts. Import the
// command types from there and re-export them so this module stays the public
// surface for consumers, without re-declaring (and risking drift from) the
// protocol. Adding a new command type is an edit to protocol.ts alone.
export { mobileControlProtocolVersion } from '../../../shared/mobile-control/protocol'

import type {
  MobileControlCommand,
  MobileControlCommandType,
  MobileControlError,
} from '../../../shared/mobile-control/protocol'

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

export type SprintEngineAutomationMode = 'manual' | 'run_agents' | 'run_agents_and_approve_artifacts'

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
])
export type SprintEngineArtifactReviewAction = 'approve' | 'request-changes'

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
function pullRequestUrlFromVcsPr(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const url = (data as { pullRequestUrl?: unknown }).pullRequestUrl
  return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null
}

export class MobileSprintEngineCommandService {
  private readonly workspaceRoot: string
  private readonly configuredAllowedWorkspaceRoots: string[]
  private readonly configuredStatePaths: string[]
  private readonly commandTtlMs: number
  private readonly now: () => Date
  private readonly execute: SprintEngineToolExecutor
  private readonly sessionOrchestrator?: MobileSprintEngineSessionOrchestrator
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

    // Attach the PR to the backlog item that started this run. The renderer does
    // this on a projection tick, but that tick only runs with the desktop UI
    // mounted on the workspace — and a phone-driven run has nobody at the desktop.
    // Best-effort: the PR is already open, so a store hiccup must not fail the
    // command (and `vcs pr` is idempotent, so a retry re-attaches).
    const pullRequestUrl = pullRequestUrlFromVcsPr(result.data)
    if (pullRequestUrl) {
      const linked = await attachSprintEnginePullRequestLink({
        workspaceRoot: state.workspaceRoot,
        statePath: state.statePath,
        pullRequestUrl,
        now: this.now,
      })
      if (!linked.ok) {
        console.warn(`[mobile] Opened pull request ${pullRequestUrl} but could not link it to its backlog item: ${linked.message}`)
      }
    }

    return result
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

  // Expands the optional sprint config into `handover` CLI args. teamName is
  // slugified here (safeSlug) so bookkeeping (module metadata, audit args)
  // records the same name the engine derives; roleCounts become the wizard's
  // `role:role-N` seat specs — presence means the user composed the roster,
  // absence leaves rosterConfigured false so the architect picks the team.
  // Automation mode / permission presets / max-parallel / worktrees are
  // desktop-app runner state this CLI path cannot honor (MC-1497 et al.) and
  // are deliberately not on the wire.
  private sprintEngineConfigArgs(config: { teamName?: string; roleCounts?: Record<string, number> } | undefined, fallbackTeamName: string): { teamName: string; extraArgs: string[] } {
    const requestedName = config?.teamName?.trim()
    const teamName = requestedName ? safeSlug(requestedName) : fallbackTeamName
    const extraArgs: string[] = []
    for (const [role, count] of Object.entries(config?.roleCounts ?? {})) {
      const roleSlug = safeSlug(role)
      for (let seat = 1; seat <= count; seat += 1) {
        extraArgs.push('--agent', `${roleSlug}:${roleSlug}-${seat}`)
      }
    }
    return { teamName, extraArgs }
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

    const { teamName, extraArgs } = this.sprintEngineConfigArgs(
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
      ...extraArgs,
    ]

    return this.invokeTool(command, args, workspacePath, undefined, undefined, workspacePath)
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

    const { teamName, extraArgs } = this.sprintEngineConfigArgs(
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
      ...extraArgs,
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
    // re-reads the prompt and leaves the existing vcs block and tasks alone.
    if (statePath) {
      const init = await this.invokeTool(
        command,
        ['--state', statePath, 'init', '--use-worktrees', useWorktrees ? 'true' : 'false'],
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
