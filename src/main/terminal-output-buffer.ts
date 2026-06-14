import type { WebContents } from 'electron'
import type { TerminalSession } from './terminal-session'

type TerminalOutputCause = 'timer' | 'exit' | 'dispose'

type TerminalOutputBufferOptions = {
  getSession(sessionId: string): TerminalSession | undefined
  sendTerminalEvent(sender: WebContents, channel: string, payload: string | number): void
  recordDataBatch(
    session: TerminalSession | undefined,
    cause: TerminalOutputCause,
    chunkCount: number,
    byteCount: number
  ): void
}

const TERMINAL_INTERACTIVE_DATA_BATCH_MS = 0
const TERMINAL_DATA_BATCH_MS = 16
const TERMINAL_RECENT_INPUT_WINDOW_MS = 250
const TERMINAL_INTERACTIVE_DATA_LIMIT = 4096
const TERMINAL_PENDING_DATA_LIMIT = 256 * 1024

export function createTerminalOutputBuffer({
  getSession,
  sendTerminalEvent,
  recordDataBatch,
}: TerminalOutputBufferOptions) {
  const pendingTerminalData = new Map<string, {
    sender: WebContents
    channel: string
    chunks: string[]
    bytes: number
    timer: NodeJS.Timeout
  }>()

  function flush(sessionId: string, cause: TerminalOutputCause = 'timer'): void {
    const pending = pendingTerminalData.get(sessionId)
    if (!pending) return

    pendingTerminalData.delete(sessionId)
    clearTimeout(pending.timer)
    const data = pending.chunks.join('')
    const session = getSession(sessionId)
    if (session?.visible !== false) {
      sendTerminalEvent(pending.sender, pending.channel, data)
    }
    recordDataBatch(
      session,
      cause,
      pending.chunks.length,
      Buffer.byteLength(data)
    )
  }

  function send(session: TerminalSession, data: string): void {
    const channel = `terminal:data:${session.sessionId}`
    const pending = pendingTerminalData.get(session.sessionId)
    if (pending) {
      pending.sender = session.sender
      pending.channel = channel
      pending.chunks.push(data)
      pending.bytes += Buffer.byteLength(data)
      if (pending.bytes > TERMINAL_PENDING_DATA_LIMIT) {
        const trimmed = trimPendingTerminalChunks(pending.chunks, TERMINAL_PENDING_DATA_LIMIT)
        pending.chunks = trimmed.chunks
        pending.bytes = trimmed.bytes
      }
      return
    }

    const delayMs = getTerminalDataBatchDelay(session, data)
    const timer = setTimeout(() => {
      flush(session.sessionId, 'timer')
    }, delayMs)
    pendingTerminalData.set(session.sessionId, {
      sender: session.sender,
      channel,
      chunks: [data],
      bytes: Buffer.byteLength(data),
      timer,
    })
  }

  return {
    flush,
    send,
  }
}

function trimPendingTerminalChunks(chunks: string[], maxBytes: number): { chunks: string[]; bytes: number; dropped: boolean } {
  let bytes = 0
  const retained: string[] = []

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index] ?? ''
    const chunkBytes = Buffer.byteLength(chunk)
    if (bytes + chunkBytes <= maxBytes) {
      retained.unshift(chunk)
      bytes += chunkBytes
      continue
    }

    const remainingBytes = maxBytes - bytes
    if (remainingBytes > 0) {
      const tail = Buffer.from(chunk)
        .subarray(Math.max(0, chunkBytes - remainingBytes))
        .toString('utf8')
      retained.unshift(tail)
      bytes += Buffer.byteLength(tail)
    }
    retained.unshift('\r\n[Multicode: terminal output throttled to keep the UI responsive]\r\n')
    return {
      chunks: retained,
      bytes: retained.reduce((total, value) => total + Buffer.byteLength(value), 0),
      dropped: true,
    }
  }

  return { chunks: retained, bytes, dropped: false }
}

function getTerminalDataBatchDelay(session: TerminalSession, data: string): number {
  const recentInput = session.lastInputAt !== null
    && Date.now() - session.lastInputAt <= TERMINAL_RECENT_INPUT_WINDOW_MS
  const smallOutput = Buffer.byteLength(data) <= TERMINAL_INTERACTIVE_DATA_LIMIT

  return recentInput && smallOutput
    ? TERMINAL_INTERACTIVE_DATA_BATCH_MS
    : TERMINAL_DATA_BATCH_MS
}
