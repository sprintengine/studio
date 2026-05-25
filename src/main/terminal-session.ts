import type { WebContents } from 'electron'
import type * as pty from 'node-pty'
import type {
  AgentCli,
  AgentExecutionMode,
  AgentSessionIdentity,
  SessionActivity,
  TerminalKind,
  TerminalPathStyle,
  TerminalSessionSnapshot,
} from '../shared/electron-api'

export type TerminalSize = {
  cols: number
  rows: number
}

type FailedTerminalSessionInput = {
  sessionId: string
  sender?: WebContents
  message: string
  at?: number
  exitCode?: number
  kind?: TerminalKind
  pathStyle?: TerminalPathStyle
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  sprintEngineStatePath?: string
  sprintEngineMcpRunId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  agentSession?: AgentSessionIdentity
  visible?: boolean
  lastOutputAt?: number | null
  lastInputAt?: number | null
}

export type TerminalSession = {
  sessionId: string
  process: pty.IPty
  sender: WebContents
  isReady: boolean
  hasExited: boolean
  exitedAt: number | null
  exitCode?: number
  isDisposed: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  activity: SessionActivity
  outputChunks: string[]
  outputChunkBytes: number[]
  outputChunkStart: number
  outputBytes: number
  outputLength: number
  kind: TerminalKind
  pathStyle?: TerminalPathStyle
  workspaceId?: string
  agentId?: string
  terminalId?: string
  cli?: AgentCli
  cwd?: string
  sprintEngineStatePath?: string
  sprintEngineMcpRunId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  agentSession?: AgentSessionIdentity
  visible: boolean
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  pendingResize?: TerminalSize
  startupScriptPath?: string
}

const TERMINAL_REPLAY_BUFFER_LIMIT = 512 * 1024
const TERMINAL_REPLAY_COMPACT_THRESHOLD = 1024

export const DEFAULT_IDLE_POLICY = {
  flipToIdleAfterMs: 3_000,
  agentFlipToIdleAfterMs: 4_000,
} as const

export function getTerminalSize(cols: number, rows: number): TerminalSize {
  return {
    cols: Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20),
    rows: Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8),
  }
}

export function isTerminalProcessAlive(session: TerminalSession): boolean {
  return !session.hasExited && !session.isDisposed
}

export function clearTerminalIdleTimer(session: TerminalSession): void {
  if (!session.idleTimer) return
  clearTimeout(session.idleTimer)
  session.idleTimer = undefined
}

export function getTerminalIdleTimeoutMs(session: TerminalSession): number {
  return session.kind === 'agent'
    ? DEFAULT_IDLE_POLICY.agentFlipToIdleAfterMs
    : DEFAULT_IDLE_POLICY.flipToIdleAfterMs
}

export function createInitialTerminalActivity(startedAt: number): SessionActivity {
  return { kind: 'working', since: startedAt }
}

export function transitionTerminalActivity(session: TerminalSession, next: SessionActivity): boolean {
  if (next.kind === 'exited' || next.kind === 'failed') {
    clearTerminalIdleTimer(session)
    session.hasExited = true
    session.exitedAt ??= next.at
    session.exitCode = next.exitCode
  } else if (!isTerminalProcessAlive(session)) {
    return false
  }

  if (sessionActivitiesEqual(session.activity, next)) return false
  session.activity = next
  return true
}

export function markTerminalWorking(session: TerminalSession, at = Date.now()): boolean {
  if (!isTerminalProcessAlive(session)) return false
  session.lastOutputAt = at
  if (session.activity.kind === 'working') return false
  return transitionTerminalActivity(session, { kind: 'working', since: at })
}

export function recordTerminalInput(session: TerminalSession, at = Date.now()): void {
  session.lastInputAt = at
}

export function markTerminalIdle(session: TerminalSession, at = Date.now()): boolean {
  if (session.activity.kind !== 'working') return false
  return transitionTerminalActivity(session, { kind: 'idle', since: at })
}

export function markTerminalExited(session: TerminalSession, exitCode: number, at = Date.now()): void {
  transitionTerminalActivity(session, { kind: 'exited', at, exitCode })
}

export function markTerminalFailed(
  session: TerminalSession,
  exitCode: number,
  message: string | undefined,
  at = Date.now()
): void {
  transitionTerminalActivity(session, message
    ? { kind: 'failed', at, exitCode, message }
    : { kind: 'failed', at, exitCode })
}

