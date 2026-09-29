import { stat } from 'fs/promises'
import {
  MAX_CONVERSATION_METADATA_BYTES,
  readConversationStorage,
  removeConversationStorage,
  writeConversationStorage,
} from './conversation-persistence'

import type {
  ConversationAttachmentResult,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationCliRuntimeOverrides,
  ConversationPageResult,
  ConversationEvent,
  ConversationImageAttachment,
  ConversationInterruptInput,
  ConversationPermissionPreset,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSessionSummary,
  ConversationSkillRef,
  ConversationSubagentStatusPayload,
  ConversationSetModelInput,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationSuspendSessionInput,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationToolDetail,
  ConversationJsonValue,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationRewindResult,
} from '../shared/conversation-runtime'
import { inferConversationToolKind } from '../shared/conversation/toolKind'
import { readSubagentStatus } from '../shared/conversation/subagents'
import {
  readToolDetail,
  writeToolDetail,
  redactConversationValue,
  ToolOutputStream,
  toolOutputStreamPath,
  TOOL_PREVIEW_CHARS,
} from './conversation-tool-details'
import {
  createConversationSkillsResolver,
  type ConversationSkillsResolver,
  type ResolvedConversationSkills,
} from './conversation-skills'
import { resolveConversationMentions } from './conversation-mentions'
import { ConversationCheckpoints } from './conversation-checkpoints'
import { ConversationIndex } from './conversation-index'
import type {
  ConversationWorkspaceKey,
  ConversationSearchInput,
  ConversationSearchHit,
  ConversationRenameInput,
} from '../shared/conversation-index'
import { presentToolItem } from '../shared/conversation/presentation'
import { applyPromptCacheEvent } from '../shared/prompt-cache'
import { ConversationApprovalRuleStore } from './conversation-approval-rules'
import { ConversationAttachmentStore } from './conversation-attachment-store'
import { ConversationPlanStore } from './conversation-plan-store'
import type { ApprovalRuleRequest } from '../shared/conversation/approvalRules'
import { getConversationProviderById } from './plugin-registry-instance'
import { ProviderSecretStore } from './secret-store'
import { clampSuspendIdleAfterMs, DEFAULT_SUSPEND_IDLE_AFTER_MS } from './terminal-reap-policy'
import type { TerminalRootInfo } from './workspace-memory'
import {
  type ConversationMessage,
  type ConversationProviderAdapter,
  type ConversationProviderCursor,
  type ConversationProviderEventStream,
} from './providers/conversation-provider-adapter'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import { createOpenAiCompatibleProvider } from './providers/openai-compatible-provider'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './providers/claude-agent-provider'
import { createCodexConversationProvider } from './providers/codex-conversation-provider'
import { ACP_PROFILES, createAcpConversationProvider } from './providers/acp-conversation-provider'
import { leadingCommandFor } from './conversation-commands/leading-command'
import { cliForConversationProvider } from '../shared/conversation-harness'
import { workspaceSidecarPath } from './workspace-sidecar'
import {
  ConversationEventLog,
  type ConversationAppendOutcome,
  type ConversationEventLogOptions,
} from './conversation-event-log'
import {
  ConversationTranscriptReader,
  DEFAULT_TRANSCRIPT_LIMITS,
  type ConversationTranscriptLimits,
  type TranscriptSyncResult,
} from './conversation-transcript-reader'

type RuntimeSession = ConversationSessionSummary & {
  // Spawned agents still running, by spawning tool call.
  runningSubagents: Map<string, ConversationSubagentStatusPayload>
  workspaceRoot: string
  fileScope: string
  activeTurnId: string | null
  pendingRequestId: string | null
  activeTurnAbort: AbortController | null
  canceledTurnIds: Set<string>
  // Completed turns only, in send order, so each new turn carries prior context.
  // A failed/interrupted turn is not recorded, so a retry re-sends cleanly.
  history: ConversationMessage[]
  // True when the provider adapter owns history/resume (sessions: 'stateful').
  // Stateful sessions never replay history and resolve approvals mid-turn.
  stateful: boolean
  // The requestId allocated at turn start. For stateful sessions it doubles as
  // the send lock while a turn is streaming; mid-turn approvals temporarily
  // override pendingRequestId with their own ids.
  turnLockRequestId: string | null
  // All approval request ids currently unresolved on a stateful turn (the
  // provider can hold several permission callbacks open at once).
  pendingApprovalRequestIds: Set<string>
  // Serializes continuation-channel events (post-`result` turns the provider
  // opens outside a sendTurn) so their persistence and broadcast stay ordered.
  continuationTail: Promise<void>
  checkpointTurnSeq: number | null
  checkpointCapture: Promise<void> | null
  checkpointCaptured: boolean
  checkpointNotice?: string
  checkpointNoticeSent?: boolean
  revertedNote?: string
  // Skills attached to a message that opened with a slash command. The CLI
  // runs that message as the command, so they wait here and go with the next
  // message that is not one, exactly once.
  pendingSkills?: ConversationSkillRef[]
  approvalRequests: Map<string, ApprovalRuleRequest>
  automaticApprovals: Map<string, string>
  cliRuntimes?: ConversationCliRuntimeOverrides
  permissionPreset?: ConversationPermissionPreset
  permissionChangeTail?: Promise<ConversationSessionActionResult>
  modelChangeTail?: Promise<ConversationSessionActionResult>
  allowedTools?: string[]
  // Detail files of tools still open in this session, closed when a turn ends.
  toolDetailPaths: Set<string>
  // The provider stream of the turn a send is running, once the provider has
  // been handed it; see ProviderTurn.
  providerTurn: ProviderTurn | null
}

/**
 * One provider stream: a send's, or a continuation the agent carried on with
 * by itself. Its events carry `streamTurnId`, the turn it was sent (or opened)
 * as, and count toward `turnId`: the same turn until a steer ends it where the
 * steered message lands and opens the next, after which the stream's
 * remaining events are that turn's. `finished` once the stream's own end has
 * been written; `ended` settles, through `settle`, when the stream closes.
 */
type ProviderTurn = {
  streamTurnId: string
  turnId: string
  finished: boolean
  continuation: boolean
  ended: Promise<ConversationSessionActionResult>
  settle: (result: ConversationSessionActionResult) => void
}

function openProviderTurn(turnId: string, continuation: boolean): ProviderTurn {
  let settle: (result: ConversationSessionActionResult) => void = () => undefined
  const ended = new Promise<ConversationSessionActionResult>((resolve) => (settle = resolve))
  return { streamTurnId: turnId, turnId, finished: false, continuation, ended, settle }
}

type ConversationRuntimeOptions = {
  approvalRules?: ConversationApprovalRuleStore
  attachmentStore?: ConversationAttachmentStore
  planStore?: ConversationPlanStore
  resolveSkills?: ConversationSkillsResolver
  adapters?: ConversationProviderAdapter[]
  secretStore?: Pick<ProviderSecretStore, 'getStatus'> & Partial<Pick<ProviderSecretStore, 'resolveSecret'>>
  getProviderById?: typeof getConversationProviderById
  stat?: typeof stat
  // How transcript lines reach disk; tests shorten the delta flush or stub the
  // stream. Defaults to one append stream per transcript file.
  eventLog?: ConversationEventLogOptions
  // Read budgets for transcripts; tests shrink them to exercise long chats.
  transcriptLimits?: Partial<ConversationTranscriptLimits>
  now?: () => number
  randomId?: () => string
  // Least time between two running previews of one tool's output; tests shorten it.
  toolPreviewIntervalMs?: number
  prepareStudioMcp?: (input: {
    workspaceRoot: string
    workspaceId: string
    agentId: string
  }) => Promise<{ ok: true } | { ok: false; message: string }>
}

type ConversationRuntimeListener = (event: ConversationEvent) => void
/** `lost`: highest sequence number published but not written; `recorded`: highest one on disk as such. */
type NonDurableLog = { root: string; lost: number; recorded: number; recording: boolean }
/** One running tool's preview cadence: when the last went out, what it showed, and the one waiting. */
type ToolPreviewThrottle = {
  session: RuntimeSession
  sentAt: number
  shown: string | null
  held: { event: ConversationEvent; options: EmitOptions } | null
  timer: NodeJS.Timeout | null
}
type EmitOptions = { turnId?: string; allowCanceledTurnId?: string | null; prepared?: boolean }

/**
 * A running tool's preview is a tail of up to {@link TOOL_PREVIEW_CHARS} of its
 * output, and every one that is published is also a transcript line, because
 * a client may hold its sequence number. At the log's own cadence a ten-minute
 * build left megabytes of near-identical previews, crowding a reconnecting
 * client out of its catch-up budget. The first preview goes out at once, then
 * at most one every this long, and only when it changed; the full output is in
 * the tool's detail file and its final event regardless.
 */
const DEFAULT_TOOL_PREVIEW_INTERVAL_MS = 5_000

const UNSAVED_NOTICE =
  'This conversation could not be saved to disk. It carries on here, but messages from now on may be missing after the app restarts.'

// Cap on how many persisted events a transcript replay returns to the
// renderer; the JSONL on disk keeps everything.
const MAX_TRANSCRIPT_REPLAY_EVENTS = 2000

// Same cadence as the terminal runtime's stale-terminal sweep: often enough
// that an idle child process does not outlive the threshold by much, rare
// enough to be free.
const IDLE_SWEEP_INTERVAL_MS = 3 * 60 * 1000

export class ConversationRuntime {
  private readonly adapters = new Map<string, ConversationProviderAdapter>()
  private readonly secretStore: Pick<ProviderSecretStore, 'getStatus'> &
    Partial<Pick<ProviderSecretStore, 'resolveSecret'>>
  private readonly getProviderById: typeof getConversationProviderById
  private readonly stat: typeof stat
  private readonly eventLog: ConversationEventLog
  private readonly threadIndex: ConversationIndex
  private readonly transcripts: ConversationTranscriptReader
  private readonly transcriptLimits: ConversationTranscriptLimits
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly prepareStudioMcp?: ConversationRuntimeOptions['prepareStudioMcp']
  private readonly resolveSkills: ConversationSkillsResolver
  private readonly checkpoints = new ConversationCheckpoints()
  private readonly approvalRules: ConversationApprovalRuleStore
  private readonly attachmentStore: ConversationAttachmentStore
  private readonly planStore: ConversationPlanStore
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly deletingTranscripts = new Set<string>()
  private readonly startingTranscripts = new Set<string>()
  private readonly revertingScopes = new Set<string>()
  // Transcripts being taken back to an earlier message; a send waits for it.
  private readonly rewindingTranscripts = new Set<string>()
  private readonly sequenceInitializations = new Map<string, Promise<void>>()
  private readonly listeners = new Set<ConversationRuntimeListener>()
  private readonly sequences = new Map<string, number>()
  // Housekeeping that must not delay the caller but must finish before shutdown.
  private readonly background = new Set<Promise<unknown>>()
  private readonly emissionTails = new Map<string, Promise<unknown>>()
  private readonly receipts = new Map<string, Promise<Map<string, ConversationSessionActionResult>>>()
  private readonly pendingCommands = new Map<string, Promise<ConversationSessionActionResult>>()
  private readonly receiptWrites = new Map<string, Promise<void>>()
  // Transcripts with a write that failed this run: a sequence number was
  // published that is not on disk, so they never serve incremental catch-up.
  // The highest such number is also recorded beside the transcript, so the
  // next run numbers above it rather than reusing numbers a client has seen.
  private readonly nonDurableLogs = new Map<string, NonDurableLog>()
  // Per tool detail path: the detail being built, its streamed output, and
  // the write in flight.
  private readonly toolDetails = new Map<string, ConversationToolDetail>()
  private readonly toolStreams = new Map<string, ToolOutputStream>()
  private readonly toolDetailWrites = new Map<string, Promise<void>>()
  private readonly toolPreviews = new Map<string, ToolPreviewThrottle>()
  private readonly toolPreviewIntervalMs: number
  private eventSequence = 0
  // Event ids must stay unique across app restarts: the persisted transcript
  // is replayed into the renderer, which dedupes live pushes against it by id.
  private readonly eventEpoch: string
  private idleThresholdMs = DEFAULT_SUSPEND_IDLE_AFTER_MS
  private idleSweepTimer: NodeJS.Timeout | null = null

  constructor(options: ConversationRuntimeOptions = {}) {
    this.secretStore = options.secretStore ?? new ProviderSecretStore()
    this.getProviderById = options.getProviderById ?? getConversationProviderById
    const defaultAdapters = [
      createMockConversationProvider(),
      createOpenAiCompatibleProvider({
        getProviderById: this.getProviderById,
        resolveSecret: (providerId) => this.resolveSecret(providerId),
      }),
      createClaudeAgentProvider(),
      createCodexConversationProvider(),
      ...ACP_PROFILES.map((profile) => createAcpConversationProvider(profile)),
    ]
    for (const adapter of options.adapters ?? defaultAdapters) {
      this.adapters.set(adapter.id, adapter)
    }
    this.stat = options.stat ?? stat
    this.eventLog = new ConversationEventLog({
      onError: (filePath, error) => {
        console.warn(
          `[conversation-runtime] transcript write failed for ${filePath}:`,
          error instanceof Error ? error.message : error,
        )
      },
      ...options.eventLog,
    })
    this.transcriptLimits = { ...DEFAULT_TRANSCRIPT_LIMITS, ...options.transcriptLimits }
    this.transcripts = new ConversationTranscriptReader(this.transcriptLimits)
    this.threadIndex = new ConversationIndex({
      flush: (path) => this.eventLog.flush(path),
      close: (path) => this.eventLog.close(path),
      maxTranscriptBytes: this.transcriptLimits.fullReadBytes,
    })
    this.now = options.now ?? Date.now
    this.toolPreviewIntervalMs = options.toolPreviewIntervalMs ?? DEFAULT_TOOL_PREVIEW_INTERVAL_MS
    this.randomId = options.randomId ?? (() => Math.random().toString(36).slice(2, 10))
    this.prepareStudioMcp = options.prepareStudioMcp
    this.resolveSkills = options.resolveSkills ?? createConversationSkillsResolver()
    this.approvalRules = options.approvalRules ?? new ConversationApprovalRuleStore()
    this.attachmentStore = options.attachmentStore ?? new ConversationAttachmentStore()
    this.planStore = options.planStore ?? new ConversationPlanStore()
    // Startup-time epoch (not randomId — tests inject deterministic id
    // sequences that must not be consumed by construction).
    this.eventEpoch = this.now().toString(36)
  }

