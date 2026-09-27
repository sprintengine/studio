import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  openConfinedExistingFile,
  readBoundedConversationFile,
  resolveConversationPath,
} from '../conversation-file-access'
import { cliSpawnTarget, terminateCliChild } from './cli-child-process'
import type {
  ClientSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk'
import type {
  ConversationCapabilities,
  ConversationEvent,
  ConversationPermissionPreset,
  ConversationToolKind,
} from '../../shared/conversation-runtime'
import type {
  ConversationProviderAdapter,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './conversation-provider-adapter'

type EnforcedPreset = Exclude<ConversationPermissionPreset, 'none'>

export type AcpProfile = {
  id: string
  displayName: string
  cli: string
  // The launch argv when the CLI's own configuration decides permissions ('none').
  argv: string[]
  // The launch argv for each preset the CLI enforces through its own flags. The
  // flags are fixed when the child starts, so changing the preset respawns it
  // and reloads the session.
  presetArgv?: Partial<Record<EnforcedPreset, string[]>>
  // Commands the CLI accepts in the prompt that switch its own permission mode,
  // with the least permissive preset that already allows what they switch to.
  // Typed under a stricter preset, they would undo the person's choice from
  // inside the conversation, where the permission picker cannot see it.
  permissionCommands?: Record<string, EnforcedPreset>
  // What the person should know about a preset the CLI only partly enforces.
  permissionNotice?: (preset: ConversationPermissionPreset, env: NodeJS.ProcessEnv) => Promise<string | undefined>
  authHint: string
  authenticate?: string
  images: boolean
  planMode: boolean
}

const PRESET_RANK: Record<EnforcedPreset, number> = { manual: 0, auto: 1, bypass: 2 }

/** Cursor's approval mode lives in its own configuration; it is read, never written. */
async function cursorPermissionNotice(
  preset: ConversationPermissionPreset,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (preset !== 'manual') return undefined
  const configDir =
    env.CURSOR_CONFIG_DIR?.trim() ||
    (env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME, 'cursor') : join(env.HOME || homedir(), '.cursor'))
  let approvalMode: unknown
  try {
    const config = JSON.parse(await readFile(join(configDir, 'cli-config.json'), 'utf8')) as Record<string, unknown>
    approvalMode = config.approvalMode
  } catch {
    // No readable configuration: Cursor runs on its defaults, described below.
  }
  // Run Everything is the saved form of what --force does for one launch, and
  // the manual launch passes no flag that would override it.
  if (approvalMode === 'unrestricted')
    return 'Cursor is set to Run Everything in its own settings, so it runs commands and edits files without asking. Change its approval mode in Cursor to get approval requests here.'
  // Observed with Cursor's allowlist mode: shell commands outside the allowlist
  // are sent for approval, file edits inside the workspace are applied directly.
  return 'Cursor asks before running commands that are not on its own allowlist, but it edits files in this workspace without asking.'
}

/** Profiles are protocol observations, not guesses based on a CLI's terminal features. */
export const ACP_PROFILES: AcpProfile[] = [
  {
    id: 'cursor-agent',
    displayName: 'Cursor',
    cli: 'cursor',
    argv: ['acp'],
    // Cursor's permission flags are top-level options and must precede the
    // subcommand. Without a flag it sends session/request_permission for what
    // its own policy does not already allow.
    presetArgv: {
      manual: ['acp'],
      auto: ['--auto-review', 'acp'],
      bypass: ['--force', 'acp'],
    },
    permissionNotice: cursorPermissionNotice,
    authHint: 'Run agent login in a terminal.',
    authenticate: 'cursor_login',
    images: true,
    planMode: true,
  },
  {
    id: 'opencode-agent',
    displayName: 'OpenCode',
    cli: 'opencode',
    argv: ['acp'],
    authHint: 'Run opencode auth login in a terminal and configure a working model.',
    images: true,
    planMode: true,
  },
  {
    id: 'grok-agent',
    displayName: 'Grok',
    cli: 'grok',
    // --no-leader keeps one agent process per conversation even when Grok's
    // config enables its shared leader, so the flags below govern this session
    // alone. --permission-mode is a top-level option (before `agent`) and
    // overrides the configured mode for this process; --always-approve is an
    // agent option (after `agent`, before the transport).
    argv: ['agent', '--no-leader', 'stdio'],
    presetArgv: {
      manual: ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'],
      auto: ['--permission-mode', 'auto', 'agent', '--no-leader', 'stdio'],
      bypass: ['agent', '--always-approve', '--no-leader', 'stdio'],
    },
    permissionCommands: { '/always-approve': 'bypass', '/auto': 'auto' },
    authHint: 'Run grok login in a terminal.',
    images: false,
    planMode: false,
  },
]

const supportedPresets = (profile: AcpProfile): ConversationPermissionPreset[] =>
  profile.cli === 'opencode'
    ? ['none', 'manual']
    : ['none', ...(Object.keys(profile.presetArgv ?? {}) as EnforcedPreset[])]

/** The argv a conversation's child is launched with under a permission preset. */
export function acpLaunchArgv(profile: AcpProfile, preset: ConversationPermissionPreset = 'none'): string[] {
  return (preset !== 'none' && profile.presetArgv?.[preset]) || profile.argv
}

/** A prompt that would switch the CLI's own permission mode past the chosen preset. */
function permissionCommandRefusal(
  profile: AcpProfile,
  preset: ConversationPermissionPreset | undefined,
  message: string,
): string | undefined {
  if (!preset || preset === 'none') return undefined
  const command = message.trim().split(/\s/, 1)[0]?.toLowerCase() ?? ''
  const needs = profile.permissionCommands?.[command]
  if (!needs || PRESET_RANK[needs] <= PRESET_RANK[preset]) return undefined
  return `${command} would change ${profile.displayName}'s permissions from inside the conversation. Use the permission picker in the chat box instead.`
}

const baseCapabilities = (profile: AcpProfile): ConversationCapabilities => ({
  permissionPresets: supportedPresets(profile),
  tools: true,
  approvals: true,
  questions: false,
  planMode: profile.planMode,
  images: profile.images,
  skills: 'context',
  reasoningEfforts: null,
  interrupt: true,
  resume: true,
  subagents: false,
  cost: false,
  contextMeter: false,
  liveModelSwitch: false,
})
export const acpToolKind = (kind?: ToolKind | null): ConversationToolKind =>
  ({
    read: 'file_read',
    edit: 'file_edit',
    delete: 'file_edit',
    move: 'file_edit',
    search: 'search',
    execute: 'command',
    fetch: 'web',
    think: 'other',
    switch_mode: 'other',
    other: 'other',
  })[kind ?? 'other'] as ConversationToolKind

class Queue implements AsyncIterable<ConversationEvent> {
  private items: ConversationEvent[] = []
  private wake?: () => void
  private ended = false
  push(event: ConversationEvent) {
    if (!this.ended) {
      this.items.push(event)
      this.wake?.()
    }
  }
  end() {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.items.length) {
      const next = this.items.shift()
      if (next) yield next
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}
type Pending = { options: RequestPermissionRequest['options']; resolve: (value: RequestPermissionResponse) => void }
type State = {
  input: MockAdapterSessionInput
  child?: ChildProcessWithoutNullStreams
  connection?: ClientSideConnection
  starting?: Promise<void>
  nativeId?: string
  closed: boolean
  loading: boolean
  loadSupported: boolean
  queue?: Queue
  turn?: MockAdapterTurnInput
  cancelled: boolean
  pending: Map<string, Pending>
  toolCalls: Map<string, Record<string, unknown>>
  lastActivityAt: number
  spawnedAt: number | null
  capabilities: ConversationCapabilities
  modes: string[]
  defaultMode?: string
  modeConfigId?: string
  history: Array<{ user: string; assistant: string }>
  replayHistory: boolean
  // Set when a stored session could not be reopened; reported once, with the
  // replacement session's identity, so the person knows context was replayed.
  resumeNotice?: string
  assistantText: string
}
// A change larger than this is approved by path and size: the approval card is
// persisted with the transcript, and a multi-megabyte diff would dominate it.
const WRITE_PREVIEW_BYTES = 256 * 1024

type Options = {
  detect?: (input: MockAdapterSessionInput) => Promise<string>
  buildEnv?: (input: MockAdapterSessionInput) => Promise<NodeJS.ProcessEnv>
  startupTimeoutMs?: number
}

/** Text helpers refuse symlinks in every path component, not only the leaf.
 * The agent was started in the workspace root as configured, so it names files
 * under that spelling or under the resolved one (a root below macOS `/var` is
 * really below `/private/var`); both are the workspace. */
export async function confinedAcpPath(cwd: string, requested: string, writing = false): Promise<string> {
  const { root, target, suffix } = await resolveConversationPath(cwd, requested)
  const parts = suffix.split(sep)
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index])
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink()) throw new Error('Symbolic links are not available through conversation file access.')
      if (index < parts.length - 1 && !entry.isDirectory()) throw new Error('File parent is not a directory.')
      if (index === parts.length - 1 && !entry.isFile())
        throw new Error('Only regular files are available through conversation file access.')
    } catch (error) {
      if (writing && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  return target
}

export function createAcpConversationProvider(profile: AcpProfile, options: Options = {}): ConversationProviderAdapter {
  const sessions = new Map<string, State>()
  const modelIds = new Set<string>(['default'])
  let requestSequence = 0
  const event = (
    state: State,
    type: ConversationEvent['type'],
    payload: Record<string, unknown> = {},
  ): ConversationEvent => ({
    id: '',
    sessionId: state.input.sessionId,
    workspaceId: state.input.workspaceId,
    agentId: state.input.agentId,
    providerId: profile.id,
    modelId: state.input.modelId,
    createdAt: Date.now(),
    type,
    payload: { ...(state.turn ? { turnId: state.turn.turnId } : {}), ...payload },
  })
  const emit = (state: State, type: ConversationEvent['type'], payload: Record<string, unknown>) => {
    state.lastActivityAt = Date.now()
    if (!state.loading) state.queue?.push(event(state, type, payload))
  }
  const cancelPermissions = (state: State) => {
    for (const pending of state.pending.values()) pending.resolve({ outcome: { outcome: 'cancelled' } })
    state.pending.clear()
  }
  const dispose = (state: State) => {
    cancelPermissions(state)
    const child = state.child
    state.child = undefined
    state.connection = undefined
    if (child && child.exitCode === null) {
      child.stdin.end()
      terminateCliChild(child)
    }
  }
  const permission = (state: State, params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    if (!state.turn || state.cancelled || state.closed || params.sessionId !== state.nativeId)
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    if (state.turn.mode === 'ask' && !['read', 'search', 'fetch'].includes(params.toolCall.kind ?? 'other'))
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const requestId = `acp_permission_${++requestSequence}`
    const result = new Promise<RequestPermissionResponse>((resolve) =>
      state.pending.set(requestId, { options: params.options, resolve }),
    )
    emit(state, 'approval_requested', {
      requestId,
      kind: 'tool',
      action: params.toolCall.name ?? params.toolCall.title ?? params.toolCall.kind ?? 'Tool',
      input: params.toolCall.rawInput,
      toolKind: acpToolKind(params.toolCall.kind),
      toolUseId: params.toolCall.toolCallId,
      cwd: state.input.workspaceRoot,
    })
    return result
  }
  const update = (state: State, value: SessionUpdate) => {
    if (state.loading || !state.turn) return
    if (value.sessionUpdate === 'agent_message_chunk' || value.sessionUpdate === 'agent_thought_chunk') {
      if (value.content.type === 'text')
        emit(state, value.sessionUpdate === 'agent_message_chunk' ? 'content_delta' : 'reasoning_delta', {
          text: value.content.text,
        })
      if (value.sessionUpdate === 'agent_message_chunk' && value.content.type === 'text')
        state.assistantText += value.content.text
    } else if (value.sessionUpdate === 'tool_call' || value.sessionUpdate === 'tool_call_update') {
      const prior = state.toolCalls.get(value.toolCallId)
      const tool = { ...prior, ...value }
      state.toolCalls.set(value.toolCallId, tool)
      const content = value.content ?? []
      const diff = content.find((entry) => entry.type === 'diff')
      if (!prior || value.rawInput !== undefined || diff)
        emit(state, 'tool_started', {
          toolUseId: value.toolCallId,
          toolCallId: value.toolCallId,
          kind: acpToolKind(tool.kind as ToolKind | undefined),
          name: tool.name ?? tool.title ?? tool.kind ?? 'Tool',
          input: diff
            ? {
                ...(tool.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput : {}),
                path: diff.path,
                oldText: diff.oldText ?? '',
                newText: diff.newText,
              }
            : tool.rawInput,
        })
      const output =
        value.rawOutput ??
        content
          .map((entry) =>
            entry.type === 'content' && entry.content.type === 'text'
              ? entry.content.text
              : entry.type === 'diff'
                ? { path: entry.path, oldText: entry.oldText, newText: entry.newText }
                : '',
          )
          .filter(Boolean)
      if (value.status === 'completed' || value.status === 'failed' || value.rawOutput !== undefined || content.length)
        emit(state, 'tool_output', {
          toolUseId: value.toolCallId,
          toolCallId: value.toolCallId,
          output,
          status: value.status === 'failed' ? 'error' : value.status === 'completed' ? 'success' : 'running',
          isError: value.status === 'failed',
          partial: value.status !== 'completed' && value.status !== 'failed',
        })
    } else if (value.sessionUpdate === 'plan') {
      const toolUseId = `plan_${state.turn.turnId}`
      emit(state, 'tool_started', {
        toolUseId,
        toolCallId: toolUseId,
        kind: 'todo',
        name: 'Plan',
        input: { todos: value.entries.map((entry) => ({ content: entry.content, status: entry.status })) },
      })
      emit(state, 'tool_output', { toolUseId, toolCallId: toolUseId, output: '', status: 'success' })
    } else if (value.sessionUpdate === 'usage_update') {
      emit(state, 'usage_updated', {
        contextWindow: value.size,
        contextUsed: value.used,
        ...(value.cost?.currency === 'USD' ? { costUsd: value.cost.amount } : {}),
      })
    }
  }
  const environment = async (input: MockAdapterSessionInput): Promise<NodeJS.ProcessEnv> =>
    (
      options.buildEnv ??
      (async () => {
        const { getTerminalEnv } = await import('../terminal-launch')
        return Object.fromEntries(
          Object.entries(getTerminalEnv()).filter(
            ([key]) => !/^(SPRINTENGINE_|MULTICODE_|CODEX_|CLAUDECODE$|ELECTRON_)/.test(key),
          ),
        )
      })
    )(input)
  const permissionNotice = async (input: MockAdapterSessionInput) =>
    input.permissionPreset && profile.permissionNotice
      ? profile.permissionNotice(input.permissionPreset, await environment(input))
      : undefined
  const ensure = async (state: State) => {
    if (state.connection) return
    if (state.starting) return state.starting
    state.starting = (async () => {
      // The agent would run on this machine against a workspace that lives on
      // the other host; refuse rather than edit the wrong tree.
      const hostId = state.input.cliRuntimes?.[profile.cli]?.hostId
      if (hostId && hostId !== 'local')
        throw new Error(`${profile.displayName} conversation requires a local CLI runtime.`)
      const command = await (
        options.detect ??
        (async (input) => {
          const { detectCli } = await import('../cli-runtime-install')
          const result = await detectCli(profile.cli, input.cliRuntimes?.[profile.cli])
          if (!result.installed || !result.resolvedPath)
            throw new Error(
              `${profile.displayName} CLI was not found. Install it or configure its command in Settings.`,
            )
          return result.resolvedPath
        })
      )(state.input)
      const env = await environment(state.input)
      if (profile.cli === 'opencode' && state.input.permissionPreset === 'manual')
        env.OPENCODE_PERMISSION = JSON.stringify({ '*': 'ask' })
      if (state.closed) throw new Error('Conversation was stopped during startup.')
      const sdk = await import('@agentclientprotocol/sdk')
      if (state.closed) throw new Error('Conversation was stopped during startup.')
      const target = cliSpawnTarget(command, acpLaunchArgv(profile, state.input.permissionPreset), { env })
      const child = spawn(target.file, target.args, {
        cwd: state.input.workspaceRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      })
      state.child = child
      state.spawnedAt = Date.now()
      child.stderr.on('data', () => undefined)
      // A CLI that cannot be started is reported as that, not as a protocol
      // failure followed by a sign-in hint that would send the person the
      // wrong way. Later errors close the stream, which rejects what is pending.
      let spawnError: Error | undefined
      const spawnFailed = new Promise<never>((_, reject) =>
        child.on('error', (error) => {
          if (child.pid !== undefined) return
          spawnError = error
          reject(error)
        }),
      )
      spawnFailed.catch(() => undefined)
      child.stdin.on('error', () => undefined)
      child.on('close', () => {
        if (state.child !== child) return
        state.child = undefined
        state.connection = undefined
        cancelPermissions(state)
        if (state.queue) {
          emit(state, 'turn_failed', { message: `${profile.displayName} process exited.` })
          state.queue.end()
        }
      })
      let frameBytes = 0
      const boundedInput = (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            for (const byte of chunk) {
              frameBytes = byte === 10 ? 0 : frameBytes + 1
              if (frameBytes > 16 * 1024 * 1024) {
                dispose(state)
                throw new Error('ACP protocol frame exceeds the size limit.')
              }
            }
            controller.enqueue(chunk)
          },
        }),
      )
      const connection = new sdk.ClientSideConnection(
        () => ({
          requestPermission: (params) => permission(state, params),
          sessionUpdate: async (params) => {
            if (params.sessionId === state.nativeId || state.loading) update(state, params.update)
          },
          readTextFile: async (params) => {
            if (!state.turn || params.sessionId !== state.nativeId) throw new Error('No active conversation turn.')
            const path = await confinedAcpPath(state.input.workspaceRoot!, params.path)
            const file = await openConfinedExistingFile(state.input.workspaceRoot!, path)
            try {
              if ((await file.stat()).size > 2 * 1024 * 1024)
                throw new Error('File exceeds the conversation read limit.')
              const content = (await readBoundedConversationFile(file, 2 * 1024 * 1024)).toString('utf8')
              if (content.includes('\0')) throw new Error('Binary files are not supported.')
              const lines = content.split('\n'),
                start = Math.max(0, (params.line ?? 1) - 1)
              return {
                content:
                  params.line || params.limit
                    ? lines.slice(start, params.limit ? start + params.limit : undefined).join('\n')
                    : content,
              }
            } finally {
              await file.close()
            }
          },
          writeTextFile: async (params) => {
            if (!state.turn || params.sessionId !== state.nativeId) throw new Error('No active conversation turn.')
            if (state.turn.mode === 'ask' || state.turn.mode === 'plan')
              throw new Error('This conversation mode is read-only.')
            if (Buffer.byteLength(params.content) > 2 * 1024 * 1024)
              throw new Error('File exceeds the conversation write limit.')
            const path = await confinedAcpPath(state.input.workspaceRoot!, params.path, true)
            // Creating through an unanchored parent path can escape after a
            // directory swap, even with O_NOFOLLOW. Native CLI tools may create
            // files under their own policy; this callback edits existing files.
            // That is checked before asking, so an approval is never spent on a
            // write that cannot happen, and the current text becomes the
            // before side of the change the person is asked to approve.
            const openExisting = (access: 'read' | 'write') =>
              openConfinedExistingFile(state.input.workspaceRoot!, path, access).catch((error) => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                  throw new Error(
                    'Conversation file callbacks can edit existing files only. Use the native CLI file tool to create a file.',
                  )
                throw error
              })
            const current = await openExisting('read')
            let oldText: string | undefined
            try {
              if ((await current.stat()).size <= WRITE_PREVIEW_BYTES) {
                const text = (await readBoundedConversationFile(current, WRITE_PREVIEW_BYTES)).toString('utf8')
                if (!text.includes('\0')) oldText = text
              }
            } finally {
              await current.close()
            }
            const preview =
              oldText !== undefined && Buffer.byteLength(params.content) <= WRITE_PREVIEW_BYTES
                ? { oldText, newText: params.content }
                : { bytes: Buffer.byteLength(params.content) }
            const decision = await permission(state, {
              sessionId: params.sessionId,
              toolCall: {
                toolCallId: `write_${++requestSequence}`,
                kind: 'edit',
                name: 'Write',
                rawInput: { path, ...preview },
              },
              options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
            })
            if (decision.outcome.outcome !== 'selected') throw new Error('File write was not approved.')
            await state.input.onBeforeTool?.('Write')
            await confinedAcpPath(state.input.workspaceRoot!, params.path, true)
            const file = await openExisting('write')
            try {
              await file.truncate(0)
              await file.writeFile(params.content, 'utf8')
            } finally {
              await file.close()
            }
          },
        }),
        sdk.ndJsonStream(Writable.toWeb(child.stdin), boundedInput),
      )
      const initialize = async () => {
        const hello = await connection.initialize({
          protocolVersion: sdk.PROTOCOL_VERSION,
          clientInfo: { name: 'sprintengine-studio', version: '1' },
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        })
        if (hello.protocolVersion !== sdk.PROTOCOL_VERSION) throw new Error('ACP protocol version is incompatible.')
        state.loadSupported = hello.agentCapabilities?.loadSession === true
        state.capabilities = {
          ...baseCapabilities(profile),
          resume: state.loadSupported,
          images: hello.agentCapabilities?.promptCapabilities?.image === true,
        }
        if (profile.authenticate && hello.authMethods?.some((method) => method.id === profile.authenticate))
          await connection.authenticate({ methodId: profile.authenticate })
        // Replayed history is suppressed while loading. The flag must drop on
        // every exit, or the failure this startup reports is suppressed too
        // and the turn that triggered a reload never receives a terminal event.
        state.loading = true
        try {
          await openSession(connection)
        } finally {
          state.loading = false
        }
        if (state.closed || state.child !== child || child.exitCode !== null)
          throw new Error('Conversation was stopped during startup.')
        state.connection = connection
      }
      const openSession = async (connection: ClientSideConnection) => {
        const resumeId = state.nativeId ?? state.input.resumeSessionId
        state.replayHistory = Boolean(resumeId && !state.loadSupported)
        const fresh = () => connection.newSession({ cwd: state.input.workspaceRoot!, mcpServers: [] })
        let session: Awaited<ReturnType<typeof fresh>> | Awaited<ReturnType<ClientSideConnection['loadSession']>>
        if (resumeId && state.loadSupported) {
          try {
            session = await connection.loadSession({
              sessionId: resumeId,
              cwd: state.input.workspaceRoot!,
              mcpServers: [],
            })
          } catch (error) {
            // The agent answered that it cannot load this session (it was
            // deleted, or the cursor came from another machine). Asking again
            // would fail on every turn, so continue in a new session, carry the
            // conversation over as context, and say so. Any other answer (the
            // session is busy, a rate limit, an internal error) and a request
            // that was never answered fail this turn and keep the id, since
            // the session may still be there to reopen next time.
            if (!isMissingSessionError(error)) throw error
            session = await fresh()
            state.replayHistory = true
            state.resumeNotice = `${profile.displayName} could not reopen its previous session, so this conversation continues in a new one. The earlier messages were passed to it as context.`
          }
        } else session = await fresh()
        state.nativeId = 'sessionId' in session ? String(session.sessionId) : resumeId
        state.modes = session.modes?.availableModes.map((mode) => mode.id) ?? []
        state.defaultMode = session.modes?.currentModeId
        const modeConfig = session.configOptions?.find((option) => option.category === 'mode')
        state.modeConfigId = modeConfig?.id
        if (!state.modes.length && modeConfig && 'options' in modeConfig) {
          state.modes = modeConfig.options.flatMap((option) =>
            'value' in option ? [option.value] : option.options.map((entry) => entry.value),
          )
          state.defaultMode = modeConfig.currentValue
        }
        state.capabilities.planMode = state.modes.includes('plan')
        const modelConfig = session.configOptions?.find((option) => option.category === 'model')
        if (modelConfig && 'options' in modelConfig) {
          for (const option of modelConfig.options) {
            for (const id of 'value' in option ? [option.value] : option.options.map((entry) => entry.value))
              modelIds.add(id)
          }
        }
        if (state.input.modelId !== 'default') {
          if (modelConfig)
            await connection.setSessionConfigOption({
              sessionId: state.nativeId!,
              configId: modelConfig.id,
              value: state.input.modelId,
            })
          else throw new Error('This ACP agent does not expose model selection. Choose the default model.')
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          initialize(),
          spawnFailed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('ACP startup timed out.')), options.startupTimeoutMs ?? 30_000)
          }),
        ])
      } catch (error) {
        dispose(state)
        if (child.pid === undefined)
          throw new Error(
            `${profile.displayName} could not be started from ${command}: ${spawnError?.message ?? 'the process did not start.'}`,
          )
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${profile.authHint}`)
      } finally {
        if (timer) clearTimeout(timer)
      }
    })().finally(() => {
      state.starting = undefined
    })
    return state.starting
  }
  return {
    id: profile.id,
    displayName: profile.displayName,
    capabilities: baseCapabilities(profile),
    sessions: 'stateful',
    listModels: () => Array.from(modelIds),
    async startSession(input) {
      if (input.permissionPreset && !supportedPresets(profile).includes(input.permissionPreset))
        throw new Error(
          `${profile.displayName} ACP cannot enforce the ${input.permissionPreset} permission preset. Choose another permission preset.`,
        )
      const state: State = {
        input,
        closed: false,
        loading: false,
        loadSupported: false,
        cancelled: false,
        pending: new Map(),
        toolCalls: new Map(),
        lastActivityAt: Date.now(),
        spawnedAt: null,
        capabilities: baseCapabilities(profile),
        modes: [],
        history: [],
        replayHistory: false,
        assistantText: '',
      }
      sessions.set(input.sessionId, state)
      try {
        await ensure(state)
      } catch (error) {
        sessions.delete(input.sessionId)
        throw error
      }
      const notice = [state.resumeNotice, await permissionNotice(input)].filter(Boolean).join(' ')
      state.resumeNotice = undefined
      return [
        event(state, 'session_started', { providerSessionId: state.nativeId, capabilities: state.capabilities }),
        ...(notice ? [event(state, 'session_updated', { providerSessionId: state.nativeId, notice })] : []),
      ]
    },
    sendTurn(input) {
      const state = sessions.get(input.sessionId)
      if (!state || state.closed) throw new Error('ACP session is unavailable.')
      if (state.turn) throw new Error('ACP turn is already active.')
      const queue = new Queue()
      state.queue = queue
      state.turn = input
      state.cancelled = false
      state.toolCalls.clear()
      state.assistantText = ''
      const abort = () => {
        state.cancelled = true
        cancelPermissions(state)
        if (state.nativeId) void state.connection?.cancel({ sessionId: state.nativeId }).catch(() => dispose(state))
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      void (async () => {
        try {
          const refusal = permissionCommandRefusal(profile, state.input.permissionPreset, input.message)
          if (refusal) throw new Error(refusal)
          const previousId = state.nativeId
          await ensure(state)
          // A reconnect can land in a different session; record it as the
          // resume cursor, or the next restart would try the old one again.
          if (state.nativeId !== previousId || state.resumeNotice) {
            const notice = state.resumeNotice
            state.resumeNotice = undefined
            emit(state, 'session_updated', { providerSessionId: state.nativeId, ...(notice ? { notice } : {}) })
          }
          if (input.signal?.aborted || state.cancelled) throw new Error('interrupted')
          if (input.mode || state.defaultMode) {
            const desired = !input.mode || input.mode === 'default' ? state.defaultMode : input.mode
            if (!desired || !state.modes.includes(desired))
              throw new Error('This mode is unavailable from the ACP agent.')
            if (state.modeConfigId)
              await state.connection!.setSessionConfigOption({
                sessionId: state.nativeId!,
                configId: state.modeConfigId,
                value: desired,
              })
            else await state.connection!.setSessionMode({ sessionId: state.nativeId!, modeId: desired })
          }
          await state.input.onBeforeTool?.('ACP agent turn')
          emit(state, 'turn_started', { providerSessionId: state.nativeId })
          const prior = state.replayHistory
            ? [
                ...(state.input.fallbackHistory ?? []).map((message) => `${message.role}: ${message.content}`),
                ...state.history.map((turn) => `User: ${turn.user}\nAssistant: ${turn.assistant}`),
              ].join('\n\n')
            : ''
          const prompt: Parameters<ClientSideConnection['prompt']>[0]['prompt'] = [
            {
              type: 'text',
              text: prior ? `Previous conversation:\n${prior}\n\nUser: ${input.message}` : input.message,
            },
          ]
          state.replayHistory = false
          if (input.attachments?.length && !state.capabilities.images)
            throw new Error('This ACP agent does not support images.')
          for (const attachment of input.attachments ?? [])
            prompt.push({ type: 'image', data: attachment.dataBase64, mimeType: attachment.mediaType })
          const result = await state.connection!.prompt({ sessionId: state.nativeId!, prompt })
          if (result.usage)
            emit(state, 'usage_updated', {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            })
          if (!state.cancelled && result.stopReason !== 'cancelled')
            state.history.push({ user: input.message, assistant: state.assistantText })
          emit(
            state,
            state.cancelled || result.stopReason === 'cancelled' ? 'turn_failed' : 'turn_completed',
            state.cancelled || result.stopReason === 'cancelled'
              ? { reason: 'interrupted' }
              : { stopReason: result.stopReason },
          )
        } catch (error) {
          emit(state, 'turn_failed', {
            message: state.cancelled ? 'interrupted' : error instanceof Error ? error.message : String(error),
          })
        } finally {
          input.signal?.removeEventListener('abort', abort)
          cancelPermissions(state)
          state.turn = undefined
          state.queue = undefined
          queue.end()
        }
      })()
      return queue
    },
    resolveApproval(input) {
      const state = sessions.get(input.sessionId),
        pending = state?.pending.get(input.requestId)
      if (!state || !pending) return []
      const selected = pending.options.find((option) => option.kind === (input.approved ? 'allow_once' : 'reject_once'))
      // Never convert a once-only approval into an agent-wide persistent grant.
      pending.resolve(
        selected
          ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
          : { outcome: { outcome: 'cancelled' } },
      )
      state.pending.delete(input.requestId)
      return [
        event(state, 'approval_resolved', {
          requestId: input.requestId,
          approved: input.approved && Boolean(selected),
        }),
      ]
    },
    async setPermissionPreset(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'ACP session is unavailable.' }
      if (!supportedPresets(profile).includes(input.permissionPreset))
        return {
          ok: false,
          message: `${profile.displayName} ACP cannot enforce this permission preset. Choose another permission preset.`,
        }
      if (state.turn) return { ok: false, message: 'Wait for the active turn before changing ACP permissions.' }
      state.input.permissionPreset = input.permissionPreset
      // The preset is a launch flag, so the child is replaced: the next turn
      // starts a new one under the new flags and reloads this session.
      dispose(state)
      const notice = await permissionNotice(state.input)
      return notice ? { ok: true, notice } : { ok: true }
    },
    async interrupt(input) {
      const state = sessions.get(input.sessionId)
      if (state) {
        state.cancelled = true
        cancelPermissions(state)
        if (state.nativeId) await state.connection?.cancel({ sessionId: state.nativeId })
        dispose(state)
      }
      return []
    },
    stopSession(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return []
      state.closed = true
      dispose(state)
      sessions.delete(input.sessionId)
      return []
    },
    disposeAll() {
      for (const state of sessions.values()) {
        state.closed = true
        dispose(state)
      }
      sessions.clear()
    },
    disposeChildProcess(sessionId) {
      const state = sessions.get(sessionId)
      if (!state || state.turn || state.pending.size) return false
      dispose(state)
      return true
    },
    listLiveSessions() {
      return Array.from(sessions.values(), (state) => ({
        sessionId: state.input.sessionId,
        workspaceId: state.input.workspaceId,
        agentId: state.input.agentId,
        workspaceRoot: state.input.workspaceRoot!,
        providerSessionId: state.nativeId ?? null,
        hasChildProcess: Boolean(state.child),
        childPid: state.child?.pid ?? null,
        turnActive: Boolean(state.turn),
        pendingApproval: state.pending.size > 0,
        lastActivityAt: state.lastActivityAt,
        spawnedAt: state.spawnedAt,
      }))
    },
  }
}

/** The agent answered `session/load` that the session does not exist, rather than that it cannot be opened now. */
function isMissingSessionError(error: unknown): boolean {
  const { code, message, data } = (error ?? {}) as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof code !== 'number') return false
  // JSON-RPC "resource not found".
  if (code === -32002) return true
  let detail = ''
  try {
    detail = data === undefined ? '' : JSON.stringify(data)
  } catch {
    // Unserializable detail says nothing about the session.
  }
  return /not found|no such session|unknown session|does not exist|invalid session/i.test(
    `${typeof message === 'string' ? message : ''} ${detail}`,
  )
}
