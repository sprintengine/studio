import type { WebContents } from 'electron'
import type * as pty from 'node-pty'
import type {
  AgentCli,
  AgentExecutionMode,
  TerminalKind,
  TerminalPathStyle,
  TerminalSessionSnapshot,
} from '../shared/electron-api'

export type TerminalSize = {
  cols: number
  rows: number
}

export type TerminalSession = {
  sessionId: string
  process: pty.IPty
  sender: WebContents
  isReady: boolean
  hasExited: boolean
  isDisposed: boolean
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
  swarmStatePath?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  pendingResize?: TerminalSize
  startupScriptPath?: string
}

const TERMINAL_REPLAY_BUFFER_LIMIT = 512 * 1024
const TERMINAL_REPLAY_COMPACT_THRESHOLD = 1024

export function getTerminalSize(cols: number, rows: number): TerminalSize {
  return {
    cols: Math.max(Number.isFinite(cols) ? Math.floor(cols) : 80, 20),
    rows: Math.max(Number.isFinite(rows) ? Math.floor(rows) : 24, 8),
  }
}

export function appendTerminalOutput(session: TerminalSession, data: string): void {
  const chunk = trimTerminalChunkToReplayLimit(data)
  session.outputChunks.push(chunk.data)
  session.outputChunkBytes.push(chunk.bytes)
  session.outputBytes += chunk.bytes
  session.outputLength += chunk.data.length
  session.lastOutputAt = Date.now()

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
    running: !session.hasExited && !session.isDisposed,
    kind: session.kind,
    pathStyle: session.pathStyle,
    workspaceId: session.workspaceId,
    agentId: session.agentId,
    terminalId: session.terminalId,
    cli: session.cli,
    cwd: session.cwd,
    swarmStatePath: session.swarmStatePath,
    executionMode: session.executionMode,
    worktreeId: session.worktreeId,
    worktreePath: session.worktreePath,
    startedAt: session.startedAt,
    lastOutputAt: session.lastOutputAt,
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