  onEvent(listener: ConversationRuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getProviderCapabilities(providerId: string) {
    return this.getAdapterForProviderId(providerId)?.capabilities
  }
  getNativeProviderModels(providerId: string) {
    const adapter = this.getAdapterForProviderId(providerId)
    return adapter?.sessions === 'stateful'
      ? adapter.listModels().map((id) => ({ id, displayName: id === 'default' ? 'CLI default' : id }))
      : undefined
  }

  async startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
    if (!input.workspaceRoot?.trim() || !input.workspaceId?.trim() || !input.agentId?.trim())
      return { ok: false, message: 'Conversation identity is required.' }
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    // A rewind writes the marker the next start forks from; a start that read
    // the cursor before it would resume the whole session and undo the rewind.
    if (this.deletingTranscripts.has(path) || this.startingTranscripts.has(path) || this.rewindingTranscripts.has(path))
      return { ok: false, message: 'Conversation lifecycle operation is already in progress.' }
    this.startingTranscripts.add(path)
    try {
      return await this.startSessionNow(input)
    } finally {
      this.startingTranscripts.delete(path)
    }
  }

  private async startSessionNow(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
    const validation = await this.validateStartInput(input)
    if (!validation.ok) {
      return { ok: false, message: validation.message }
    }
    if (input.providerId === CLAUDE_AGENT_PROVIDER_ID && this.prepareStudioMcp) {
      const prepared = await this.prepareStudioMcp(input)
      if (!prepared.ok) return prepared
    }

    const sessionId = `conv_${this.randomId()}`
    const now = this.now()
    const stateful = validation.adapter.sessions === 'stateful'
    const fileScope = await this.checkpoints.fileScope(input.workspaceRoot)
    if (this.revertingScopes.has(fileScope)) return { ok: false, message: 'Workspace files are being reverted.' }
    const session: RuntimeSession = {
      sessionId,
      workspaceId: input.workspaceId.trim(),
      agentId: input.agentId.trim(),
      providerId: input.providerId.trim(),
      modelId: input.modelId.trim(),
      status: 'starting',
      phase: 'starting',
      displayName: validation.adapter.displayName ?? input.providerId,
      capabilities: validation.adapter.capabilities
        ? {
            ...validation.adapter.capabilities,
            checkpoints:
              validation.adapter.capabilities.tools && (await this.checkpoints.available(input.workspaceRoot)),
          }
        : undefined,
      createdAt: now,
      updatedAt: now,
      workspaceRoot: input.workspaceRoot,
      fileScope,
      activeTurnId: null,
      pendingRequestId: null,
      activeTurnAbort: null,
      canceledTurnIds: new Set(),
      history: [],
      stateful,
      turnLockRequestId: null,
      pendingApprovalRequestIds: new Set(),
      continuationTail: Promise.resolve(),
      checkpointTurnSeq: null,
      checkpointCapture: null,
      checkpointCaptured: false,
      approvalRequests: new Map(),
      automaticApprovals: new Map(),
      cliRuntimes: input.cliRuntimes,
      permissionPreset: input.permissionPreset,
      allowedTools: input.allowedTools,
      toolDetailPaths: new Set(),
      runningSubagents: new Map(),
      providerTurn: null,
    }
    await this.initializeSequence(input)
    // Excerpts and the replayed history come from the end of the chat, bounded
    // like a page: a model's context holds far less than a long transcript.
    const previousTranscript = await this.readTranscript(input, {
      all: true,
      closeOpenTurns: false,
      maxBytes: this.transcriptLimits.pageBytes,
    })
    if (previousTranscript.ok) {
      const first = await this.transcripts
        .findFirst(
          input.workspaceRoot,
          this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId),
          // The first message with words: an image-only opener names nothing.
          (event) =>
            event.type === 'user_message' &&
            typeof event.payload?.text === 'string' &&
            event.payload.text.trim().length > 0,
        )
        .catch(() => undefined)
      if (first) this.updateExcerpts(session, first)
      for (const event of previousTranscript.events) this.updateExcerpts(session, event)
      session.history = completedHistory(previousTranscript.events)
    }
    if (this.revertingScopes.has(fileScope)) return { ok: false, message: 'Workspace files are being reverted.' }
    this.sessions.set(sessionId, session)

