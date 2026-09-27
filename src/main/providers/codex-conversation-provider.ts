import { randomUUID } from 'node:crypto'
import type {
  ConversationEvent,
  ConversationPermissionPreset,
  ConversationToolKind,
} from '../../shared/conversation-runtime'
import type {
  ConversationProviderAdapter,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './conversation-provider-adapter'
import {
  createCodexRpcTransport,
  type CodexRpcOptions,
  type CodexRpcTransport,
  type RpcMessage,
} from './codex-json-rpc'

export const CODEX_CONVERSATION_PROVIDER_ID = 'codex-agent'
type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
// How long a patch approval waits for its item (and so its diff) to arrive.
const PATCH_APPROVAL_WAIT_MS = 1_000

class EventQueue implements AsyncIterable<ConversationEvent> {
  private values: ConversationEvent[] = []
  private wake?: () => void
  private ended = false
  push(event: ConversationEvent) {
    if (!this.ended) {
      this.values.push(event)
      this.wake?.()
    }
  }
  end() {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.values.length) {
      const value = this.values.shift()
      if (value) yield value
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}
type ActiveTurn = {
  id: string
  cancelled: boolean
  nativeId: string | null
  queue: EventQueue
  textItems: Set<string>
  items: Map<string, RecordValue>
  outputBytes: Map<string, number>
  deferredApprovals: Map<string, (item: RecordValue) => void>
}
type Session = {
  closed: boolean
  input: MockAdapterSessionInput
  threadId: string | null
  transport: CodexRpcTransport | null
  starting?: Promise<void>
  turn: ActiveTurn | null
  pending: Map<string, { rpcId: string | number; kind: 'tool' | 'question'; questions?: RecordValue[] }>
  lastActivityAt: number
  spawnedAt: number | null
}
export type CodexConversationProviderOptions = {
  resolveExecutable?: (input: MockAdapterSessionInput) => Promise<string>
  buildEnv?: (input: MockAdapterSessionInput) => Promise<NodeJS.ProcessEnv>
  createTransport?: (options: CodexRpcOptions) => CodexRpcTransport
}

/** Keep the same sandbox boundaries as the terminal presets. Auto never escalates. */
export function codexPermissionPolicy(preset: ConversationPermissionPreset = 'manual') {
  if (preset === 'none') return {}
  if (preset === 'bypass')
    return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  if (preset === 'auto')
    return {
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    }
  return {
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  }
}

export function createCodexConversationProvider(
  options: CodexConversationProviderOptions = {},
): ConversationProviderAdapter {
  const sessions = new Map<string, Session>()
  const models = ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna']
  function event(state: Session, type: ConversationEvent['type'], payload: RecordValue = {}): ConversationEvent {
    return {
      id: randomUUID(),
      sessionId: state.input.sessionId,
      workspaceId: state.input.workspaceId,
      agentId: state.input.agentId,
      providerId: state.input.providerId,
      modelId: state.input.modelId,
      type,
      createdAt: Date.now(),
      payload: { ...(state.turn ? { turnId: state.turn.id } : {}), ...payload },
    }
  }
  function emit(state: Session, type: ConversationEvent['type'], payload: RecordValue = {}) {
    state.lastActivityAt = Date.now()
    const next = event(state, type, payload)
    if (state.turn) state.turn.queue.push(next)
    else state.input.onSessionEvent?.(next)
  }
  function finish(state: Session, failure?: string, interrupted = false) {
    if (!state.turn) return
    for (const requestId of state.pending.keys()) emit(state, 'approval_resolved', { requestId, approved: false })
    state.pending.clear()
    emit(
      state,
      failure ? 'turn_failed' : 'turn_completed',
      failure ? { message: failure, reason: 'provider_error' } : { interrupted },
    )
    state.turn.queue.end()
    state.turn = null
  }
  function tool(item: RecordValue): { name: string; kind: ConversationToolKind; input: RecordValue } | null {
    switch (item.type) {
      case 'commandExecution':
        return { name: 'Bash', kind: 'command', input: { command: item.command, cwd: item.cwd } }
      case 'fileChange':
        return {
          name: 'Edit',
          kind: 'file_edit',
          input: {
            edits: (Array.isArray(item.changes) ? item.changes : []).map((change) => ({
              path: record(change).path,
              patch: record(change).diff,
            })),
          },
        }
      case 'mcpToolCall':
        return { name: `mcp__${text(item.server)}__${text(item.tool)}`, kind: 'mcp', input: record(item.arguments) }
      case 'webSearch':
        return {
          name: 'WebSearch',
          kind: 'web',
          input: { query: item.query ?? record(item.action).query ?? '', action: item.action },
        }
      case 'plan':
        return { name: 'TodoWrite', kind: 'todo', input: { plan: item.text } }
      case 'dynamicToolCall':
        return { name: text(item.tool) || 'Tool', kind: 'other', input: record(item.arguments) }
      default:
        return null
    }
  }
  async function onMessage(state: Session, message: RpcMessage) {
    const params = record(message.params)
    if (typeof params.threadId === 'string' && state.threadId && params.threadId !== state.threadId) {
      if (message.id !== undefined) state.transport?.reject(message.id, 'This thread is not owned by this session.')
      return
    }
    const turn = state.turn
    if (message.id !== undefined) {
      const rpcId = message.id
      if (!turn) {
        state.transport?.reject(rpcId, 'No active conversation turn.')
        return
      }
      const isCommand = message.method === 'item/commandExecution/requestApproval'
      const isPatch = message.method === 'item/fileChange/requestApproval'
      const isQuestion = message.method === 'item/tool/requestUserInput'
      if (!isCommand && !isPatch && !isQuestion) {
        state.transport?.reject(rpcId, 'This client does not support this request.')
        return
      }
      const itemId = text(params.itemId)
      const requestId = `${turn.id}:${String(rpcId)}`
      const questions = Array.isArray(params.questions) ? params.questions.map(record) : []
      state.pending.set(requestId, { rpcId, kind: isQuestion ? 'question' : 'tool', questions })
      const raise = (item: RecordValue) => {
        if (state.turn !== turn || !state.pending.has(requestId)) return
        const mapped = isCommand
          ? {
              name: 'Bash',
              kind: 'command',
              input: { command: params.command ?? item.command, cwd: params.cwd ?? item.cwd },
            }
          : tool(item)
        emit(state, 'approval_requested', {
          requestId,
          action: isQuestion ? 'AskUserQuestion' : (mapped?.name ?? 'Edit'),
          kind: isQuestion ? 'question' : 'tool',
          input: mapped?.input ?? { reason: params.reason },
          toolKind: mapped?.kind ?? 'file_edit',
          cwd: state.input.workspaceRoot,
          summary:
            text(params.reason) ||
            (isCommand
              ? text(params.command ?? item.command)
              : isPatch
                ? 'Apply the proposed file changes?'
                : text(questions[0]?.question)),
          ...(isQuestion
            ? {
                questions: questions.map((question) => ({
                  question: text(question.question),
                  header: text(question.header),
                  multiSelect: false,
                  options: Array.isArray(question.options) ? question.options : [],
                })),
              }
            : {}),
        })
      }
      const known = turn.items.get(itemId)
      if (isPatch && Array.isArray(params.changes)) raise({ type: 'fileChange', changes: params.changes })
      else if (isPatch && !known && itemId) {
        // A patch approval can arrive before the item that carries its diff.
        // Asking without the diff would have the person approve blind, so the
        // card waits for the item, and only asks without it if none arrives.
        const timer = setTimeout(() => {
          turn.deferredApprovals.delete(itemId)
          raise({})
        }, PATCH_APPROVAL_WAIT_MS)
        timer.unref?.()
        turn.deferredApprovals.set(itemId, (item) => {
          clearTimeout(timer)
          turn.deferredApprovals.delete(itemId)
          raise(item)
        })
      } else raise(known ?? {})
      return
    }
    if (!turn) return
    const method = message.method
    if (method === 'turn/started') {
      turn.nativeId = text(record(params.turn).id) || turn.nativeId
      return
    }
    if (method === 'item/agentMessage/delta') {
      turn.textItems.add(text(params.itemId))
      emit(state, 'content_delta', { text: text(params.delta) })
      return
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      emit(state, 'reasoning_delta', { text: text(params.delta) })
      return
    }
    if (method === 'item/commandExecution/outputDelta') {
      // Only the new text: the runtime appends it to the tool's output, so a
      // long command costs each chunk once rather than its whole output again.
      const id = text(params.itemId)
      const totalBytes = (turn.outputBytes.get(id) ?? 0) + Buffer.byteLength(text(params.delta))
      turn.outputBytes.set(id, totalBytes)
      emit(state, 'tool_output', {
        toolUseId: id,
        output: text(params.delta),
        outputMode: 'append',
        totalBytes,
        partial: true,
        status: 'ok',
      })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = record(record(params.tokenUsage).last)
      emit(state, 'usage_updated', {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = record(params.item),
        id = text(item.id)
      if (!id) return
      const complete = method === 'item/completed'
      if (item.type === 'agentMessage' && complete && !turn.textItems.has(id)) {
        emit(state, 'content_delta', { text: text(item.text) })
        turn.textItems.add(id)
        return
      }
      const mapped = tool(item)
      if (!mapped) return
      const previous = turn.items.get(id)
      turn.items.set(id, item)
      // Completed file items may carry richer diff input than their start event.
      if (!previous || item.type === 'fileChange')
        emit(state, 'tool_started', {
          toolUseId: id,
          toolCallId: id,
          name: mapped.name,
          tool: mapped.name,
          kind: mapped.kind,
          input: mapped.input,
        })
      turn.deferredApprovals.get(id)?.(item)
      if (complete) {
        const partialBytes = turn.outputBytes.get(id)
        // With no aggregate, the streamed chunks are the output: close it without repeating them.
        const streamedOnly =
          item.aggregatedOutput == null && item.result == null && item.text == null && partialBytes !== undefined
        const output = streamedOnly ? '' : (item.aggregatedOutput ?? item.result ?? item.text ?? '')
        emit(state, 'tool_output', {
          toolUseId: id,
          toolCallId: id,
          output,
          ...(streamedOnly ? { outputMode: 'append', totalBytes: partialBytes } : {}),
          status: item.status === 'declined' ? 'declined' : item.status === 'failed' ? 'error' : 'ok',
          ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
        })
      }
      return
    }
    if (method === 'turn/completed') {
      const native = record(params.turn)
      finish(
        state,
        native.status === 'failed' ? text(record(native.error).message) || 'Codex turn failed.' : undefined,
        native.status === 'interrupted',
      )
    }
  }
  async function ensureConnected(state: Session) {
    if (state.transport) return
    if (state.starting) return state.starting
    state.starting = (async () => {
      const command = await (options.resolveExecutable ?? resolveExecutable)(state.input)
      const env = await (options.buildEnv ?? buildEnv)(state.input)
      if (state.closed) throw new Error('Codex conversation was closed.')
      const transport = (options.createTransport ?? createCodexRpcTransport)({
        command,
        cwd: state.input.workspaceRoot ?? '',
        env,
        onMessage: (message) => onMessage(state, message),
        onClose: (error) => {
          if (state.transport !== transport) return
          state.transport = null
          state.spawnedAt = null
          finish(state, error.message)
        },
      })
      state.transport = transport
      state.spawnedAt = Date.now()
      try {
        await transport.request('initialize', {
          clientInfo: { name: 'sprintengine_studio', title: 'SprintEngine Studio', version: '1.0.0' },
        })
        transport.notify('initialized', {})
        const account = record(await transport.request('account/read', { refreshToken: false }))
        if (account.requiresOpenaiAuth === true && !account.account)
          throw new Error('Codex is not logged in. Run codex login in a terminal, then retry.')
        const policy = codexPermissionPolicy(state.input.permissionPreset)
        const result = record(
          await transport.request(state.threadId ? 'thread/resume' : 'thread/start', {
            ...(state.threadId ? { threadId: state.threadId } : {}),
            cwd: state.input.workspaceRoot,
            model: state.input.modelId,
            ...(policy.approvalPolicy ? { approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox } : {}),
          }),
        )
        const id = text(record(result.thread).id)
        if (!id) throw new Error('Codex did not return a conversation identity.')
        state.threadId = id
        emit(state, 'session_updated', { providerSessionId: id })
      } catch (error) {
        state.transport = null
        state.spawnedAt = null
        transport.close()
        throw error
      }
    })().finally(() => {
      state.starting = undefined
    })
    return state.starting
  }
  return {
    id: CODEX_CONVERSATION_PROVIDER_ID,
    displayName: 'Codex',
    sessions: 'stateful',
    listModels: () => [...models],
    capabilities: {
      tools: true,
      approvals: true,
      questions: true,
      planMode: false,
      images: true,
      skills: 'context',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      interrupt: true,
      resume: true,
      subagents: false,
      cost: false,
      contextMeter: false,
      liveModelSwitch: false,
    },
    startSession(input) {
      const state: Session = {
        input,
        closed: false,
        threadId: input.resumeSessionId ?? null,
        transport: null,
        turn: null,
        pending: new Map(),
        lastActivityAt: Date.now(),
        spawnedAt: null,
      }
      sessions.set(input.sessionId, state)
      return [event(state, 'session_started'), event(state, 'session_ready')]
    },
    async *sendTurn(input: MockAdapterTurnInput) {
      const state = sessions.get(input.sessionId)
      if (!state) throw new Error('Codex conversation is not active.')
      if (state.turn) throw new Error('Codex is already running a turn.')
      if (input.mode === 'plan') throw new Error('This Codex connection does not support plan mode.')
      const queue = new EventQueue()
      state.turn = {
        id: input.turnId,
        cancelled: false,
        nativeId: null,
        queue,
        textItems: new Set(),
        items: new Map(),
        outputBytes: new Map(),
        deferredApprovals: new Map(),
      }
      emit(state, 'turn_started')
      const abort = () => {
        void interrupt(state).catch((error: unknown) =>
          finish(state, error instanceof Error ? error.message : 'Could not interrupt Codex.'),
        )
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      void (async () => {
        try {
          // Capture before starting the autonomous turn, not after an edit notification.
          await state.input.onBeforeTool?.('Edit')
          await ensureConnected(state)
          if (state.closed || !state.turn || state.turn.cancelled || input.signal?.aborted) {
            finish(state, undefined, true)
            return
          }
          // Ask can inspect, never escalate an attempted write through approval.
          // This turn-only sandbox also overrides a remembered bypass preset.
          const policy =
            input.mode === 'ask'
              ? { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
              : codexPermissionPolicy(state.input.permissionPreset)
          const result = record(
            await state.transport!.request('turn/start', {
              threadId: state.threadId,
              model: input.modelId,
              ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
              input: [
                { type: 'text', text: input.message, text_elements: [] },
                ...(input.attachments ?? []).map((attachment) => ({
                  type: 'image',
                  url: `data:${attachment.mediaType};base64,${attachment.dataBase64}`,
                })),
              ],
              ...(policy.approvalPolicy
                ? { approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy }
                : {}),
            }),
          )
          if (state.turn) state.turn.nativeId = text(record(result.turn).id) || state.turn.nativeId
          if (state.turn?.cancelled || input.signal?.aborted) await interrupt(state)
        } catch (error) {
          finish(state, error instanceof Error ? error.message : 'Codex could not start this turn.')
        }
      })()
      try {
        yield* queue
      } finally {
        input.signal?.removeEventListener('abort', abort)
      }
    },
    resolveApproval(input) {
      const state = sessions.get(input.sessionId),
        pending = state?.pending.get(input.requestId)
      if (!state || !pending || !state.transport) throw new Error('This Codex approval is no longer pending.')
      if (pending.kind === 'question') {
        const answers: Record<string, { answers: string[] }> = {}
        for (const question of pending.questions ?? [])
          answers[text(question.id)] = {
            answers: input.approved ? [input.answers?.[text(question.question)] ?? ''] : [],
          }
        state.transport.respond(pending.rpcId, { answers })
      } else state.transport.respond(pending.rpcId, { decision: input.approved ? 'accept' : 'decline' })
      state.pending.delete(input.requestId)
      emit(state, 'approval_resolved', {
        requestId: input.requestId,
        approved: input.approved,
        ...(input.answers ? { answers: input.answers } : {}),
      })
      return []
    },
    async interrupt(input) {
      const state = sessions.get(input.sessionId)
      if (state) await interrupt(state)
      return []
    },
    stopSession(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      state.closed = true
      finish(state, undefined, true)
      state.transport?.close()
      sessions.delete(input.sessionId)
      return [event(state, 'session_closed')]
    },
    async setPermissionPreset(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'Codex conversation is not active.' }
      if (input.permissionPreset === 'none' && state.input.permissionPreset !== 'none')
        return {
          ok: false,
          message:
            'Choose Manual or Auto explicitly when changing this Codex session; omitting a policy would retain its previous permissions.',
        }
      if (state.turn)
        return { ok: false, message: 'Finish or stop the current turn before changing Codex permissions.' }
      state.input = { ...state.input, permissionPreset: input.permissionPreset }
      return { ok: true }
    },
    listLiveSessions: () =>
      [...sessions.values()].map((state) => ({
        sessionId: state.input.sessionId,
        workspaceId: state.input.workspaceId,
        agentId: state.input.agentId,
        workspaceRoot: state.input.workspaceRoot ?? '',
        providerSessionId: state.threadId,
        hasChildProcess: state.transport?.pid != null,
        childPid: state.transport?.pid ?? null,
        turnActive: Boolean(state.turn),
        pendingApproval: state.pending.size > 0,
        lastActivityAt: state.lastActivityAt,
        spawnedAt: state.spawnedAt,
      })),
    disposeChildProcess(sessionId) {
      const state = sessions.get(sessionId)
      if (!state?.transport || state.turn) return false
      const transport = state.transport
      state.transport = null
      state.spawnedAt = null
      transport.close()
      return true
    },
    disposeAll() {
      for (const state of sessions.values()) {
        state.closed = true
        finish(state, undefined, true)
        state.transport?.close()
      }
      sessions.clear()
    },
  }
}

async function interrupt(state: Session): Promise<void> {
  if (!state.turn) return
  state.turn.cancelled = true
  if (!state.turn.nativeId || !state.transport) return
  await state.transport.request('turn/interrupt', { threadId: state.threadId, turnId: state.turn.nativeId })
}
async function resolveExecutable(input: MockAdapterSessionInput): Promise<string> {
  if (input.cliRuntimes?.codex?.hostId && input.cliRuntimes.codex.hostId !== 'local')
    throw new Error('Codex conversation requires a local CLI runtime.')
  const { detectCli } = await import('../cli-runtime-install')
  const detection = await detectCli('codex', input.cliRuntimes?.codex)
  if (!detection.installed || !detection.resolvedPath)
    throw new Error('Codex CLI is not installed. Install it or configure its command in Settings.')
  return detection.resolvedPath
}
async function buildEnv(input: MockAdapterSessionInput): Promise<NodeJS.ProcessEnv> {
  const { getTerminalEnv, applyAgentIdentityEnv } = await import('../terminal-launch')
  const env = applyAgentIdentityEnv(getTerminalEnv(), { workspaceId: input.workspaceId, agentId: input.agentId })
  for (const key of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT_ID',
    'ELECTRON_RUN_AS_NODE',
  ])
    delete env[key]
  env.SPRINTENGINE_CONVERSATION_SESSION_ID = input.sessionId
  return env
}
