import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { lstat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import {
  openConfinedExistingFile,
  readBoundedConversationFile,
  resolveConversationPath,
} from '../conversation-file-access'
import { cliSpawnTarget, terminateCliChild } from './cli-child-process'
import { publishConversationCommands } from '../conversation-commands/registry'
import { acpConversationCommands } from '../conversation-commands/acp'
import { leadingCommandFor } from '../conversation-commands/leading-command'
import type { ConversationCommand } from '../../shared/conversation/commands'
import { conversationPermissionPresetRefusals } from '../../shared/conversation-harness'
import { isLooserCliPermissionPreset } from '../../shared/cli-permission-preset'
import type {
  ClientSideConnection,
  McpCapabilities,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk'
import type {
  ConversationCapabilities,
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationMcpServer,
  ConversationPermissionPreset,
  ConversationToolKind,
} from '../../shared/conversation-runtime'
import type {
  ConversationProviderAdapter,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './conversation-provider-adapter'

type EnforcedPreset = Exclude<ConversationPermissionPreset, 'none'>

/** How a CLI is told one permission preset: launch argv in place of the plain one, environment on top, or both. */
type AcpPresetLaunch = { argv?: string[]; env?: Record<string, string> }

export type AcpProfile = {
  id: string
  displayName: string
  cli: string
  // The launch argv under `none`: no permission flag, so the CLI's own
  // configuration decides.
  argv: string[]
  // How the CLI is told each preset it can be held to. Both are fixed when
  // the child starts, so changing the preset respawns it and reloads the
  // session, at the next turn when one is running. A preset missing here is
  // one the CLI cannot be held to; `unsupported` says why, and it is refused
  // rather than run as something else.
  presets?: Partial<Record<EnforcedPreset, AcpPresetLaunch>>
  unsupported?: Partial<Record<EnforcedPreset, string>>
  // Commands the CLI accepts in the prompt that switch its own permission mode,
  // with the least permissive preset that already allows what they switch to.
  // Typed under a stricter preset, they would undo the person's choice from
  // inside the conversation, where the permission picker cannot see it.
  permissionCommands?: Record<string, EnforcedPreset>
  authHint: string
  authenticate?: string
  images: boolean
  planMode: boolean
}

// OpenCode's permission rule set for a preset. `opencode acp` takes no
// permission flag (`--auto` belongs to the TUI and `run`), but its
// configuration takes a rule set from OPENCODE_PERMISSION, merged over the
// person's own, and the last matching rule wins. So the wildcard comes first
// and every tool OpenCode names follows it, each overriding the person's rule
// for the same tool; reads, searches, listings and the to-do list run, and
// `external_directory` (anything outside the project) asks.
function opencodePermission(edit: 'allow' | 'ask'): Record<string, string> {
  return {
    OPENCODE_PERMISSION: JSON.stringify({
      '*': 'ask',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      lsp: 'allow',
      todoread: 'allow',
      todowrite: 'allow',
      edit,
      bash: 'ask',
      task: 'ask',
      webfetch: 'ask',
      websearch: 'ask',
      codesearch: 'ask',
      external_directory: 'ask',
    }),
  }
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
    // its own configuration does not already allow. `--auto-review` is its own
    // Auto: a classifier runs the calls it judges safe and asks for the rest.
    presets: {
      auto: { argv: ['--auto-review', 'acp'] },
      bypass: { argv: ['--force', 'acp'] },
    },
    unsupported: conversationPermissionPresetRefusals('cursor'),
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
    presets: {
      manual: { env: opencodePermission('ask') },
      auto: { env: opencodePermission('allow') },
      // A wildcard allow is what `--auto` does for the TUI.
      bypass: { env: { OPENCODE_PERMISSION: JSON.stringify({ '*': 'allow' }) } },
    },
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
    // overrides the configured mode for this process: Grok has the same modes
    // Claude Code does, so Manual is `default` and Auto `acceptEdits`.
    // --always-approve is an agent option (after `agent`, before the transport).
    argv: ['agent', '--no-leader', 'stdio'],
    presets: {
      manual: { argv: ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio'] },
      auto: { argv: ['--permission-mode', 'acceptEdits', 'agent', '--no-leader', 'stdio'] },
      bypass: { argv: ['agent', '--always-approve', '--no-leader', 'stdio'] },
    },
    // Grok's `/auto` hands its approvals to a classifier, which answers for the
    // person the way bypass does rather than asking; `/always-approve` is bypass.
    permissionCommands: { '/always-approve': 'bypass', '/auto': 'bypass' },
    authHint: 'Run grok login in a terminal.',
    images: false,
    planMode: false,
  },
]

const supportedPresets = (profile: AcpProfile): ConversationPermissionPreset[] => [
  'none',
  ...(Object.keys(profile.presets ?? {}) as EnforcedPreset[]),
]

/** The argv a conversation's child is launched with under a permission preset. */
export function acpLaunchArgv(profile: AcpProfile, preset: ConversationPermissionPreset = 'none'): string[] {
  return (preset !== 'none' && profile.presets?.[preset]?.argv) || profile.argv
}

/** What a conversation's child gets on top of its environment under a permission preset. */
export function acpLaunchEnv(
  profile: AcpProfile,
  preset: ConversationPermissionPreset = 'none',
): Record<string, string> {
  return (preset !== 'none' && profile.presets?.[preset]?.env) || {}
}

/** Why a CLI cannot run a preset, or null when it can. */
function presetRefusal(profile: AcpProfile, preset: ConversationPermissionPreset): string | null {
  if (supportedPresets(profile).includes(preset)) return null
  const reason = preset === 'none' ? undefined : profile.unsupported?.[preset]
  return `${reason ?? `${profile.displayName} cannot be held to this permission preset.`} Choose another permission preset.`
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
  if (!needs || !isLooserCliPermissionPreset(needs, preset)) return undefined
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
  liveModelSwitch: true,
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
  // What the agent said it can connect to, from its handshake.
  mcpCapabilities?: McpCapabilities
  child?: ChildProcessWithoutNullStreams
  connection?: ClientSideConnection
  starting?: Promise<void>
  nativeId?: string
  closed: boolean
  loading: boolean
  loadSupported: boolean
  queue?: Queue
  turn?: MockAdapterTurnInput
  // Settles when the running turn has ended, however it ended.
  turnEnded?: Promise<void>
  cancelled: boolean
  // Ends the process of a stopped turn the agent does not wind down; see
  // ACP_CANCEL_GRACE_MS.
  cancelWatchdog?: ReturnType<typeof setTimeout>
  pending: Map<string, Pending>
  toolCalls: Map<string, Record<string, unknown>>
  lastActivityAt: number
  spawnedAt: number | null
  capabilities: ConversationCapabilities
  modes: string[]
  defaultMode?: string
  modeConfigId?: string
  // The agent's model config option, the value it started on (what the CLI's
  // own default row maps back to), and the model the live session is on — a
  // switch is applied at the start of the next turn when these disagree.
  modelConfigId?: string
  defaultModelValue?: string
  appliedModelId?: string
  history: Array<{ user: string; assistant: string }>
  replayHistory: boolean
  // Set when a stored session could not be reopened; reported once, with the
  // replacement session's identity, so the person knows context was replayed.
  resumeNotice?: string
  assistantText: string
  // The preset changed while a turn ran; the next turn starts a new child.
  relaunch?: boolean
}
// A change larger than this is approved by path and size: the approval card is
// persisted with the transcript, and a multi-megabyte diff would dominate it.
const WRITE_PREVIEW_BYTES = 256 * 1024
// The largest protocol line an agent may print before it is taken for broken.
const MAX_FRAME_BYTES = 16 * 1024 * 1024
// How long a stopped turn waits for the agent to answer its prompt after
// `session/cancel`. The protocol has the prompt resolve as cancelled, and the
// process is kept for the next turn; one that does not answer by then is
// ended, so Stop always takes effect.
export const ACP_CANCEL_GRACE_MS = 5_000

type Options = {
  detect?: (input: MockAdapterSessionInput) => Promise<string>
  buildEnv?: (input: MockAdapterSessionInput) => Promise<NodeJS.ProcessEnv>
  startupTimeoutMs?: number
  cancelGraceMs?: number
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

async function detectAcpCommand(profile: AcpProfile, cliRuntimes?: ConversationCliRuntimeOverrides): Promise<string> {
  const { resolveCliExecutable } = await import('../cli-runtime-install')
  const { path } = await resolveCliExecutable(profile.cli, cliRuntimes?.[profile.cli])
  if (!path)
    throw new Error(`${profile.displayName} CLI was not found. Install it or configure its command in Settings.`)
  return path
}

// The CLI could not be started from where it was found: look it up again on
// the next start.
function forgetAcpCommand(profile: AcpProfile): void {
  void import('../cli-runtime-install').then(({ invalidateCliExecutable }) => invalidateCliExecutable(profile.cli))
}

async function acpEnvironment(): Promise<NodeJS.ProcessEnv> {
  const { getTerminalEnv } = await import('../terminal-launch')
  return Object.fromEntries(
    Object.entries(getTerminalEnv()).filter(
      ([key]) => !/^(SPRINTENGINE_|MULTICODE_|CODEX_|CLAUDECODE$|ELECTRON_)/.test(key),
    ),
  )
}

/**
 * The commands an ACP CLI lists before any chat has started, published for the
 * composer's `/` menu. Only a list the agent gives in its `initialize` answer
 * is read (Grok does): opening a session just to list would leave an empty
 * chat in the CLI's own history, so Cursor and OpenCode are listed once a
 * chat's session opens. Resolves null when the CLI gives no list this way.
 */
export async function probeAcpConversationCommands(
  profile: AcpProfile,
  input: { cwd: string; cliRuntimes?: ConversationCliRuntimeOverrides },
  options: { detect?: () => Promise<string>; buildEnv?: () => Promise<NodeJS.ProcessEnv>; timeoutMs?: number } = {},
): Promise<ConversationCommand[] | null> {
  const hostId = input.cliRuntimes?.[profile.cli]?.hostId
  if (hostId && hostId !== 'local') return null
  const command = await (options.detect ?? (() => detectAcpCommand(profile, input.cliRuntimes)))()
  const env = await (options.buildEnv ?? acpEnvironment)()
  const sdk = await import('@agentclientprotocol/sdk')
  const target = cliSpawnTarget(command, profile.argv, { env })
  const child = spawn(target.file, target.args, {
    cwd: input.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
  child.stderr.on('data', () => undefined)
  child.stdin.on('error', () => undefined)
  const failed = new Promise<never>((_, reject) => {
    child.on('error', reject)
    child.on('close', () => reject(new Error(`${profile.displayName} exited before answering.`)))
  })
  failed.catch(() => undefined)
  // Nothing is asked of this client before a session exists; refuse anything that is.
  const refuse = async (): Promise<never> => {
    throw new Error('No conversation is open.')
  }
  const connection = new sdk.ClientSideConnection(
    () => ({
      requestPermission: refuse,
      sessionUpdate: async () => undefined,
      readTextFile: refuse,
      writeTextFile: refuse,
    }),
    sdk.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const hello = await Promise.race([
      connection.initialize({
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientInfo: { name: 'sprintengine-studio', version: '1' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      failed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${profile.displayName} did not answer.`)),
          options.timeoutMs ?? 10_000,
        )
      }),
    ])
    const advertised = hello._meta?.availableCommands
    if (!Array.isArray(advertised)) return null
    const commands = acpConversationCommands(advertised)
    publishConversationCommands({ cli: profile.cli, cwd: input.cwd, commands })
    return commands
  } finally {
    if (timer) clearTimeout(timer)
    child.stdin.end()
    terminateCliChild(child)
  }
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
  // Stop the running turn with the protocol's own `session/cancel`, keeping
  // the process: respawning it would sign in again and reload (or, without
  // session loading, replay as a prompt) the whole conversation on the next
  // turn. The process is ended only when the cancel cannot be sent or the
  // agent has not wound the turn down within ACP_CANCEL_GRACE_MS.
  const cancelTurn = async (state: State) => {
    state.cancelled = true
    cancelPermissions(state)
    const turn = state.turn
    if (!turn) return
    if (!state.cancelWatchdog) {
      state.cancelWatchdog = setTimeout(() => {
        state.cancelWatchdog = undefined
        if (state.turn === turn) dispose(state)
      }, options.cancelGraceMs ?? ACP_CANCEL_GRACE_MS)
      state.cancelWatchdog.unref?.()
    }
    if (!state.nativeId || !state.connection) return
    await state.connection.cancel({ sessionId: state.nativeId }).catch(() => dispose(state))
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
  // The agent's command list, for the composer's `/` menu. ACP agents send it
  // on their own schedule — right after `session/new`, outside any turn — and
  // send it again whole when it changes, so each one replaces the last.
  const publishCommands = (state: State, available: unknown) =>
    publishConversationCommands({
      cli: profile.cli,
      cwd: state.input.workspaceRoot!,
      commands: acpConversationCommands(available),
    })
  const update = (state: State, value: SessionUpdate) => {
    // The one update read outside a turn: it describes the session, not a
    // reply, so it touches no turn state. Everything else out of turn is
    // replayed history or stray output and stays dropped.
    if (value.sessionUpdate === 'available_commands_update') return publishCommands(state, value.availableCommands)
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
    (options.buildEnv ?? acpEnvironment)(input)
  const ensure = async (state: State) => {
    if (state.connection) return
    if (state.starting) return state.starting
    state.starting = (async () => {
      // The agent would run on this machine against a workspace that lives on
      // the other host; refuse rather than edit the wrong tree.
      const hostId = state.input.cliRuntimes?.[profile.cli]?.hostId
      if (hostId && hostId !== 'local')
        throw new Error(`${profile.displayName} conversation requires a local CLI runtime.`)
      const command = await (options.detect ?? ((input) => detectAcpCommand(profile, input.cliRuntimes)))(state.input)
      const env = await environment(state.input)
      Object.assign(env, acpLaunchEnv(profile, state.input.permissionPreset))
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
      // The bytes since the last newline: only the chunk's first and last
      // newline matter, found natively rather than by walking every byte.
      let frameBytes = 0
      const boundedInput = (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            const first = chunk.indexOf(10)
            const oversized =
              first < 0 ? frameBytes + chunk.length > MAX_FRAME_BYTES : frameBytes + first > MAX_FRAME_BYTES
            frameBytes = first < 0 ? frameBytes + chunk.length : chunk.length - chunk.lastIndexOf(10) - 1
            if (oversized) {
              dispose(state)
              throw new Error('ACP protocol frame exceeds the size limit.')
            }
            controller.enqueue(chunk)
          },
        }),
      )
      const connection = new sdk.ClientSideConnection(
        () => ({
          // A child that has been replaced (a permission change relaunches it)
          // can still be flushing what it said last; none of it belongs to the
          // turn its replacement is running.
          requestPermission: (params) =>
            state.child === child ? permission(state, params) : Promise.resolve({ outcome: { outcome: 'cancelled' } }),
          sessionUpdate: async (params) => {
            if (state.child !== child) return
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
        // Grok lists its commands in the handshake, before any session.
        const advertised = hello._meta?.availableCommands
        if (Array.isArray(advertised)) publishCommands(state, advertised)
        state.loadSupported = hello.agentCapabilities?.loadSession === true
        state.mcpCapabilities = hello.agentCapabilities?.mcpCapabilities ?? undefined
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
        // The session's own servers, on a new session and a reopened one alike.
        const mcpServers = acpMcpServers(state.input.mcpServers ?? [], state.mcpCapabilities, profile.displayName)
        const fresh = () => connection.newSession({ cwd: state.input.workspaceRoot!, mcpServers })
        let session: Awaited<ReturnType<typeof fresh>> | Awaited<ReturnType<ClientSideConnection['loadSession']>>
        if (resumeId && state.loadSupported) {
          try {
            session = await connection.loadSession({
              sessionId: resumeId,
              cwd: state.input.workspaceRoot!,
              mcpServers,
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
        state.modelConfigId = modelConfig?.id
        state.defaultModelValue =
          modelConfig && 'currentValue' in modelConfig ? String(modelConfig.currentValue) : undefined
        state.appliedModelId = state.input.modelId
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
        if (child.pid === undefined) {
          if (!options.detect) forgetAcpCommand(profile)
          throw new Error(
            `${profile.displayName} could not be started from ${command}: ${spawnError?.message ?? 'the process did not start.'}`,
          )
        }
        // Not a sign-in problem, so without the sign-in hint.
        if (error instanceof AcpMcpServerUnsupportedError) throw error
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
    acceptsMcpServers: true,
    listModels: () => Array.from(modelIds),
    async startSession(input) {
      const refused = input.permissionPreset ? presetRefusal(profile, input.permissionPreset) : null
      if (refused) throw new Error(refused)
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
      const notice = state.resumeNotice
      state.resumeNotice = undefined
      return [
        event(state, 'session_started', { providerSessionId: state.nativeId, capabilities: state.capabilities }),
        ...(notice ? [event(state, 'session_updated', { providerSessionId: state.nativeId, notice })] : []),
      ]
    },
    async sendTurn(input) {
      const state = sessions.get(input.sessionId)
      if (!state || state.closed) throw new Error('ACP session is unavailable.')
      // A stopped turn the agent is still winding down is over from the
      // person's side: wait for it (the watchdog bounds the wait).
      if (state.turn && state.cancelled) await state.turnEnded
      if (state.closed) throw new Error('ACP session is unavailable.')
      if (state.turn) throw new Error('ACP turn is already active.')
      const queue = new Queue()
      let turnEnded = () => {}
      state.turnEnded = new Promise<void>((resolve) => {
        turnEnded = resolve
      })
      state.queue = queue
      state.turn = input
      state.cancelled = false
      state.assistantText = ''
      const abort = () => void cancelTurn(state)
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
          // A model switched since the session last ran lands here, before the
          // prompt, so this turn is the first on the new model.
          if (state.input.modelId !== state.appliedModelId) {
            const value = state.input.modelId === 'default' ? state.defaultModelValue : state.input.modelId
            if (!state.modelConfigId || !value)
              throw new Error('This ACP agent does not expose model selection. Choose the default model.')
            await state.connection!.setSessionConfigOption({
              sessionId: state.nativeId!,
              configId: state.modelConfigId,
              value,
            })
            state.appliedModelId = state.input.modelId
          }
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
          // A slash command runs only from the start of the prompt, so the
          // replayed conversation waits for the next message rather than
          // pushing the command off it and into prose.
          const command = leadingCommandFor(input.message, { cli: profile.cli, cwd: state.input.workspaceRoot })
          const prior =
            state.replayHistory && !command
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
          if (!command) state.replayHistory = false
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
          if (state.cancelWatchdog) clearTimeout(state.cancelWatchdog)
          state.cancelWatchdog = undefined
          // The turn's tool calls (diffs included) are only needed while it runs.
          state.toolCalls.clear()
          state.turn = undefined
          state.queue = undefined
          // A preset chosen while this turn ran is a launch flag: the child it
          // ran in is replaced now, once nothing it still says can reach a
          // turn, and the next turn reloads the session under the new flags.
          if (state.relaunch) {
            state.relaunch = false
            dispose(state)
          }
          queue.end()
          turnEnded()
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
    // The model is the agent's session config option. It is recorded here and
    // applied at the start of the next turn (sendTurn), so a turn already
    // running keeps the model it started with and a respawn starts on the new
    // one (initialize applies `input.modelId`).
    async setModel(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'ACP session is unavailable.' }
      state.input = { ...state.input, modelId: input.nextModelId }
      return state.turn
        ? {
            ok: true,
            notice: 'The new model starts with your next message — this reply finishes on the model it started with.',
          }
        : { ok: true }
    },
    // The preset is a launch flag (or a launch environment), so the child is
    // replaced: the next turn starts a new one under the new flags and reloads
    // this session. A turn already running finishes in the child it started
    // in, and the runtime answers what it still asks by the new mode.
    async setPermissionPreset(input) {
      const state = sessions.get(input.sessionId)
      if (!state) return { ok: false, message: 'ACP session is unavailable.' }
      const refused = presetRefusal(profile, input.permissionPreset)
      if (refused) return { ok: false, message: refused }
      state.input.permissionPreset = input.permissionPreset
      if (state.turn && (state.child || state.starting)) {
        state.relaunch = true
        return { ok: true, notice: `${profile.displayName} takes the new permissions from your next message.` }
      }
      dispose(state)
      return { ok: true }
    },
    async interrupt(input) {
      const state = sessions.get(input.sessionId)
      if (state) await cancelTurn(state)
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
    // A running turn keeps its process, except one already stopped: Settle
    // and Snooze interrupt and then dispose straight away, before the agent
    // has answered the cancel, and the process has nothing left to do.
    // `force` ends it whatever it is doing; its pending cards are cancelled.
    disposeChildProcess(sessionId, options) {
      const state = sessions.get(sessionId)
      if (!state) return false
      if (!options?.force && ((state.turn && !state.cancelled) || state.pending.size)) return false
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

/** An MCP server this agent cannot connect to; see acpMcpServers. */
class AcpMcpServerUnsupportedError extends Error {}

/**
 * A session's MCP servers as ACP's `session/new` takes them. Every agent takes
 * a stdio server; HTTP and SSE only when its handshake says so, and a server
 * it cannot take refuses the start rather than being left out. ACP names an
 * environment explicitly, so the variables a server's entry names
 * (`envVarNames`) are read from this app's own environment here, as is an
 * HTTP server's bearer token.
 */
export function acpMcpServers(
  servers: readonly ConversationMcpServer[],
  capabilities: McpCapabilities | undefined,
  agentName: string,
): McpServer[] {
  const fromEnv = (names: readonly string[] | undefined) =>
    (names ?? []).flatMap((name) => {
      const value = process.env[name]
      return value ? [{ name, value }] : []
    })
  return servers.map((server): McpServer => {
    if (server.transport === 'stdio') {
      return {
        name: server.id,
        command: server.command ?? '',
        args: server.args ?? [],
        env: [
          ...Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
          ...fromEnv(server.envVarNames),
        ],
      }
    }
    if (!capabilities?.[server.transport]) {
      throw new AcpMcpServerUnsupportedError(
        `${agentName} does not connect to ${server.transport.toUpperCase()} MCP servers, so it cannot run with "${server.name || server.id}". Choose a CLI whose chats can, such as Claude Code or Codex.`,
      )
    }
    const headers = Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
    const token = server.envVarNames?.[0] ? process.env[server.envVarNames[0]] : undefined
    if (token && !headers.some((header) => header.name.toLowerCase() === 'authorization'))
      headers.push({ name: 'Authorization', value: `Bearer ${token}` })
    return { type: server.transport, name: server.id, url: server.url ?? '', headers }
  })
}