    // Stateful providers resume their own durable session; the latest cursor
    // lives in the JSONL transcript this runtime already writes.
    const resume = stateful
      ? await this.readResumeCursor(session.workspaceRoot, session.workspaceId, session.agentId)
      : undefined
    try {
      await this.emitAll(
        session,
        validation.adapter.startSession({
          ...session,
          resumeSessionId: resume?.sessionId,
          ...(resume?.at ? { resumeSessionAt: resume.at } : {}),
          fallbackHistory: session.history,
          // Continuation channel: the adapter opens a mirror turn here when its
          // child resumes after a `result` (background subagents completing).
          onSessionEvent: (event) => this.enqueueContinuationEvent(session, event),
          onBeforeTool: (name) => this.captureBeforeTool(session, name),
        }),
      )
      // Agents the transcript left running belonged to a process that is gone.
      for (const agent of Array.from(session.runningSubagents.values()))
        await this.emit(
          session,
          this.eventForSession(session, 'subagent_status', {
            ...agent,
            status: 'stopped',
            error: 'The agent stopped when the conversation closed.',
          }),
          {},
        )
      session.status = 'ready'
      session.phase = 'idle'
      session.updatedAt = this.now()
      return { ok: true, session: this.toSummary(session) }
    } catch (error) {
      this.sessions.delete(sessionId)
      validation.adapter.disposeChildProcess?.(sessionId)
      return { ok: false, message: error instanceof Error ? error.message : 'Conversation could not start.' }
    }
  }

  async sendTurn(
    input: ConversationSendTurnInput & { sourceCommandId?: string },
  ): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(input.sessionId, input.commandId, () =>
        this.sendTurn({ ...input, sourceCommandId: input.commandId, commandId: undefined }),
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    if (this.revertingScopes.has(session.fileScope))
      return { ok: false, message: 'Workspace files are being reverted.' }
    if (this.deletingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)))
      return { ok: false, message: 'Conversation is being deleted.' }
    if (this.rewindingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)))
      return { ok: false, message: 'Conversation is going back to an earlier message.' }
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    if (isSessionBusy(session) && !input.steer) {
      return {
        ok: false,
        message: session.pendingRequestId
          ? 'Conversation turn is awaiting approval.'
          : 'Conversation turn is already in progress.',
      }
    }
    const message = input.message.trim()
    const attachments = input.attachments ?? []
    // A turn needs some payload: either text or at least one image attachment.
    if (!message && attachments.length === 0 && !input.mentions?.length && !input.skills?.length)
      return { ok: false, message: 'Conversation turn message is required.' }

    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }
    const steerRefused = isSessionBusy(session) ? steerRefusal(session, adapter) : null
    if (steerRefused) return { ok: false, message: steerRefused }

    if (input.mode === 'plan' && !session.capabilities?.planMode)
      return { ok: false, message: 'This provider does not support plan mode.' }

    // A message that opens with a slash command is run by the CLI, which reads
    // everything after the name as its arguments: skill text would push the
    // command into prose ahead of it or into its arguments after it. So that
    // turn goes without its skills, and they wait on the session for the next
    // message that is not a command. Only a stateful provider is a CLI that
    // runs commands; any other takes `/word` as prose, and its skills ride as a
    // system message beside the text rather than in it.
    const opensWithCommand =
      session.stateful &&
      leadingCommandFor(message, {
        cli: cliForConversationProvider(session.providerId),
        cwd: session.workspaceRoot,
      }) !== null
    const turnSkills = opensWithCommand ? [] : [...(session.pendingSkills ?? []), ...(input.skills ?? [])]
    let skills: ResolvedConversationSkills
    let mentions: Awaited<ReturnType<typeof resolveConversationMentions>>
    try {
      skills = await this.resolveSkills({
        workspaceRoot: session.workspaceRoot,
        skills: turnSkills,
        mode: adapter.capabilities?.skills ?? 'none',
      })
      mentions = await resolveConversationMentions({
        workspaceRoot: session.workspaceRoot,
        mentions: input.mentions ?? [],
        atMentions: session.capabilities?.atMentions === true,
        tools: session.capabilities?.tools === true,
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Attached skills could not be loaded.' }
    }
    // Resolving a skill may await disk or installation; another send can take
    // the session while that happens, so acquire the turn only after rechecking.
    if (
      this.sessions.get(input.sessionId)?.status === 'stopped' ||
      this.sessions.get(input.sessionId) !== session ||
      this.revertingScopes.has(session.fileScope) ||
      this.deletingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)) ||
      this.rewindingTranscripts.has(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId))
    )
      return { ok: false, message: 'Conversation is no longer available.' }
    // A steer is sent only over a turn that is still open; a send made as a
    // steer over a turn that has since ended is an ordinary send.
    if (isSessionBusy(session) && !input.steer)
      return { ok: false, message: 'Conversation turn is already in progress.' }
    // The resolver keeps one of each skill, so a skill attached again is sent once.
    if (opensWithCommand) {
      if (input.skills?.length) session.pendingSkills = [...(session.pendingSkills ?? []), ...input.skills]
    } else session.pendingSkills = undefined
    // What the provider is handed: stateful providers own their history, so
    // they get the message with the skill context it needs; others get the
    // history below as well. A command turn goes without the reverted-files
    // note for the reason above; the note stays with the session and rides
    // every later turn.
    const providerMessage = [
      session.stateful && !opensWithCommand ? skills.context : undefined,
      opensWithCommand ? undefined : session.revertedNote,
      message,
      mentions.context,
    ]
      .filter(Boolean)
      .join('\n\n')
    if (input.steer && isSessionBusy(session))
      return this.steerRunningTurn(session, adapter, {
        message,
        providerMessage,
        attachments,
        localTurnId: input.localTurnId,
        sourceCommandId: input.sourceCommandId,
        skillIds: skills.ids,
        mentionRefs: mentions.refs,
      })

    const turnId = `turn_${this.randomId()}`
    const requestId = `approval_${this.randomId()}`
    const turnAbort = new AbortController()
    session.activeTurnId = turnId
    session.pendingRequestId = requestId
    session.turnLockRequestId = requestId
    session.activeTurnAbort = turnAbort
    session.status = 'active'
    session.phase = 'running'
    session.updatedAt = this.now()
    session.checkpointTurnSeq = null
    session.checkpointCapture = null
    session.checkpointCaptured = false
    const providerTurn = openProviderTurn(turnId, false)
    const result = await (async (): Promise<ConversationSessionActionResult> => {
      // Persist the user's side of the exchange so the JSONL transcript replays
      // as a complete conversation after a restart.
      try {
        const storedAttachments = await this.saveAttachments(session, attachments)
        await this.emit(
          session,
          this.eventForSession(session, 'user_message', {
            turnId,
            text: message,
            ...(storedAttachments.length ? { attachments: storedAttachments } : {}),
            ...(input.localTurnId ? { localTurnId: input.localTurnId } : {}),
            ...(input.sourceCommandId ? { commandId: input.sourceCommandId } : {}),
            ...(skills.ids.length ? { skills: skills.ids } : {}),
            ...(mentions.refs.length ? { mentions: mentions.refs } : {}),
          }),
          { turnId },
        )
        // The model sees prior completed turns plus this message, so it has memory.
        // Stateful providers own their history natively — replaying ours would
        // duplicate context and defeat resume, so they get only the new message.
        const messages: ConversationMessage[] | undefined = session.stateful
          ? undefined
          : [
              ...(skills.context ? [{ role: 'system' as const, content: skills.context }] : []),
              ...(session.revertedNote ? [{ role: 'system' as const, content: session.revertedNote }] : []),
              ...session.history,
              { role: 'user', content: [message, mentions.context].filter(Boolean).join('\n\n') },
            ]
        // From here a steer can join this turn: the provider is being handed it.
        if (session.activeTurnId === turnId) session.providerTurn = providerTurn
        // Attachments are carried live into the turn call; only vision-capable
        // adapters read them. The model's history stays text-only: a later turn
        // does not re-send earlier images, and the transcript keeps references
        // for the bubbles, not the bytes.
        const events = await this.emitAll(
          session,
          adapter.sendTurn({
            ...session,
            turnId,
            requestId,
            message: providerMessage,
            skills: skills.ids,
            reasoningEffort: input.reasoningEffort,
            mode: input.mode,
            ...(attachments.length > 0 ? { attachments } : {}),
            messages,
            signal: turnAbort.signal,
          }),
          { turnId },
        )
        // A steer may have moved the stream on to a later turn; the stream's
        // end is that turn's.
        const ownTurnId = providerTurn.turnId
        const currentSession = this.sessions.get(input.sessionId)
        if (
          currentSession &&
          currentSession.status !== 'stopped' &&
          currentSession.activeTurnId === ownTurnId &&
          !currentSession.canceledTurnIds.has(ownTurnId)
        ) {
          this.applyTurnState(currentSession, events, requestId)
          currentSession.activeTurnAbort = null
          // Record only a cleanly completed turn (no failure) into history, so a
          // failed turn leaves history untouched and a retry re-sends without
          // duplicating the user message. Stateful providers keep their own.
          const completed =
            !currentSession.stateful &&
            events.some((event) => event.type === 'turn_completed') &&
            !events.some((event) => event.type === 'turn_failed')
          if (completed) {
            currentSession.history.push({ role: 'user', content: message })
            const assistantText = events
              .filter((event) => event.type === 'content_delta')
              .map((event) => (typeof event.payload?.text === 'string' ? event.payload.text : ''))
              .join('')
            if (assistantText) currentSession.history.push({ role: 'assistant', content: assistantText })
          }
        }
        return { ok: true, session: this.toSummary(currentSession ?? session) }
      } catch (error) {
        return this.failTurn(session, error)
      }
    })()
    if (session.providerTurn === providerTurn) session.providerTurn = null
    providerTurn.settle(result)
    return result
  }

  /**
   * Hand a message to the turn that is running (a steer), where the provider
   * takes one. The provider keeps the one stream it is running; no second
   * turn is started there. Here the running turn ends where the message
   * lands — its reply so far stays above the message — and the message opens
   * the next turn, which every event of that stream counts toward from then
   * on: the rest of the reply, tool results, approvals and the stream's own
   * end with its cost. The handover runs in the transcript's emission order,
   * so each event the stream produced before it is the old turn's and each
   * one after it the new turn's, an approval card included. Settles when the
   * stream does, as the send it continues does.
   */
  private async steerRunningTurn(
    session: RuntimeSession,
    adapter: ConversationProviderAdapter,
    input: {
      message: string
      providerMessage: string
      attachments: ConversationImageAttachment[]
      localTurnId?: string
      sourceCommandId?: string
      skillIds: string[]
      mentionRefs: Awaited<ReturnType<typeof resolveConversationMentions>>['refs']
    },
  ): Promise<ConversationSessionActionResult> {
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    const turnId = `turn_${this.randomId()}`
    // What the agent carried on with has already said goes out ahead of the
    // steer, not under the turn it opens. Waited on before joining the
    // emission queue: those events are written through it.
    await session.continuationTail.catch(() => undefined)
    const handover = (this.emissionTails.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async (): Promise<ProviderTurn | string> => {
        const refused =
          session.status === 'stopped' || this.sessions.get(session.sessionId) !== session
            ? 'Conversation is no longer available.'
            : steerRefusal(session, adapter)
        if (refused) return refused
        const running = session.providerTurn!
        const delivered = await adapter.steer!({
          ...session,
          turnId: running.streamTurnId,
          message: input.providerMessage,
          ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        })
        if (!delivered.ok) return delivered.message
        const storedAttachments = await this.saveAttachments(session, input.attachments)
        // The work since the running turn's first file change is one change,
        // under that turn's number; a turn with none yet takes the new one.
        const checkpointTurnSeq = session.checkpointCapture ? session.checkpointTurnSeq : null
        await this.emitNow(
          session,
          this.eventForSession(session, 'turn_completed', {
            turnId: running.turnId,
            steered: true,
            ...(delivered.providerCursor ? { providerCursor: delivered.providerCursor } : {}),
          }),
          { turnId: running.turnId },
        )
        running.turnId = turnId
        session.activeTurnId = turnId
        session.updatedAt = this.now()
        await this.emitNow(
          session,
          this.eventForSession(session, 'user_message', {
            turnId,
            text: input.message,
            ...(storedAttachments.length ? { attachments: storedAttachments } : {}),
            ...(input.localTurnId ? { localTurnId: input.localTurnId } : {}),
            ...(input.sourceCommandId ? { commandId: input.sourceCommandId } : {}),
            ...(input.skillIds.length ? { skills: input.skillIds } : {}),
            ...(input.mentionRefs.length ? { mentions: input.mentionRefs } : {}),
          }),
          { turnId },
        )
        await this.emitNow(session, this.eventForSession(session, 'turn_started', { turnId }), { turnId })
        if (checkpointTurnSeq !== null) session.checkpointTurnSeq = checkpointTurnSeq
        return running
      })
    this.emissionTails.set(path, handover)
    let outcome: ProviderTurn | string
    try {
      outcome = await handover
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The message could not be delivered.' }
    }
    if (typeof outcome === 'string') return { ok: false, message: outcome }
    return outcome.ended
  }

  // Keep a turn's attached images in the attachment store; the event names
  // them by reference. One that cannot be kept costs its thumbnail after a
  // restart, never the turn.
  private saveAttachments(session: RuntimeSession, attachments: ConversationImageAttachment[]) {
    return this.attachmentStore.save(session, attachments).catch((error: unknown) => {
      console.warn(
        '[conversation-runtime] attached images were not kept:',
        error instanceof Error ? error.message : error,
      )
      return []
    })
  }

  private async failTurn(session: RuntimeSession, error: unknown): Promise<ConversationSessionActionResult> {
    const turnId = session.activeTurnId
    session.activeTurnAbort?.abort()
    this.closeContinuation(session)
    session.activeTurnId = null
    session.pendingRequestId = null
    session.turnLockRequestId = null
    session.pendingApprovalRequestIds.clear()
    session.activeTurnAbort = null
    session.status = 'failed'
    session.phase = 'failed'
    session.updatedAt = this.now()
    const message = error instanceof Error ? error.message : 'Conversation turn failed.'
    const event = this.eventForSession(session, 'turn_failed', { turnId, reason: 'runtime', message })
    try {
      const stamped = await this.emit(session, event, { allowCanceledTurnId: turnId })
      if (stamped) return { ok: false, message, event: stamped }
    } catch {
      // The transcript could not take it. Subscribers drop an event with no
      // sequence number, so it gets the next one; the log can no longer vouch
      // for its numbering, which sends its reconnects to a full snapshot.
      const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
      event.id = `conv_evt_${this.eventEpoch}_${++this.eventSequence}`
      event.seq = (this.sequences.get(path) ?? 0) + 1
      event.createdAt = this.now()
      this.sequences.set(path, event.seq)
      this.markNonDurable(session.workspaceRoot, path, event.seq)
      this.notify(event)
    }
    return { ok: false, message, event }
  }

  /**
   * Hand a persisted event to listeners. A superseded tool preview is not
   * published at all; the one that replaced it follows. A failed write is
   * still published — the live chat must not stall on a broken disk — but the
   * log can no longer vouch for its sequence numbers, so catch-up on it falls
   * back to a full snapshot until the process restarts.
   */
  private publish(root: string, path: string, event: ConversationEvent, outcome: ConversationAppendOutcome): void {
    if (outcome === 'superseded') return
    if (outcome === 'failed') {
      // The first loss of the run is said once, on the event that was lost, so
      // the person knows before a restart shows a gap.
      if (!this.nonDurableLogs.has(path)) event = { ...event, payload: { ...event.payload, notice: UNSAVED_NOTICE } }
      this.markNonDurable(root, path, event.seq ?? 0)
    }
    // The disk took a write again: record a lost number the first attempt could not.
    else if (this.nonDurableLogs.has(path)) this.recordLostSequence(path)
    this.notify(event)
  }

  private markNonDurable(root: string, path: string, seq: number): void {
    const log = this.nonDurableLogs.get(path) ?? { root, lost: 0, recorded: 0, recording: false }
    log.lost = Math.max(log.lost, seq)
    this.nonDurableLogs.set(path, log)
    this.recordLostSequence(path)
  }

  /**
   * Keep the highest published-but-unwritten sequence number on disk. Without
   * it a restart would resume numbering from the end of the file, reissue
   * numbers a client already holds under the same log generation, and that
   * client's catch-up would skip the new events carrying them.
   */
  private recordLostSequence(path: string): void {
    const log = this.nonDurableLogs.get(path)
    if (!log || log.recording || log.recorded >= log.lost) return
    log.recording = true
    const target = log.lost
    this.runInBackground(
      writeConversationStorage(log.root, lostSequencePath(path), JSON.stringify({ seq: target })).then(
        () => {
          log.recording = false
          log.recorded = Math.max(log.recorded, target)
          this.recordLostSequence(path)
        },
        () => {
          // Still failing: the next successful append or failure tries again.
          log.recording = false
        },
      ),
    )
  }

  private async readLostSequence(root: string, path: string): Promise<number> {
    try {
      const seq = JSON.parse((await readConversationStorage(root, lostSequencePath(path), 1024)).toString('utf8'))?.seq
      return Number.isSafeInteger(seq) && seq > 0 ? seq : 0
    } catch {
      return 0
    }
  }

  private notify(event: ConversationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        this.listeners.delete(listener)
      }
    }
  }

  async respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(input.sessionId, input.commandId, () =>
        this.respondToRequest({ ...input, commandId: undefined }),
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    const requestIsPending =
      session.pendingRequestId === input.requestId || session.pendingApprovalRequestIds.has(input.requestId)
    if (!session.activeTurnId || !requestIsPending) {
      return { ok: false, message: 'Conversation approval request is invalid.' }
    }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    if (input.approved && (input.decision === 'conversation' || input.decision === 'always')) {
      const request = session.approvalRequests.get(input.requestId)
      if (!request || (request.requestKind && request.requestKind !== 'tool'))
        return { ok: false, message: 'This request can only be allowed once.' }
      try {
        await this.approvalRules.remember(session.workspaceRoot, session.sessionId, request, input.decision)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Permission rule could not be saved.' }
      }
    }

    await this.emitAll(
      session,
      adapter.resolveApproval({
        ...session,
        turnId: session.activeTurnId,
        requestId: input.requestId,
        approved: input.decision === 'deny' ? false : input.approved,
        answers: input.answers,
      }),
    )
    if (session.stateful) {
      // The turn is still streaming inside the adapter (the approval resolved
      // a mid-turn permission callback); restore the turn lock and let the
      // in-flight sendTurn stream carry the resolution + remaining events.
      // Other requests still open keep the session waiting on them.
      // This request counts as answered even before the adapter's stream
      // carries its resolution.
      const remaining = Array.from(session.pendingApprovalRequestIds).filter((id) => id !== input.requestId)
      session.pendingRequestId = remaining.at(-1) ?? session.turnLockRequestId
      session.status = remaining.length > 0 ? 'awaiting_approval' : 'active'
      session.updatedAt = this.now()
      return { ok: true, session: this.toSummary(session) }
    }
    session.activeTurnId = null
    session.pendingRequestId = null
    session.status = input.approved ? 'ready' : 'failed'
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session) }
  }

  // Change tool-permission behavior on a session that is already running. The
  // adapter applies it to its live provider session (taking effect on the next
  // tool call) and only then does the session record the new preset, so a
  // provider that refuses the change never leaves a preset it is not honoring.
  // An adapter that accepted the preset but cannot apply it to the turn already
  // running returns a `notice` — the change is recorded, and the sentence says
  // plainly when it starts applying.
  async setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(input.sessionId, input.commandId, () =>
        this.setPermission({ ...input, commandId: undefined }),
      )
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    const pending = (session.permissionChangeTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.applyPermission(session, input))
    session.permissionChangeTail = pending
    return pending
  }

  private async applyPermission(
    session: RuntimeSession,
    input: ConversationSetPermissionInput,
  ): Promise<ConversationSessionActionResult> {
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }
    if (!adapter.setPermissionPreset) {
      return { ok: false, message: 'This conversation provider cannot change tool permissions mid-conversation.' }
    }
    const applied = await adapter.setPermissionPreset({ ...session, permissionPreset: input.permissionPreset })
    if (!applied.ok) return { ok: false, message: applied.message }
    session.permissionPreset = input.permissionPreset
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session), ...(applied.notice ? { notice: applied.notice } : {}) }
  }

  // Switch a running conversation to another model of the same provider. The
  // adapter records it (and pushes it into a live provider session where it
  // can); only then does the session take it, and a `session_updated` event
  // carrying the new model is written so the transcript, the thread index, a
  // resume and a remote list all name the model the conversation is now on.
  // Gated on the adapter declaring `liveModelSwitch`, never on its id.
  async setModel(input: ConversationSetModelInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(input.sessionId, input.commandId, () => this.setModel({ ...input, commandId: undefined }))
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    const pending = (session.modelChangeTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.applyModel(session, input))
    session.modelChangeTail = pending
    return pending
  }

  private async applyModel(
    session: RuntimeSession,
    input: ConversationSetModelInput,
  ): Promise<ConversationSessionActionResult> {
    const modelId = input.modelId.trim()
    if (!modelId) return { ok: false, message: 'Conversation model is invalid.' }
    if (session.status === 'stopped') return { ok: false, message: 'Conversation session is stopped.' }
    if (modelId === session.modelId) return { ok: true, session: this.toSummary(session) }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }
    if (!adapter.setModel || session.capabilities?.liveModelSwitch !== true) {
      return { ok: false, message: 'This conversation provider cannot change models mid-conversation.' }
    }
    const applied = await adapter.setModel({ ...session, nextModelId: modelId })
    if (!applied.ok) return { ok: false, message: applied.message }
    session.modelId = modelId
    session.updatedAt = this.now()
    await this.emit(session, this.eventForSession(session, 'session_updated', { modelId }))
    return { ok: true, session: this.toSummary(session), ...(applied.notice ? { notice: applied.notice } : {}) }
  }

  async interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult> {
    if (input.commandId)
      return this.runCommand(input.sessionId, input.commandId, () => this.interrupt({ ...input, commandId: undefined }))
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    if (!session.activeTurnId) return { ok: false, message: 'Conversation session has no active turn.' }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    const turnId = session.activeTurnId
    if (turnId) this.cancelActiveTurn(session)
    const events = await this.emitAll(session, adapter.interrupt(session), { allowCanceledTurnId: turnId })
    if (!events.some((event) => event.type === 'turn_failed' || event.type === 'turn_completed'))
      await this.emit(
        session,
        this.eventForSession(session, 'turn_failed', {
          turnId,
          reason: 'interrupted',
          message: 'Conversation interrupted.',
        }),
        { allowCanceledTurnId: turnId },
      )
    session.activeTurnId = null
    session.pendingRequestId = null
    session.turnLockRequestId = null
    session.pendingApprovalRequestIds.clear()
    session.activeTurnAbort = null
    session.status = 'ready'
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session) }
  }

  async stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    const adapter = this.getAdapterForProviderId(session.providerId)
    if (!adapter) return { ok: false, message: 'Conversation provider is unavailable.' }

    const turnId = session.activeTurnId
    if (turnId) {
      this.cancelActiveTurn(session)
      await this.emit(
        session,
        this.eventForSession(session, 'turn_failed', {
          turnId,
          reason: 'interrupted',
          message: 'Conversation stopped.',
        }),
        { allowCanceledTurnId: turnId },
      )
    }
    await this.emitAll(session, adapter.stopSession(session), { allowCanceledTurnId: turnId })
    await this.eventLog.close(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId))
    await this.closeToolStreams(session)
    session.activeTurnId = null
    session.pendingRequestId = null
    session.turnLockRequestId = null
    session.pendingApprovalRequestIds.clear()
    session.activeTurnAbort = null
    session.status = 'stopped'
    this.approvalRules.dropSession(session.sessionId)
    session.approvalRequests.clear()
    session.automaticApprovals.clear()
    session.updatedAt = this.now()
    return { ok: true, session: this.toSummary(session) }
  }

  // Settle and Snooze: whatever the session is doing ends now. A running turn
  // is interrupted and the child process disposed, as the idle sweep does, so
  // the session and its resume cursor stay and the next message respawns the
  // child. Not `stopSession`: a stopped session refuses every later turn, and
  // a settled chat can be un-settled and typed into.
  async suspendSession(input: ConversationSuspendSessionInput): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return { ok: false, message: 'Conversation session is invalid.' }
    if (session.status === 'stopped') return { ok: true, session: this.toSummary(session) }
    if (session.activeTurnId) {
      const interrupted = await this.interrupt({ sessionId: session.sessionId })
      if (!interrupted.ok) return interrupted
    }
    // A session still starting has no child to dispose yet; the idle sweep
    // reaches it once it is ready.
    if (session.status === 'ready' || session.status === 'failed')
      this.getAdapterForProviderId(session.providerId)?.disposeChildProcess?.(session.sessionId)
    void this.eventLog.close(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId))
    return { ok: true, session: this.toSummary(session) }
  }

  listSessions(input: ConversationListSessionsInput = {}): ConversationListSessionsResult {
    const sessions = Array.from(this.sessions.values())
      .filter((session) => !input.workspaceId || session.workspaceId === input.workspaceId)
      .filter((session) => !input.agentId || session.agentId === input.agentId)
      .map((session) => this.toSummary(session))
    return { ok: true, sessions }
  }

  // ── Lifecycle parity (idle disposal, quit disposal, process inventory) ────

  setIdleThresholdMs(value: unknown): void {
    this.idleThresholdMs = clampSuspendIdleAfterMs(value)
  }

  startIdleSweep(): void {
    if (this.idleSweepTimer) return
    this.idleSweepTimer = setInterval(() => {
      this.sweepIdleSessions()
    }, IDLE_SWEEP_INTERVAL_MS)
    this.idleSweepTimer.unref?.()
  }

  stopIdleSweep(): void {
    if (!this.idleSweepTimer) return
    clearInterval(this.idleSweepTimer)
    this.idleSweepTimer = null
  }

  // Dispose the child process of every idle stateful session, keeping the
  // session (and its resume cursor) so the next turn transparently respawns.
  // Never disposes mid-turn or while an approval/question card is pending.
  sweepIdleSessions(now: number = this.now()): string[] {
    const disposed: string[] = []
    for (const session of this.sessions.values()) {
      if (isSessionBusy(session)) continue
      if (now - session.updatedAt < this.idleThresholdMs) continue
      // An idle chat does not hold a file handle open for the rest of the run;
      // its next event reopens the stream.
      void this.eventLog.close(this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId))
      if (!session.stateful) continue
      if (session.status !== 'ready' && session.status !== 'failed') continue
      const adapter = this.getAdapterForProviderId(session.providerId)
      if (adapter?.disposeChildProcess?.(session.sessionId)) disposed.push(session.sessionId)
    }
    return disposed
  }

  // Live child processes across all adapters, shaped like terminal roots so
  // workspace-memory attribution and the process tree can consume them as-is.
  listLiveConversationRoots(): TerminalRootInfo[] {
    const roots: TerminalRootInfo[] = []
    for (const adapter of this.adapters.values()) {
      for (const live of adapter.listLiveSessions?.() ?? []) {
        if (!live.childPid) continue
        roots.push({
          sessionId: live.sessionId,
          rootPid: live.childPid,
          workspaceId: live.workspaceId || null,
          agentId: live.agentId || null,
          terminalId: null,
          kind: 'agent',
          cli: 'claude-code',
          activityKind: live.turnActive ? 'working' : 'idle',
          processAlive: true,
          startedAt: live.spawnedAt ?? live.lastActivityAt,
        })
      }
    }
    return roots
  }

  // App-quit disposal: stop every live session so no headless child outlives
  // the app. Sessions keep their resume cursors in the JSONL transcripts.
  /**
   * Put every chat's buffered transcript on disk without stopping anything.
   * The first thing quit does for chats: the streamed text is what a person
   * would miss, and stopping each session (the rest of `shutdown`) can take
   * longer than a quit that is being cut short allows.
   */
  async flushTranscripts(): Promise<void> {
    await this.eventLog.flush()
  }

  async shutdown(): Promise<void> {
    this.stopIdleSweep()
    for (const session of Array.from(this.sessions.values())) {
      if (session.status === 'stopped') continue
      try {
        await this.stopSession({ sessionId: session.sessionId })
      } catch {
        // Best-effort: adapter disposeAll below is the backstop.
      }
    }
    await Promise.allSettled(Array.from(this.adapters.values(), async (adapter) => adapter.disposeAll?.()))
    this.dropToolPreviews()
    // Housekeeping can queue more of itself as it settles (a lost sequence
    // number recorded again after a newer one), so drain until none is left.
    while (this.background.size) await Promise.allSettled(this.background)
    await this.eventLog.closeAll()
    // The last writes can fail as they flush, and record their loss.
    while (this.background.size) await Promise.allSettled(this.background)
  }

  private runInBackground(task: Promise<unknown>): void {
    const tracked = task.catch(() => undefined).finally(() => this.background.delete(tracked))
    this.background.add(tracked)
  }

  private async validateStartInput(
    input: ConversationStartSessionInput,
  ): Promise<{ ok: true; adapter: ConversationProviderAdapter } | { ok: false; message: string }> {
    if (!input.workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
    try {
      const stats = await this.stat(input.workspaceRoot)
      if (!stats.isDirectory()) return { ok: false, message: 'Workspace path is unavailable.' }
    } catch {
      return { ok: false, message: 'Workspace path is unavailable.' }
    }

    const providerId = input.providerId.trim()
    const registryProvider = this.getProviderById(providerId)
    const adapter = this.getAdapterForProviderId(providerId)
    if (!adapter && !registryProvider) return { ok: false, message: 'Conversation provider is not installed.' }

    if (registryProvider?.adapter.execution === 'blocked') {
      return {
        ok: false,
        message: registryProvider.adapter.trustError ?? 'Conversation provider adapter is not trusted for execution.',
      }
    }

    // Providers with a live catalog (e.g. OpenRouter) accept any model id from
    // their `/models` endpoint, which is not in the static seed list — so only
    // enforce seed membership for static-only providers. Agent-harness
    // providers ride a local CLI whose model vocabulary (aliases like
    // 'opus[1m]', full model ids, custom ids) is far wider than the manifest
    // seed, so the CLI is the validator there too. A truly invalid model is
    // surfaced by the provider as a `turn_failed` model error at call time.
    const supportsDynamicModels =
      Boolean(registryProvider?.manifest.openaiCompatible?.modelsPath) ||
      registryProvider?.manifest.providerType === 'agent-harness'
    if (!input.modelId.trim()) return { ok: false, message: 'Conversation model is invalid.' }
    if (!supportsDynamicModels) {
      const models = registryProvider?.manifest.models.map((model) => model.id) ?? adapter?.listModels() ?? []
      if (!models.includes(input.modelId.trim())) return { ok: false, message: 'Conversation model is invalid.' }
    }

    if (registryProvider?.manifest.auth) {
      const secretStatus = await this.secretStore.getStatus(providerId)
      if (!secretStatus.ok) return { ok: false, message: secretStatus.message }
      if (!secretStatus.status.configured)
        return { ok: false, message: 'Conversation provider secret is not configured.' }
    }

    if (!adapter) return { ok: false, message: 'Conversation provider adapter is unavailable.' }

    return { ok: true, adapter }
  }

  private getAdapterForProviderId(providerId: string): ConversationProviderAdapter | undefined {
    const direct = this.adapters.get(providerId)
    if (direct) return direct
    const provider = this.getProviderById(providerId)
    if (provider?.manifest.openaiCompatible) return this.adapters.get('openai-compatible-api')
    return undefined
  }

  private async resolveSecret(
    providerId: string,
  ): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
    if (!this.secretStore.resolveSecret) {
      return { ok: false, message: 'Conversation provider secret resolver is unavailable.' }
    }
    return this.secretStore.resolveSecret(providerId)
  }

  private cancelActiveTurn(session: RuntimeSession): void {
    const turnId = session.activeTurnId
    if (!turnId) return
    session.canceledTurnIds.add(turnId)
    session.activeTurnAbort?.abort()
    // A send's stream settles when the send returns; a continuation's has no
    // send to return, and its adapter may end it without another event.
    this.closeContinuation(session)
  }

  private closeContinuation(session: RuntimeSession): void {
    const running = session.providerTurn
    if (!running?.continuation) return
    session.providerTurn = null
    running.settle({ ok: true, session: this.toSummary(session) })
  }

  private async emitAll(
    session: RuntimeSession,
    events: ConversationProviderEventStream,
    options: { turnId?: string; allowCanceledTurnId?: string | null } = {},
  ): Promise<ConversationEvent[]> {
    const emitted: ConversationEvent[] = []
    const resolved = await events
    if (isAsyncIterable(resolved)) {
      for await (const event of resolved) {
        const stamped = await this.emit(session, event, options)
        if (stamped) emitted.push(stamped)
      }
      return emitted
    }
    for (const event of resolved) {
      const stamped = await this.emit(session, event, options)
      if (stamped) emitted.push(stamped)
    }
    return emitted
  }

  private async emit(
    session: RuntimeSession,
    event: ConversationEvent,
    options: EmitOptions = {},
  ): Promise<ConversationEvent | null> {
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    const result = (this.emissionTails.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.emitNow(session, event, options))
    this.emissionTails.set(path, result)
    return result
  }

  private async emitNow(
    session: RuntimeSession,
    event: ConversationEvent,
    options: EmitOptions,
  ): Promise<ConversationEvent | null> {
    // A provider stream a steer moved on: what it still sends as the turn it
    // was sent for is the turn the steer opened.
    const moved = session.providerTurn
    if (moved && moved.turnId !== moved.streamTurnId) {
      const payloadTurnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : undefined
      if ((payloadTurnId ?? options.turnId) === moved.streamTurnId) {
        if (payloadTurnId) event = { ...event, payload: { ...event.payload, turnId: moved.turnId } }
        options = { ...options, turnId: moved.turnId }
      }
    }
    if (this.shouldSuppressEvent(session, event, options)) return null
    // A turn a steer ended goes on as the next one: its tools keep running, its
    // cards stay open, and nothing is settled until the stream really ends.
    const steered = event.type === 'turn_completed' && event.payload?.steered === true
    const ends = (event.type === 'turn_completed' || event.type === 'turn_failed') && !steered
    const eventTurnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : options.turnId
    if (ends && session.providerTurn && eventTurnId === session.providerTurn.turnId)
      session.providerTurn.finished = true
    // A preview still waiting when its turn ends is the newest output of a
    // tool that never sent a final one: it goes out ahead of the turn's end.
    if (ends) await this.flushToolPreviews(session)
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    // Preparing stores the output in the tool's detail file, so it happens for
    // every event, including a preview that is then held back.
    const prepared = options.prepared ? event : await this.prepareToolEvent(session, event)
    if (!options.prepared && this.holdToolPreview(session, prepared, options)) return null
    const stamped: ConversationEvent = {
      ...prepared,
      id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
      seq: (this.sequences.get(path) ?? 0) + 1,
      createdAt: this.now(),
    }
    this.sequences.set(path, stamped.seq!)
    if (stamped.type === 'user_message' || (stamped.type === 'turn_started' && session.checkpointTurnSeq === null))
      session.checkpointTurnSeq = stamped.seq!
    if (stamped.type === 'tool_started')
      await this.captureBeforeTool(session, String(stamped.payload?.name ?? stamped.payload?.tool ?? ''))
    if (ends && session.checkpointCaptured && session.checkpointTurnSeq) {
      const checkpoint = await this.checkpoints.capture(session, session.checkpointTurnSeq, 'post')
      stamped.payload = {
        ...stamped.payload,
        checkpointTurnSeq: session.checkpointTurnSeq,
        checkpointAvailable: checkpoint.ok,
      }
      if (checkpoint.ok) {
        const diff = await this.checkpoints.getTurnDiff({ key: session, turnSeq: session.checkpointTurnSeq })
        if (diff.ok)
          stamped.payload.checkpointSummary = {
            files: diff.diff.files.length,
            addedLines: diff.diff.files.reduce((sum, file) => sum + file.addedLines, 0),
            removedLines: diff.diff.files.reduce((sum, file) => sum + file.removedLines, 0),
          }
      }
    }
    if (session.checkpointNotice && !session.checkpointNoticeSent) {
      stamped.payload = { ...stamped.payload, notice: session.checkpointNotice }
      session.checkpointNoticeSent = true
    }
    this.trackStatefulSessionEvent(session, stamped)
    let automaticRequestId: string | undefined
    if (stamped.type === 'approval_requested' && typeof stamped.payload?.requestId === 'string') {
      const request: ApprovalRuleRequest = {
        action: String(stamped.payload.action ?? ''),
        input: stamped.payload.input,
        toolKind: stamped.payload.toolKind as ApprovalRuleRequest['toolKind'],
        requestKind: String(stamped.payload.kind ?? 'tool'),
        defaultToNo: stamped.payload.defaultToNo === true,
        suppressAlwaysAllowRule: stamped.payload.suppressAlwaysAllowRule === true,
      }
      const requestId = stamped.payload.requestId
      session.approvalRequests.set(requestId, request)
      // Decide whether a human is needed before publication, so remembered
      // grants never briefly trigger OS attention.
      // Resolution starts only after this request has persisted and published.
      const rule = await this.approvalRules.match(session.workspaceRoot, session.sessionId, request).catch(() => null)
      if (rule && session.approvalRequests.has(requestId) && session.status !== 'stopped') {
        session.automaticApprovals.set(requestId, rule.label)
        stamped.payload = { ...stamped.payload, autoApproved: true, ruleLabel: rule.label }
        automaticRequestId = requestId
      }
    } else if (stamped.type === 'approval_resolved' && typeof stamped.payload?.requestId === 'string') {
      const requestId = stamped.payload.requestId
      const ruleLabel = session.automaticApprovals.get(requestId)
      if (ruleLabel) stamped.payload = { ...stamped.payload, autoApproved: true, ruleLabel }
      session.approvalRequests.delete(requestId)
      session.automaticApprovals.delete(requestId)
    }
    this.updateExcerpts(session, stamped)
    // Streamed events join the transcript's write batch and are published when
    // it lands, without holding the emission queue for the disk: the next token
    // is stamped while this one waits. Batches resolve in order and each
    // publication is registered before the next event is stamped, so listeners
    // still see sequence order.
    if (isStreamedEvent(stamped)) {
      this.persistEvent(session, stamped).then(
        (outcome) => this.publish(session.workspaceRoot, path, stamped, outcome),
        () => undefined,
      )
      return stamped
    }
    const outcome = await this.persistEvent(session, stamped)
    if (ends) await this.closeToolStreams(session)
    if (ends && stamped.type === 'turn_completed' && session.status !== 'stopped')
      await this.threadIndex.refresh(session).catch(() => undefined)
    // Publish status at the same boundary as the terminal notification, after
    // persistence. Pollers and event-driven consumers must observe one state.
    if (session.status !== 'stopped' && ends) {
      session.status = stamped.type === 'turn_completed' ? 'ready' : 'failed'
      session.updatedAt = this.now()
    }
    this.publish(session.workspaceRoot, path, stamped, outcome)
    if (automaticRequestId)
      void this.respondToRequest({
        sessionId: session.sessionId,
        requestId: automaticRequestId,
        approved: true,
        decision: 'once',
      }).catch(() => undefined)
    return stamped
  }

  private updateExcerpts(session: RuntimeSession, event: ConversationEvent): void {
    // The prompt cache, from the requests the provider saw start (and reset by
    // a compaction) — the same fold the chat's own projection makes.
    const promptCache = applyPromptCacheEvent(session.promptCache ?? null, event)
    if (promptCache) session.promptCache = promptCache
    if ((event.type === 'session_started' || event.type === 'session_updated') && event.payload?.capabilities)
      session.capabilities = {
        ...session.capabilities,
        ...(event.payload.capabilities as import('../shared/conversation-runtime').ConversationCapabilities),
      }
    if (event.type === 'session_updated' && typeof event.payload?.revertedAfterSeq === 'number')
      session.revertedNote = `Files were ${event.payload.undo ? 'restored from the undo checkpoint' : `reverted to before conversation turn ${event.payload.revertedAfterSeq}`}. Inspect the current files before continuing; later transcript messages describe the previous file state.`
    if (event.type === 'tool_started')
      session.currentToolTitle = presentToolItem({
        kind: event.payload?.kind as import('../shared/conversation-runtime').ConversationToolKind,
        name: String(event.payload?.name ?? event.payload?.tool ?? ''),
        input: event.payload?.input as ConversationJsonValue | undefined,
        status: 'running',
      }).title
    // Streamed output (`partial`) arrives while the tool is still running.
    else if (
      (event.type === 'tool_output' && event.payload?.partial !== true) ||
      (event.type === 'turn_completed' && event.payload?.steered !== true) ||
      event.type === 'turn_failed'
    )
      session.currentToolTitle = undefined
    // A steered turn's end is not the session's: the work goes on.
    if (event.type === 'turn_completed' && event.payload?.steered === true) return
    // When the last turn ended, read off the event rather than the clock so
    // the transcript replay on resume restores the true time, not the resume.
    if (event.type === 'turn_completed' || event.type === 'turn_failed') session.lastTurnEndedAt = event.createdAt
    if (event.type === 'turn_completed') session.phase = 'completed'
    else if (event.type === 'turn_failed') session.phase = 'failed'
    else if (event.type === 'approval_resolved' && session.pendingApprovalRequestIds.size > 0) {
      // Another card is still up: the turn is still waiting on a person.
      const remaining = session.approvalRequests.get(Array.from(session.pendingApprovalRequestIds).at(-1)!)
      session.phase = remaining?.requestKind === 'question' ? 'waiting_for_input' : 'waiting_for_approval'
    } else if (event.type === 'turn_started' || event.type === 'user_message' || event.type === 'approval_resolved')
      session.phase = 'running'
    else if (event.type === 'approval_requested')
      session.phase = event.payload?.kind === 'question' ? 'waiting_for_input' : 'waiting_for_approval'
    if (event.type === 'subagent_status') {
      const status = readSubagentStatus(event.payload)
      if (status?.status === 'running')
        session.runningSubagents.set(status.toolUseId, {
          ...session.runningSubagents.get(status.toolUseId),
          ...status,
        })
      else if (status) session.runningSubagents.delete(status.toolUseId)
      session.backgroundAgents = Array.from(session.runningSubagents.values()).filter(
        (agent) => agent.background,
      ).length
    }
    if (event.type === 'user_message' && typeof event.payload?.text === 'string') {
      // An image-only turn carries no text, and an empty excerpt would pin the
      // chat's "first message" to nothing: the first turn with words keeps it.
      if (!session.firstUserText && event.payload.text.trim()) session.firstUserText = event.payload.text.slice(0, 240)
      session.lastUserText = event.payload.text.slice(0, 240)
      session.lastAssistantText = ''
    } else if (event.type === 'content_delta' && typeof event.payload?.text === 'string') {
      session.lastAssistantText = ((session.lastAssistantText ?? '') + event.payload.text).slice(0, 240)
    }
  }

  private runCommand(
    sessionId: string,
    commandId: string,
    action: () => Promise<ConversationSessionActionResult>,
  ): Promise<ConversationSessionActionResult> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, message: 'Conversation session is invalid.' })
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId).replace(
      /\.jsonl$/,
      '.receipts.json',
    )
    const key = `${path}:${commandId}`
    const pending = this.pendingCommands.get(key)
    if (pending) return pending
    const result = (async (): Promise<ConversationSessionActionResult> => {
      let receipts: Map<string, ConversationSessionActionResult>
      try {
        receipts = await this.loadReceipts(session.workspaceRoot, path)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Command receipts are unavailable.' }
      }
      const prior = receipts.get(commandId)
      if (prior) return prior
      const persist = async () => {
        while (receipts.size > 256) receipts.delete(receipts.keys().next().value!)
        const serialized = JSON.stringify(Array.from(receipts))
        const write = (this.receiptWrites.get(path) ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => writeConversationStorage(session.workspaceRoot, path, serialized))
        this.receiptWrites.set(path, write)
        await write
      }
      // Write the intent before an adapter can do work. If the process dies
      // before completion, replay this uncertainty instead of executing twice.
      receipts.set(commandId, {
        ok: false,
        message:
          'This command started before the connection was interrupted. Check the conversation before sending a new command.',
      })
      try {
        await persist()
      } catch (error) {
        // Nothing ran: a retry may execute it.
        receipts.delete(commandId)
        return { ok: false, message: error instanceof Error ? error.message : 'Command could not be recorded.' }
      }
      // A command that throws has still finished, so its failure is its result:
      // a retry is answered with it rather than with the crash-era uncertainty.
      let receipt: ConversationSessionActionResult
      try {
        receipt = JSON.parse(JSON.stringify(await action())) as ConversationSessionActionResult
      } catch (error) {
        receipt = { ok: false, message: error instanceof Error ? error.message : 'Conversation command failed.' }
      }
      receipts.set(commandId, receipt)
      await persist().catch(() => undefined)
      return receipt
    })()
    this.pendingCommands.set(key, result)
    void result.finally(() => this.pendingCommands.delete(key)).catch(() => undefined)
    return result
  }

  /**
   * The receipts for one conversation, read once per run. A failed read is not
   * remembered, so the next command tries again instead of every command
   * failing until restart. A receipts file that does not parse is moved aside
   * and replaced by an empty one: losing old receipts only means a very late
   * retry could run again, while refusing every command locks the chat.
   */
  private loadReceipts(root: string, path: string): Promise<Map<string, ConversationSessionActionResult>> {
    const cached = this.receipts.get(path)
    if (cached) return cached
    const loading = (async () => {
      let raw: Buffer
      try {
        raw = await readConversationStorage(root, path, MAX_CONVERSATION_METADATA_BYTES)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return new Map<string, ConversationSessionActionResult>()
        throw error
      }
      try {
        const entries = JSON.parse(raw.toString('utf8')) as unknown
        if (
          Array.isArray(entries) &&
          entries.every(
            (entry) =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === 'string' &&
              entry[1] &&
              typeof entry[1] === 'object' &&
              typeof entry[1].ok === 'boolean',
          )
        )
          return new Map<string, ConversationSessionActionResult>(entries)
      } catch {
        // Quarantined below.
      }
      console.warn(`[conversation-runtime] command receipts at ${path} are corrupt; moved aside`)
      await writeConversationStorage(root, `${path}.corrupt`, raw.toString('utf8')).catch(() => undefined)
      return new Map<string, ConversationSessionActionResult>()
    })()
    this.receipts.set(path, loading)
    loading.catch(() => {
      if (this.receipts.get(path) === loading) this.receipts.delete(path)
    })
    return loading
  }

  // Stateful adapters surface approvals mid-stream (the provider turn blocks
  // inside a permission callback while its event stream stays open), so the
  // pending-request cursor has to follow the events rather than the
  // end-of-stream summary that stateless turns use.
  private trackStatefulSessionEvent(session: RuntimeSession, event: ConversationEvent): void {
    if (!session.stateful) return
    if (event.type === 'approval_requested') {
      const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
      if (requestId) {
        session.pendingApprovalRequestIds.add(requestId)
        session.pendingRequestId = requestId
        session.status = 'awaiting_approval'
        session.updatedAt = this.now()
      }
    } else if (event.type === 'approval_resolved') {
      const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
      if (requestId) session.pendingApprovalRequestIds.delete(requestId)
      const remaining = Array.from(session.pendingApprovalRequestIds)
      if (remaining.length > 0) {
        session.pendingRequestId = remaining[remaining.length - 1]
        session.status = 'awaiting_approval'
      } else {
        session.pendingRequestId = session.turnLockRequestId
        if (session.status === 'awaiting_approval') session.status = 'active'
      }
      session.updatedAt = this.now()
    } else if (event.type === 'turn_failed' || (event.type === 'turn_completed' && event.payload?.steered !== true)) {
      session.pendingApprovalRequestIds.clear()
    }
  }

  // The session-scoped continuation channel: a stateful adapter pushes events
  // here when its child resumes after a `result` with no open sendTurn (e.g. a
  // background subagent completed and the model issued another tool call). Runs
  // outside any sendTurn IPC, so the composer stays free to end the prior turn.
  // Serialized through session.continuationTail to keep persistence ordered.
  private enqueueContinuationEvent(session: RuntimeSession, event: ConversationEvent): void {
    session.continuationTail = session.continuationTail
      .catch(() => undefined)
      .then(() => this.processContinuationEvent(session, event))
      .catch(async (error) => {
        await this.failTurn(session, error)
      })
  }

  private async processContinuationEvent(session: RuntimeSession, event: ConversationEvent): Promise<void> {
    if (session.status === 'stopped') return
    const streamTurnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : null
    // A steer may have moved the continuation on to a later turn; its events
    // are that turn's (emitNow restamps them).
    const continuing = streamTurnId && session.providerTurn?.streamTurnId === streamTurnId ? session.providerTurn : null
    const turnId = continuing ? continuing.turnId : streamTurnId
    if (turnId && session.canceledTurnIds.has(turnId)) return
    // First sight of a continuation turn: open a mirror in session state so its
    // events survive suppression and its approvals track through the normal
    // pendingRequestId path. A concurrently-completing sendTurn will see its own
    // turnId no longer active and skip its post-loop reset, so this stands.
    if (event.type === 'turn_started' && turnId && turnId !== session.activeTurnId) {
      // A live turn owns the session. The continuation raced a send that the
      // busy guard could not see yet (the channel is serialized off the send
      // path), and the adapter has since taken the turn over — so this mirror
      // would only blank the live turn by suppressing every event it has left.
      if (isSessionBusy(session)) return
      session.activeTurnId = turnId
      session.activeTurnAbort = null
      session.turnLockRequestId = null
      session.pendingRequestId = null
      session.pendingApprovalRequestIds.clear()
      session.status = 'active'
      session.checkpointTurnSeq = null
      session.checkpointCapture = null
      session.checkpointCaptured = false
      session.updatedAt = this.now()
      // From here a steer can join it, as it joins a send's turn.
      session.providerTurn = openProviderTurn(turnId, true)
    }
    await this.emit(session, event, streamTurnId ? { turnId: streamTurnId } : {})
    // Looked up again: a steer can have landed while the event waited its turn to be written.
    const stream = streamTurnId && session.providerTurn?.streamTurnId === streamTurnId ? session.providerTurn : null
    const ownTurnId = stream ? stream.turnId : streamTurnId
    const ends = event.type === 'turn_completed' || event.type === 'turn_failed'
    if (ends && stream) this.closeContinuation(session)
    if (ownTurnId && session.activeTurnId === ownTurnId && ends) {
      session.activeTurnId = null
      session.activeTurnAbort = null
      session.turnLockRequestId = null
      session.pendingRequestId = null
      session.pendingApprovalRequestIds.clear()
      session.status = event.type === 'turn_completed' ? 'ready' : 'failed'
      session.updatedAt = this.now()
    }
  }

  private shouldSuppressEvent(
    session: RuntimeSession,
    event: ConversationEvent,
    options: { turnId?: string; allowCanceledTurnId?: string | null },
  ): boolean {
    const eventTurnId =
      event.payload && typeof event.payload.turnId === 'string' ? event.payload.turnId : options.turnId
    if (!eventTurnId) return false
    if (eventTurnId === options.allowCanceledTurnId) return false
    if (session.status === 'stopped') return true
    if (session.canceledTurnIds.has(eventTurnId)) return true
    return session.activeTurnId !== eventTurnId
  }

  private eventForSession(
    session: RuntimeSession,
    type: ConversationEvent['type'],
    payload?: Record<string, unknown>,
  ): ConversationEvent {
    return {
      id: '',
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      providerId: session.providerId,
      modelId: session.modelId,
      type,
      createdAt: 0,
      payload,
    }
  }

  private applyTurnState(session: RuntimeSession, events: ConversationEvent[], requestId: string): void {
    // A terminal event always wins: a dead turn cannot keep an approval
    // pending (e.g. the provider child crashed while a card was up — leaving
    // the session in awaiting_approval would wedge it forever, since the
    // adapter-side permission no longer exists to resolve).
    const failed = events.some((event) => event.type === 'turn_failed')
    const completed = events.some((event) => event.type === 'turn_completed')
    if (failed || completed) {
      session.pendingRequestId = null
      session.pendingApprovalRequestIds.clear()
      session.status = failed ? 'failed' : 'ready'
      session.activeTurnId = null
      session.turnLockRequestId = null
      session.updatedAt = this.now()
      return
    }
    // An approval is pending at end-of-stream only when a request was never
    // resolved. Stateless turns end their stream at the request; stateful
    // turns resolve requests mid-stream and keep going.
    const requested = events.filter((event) => event.type === 'approval_requested').length
    const resolved = events.filter((event) => event.type === 'approval_resolved').length
    if (requested > resolved) {
      session.pendingRequestId = session.stateful ? session.pendingRequestId : requestId
      session.status = 'awaiting_approval'
    } else {
      session.pendingRequestId = null
      session.status = 'active'
    }
    session.updatedAt = this.now()
  }

  private persistEvent(session: RuntimeSession, event: ConversationEvent): Promise<ConversationAppendOutcome> {
    return this.eventLog.append(
      this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId),
      redactEvent(event),
      session.workspaceRoot,
    )
  }

  private toolDetailPath(input: ConversationToolDetailInput): string {
    return workspaceSidecarPath(
      input.workspaceRoot,
      'conversations',
      safeSegment(input.workspaceId),
      `${safeSegment(input.agentId)}.tools`,
      `${safeSegment(input.toolUseId)}.json`,
    )
  }

  async getToolDetail(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult> {
    if (
      !input.workspaceRoot?.trim() ||
      !input.workspaceId?.trim() ||
      !input.agentId?.trim() ||
      !input.toolUseId?.trim()
    ) {
      return { ok: false, code: 'invalid_input', message: 'Conversation and tool identity are required.' }
    }
    const path = this.toolDetailPath(input)
    // A detail asked for mid-stream includes every chunk published so far.
    await this.toolStreams.get(path)?.settled()
    await this.toolDetailWrites.get(path)?.catch(() => undefined)
    return readToolDetail(input.workspaceRoot, path)
  }

  /** The bytes of an image a turn carried, by the reference its `user_message` recorded. */
  readAttachment(ref: unknown): Promise<ConversationAttachmentResult> {
    return this.attachmentStore.read(ref)
  }

  /** A proposed plan as a file the workspace pane can open (conversation-plan-store). */
  planDocument(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult> {
    return this.planStore.document(input)
  }

  /** Explicit deletion removes the paired detail store as well as the transcript. */
  async listThreads(input: ConversationWorkspaceKey) {
    try {
      await this.eventLog.flush()
      return { ok: true as const, threads: await this.threadIndex.list(input) }
    } catch (error) {
      return { ok: false as const, message: String(error) }
    }
  }

  async searchThreads(
    input: ConversationSearchInput,
    options: { signal?: AbortSignal; onBatch?: (hits: ConversationSearchHit[]) => void } = {},
  ) {
    try {
      await this.eventLog.flush()
      return { ok: true as const, hits: await this.threadIndex.search(input, options) }
    } catch (error) {
      return { ok: false as const, message: String(error) }
    }
  }

  async renameThread(input: ConversationRenameInput, titleSource: 'user' | 'generated' = 'user') {
    if (this.deletingTranscripts.has(this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)))
      return { ok: false as const, message: 'Conversation is being deleted.' }
    const title = input.title.trim().slice(0, 200)
    if (!title) return { ok: false as const, message: 'A conversation title is required.' }
    try {
      const threads = await this.threadIndex.list(input)
      const thread = threads.find((entry) => entry.agentId === input.agentId)
      if (!thread) return { ok: false as const, message: 'Conversation was not found.' }
      if (titleSource === 'generated' && thread.titleSource === 'user') return { ok: true as const }
      const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
      const pending = (this.emissionTails.get(path) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const previous = (await this.transcripts.tail(input.workspaceRoot, path, { events: 1 })).at(-1)
          if (!previous) throw new Error('Conversation was not found.')
          // The source event is authoritative even if another rename raced the index lookup.
          if (
            titleSource === 'generated' &&
            (await this.transcripts.findLast(
              input.workspaceRoot,
              path,
              (event) => event.payload?.titleSource === 'user',
            ))
          )
            return
          const event: ConversationEvent = {
            ...previous,
            id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
            seq: Math.max(this.sequences.get(path) ?? 0, previous.seq ?? 0) + 1,
            createdAt: this.now(),
            type: 'session_updated',
            payload: { conversationTitle: title, titleSource },
          }
          this.sequences.set(path, event.seq!)
          this.publish(input.workspaceRoot, path, event, await this.eventLog.append(path, event, input.workspaceRoot))
        })
      this.emissionTails.set(path, pending)
      await pending
      await this.threadIndex.refresh(input)
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, message: String(error) }
    }
  }

  async deleteTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult> {
    if (!input.workspaceRoot?.trim() || !input.workspaceId?.trim() || !input.agentId?.trim())
      return { ok: false, message: 'Conversation identity is required.' }
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    const fileScope = await this.checkpoints.fileScope(input.workspaceRoot)
    if (this.revertingScopes.has(fileScope)) return { ok: false, message: 'Workspace files are being reverted.' }
    if (this.deletingTranscripts.has(path) || this.startingTranscripts.has(path))
      return { ok: false, message: 'Conversation lifecycle operation is already in progress.' }
    const matching = Array.from(this.sessions.values()).filter(
      (session) =>
        session.workspaceRoot === input.workspaceRoot &&
        session.workspaceId === input.workspaceId &&
        session.agentId === input.agentId,
    )
    if (matching.some((session) => isSessionBusy(session) || session.status === 'starting'))
      return { ok: false, message: 'Stop the active conversation turn before deleting it.' }
    this.deletingTranscripts.add(path)
    try {
      for (const session of matching)
        if (session.status !== 'stopped') await this.stopSession({ sessionId: session.sessionId })
      await this.emissionTails.get(path)
      for (const session of matching) await session.continuationTail
      await this.threadIndex.delete(input)
      await this.checkpoints.deleteConversation(input)
      await this.attachmentStore.deleteConversation(input)
      await this.planStore.deleteConversation(input)
      const receiptsPath = path.replace(/\.jsonl$/, '.receipts.json')
      await this.receiptWrites.get(receiptsPath)
      await removeConversationStorage(input.workspaceRoot, receiptsPath)
      await removeConversationStorage(input.workspaceRoot, `${receiptsPath}.corrupt`)
      await removeConversationStorage(input.workspaceRoot, lostSequencePath(path))
      this.receipts.delete(receiptsPath)
      this.transcripts.forget(path)
      this.nonDurableLogs.delete(path)
      this.sequences.delete(path)
      this.emissionTails.delete(path)
      for (const session of matching) this.sessions.delete(session.sessionId)
      return { ok: true, events: [] }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.deletingTranscripts.delete(path)
    }
  }

  /**
   * Store a tool event's full input or output in its detail file and leave the
   * transcript event a bounded preview. Partial output never blocks the
   * emission queue on the detail file: appended text goes to the tool's output
   * file and replaced output is rewritten in the background, in order per
   * tool. The final output waits for all of it, so a finished tool's detail is
   * complete by the time its event is published.
   */
  private async prepareToolEvent(session: RuntimeSession, event: ConversationEvent): Promise<ConversationEvent> {
    if (event.type !== 'tool_started' && event.type !== 'tool_output') return event
    const payload = redactConversationValue({ ...event.payload })
    const toolUseId =
      typeof payload.toolUseId === 'string'
        ? payload.toolUseId
        : typeof payload.toolCallId === 'string'
          ? payload.toolCallId
          : undefined
    const append = payload.outputMode === 'append'
    delete payload.outputMode
    if (!toolUseId) return { ...event, payload }
    payload.toolUseId = toolUseId
    const path = this.toolDetailPath({ ...session, toolUseId })
    if (event.type === 'tool_started') {
      const previous = await readToolDetail(session.workspaceRoot, path)
      const detail: ConversationToolDetail = previous.ok
        ? previous.detail
        : { input: {}, output: '', status: 'ok', clipped: false }
      const name =
        typeof payload.name === 'string' ? payload.name : typeof payload.tool === 'string' ? payload.tool : ''
      payload.name = name
      payload.kind = payload.kind ?? inferConversationToolKind(name)
      detail.input = (payload.input ?? {}) as ConversationJsonValue
      if (Buffer.byteLength(JSON.stringify(detail.input)) > 64 * 1024) {
        payload.input = {}
        payload.inputTruncated = true
      }
      this.toolDetails.set(path, detail)
      session.toolDetailPaths.add(path)
      await this.queueToolDetailWrite(session, path, detail)
      return { ...event, payload }
    }

    const partial = payload.partial === true
    const output = (payload.output ?? payload.preview ?? '') as ConversationJsonValue
    const text = typeof output === 'string' ? output : JSON.stringify(output)
    let stream = this.toolStreams.get(path)
    if (append && !stream) {
      stream = new ToolOutputStream(session.workspaceRoot, toolOutputStreamPath(path))
      this.toolStreams.set(path, stream)
      session.toolDetailPaths.add(path)
    }
    const mime = typeof payload.mime === 'string' ? payload.mime : undefined
    const binary = mime !== undefined && !/^(text\/|application\/(json|xml))/.test(mime)
    let totalBytes: number
    if (append) {
      stream!.append(text)
      payload.preview = binary ? '' : stream!.tail
      payload.truncated = binary || stream!.chars > TOOL_PREVIEW_CHARS
      totalBytes = stream!.totalBytes
    } else {
      // Output that streamed is read from its end, where the new lines are;
      // a one-shot result (a file read) from its beginning.
      const streamed = partial || stream !== undefined
      payload.preview = binary ? '' : streamed ? text.slice(-TOOL_PREVIEW_CHARS) : text.slice(0, TOOL_PREVIEW_CHARS)
      payload.truncated = binary || text.length > TOOL_PREVIEW_CHARS
      totalBytes = Buffer.byteLength(text)
    }
    if (typeof payload.totalBytes === 'number') totalBytes = Math.max(totalBytes, payload.totalBytes)
    const status =
      payload.status === 'declined' || payload.status === 'stopped' || payload.status === 'error'
        ? payload.status
        : payload.isError
          ? 'error'
          : 'ok'
    payload.output = payload.preview
    payload.totalBytes = totalBytes
    payload.status = status

    if (partial && append) return { ...event, payload }
    const known = this.toolDetails.get(path)
    const detail: ConversationToolDetail = known ?? {
      input: {},
      output: '',
      status: 'ok' as const,
      clipped: false,
    }
    detail.status = status
    detail.totalBytes = totalBytes
    if (payload.clipped === true) detail.clipped = true
    if (typeof payload.exitCode === 'number') detail.exitCode = payload.exitCode
    if (mime !== undefined) detail.mime = mime
    if (append) detail.output = ''
    else detail.output = binary ? '' : output
    if (partial) {
      // Replaced output mid-stream: the latest version, written behind the queue.
      this.toolDetails.set(path, detail)
      // The cached detail itself: a later write serializes the latest output,
      // and an input merged from disk by the first write stays for the rest.
      void this.queueToolDetailWrite(session, path, detail, !known)
      return { ...event, payload }
    }
    this.toolDetails.delete(path)
    this.toolStreams.delete(path)
    if (stream) {
      await stream.finish()
      if (stream.clipped) detail.clipped = true
      // A final output that carries everything supersedes what streamed.
      if (!append) await removeConversationStorage(session.workspaceRoot, stream.path).catch(() => undefined)
    }
    await this.queueToolDetailWrite(session, path, detail, !known)
    session.toolDetailPaths.delete(path)
    return { ...event, payload }
  }

  /**
   * Write a detail file behind any earlier write for the same tool. A detail
   * whose input was never seen this run (the tool started before a restart)
   * keeps the input already on disk.
   */
  private queueToolDetailWrite(
    session: RuntimeSession,
    path: string,
    detail: ConversationToolDetail,
    mergeInput = false,
  ): Promise<void> {
    const write = (this.toolDetailWrites.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (mergeInput) {
          const previous = await readToolDetail(session.workspaceRoot, path)
          if (previous.ok) detail.input = previous.detail.input
        }
        await writeToolDetail(session.workspaceRoot, path, detail)
      })
    this.toolDetailWrites.set(path, write)
    void write
      .finally(() => {
        if (this.toolDetailWrites.get(path) === write) this.toolDetailWrites.delete(path)
      })
      .catch(() => undefined)
    return write
  }

  /** Close the output files of tools a turn left unfinished. */
  /**
   * Hold a running tool's preview back when one went out less than the
   * preview interval ago, keeping only the latest for when it has passed; drop
   * one that shows nothing new. True when the event is not to be emitted now.
   * A final output ends the tool's throttle and always goes out.
   */
  private holdToolPreview(session: RuntimeSession, event: ConversationEvent, options: EmitOptions): boolean {
    const toolUseId = event.type === 'tool_output' ? event.payload?.toolUseId : undefined
    if (typeof toolUseId !== 'string') return false
    const key = `${session.sessionId}\0${toolUseId}`
    const throttle = this.toolPreviews.get(key)
    if (event.payload?.partial !== true) {
      if (throttle?.timer) clearTimeout(throttle.timer)
      this.toolPreviews.delete(key)
      return false
    }
    const shown = `${String(event.payload.totalBytes ?? '')}:${String(event.payload.preview ?? '')}`
    const now = Date.now()
    if (!throttle) {
      this.toolPreviews.set(key, { session, sentAt: now, shown, held: null, timer: null })
      return false
    }
    if (shown === throttle.shown) {
      throttle.held = null
      return true
    }
    const wait = throttle.sentAt + this.toolPreviewIntervalMs - now
    if (wait <= 0 && !throttle.timer) {
      throttle.sentAt = now
      throttle.shown = shown
      return false
    }
    throttle.held = { event, options }
    if (!throttle.timer) {
      throttle.timer = setTimeout(() => this.releaseToolPreview(key), Math.max(0, wait))
      throttle.timer.unref?.()
    }
    return true
  }

  private releaseToolPreview(key: string): void {
    const throttle = this.toolPreviews.get(key)
    if (!throttle) return
    throttle.timer = null
    if (throttle.session.status === 'stopped') {
      this.toolPreviews.delete(key)
      return
    }
    if (!throttle.held) return
    // Decide in the emission queue, not here: the tool's final output may
    // already be queued ahead of this preview, and a preview released after
    // it would show stale output over the finished tool.
    const session = throttle.session
    const path = this.transcriptPath(session.workspaceRoot, session.workspaceId, session.agentId)
    const release = (this.emissionTails.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        const held = throttle.held
        if (this.toolPreviews.get(key) !== throttle || !held || session.status === 'stopped') return null
        throttle.held = null
        throttle.sentAt = Date.now()
        throttle.shown = `${String(held.event.payload?.totalBytes ?? '')}:${String(held.event.payload?.preview ?? '')}`
        return this.emitNow(session, held.event, { ...held.options, prepared: true })
      })
    this.emissionTails.set(path, release)
    this.runInBackground(release)
  }

  /** Emit a session's waiting previews now, from inside the emission queue, and end their throttles. */
  private async flushToolPreviews(session: RuntimeSession): Promise<void> {
    for (const [key, throttle] of Array.from(this.toolPreviews)) {
      if (throttle.session !== session) continue
      if (throttle.timer) clearTimeout(throttle.timer)
      this.toolPreviews.delete(key)
      if (throttle.held) await this.emitNow(session, throttle.held.event, { ...throttle.held.options, prepared: true })
    }
  }

  private dropToolPreviews(): void {
    for (const throttle of this.toolPreviews.values()) if (throttle.timer) clearTimeout(throttle.timer)
    this.toolPreviews.clear()
  }

  private async closeToolStreams(session: RuntimeSession): Promise<void> {
    for (const path of Array.from(session.toolDetailPaths)) {
      const stream = this.toolStreams.get(path)
      this.toolStreams.delete(path)
      this.toolDetails.delete(path)
      session.toolDetailPaths.delete(path)
      await stream?.finish().catch(() => undefined)
      await this.toolDetailWrites.get(path)?.catch(() => undefined)
    }
  }

  private transcriptPath(workspaceRoot: string, workspaceId: string, agentId: string): string {
    return workspaceSidecarPath(
      workspaceRoot,
      'conversations',
      safeSegment(workspaceId),
      `${safeSegment(agentId)}.jsonl`,
    )
  }

  // Replay the persisted transcript for one agent, bounded to the most recent
  // events so a long-lived chat cannot flood the renderer. `all` lifts the
  // event count but not the byte budget: a transcript longer than that comes
  // back as its newest part rather than as an error.
  async readTranscript(
    input: ConversationTranscriptInput,
    options: { all?: boolean; closeOpenTurns?: boolean; maxBytes?: number } = {},
  ): Promise<ConversationTranscriptResult> {
    if (!input.workspaceRoot?.trim() || !input.workspaceId?.trim() || !input.agentId?.trim()) {
      return { ok: false, message: 'Conversation transcript request is invalid.' }
    }
    const filePath = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    // Buffered deltas first, so a reload mid-stream sees everything emitted.
    await this.eventLog.flush(filePath)
    let bounded: ConversationEvent[]
    try {
      bounded = await this.transcripts.tail(input.workspaceRoot, filePath, {
        events: options.all ? undefined : MAX_TRANSCRIPT_REPLAY_EVENTS,
        bytes: options.maxBytes,
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Conversation transcript is unavailable.' }
    }
    const live = Array.from(this.sessions.values()).some(
      (session) =>
        session.workspaceRoot === input.workspaceRoot &&
        session.workspaceId === input.workspaceId &&
        session.agentId === input.agentId &&
        session.status !== 'stopped',
    )
    return {
      ok: true,
      events: [
        ...bounded,
        ...(options.closeOpenTurns !== false && !live ? syntheticTurnClosures(bounded, bounded.at(-1)?.seq ?? 0) : []),
      ],
    }
  }

  /**
   * What a subscriber needs to join: the events after its cursor when the
   * cursor provably belongs to this log, otherwise a snapshot of the last
   * turns. Only published events are ever on disk ahead of a reader, so
   * nothing read here can be missing from, or repeated by, the live stream a
   * subscriber attached before calling this.
   */
  async readConversationSync(
    key: ConversationTranscriptInput,
    input: { afterSeq?: number; generation?: string; turnLimit?: number },
  ): Promise<({ ok: true } & TranscriptSyncResult) | { ok: false; message: string }> {
    const path = this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId)
    try {
      const result = await this.transcripts.sync(key.workspaceRoot, path, {
        ...input,
        forceSnapshot: this.nonDurableLogs.has(path),
      })
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Conversation transcript is unavailable.' }
    }
  }

  async readConversationPage(
    key: ConversationTranscriptInput,
    beforeCursor: number,
    turnLimit?: number,
  ): Promise<ConversationPageResult> {
    const path = this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId)
    try {
      return { ok: true, page: await this.transcripts.before(key.workspaceRoot, path, beforeCursor, turnLimit) }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Conversation transcript is unavailable.' }
    }
  }

  async recoverTranscript(input: ConversationTranscriptInput): Promise<void> {
    if (this.deletingTranscripts.has(this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)))
      throw new Error('Conversation is being deleted.')
    await this.initializeSequence(input)
  }

  private async initializeSequence(input: ConversationTranscriptInput): Promise<void> {
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    const existing = this.sequenceInitializations.get(path)
    if (existing) return existing
    const pending = this.initializeSequenceNow(input)
    this.sequenceInitializations.set(path, pending)
    try {
      await pending
    } finally {
      if (this.sequenceInitializations.get(path) === pending) this.sequenceInitializations.delete(path)
    }
  }

  private async initializeSequenceNow(input: ConversationTranscriptInput): Promise<void> {
    const path = this.transcriptPath(input.workspaceRoot, input.workspaceId, input.agentId)
    if (this.sequences.has(path)) return
    await this.eventLog.flush(path)
    // Only the last turn can still be open, so the end of the log is all this
    // needs: its last sequence number and any turn it left unfinished.
    const sync = await this.transcripts.sync(input.workspaceRoot, path, { turnLimit: 1 })
    const live = Array.from(this.sessions.values()).some(
      (session) =>
        session.workspaceRoot === input.workspaceRoot &&
        session.workspaceId === input.workspaceId &&
        session.agentId === input.agentId &&
        session.status !== 'stopped',
    )
    const floor = Math.max(sync.head, await this.readLostSequence(input.workspaceRoot, path))
    const closures = sync.kind === 'snapshot' && !live ? syntheticTurnClosures(sync.page.events, floor) : []
    for (const event of closures) await this.eventLog.append(path, event, input.workspaceRoot)
    this.sequences.set(path, closures.at(-1)?.seq ?? floor)
    // Expiry lists every thread in the workspace; opening a conversation must not wait on it.
    this.runInBackground(
      this.threadIndex
        .list(input)
        .catch(() => [])
        .then((threads) =>
          this.checkpoints.collectExpired(input.workspaceRoot, this.now(), [
            { key: input, updatedAt: this.now() },
            ...threads.map((thread) => ({ key: { ...input, agentId: thread.agentId }, updatedAt: thread.updatedAt })),
          ]),
        ),
    )
  }

  private async captureBeforeTool(session: RuntimeSession, name: string): Promise<void> {
    if (!session.capabilities?.checkpoints || !session.checkpointTurnSeq) return
    if (['file_read', 'search', 'list', 'web', 'todo'].includes(inferConversationToolKind(name))) return
    if (!session.checkpointCapture) {
      session.checkpointCapture = (async () => {
        const result = await this.checkpoints.capture(session, session.checkpointTurnSeq!, 'pre')
        session.checkpointCaptured = result.ok
        if (!result.ok) session.checkpointNotice = result.message
      })()
    }
    await session.checkpointCapture
  }

  getTurnDiff(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult> {
    return this.checkpoints.getTurnDiff(input)
  }
  async listApprovalRules() {
    try {
      return { ok: true as const, rules: await this.approvalRules.list() }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'Permission rules are unavailable.',
      }
    }
  }
  async revokeApprovalRule(ruleId: string) {
    try {
      await this.approvalRules.revoke(ruleId)
      return { ok: true as const }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'Permission rule could not be revoked.',
      }
    }
  }

  async revertToTurn(input: ConversationRevertInput): Promise<ConversationRevertResult> {
    const scope = await this.checkpoints.fileScope(input.key.workspaceRoot)
    const path = this.transcriptPath(input.key.workspaceRoot, input.key.workspaceId, input.key.agentId)
    if (this.revertingScopes.has(scope) || this.deletingTranscripts.has(path) || this.startingTranscripts.has(path))
      return { ok: false, message: 'A workspace lifecycle operation is already in progress.' }
    const sharingFiles = Array.from(this.sessions.values()).filter((session) => session.fileScope === scope)
    if (sharingFiles.some((session) => isSessionBusy(session) || session.status === 'starting'))
      return { ok: false, message: 'Stop the running turn before reverting files.' }
    this.revertingScopes.add(scope)
    try {
      await this.initializeSequence(input.key)
      // Idle native children may produce background continuations. Resume their
      // durable cursors on the next send after the file transaction has finished.
      for (const session of sharingFiles)
        this.getAdapterForProviderId(session.providerId)?.disposeChildProcess?.(session.sessionId)
      const result = await this.checkpoints.revert(input)
      if (result.ok && result.reverted) {
        const pending = (this.emissionTails.get(path) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            await this.eventLog.flush(path)
            const previous = (await this.transcripts.tail(input.key.workspaceRoot, path, { events: 1 })).at(-1)
            const event: ConversationEvent = {
              id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
              seq: (this.sequences.get(path) ?? 0) + 1,
              createdAt: this.now(),
              workspaceId: input.key.workspaceId,
              agentId: input.key.agentId,
              sessionId: previous?.sessionId ?? 'recovered',
              providerId: previous?.providerId ?? '',
              modelId: previous?.modelId ?? '',
              type: 'session_updated',
              payload: { revertedAfterSeq: input.turnSeq, undo: input.undo === true },
            }
            this.sequences.set(path, event.seq!)
            const outcome = await this.eventLog.append(path, event, input.key.workspaceRoot)
            for (const session of sharingFiles) {
              if (session.workspaceId === input.key.workspaceId && session.agentId === input.key.agentId)
                this.updateExcerpts(session, event)
            }
            this.publish(input.key.workspaceRoot, path, event, outcome)
          })
        this.emissionTails.set(path, pending)
        await pending
      }
      return result
    } finally {
      this.revertingScopes.delete(scope)
    }
  }

  /**
   * "Edit from here": take the conversation back to before the user message
   * at `turnSeq`. The provider forgets that message and every turn after it,
   * and a `session_updated` carrying `rewoundFromSeq` takes them out of the
   * transcript's view; the JSONL keeps them, as it keeps everything. Files
   * are not touched: a caller that wants them back reverts the turn's
   * checkpoint once this has succeeded. Gated on the adapter declaring `rewind`.
   * A message steered into a turn before the provider had a point within it
   * to go back to takes that turn's own message with it (findRewindTarget).
   */
  async rewindToTurn(input: ConversationRewindInput): Promise<ConversationRewindResult> {
    const { key, turnSeq } = input
    if (!key?.workspaceRoot?.trim() || !key.workspaceId?.trim() || !key.agentId?.trim())
      return { ok: false, message: 'Conversation identity is required.' }
    if (!Number.isSafeInteger(turnSeq) || turnSeq < 1) return { ok: false, message: 'The message to edit is invalid.' }
    const path = this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId)
    const scope = await this.checkpoints.fileScope(key.workspaceRoot)
    if (
      this.revertingScopes.has(scope) ||
      this.deletingTranscripts.has(path) ||
      this.startingTranscripts.has(path) ||
      this.rewindingTranscripts.has(path)
    )
      return { ok: false, message: 'A workspace lifecycle operation is already in progress.' }
    const live = Array.from(this.sessions.values()).filter(
      (session) =>
        session.workspaceRoot === key.workspaceRoot &&
        session.workspaceId === key.workspaceId &&
        session.agentId === key.agentId &&
        session.status !== 'stopped',
    )
    if (live.some((session) => isSessionBusy(session) || session.status === 'starting'))
      return { ok: false, message: 'Stop the running turn before editing an earlier message.' }
    this.rewindingTranscripts.add(path)
    try {
      await this.initializeSequence(key)
      await this.eventLog.flush(path)
      const target = await this.findRewindTarget(key, turnSeq)
      if (!target.ok) return target
      const providerId = live[0]?.providerId ?? target.event.providerId
      const adapter = this.getAdapterForProviderId(providerId)
      if (!adapter?.rewind || adapter.capabilities?.rewind !== true)
        return { ok: false, message: 'This agent cannot go back to an earlier message.' }
      // A live session drops its child now; without one, the next session
      // starts from the cursor the event below records.
      for (const session of live) {
        const rewound = await adapter.rewind({ ...session, cursor: target.cursor })
        if (!rewound.ok) return rewound
      }
      const pending = (this.emissionTails.get(path) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const event: ConversationEvent = {
            id: `conv_evt_${this.eventEpoch}_${++this.eventSequence}`,
            seq: (this.sequences.get(path) ?? 0) + 1,
            createdAt: this.now(),
            workspaceId: key.workspaceId,
            agentId: key.agentId,
            sessionId: live[0]?.sessionId ?? target.event.sessionId,
            providerId,
            modelId: live[0]?.modelId ?? target.event.modelId,
            type: 'session_updated',
            // Also the resume cursor (readResumeCursor): no provider session
            // before the first turn, else the kept turn's end as a fork point.
            payload: {
              rewoundFromSeq: target.fromSeq,
              providerSessionId: target.cursor?.sessionId ?? null,
              ...(target.cursor?.at ? { providerResumeAt: target.cursor.at } : {}),
            },
          }
          this.sequences.set(path, event.seq!)
          const outcome = await this.eventLog.append(path, event, key.workspaceRoot)
          this.publish(key.workspaceRoot, path, event, outcome)
        })
      this.emissionTails.set(path, pending)
      await pending
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The conversation could not go back.' }
    } finally {
      this.rewindingTranscripts.delete(path)
    }
  }

  /**
   * The user message at `turnSeq` and where the provider stood before it: the
   * cursor on the end of the newest turn still in view before it, or null when
   * it is the conversation's first. Read from the end back, so rewinds already
   * made (each after the turns it hid) are known before the turns they hid.
   */
  private async findRewindTarget(
    key: ConversationTranscriptInput,
    turnSeq: number,
  ): Promise<
    | { ok: true; event: ConversationEvent; cursor: ConversationProviderCursor | null; fromSeq: number }
    | { ok: false; message: string }
  > {
    const hidden: Array<{ from: number; before: number }> = []
    // Turns that failed before reaching the provider left nothing in its
    // session, so the turn before them is as good a point as any.
    const unreached = new Set<string>()
    // Turns a steer ended before the provider had a point within them to go
    // back to. The steered message went into that turn's work, so going back
    // before it goes back before that turn's own message as well, and both
    // leave the view: what stays on screen is what the agent still knows.
    const joined = new Set<string>()
    const walk: {
      target?: ConversationEvent
      cursor: ConversationProviderCursor | null
      uncharted: boolean
      fromSeq: number
    } = {
      cursor: null,
      uncharted: false,
      fromSeq: turnSeq,
    }
    await this.transcripts.findLast(
      key.workspaceRoot,
      this.transcriptPath(key.workspaceRoot, key.workspaceId, key.agentId),
      (event) => {
        const seq = event.seq ?? 0
        const rewoundFrom = event.type === 'session_updated' ? event.payload?.rewoundFromSeq : undefined
        if (typeof rewoundFrom === 'number') {
          hidden.push({ from: rewoundFrom, before: seq })
          return false
        }
        if (hidden.some((range) => seq >= range.from && seq < range.before)) return false
        if (!walk.target) {
          if (seq === turnSeq) {
            walk.target = event
            return event.type !== 'user_message'
          }
          // Past it without meeting it: hidden by a rewind, or never there.
          return seq < turnSeq
        }
        const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : undefined
        if (event.type === 'turn_completed' || event.type === 'turn_failed') {
          const found = readProviderCursor(event.payload?.providerCursor)
          if (found?.at) {
            walk.cursor = found
            return true
          }
          if (turnId && event.payload?.steered === true) joined.add(turnId)
          const reason = event.payload?.reason
          if (turnId && !found && (reason === 'runtime' || reason === 'spawn')) unreached.add(turnId)
          return false
        }
        if (event.type === 'user_message' && turnId && joined.has(turnId)) {
          walk.fromSeq = seq
          return false
        }
        if (event.type === 'user_message' && !(turnId && unreached.has(turnId))) {
          walk.uncharted = true
          return true
        }
        return false
      },
    )
    const { target, cursor, uncharted, fromSeq } = walk
    if (target?.type !== 'user_message')
      return { ok: false, message: 'That message is no longer in this conversation.' }
    if (!cursor && uncharted)
      return {
        ok: false,
        message:
          'There is no record of where the agent stood before this message, so the conversation cannot go back to it.',
      }
    return { ok: true, event: target, cursor, fromSeq }
  }

  // The latest provider-session cursor recorded in the transcript; stateful
  // providers use it to natively resume after a restart. A rewind is a cursor
  // too: to no session at all when it went back past the first turn, else to a
  // point inside one (`providerResumeAt`) that the next child forks at.
  private async readResumeCursor(
    workspaceRoot: string,
    workspaceId: string,
    agentId: string,
  ): Promise<{ sessionId?: string; at?: string } | undefined> {
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
    const isCursor = (event: ConversationEvent) =>
      (event.type === 'session_updated' || event.type === 'session_started') &&
      (text(event.payload?.providerSessionId) !== undefined || typeof event.payload?.rewoundFromSeq === 'number')
    try {
      await this.eventLog.flush(this.transcriptPath(workspaceRoot, workspaceId, agentId))
      const event = await this.transcripts.findLast(
        workspaceRoot,
        this.transcriptPath(workspaceRoot, workspaceId, agentId),
        isCursor,
      )
      const sessionId = text(event?.payload?.providerSessionId)
      if (!sessionId) return undefined
      const at = text(event?.payload?.providerResumeAt)
      return { sessionId, ...(at ? { at } : {}) }
    } catch {
      return undefined
    }
  }

  private toSummary(session: RuntimeSession): ConversationSessionSummary {
    const { sessionId, workspaceId, agentId, providerId, modelId, status, createdAt, updatedAt, permissionPreset } =
      session
    return {
      sessionId,
      workspaceId,
      agentId,
      providerId,
      modelId,
      status,
      createdAt,
      updatedAt,
      displayName: session.displayName,
      capabilities: session.capabilities,
      phase: session.phase,
      currentToolTitle: session.currentToolTitle,
      firstUserText: session.firstUserText,
      lastUserText: session.lastUserText,
      lastAssistantText: session.lastAssistantText,
      ...(session.backgroundAgents ? { backgroundAgents: session.backgroundAgents } : {}),
      ...(session.lastTurnEndedAt !== undefined ? { lastTurnEndedAt: session.lastTurnEndedAt } : {}),
      ...(session.promptCache ? { promptCache: session.promptCache } : {}),
      // Only when the session carries one, so a session that never chose a
      // preset reports absence rather than an invented 'default'.
      ...(permissionPreset ? { permissionPreset } : {}),
    }
  }
}