export function createFailedTerminalSession(input: FailedTerminalSessionInput): TerminalSession {
  const at = input.at ?? Date.now()
  return {
    sessionId: input.sessionId,
    process: createInactiveTerminalProcess(),
    sender: input.sender ?? createNoopWebContents(),
    isReady: true,
    hasExited: true,
    exitedAt: at,
    exitCode: input.exitCode ?? 1,
    isDisposed: false,
    activity: {
      kind: 'failed',
      at,
      exitCode: input.exitCode ?? 1,
      message: input.message,
    },
    outputChunks: [],
    outputChunkBytes: [],
    outputChunkStart: 0,
    outputBytes: 0,
    outputLength: 0,
    kind: input.kind ?? 'agent',
    pathStyle: input.pathStyle,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    terminalId: input.terminalId,
    cli: input.cli,
    cwd: input.cwd,
    sprintEngineStatePath: input.sprintEngineStatePath,
    sprintEngineMcpRunId: input.sprintEngineMcpRunId,
    executionMode: input.executionMode,
    worktreeId: input.worktreeId,
    worktreePath: input.worktreePath,
    agentSession: input.agentSession,
    visible: input.visible ?? false,
    startedAt: at,
    lastOutputAt: input.lastOutputAt === undefined ? at : input.lastOutputAt,
    lastInputAt: input.lastInputAt ?? null,
  }
}

export function appendTerminalOutput(session: TerminalSession, data: string, at = Date.now()): void {
  const chunk = trimTerminalChunkToReplayLimit(data)
  session.outputChunks.push(chunk.data)
  session.outputChunkBytes.push(chunk.bytes)
  session.outputBytes += chunk.bytes
  session.outputLength += chunk.data.length
  session.lastOutputAt = at

  while (
    session.outputBytes > TERMINAL_REPLAY_BUFFER_LIMIT
    && session.outputChunkStart < session.outputChunks.length
  ) {
    const removed = session.outputChunks[session.outputChunkStart]
    const removedBytes = session.outputChunkBytes[session.outputChunkStart] ?? 0
    session.outputChunkStart += 1
    session.outputBytes -= removedBytes
    session.outputLength -= removed?.length ?? 0
  }

  if (
    session.outputChunkStart >= TERMINAL_REPLAY_COMPACT_THRESHOLD
    && session.outputChunkStart > session.outputChunks.length / 2
  ) {
    session.outputChunks.splice(0, session.outputChunkStart)
    session.outputChunkBytes.splice(0, session.outputChunkStart)
    session.outputChunkStart = 0
  }
}

export function materializeTerminalReplay(session: TerminalSession): string {
  return session.outputChunks.slice(session.outputChunkStart).join('')
}

export function getTerminalSnapshot(session: TerminalSession): TerminalSessionSnapshot {
  return {
    sessionId: session.sessionId,
    processAlive: isTerminalProcessAlive(session),
    kind: session.kind,
    pathStyle: session.pathStyle,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    terminalId: session.terminalId,
    cli: session.cli,
    cwd: session.cwd,
    sprintEngineStatePath: session.sprintEngineStatePath,
    executionMode: session.executionMode,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    agentSession: session.agentSession,
    visible: session.visible,
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
    lastInputAt: session.lastInputAt,
    activity: session.activity,
    exitedAt: session.exitedAt,
    outputBufferLength: session.outputLength,
    retainedOutputBytes: session.outputBytes,
  }
}

function trimTerminalChunkToReplayLimit(data: string): { data: string; bytes: number } {
  const bytes = Buffer.byteLength(data)
  if (bytes <= TERMINAL_REPLAY_BUFFER_LIMIT) return { data, bytes }

  const trimmed = Buffer.from(data)
    .subarray(bytes - TERMINAL_REPLAY_BUFFER_LIMIT)
    .toString('utf8')

  return {
    data: trimmed,
    bytes: Buffer.byteLength(trimmed),
  }
}

function sessionActivitiesEqual(first: SessionActivity, second: SessionActivity): boolean {
  if (first.kind !== second.kind) return false
  if (first.kind === 'working' && second.kind === 'working') return first.since === second.since
  if (first.kind === 'idle' && second.kind === 'idle') return first.since === second.since
  if (first.kind === 'exited' && second.kind === 'exited') {
    return first.at === second.at && first.exitCode === second.exitCode
  }
  if (first.kind === 'failed' && second.kind === 'failed') {
    return first.at === second.at && first.exitCode === second.exitCode && first.message === second.message
  }
  return false
}

function createInactiveTerminalProcess(): pty.IPty {
  return {
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as pty.IPty
}

function createNoopWebContents(): WebContents {
  return {
    isDestroyed: () => true,
    send: () => undefined,
  } as unknown as WebContents
}