// The one busy predicate: a session is busy while any turn is open, whether it
// came from `sendTurn` or from the adapter's continuation channel. A
// continuation turn clears `pendingRequestId`, so that field alone would report
// an occupied session as free and let a second turn take it over.
function completedHistory(events: ConversationEvent[]): ConversationMessage[] {
  const history: ConversationMessage[] = []
  let user: string | undefined
  let assistant = ''
  for (const event of events) {
    if (event.type === 'user_message') {
      user = typeof event.payload?.text === 'string' ? event.payload.text : undefined
      assistant = ''
    } else if (event.type === 'content_delta' && typeof event.payload?.text === 'string')
      assistant += event.payload.text
    else if (event.type === 'turn_completed' && user !== undefined) {
      history.push({ role: 'user', content: user })
      if (assistant) history.push({ role: 'assistant', content: assistant })
      user = undefined
      assistant = ''
    } else if (event.type === 'turn_failed') {
      user = undefined
      assistant = ''
    }
  }
  return history
}

function isSessionBusy(session: RuntimeSession): boolean {
  return session.activeTurnId !== null || session.pendingRequestId !== null
}

// Why a busy session cannot take a steer, or null when it can: the provider
// has to take messages mid-turn, a turn has to be running to take it, and a
// card the agent is blocked on is answered first — a message would only queue
// behind it. The running turn must have reached the provider, which is what
// the message joins, and must not have ended there: a message sent then goes
// as the next turn once this one is over.
function steerRefusal(session: RuntimeSession, adapter: ConversationProviderAdapter): string | null {
  if (session.capabilities?.steer !== true || !adapter.steer)
    return 'This agent cannot take a message while it is working.'
  if (!session.activeTurnId) return 'Conversation turn is already in progress.'
  if (session.pendingApprovalRequestIds.size > 0) return 'Conversation turn is awaiting approval.'
  const running = session.providerTurn
  if (!running || running.turnId !== session.activeTurnId)
    return session.turnLockRequestId
      ? 'The agent has not started on the last message yet.'
      : 'The agent is carrying on by itself; the message goes when it stops.'
  if (running.finished) return 'The agent has just finished; the message goes as the next turn.'
  return null
}

function safeSegment(value: string): string {
  const encoded = encodeURIComponent(value.trim().replace(/[\\/]/g, '-'))
  return encoded === '.' || encoded === '..' ? encoded.replace(/\./g, '%2E') : encoded
}

// A transcript can end mid-turn (the app died while streaming). Replaying it
// verbatim would leave the projection permanently "streaming" and block the
// composer, so unfinished turns are closed with synthetic interrupt events —
// not persisted, only appended to the replay result.
function syntheticTurnClosures(events: ConversationEvent[], after: number): ConversationEvent[] {
  const openTurns = new Map<string, ConversationEvent>()
  for (const event of events) {
    const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : null
    if (!turnId) continue
    if (event.type === 'turn_started' || event.type === 'user_message') {
      if (!openTurns.has(turnId)) openTurns.set(turnId, event)
    } else if (event.type === 'turn_completed' || event.type === 'turn_failed') {
      openTurns.delete(turnId)
    }
  }
  let sequence = 0
  return Array.from(openTurns.entries()).map(([turnId, source]) => ({
    id: `conv_evt_replay_close_${++sequence}`,
    seq: after + sequence,
    sessionId: source.sessionId,
    workspaceId: source.workspaceId,
    agentId: source.agentId,
    providerId: source.providerId,
    modelId: source.modelId,
    type: 'turn_failed',
    createdAt: source.createdAt,
    payload: { turnId, reason: 'interrupted', message: 'The app closed while this turn was streaming.' },
  }))
}

/** A turn end's `providerCursor`, as the adapter recorded it; null when absent or malformed. */
function readProviderCursor(value: unknown): ConversationProviderCursor | null {
  if (!value || typeof value !== 'object') return null
  const { sessionId, at } = value as Record<string, unknown>
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null
  return { sessionId, at: typeof at === 'string' && at ? at : null }
}

/** Beside the transcript: the highest sequence number published that may not be in it. */
function lostSequencePath(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '.lost-seq.json')
}

function isAsyncIterable(
  value: ConversationEvent[] | AsyncIterable<ConversationEvent>,
): value is AsyncIterable<ConversationEvent> {
  return typeof (value as AsyncIterable<ConversationEvent>)[Symbol.asyncIterator] === 'function'
}

function redactEvent(event: ConversationEvent): ConversationEvent {
  return redactConversationValue(event)
}

/** Events that ride the log's short batch instead of forcing a write. */
function isStreamedEvent(event: ConversationEvent): boolean {
  return (
    event.type === 'content_delta' ||
    event.type === 'reasoning_delta' ||
    (event.type === 'tool_output' && event.payload?.partial === true)
  )
}
