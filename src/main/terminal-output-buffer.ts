import type { WebContents } from 'electron'
import type { TerminalSession } from './terminal-session'

type TerminalOutputCause = 'timer' | 'exit' | 'dispose' | 'visibility'

/**
 * Backpressure from the renderer's xterm to the pty.
 *
 * Main used to forward whatever the pty produced, every 16 ms, up to 256 KB a
 * batch — more than xterm can parse from a colour-heavy TUI. The surplus queued
 * in the renderer ahead of the person's own keystroke echo, and past the bound
 * it was dropped and the screen corrupted. Now the renderer acknowledges what
 * it has parsed (from xterm's write callback), and the pty is paused while more
 * than `highWatermark` UTF-16 units are in flight and resumed once the backlog
 * falls to `lowWatermark`. Units rather than bytes because that is what both
 * ends can count for free.
 *
 * Only a pane that acknowledges is ever waited on: a session whose window has
 * no mounted view, a hidden pane, a headless launch — none of them ack, and
 * none of them may stall an agent. Every reset (a reveal, a replay, a new
 * window) forgets the pane's acking until it acks again, and a pane that stops
 * acknowledging while the pty is paused is given up on after `stallResumeMs`.
 */
export type TerminalFlowControl = {
  highWatermark: number
  lowWatermark: number
  stallResumeMs: number
  pause(session: TerminalSession): void
  resume(session: TerminalSession): void
}

export const TERMINAL_FLOW_HIGH_WATERMARK = 100_000
export const TERMINAL_FLOW_LOW_WATERMARK = 5_000
export const TERMINAL_FLOW_STALL_RESUME_MS = 2_000

type TerminalOutputBufferOptions = {
  getSession(sessionId: string): TerminalSession | undefined
  sendTerminalEvent(sender: WebContents, channel: string, payload: string | number): void
  recordDataBatch(
    session: TerminalSession | undefined,
    cause: TerminalOutputCause,
    chunkCount: number,
    byteCount: number,
  ): void
  flowControl?: TerminalFlowControl
}

const TERMINAL_INTERACTIVE_DATA_BATCH_MS = 0
const TERMINAL_DATA_BATCH_MS = 16
const TERMINAL_RECENT_INPUT_WINDOW_MS = 250
const TERMINAL_INTERACTIVE_DATA_LIMIT = 4096
const TERMINAL_PENDING_DATA_LIMIT = 256 * 1024

const TERMINAL_THROTTLE_NOTICE = '\r\n[Terminal output throttled to keep the UI responsive]\r\n'

type PendingBatch = {
  // The session the newest chunk was queued for. A resume can respawn under
  // the same id between the first chunk of a batch and its flush; the batch
  // goes to the window the newest chunk's session is routed to.
  session: TerminalSession
  chunks: string[]
  bytes: number
  units: number
  // The session's stream offset once the newest chunk in this batch was
  // appended — how far the pane has been sent when this batch goes out.
  endOffset: number
  timer: NodeJS.Timeout
}

type RendererFlow = {
  // Units forwarded to the pane and not yet acknowledged.
  inflight: number
  // Whether the pane has acknowledged anything since the last reset; only then
  // is it waited on.
  acking: boolean
  paused: boolean
  stallTimer: NodeJS.Timeout | null
}

export function createTerminalOutputBuffer({
  getSession,
  sendTerminalEvent,
  recordDataBatch,
  flowControl,
}: TerminalOutputBufferOptions) {
  // sessionId -> the batch waiting for the session's pane.
  const pendingTerminalData = new Map<string, PendingBatch>()
  const rendererFlow = new Map<string, RendererFlow>()

  function flush(sessionId: string, cause: TerminalOutputCause = 'timer'): void {
    const pending = pendingTerminalData.get(sessionId)
    if (!pending) return

    pendingTerminalData.delete(sessionId)
    clearTimeout(pending.timer)
    const session = getSession(sessionId)
    const data = pending.chunks.length === 1 ? (pending.chunks[0] as string) : pending.chunks.join('')
    // While a pane is hidden the bytes are held in the retained replay buffer
    // and the reveal path resends them, so forwarding here would only
    // duplicate the tail.
    if (session?.visible !== false) {
      sendTerminalEvent(pending.session.sender, `terminal:data:${pending.session.sessionId}`, data)
      if (session) {
        session.rendererDeliveredOffset = pending.endOffset
        session.rendererDeliveredTo = session.sender
        noteRendererForwarded(sessionId, data.length)
      }
    }
    recordDataBatch(session, cause, pending.chunks.length, pending.bytes)
    if (session) evaluateFlow(session)
  }

  /** Drop the queued batch: a replay about to be sent already holds it. */
  function discard(sessionId: string): void {
    const pending = pendingTerminalData.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingTerminalData.delete(sessionId)
  }

  /**
   * Queue one pty chunk for the session's pane. `bytes` is the chunk's UTF-8
   * length, already measured when it was appended to the replay buffer.
   */
  function send(session: TerminalSession, data: string, bytes: number): void {
    const pending = pendingTerminalData.get(session.sessionId)
    if (pending) {
      pending.session = session
      pending.chunks.push(data)
      pending.bytes += bytes
      pending.units += data.length
      pending.endOffset = session.output.endOffset
      if (pending.bytes > TERMINAL_PENDING_DATA_LIMIT) {
        const trimmed = trimPendingTerminalChunks(pending.chunks, TERMINAL_PENDING_DATA_LIMIT)
        pending.chunks = trimmed.chunks
        pending.bytes = trimmed.bytes
        pending.units = trimmed.chunks.reduce((total, chunk) => total + chunk.length, 0)
      }
      evaluateFlow(session)
      return
    }

    const delayMs = getTerminalDataBatchDelay(session, bytes)
    const timer = setTimeout(() => {
      flush(session.sessionId, 'timer')
    }, delayMs)
    pendingTerminalData.set(session.sessionId, {
      session,
      chunks: [data],
      bytes,
      units: data.length,
      endOffset: session.output.endOffset,
      timer,
    })
    evaluateFlow(session)
  }

  // --- Flow control --------------------------------------------------------

  function flowFor(sessionId: string): RendererFlow {
    let flow = rendererFlow.get(sessionId)
    if (!flow) {
      flow = { inflight: 0, acking: false, paused: false, stallTimer: null }
      rendererFlow.set(sessionId, flow)
    }
    return flow
  }

  function noteRendererForwarded(sessionId: string, units: number): void {
    if (!flowControl) return
    flowFor(sessionId).inflight += units
  }

  /**
   * The runtime sent the pane `units` of live data itself, outside a batch —
   * a reveal's catch-up. The pane acknowledges those units like any other
   * live data, so they are counted in flight like any other: uncounted, each
   * ack for them would cancel units main did count, and backpressure would be
   * off while the pane parsed what could be megabytes.
   */
  function noteRendererSent(sessionId: string, units: number): void {
    if (!flowControl || units <= 0) return
    noteRendererForwarded(sessionId, units)
    const session = getSession(sessionId)
    if (session) evaluateFlow(session)
  }

  function rendererBacklog(sessionId: string): number {
    const flow = rendererFlow.get(sessionId)
    const pendingUnits = pendingTerminalData.get(sessionId)?.units ?? 0
    return (flow?.inflight ?? 0) + pendingUnits
  }

  function evaluateFlow(session: TerminalSession): void {
    if (!flowControl) return
    const flow = rendererFlow.get(session.sessionId)
    if (!flow) return
    // A hidden pane is sent nothing, so there is nothing to wait on it for —
    // and its batch still fills with every chunk until the flush drops it, so
    // counting it would pause the pty of an agent nobody is looking at (a
    // minimized window) at the pane's parse speed.
    if (session.visible === false) {
      if (flow.paused) resumeFlow(session, flow)
      return
    }
    const backlog = rendererBacklog(session.sessionId)
    if (!flow.paused) {
      if (!flow.acking || backlog <= flowControl.highWatermark) return
      flow.paused = true
      flowControl.pause(session)
      armStallTimer(session, flow)
      return
    }
    if (backlog <= flowControl.lowWatermark) resumeFlow(session, flow)
  }

  function armStallTimer(session: TerminalSession, flow: RendererFlow): void {
    if (!flowControl) return
    if (flow.stallTimer) clearTimeout(flow.stallTimer)
    const sessionId = session.sessionId
    flow.stallTimer = setTimeout(() => {
      flow.stallTimer = null
      // The pane stopped acknowledging while the pty waited on it: it closed,
      // hung, or lost its listener. Stop waiting on it until it acks again.
      const current = getSession(sessionId)
      flow.inflight = 0
      flow.acking = false
      if (current && flow.paused) resumeFlow(current, flow)
    }, flowControl.stallResumeMs)
    flow.stallTimer.unref?.()
  }

  function resumeFlow(session: TerminalSession, flow: RendererFlow): void {
    if (flow.stallTimer) {
      clearTimeout(flow.stallTimer)
      flow.stallTimer = null
    }
    if (!flow.paused) return
    flow.paused = false
    flowControl?.resume(session)
  }

  /** The pane parsed (or discarded) `units` of what it was sent. */
  function ack(sessionId: string, units: number): void {
    if (!flowControl || !Number.isFinite(units) || units <= 0) return
    const session = getSession(sessionId)
    if (!session) return
    const flow = flowFor(sessionId)
    flow.inflight = Math.max(0, flow.inflight - units)
    // Acks that arrive after a hide are for what the pane was sent before it:
    // the renderer is still parsing its queue. They must not make main start
    // waiting on a pane it no longer sends to.
    if (session.visible === false) return
    flow.acking = true
    if (flow.paused) armStallTimer(session, flow)
    evaluateFlow(session)
  }

  /**
   * Forget what the pane had in flight and stop waiting on it: it was hidden,
   * revealed, handed a replay (which resets it), or replaced by another window.
   * Resumes a paused pty.
   */
  function resetRendererFlow(sessionId: string): void {
    const flow = rendererFlow.get(sessionId)
    if (!flow) return
    flow.inflight = 0
    flow.acking = false
    const session = getSession(sessionId)
    if (session) resumeFlow(session, flow)
    else if (flow.stallTimer) {
      clearTimeout(flow.stallTimer)
      flow.stallTimer = null
    }
  }

  /** The session's pty is gone (suspend, exit, dispose): drop its flow state without touching the pty. */
  function forgetSession(sessionId: string): void {
    const flow = rendererFlow.get(sessionId)
    if (!flow) return
    if (flow.stallTimer) clearTimeout(flow.stallTimer)
    rendererFlow.delete(sessionId)
  }

  return {
    flush,
    send,
    discard,
    ack,
    noteRendererSent,
    resetRendererFlow,
    forgetSession,
    /** Test and diagnostics seam: units the pane has in flight or queued for it. */
    rendererBacklog,
    isFlowPaused: (sessionId: string): boolean => rendererFlow.get(sessionId)?.paused === true,
  }
}

function trimPendingTerminalChunks(chunks: string[], maxBytes: number): { chunks: string[]; bytes: number } {
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
      const encoded = Buffer.from(chunk)
      let start = Math.max(0, chunkBytes - remainingBytes)
      // Start on a character, not inside one: a cut through a multi-byte
      // sequence decodes its orphaned continuation bytes as U+FFFD.
      while (start < encoded.length && ((encoded[start] as number) & 0xc0) === 0x80) start += 1
      const tail = encoded.subarray(start).toString('utf8')
      retained.unshift(tail)
      bytes += Buffer.byteLength(tail)
    }
    retained.unshift(TERMINAL_THROTTLE_NOTICE)
    return { chunks: retained, bytes: retained.reduce((total, value) => total + Buffer.byteLength(value), 0) }
  }

  return { chunks: retained, bytes }
}

function getTerminalDataBatchDelay(session: TerminalSession, bytes: number): number {
  const recentInput =
    session.lastInputAt !== null && Date.now() - session.lastInputAt <= TERMINAL_RECENT_INPUT_WINDOW_MS
  const smallOutput = bytes <= TERMINAL_INTERACTIVE_DATA_LIMIT

  return recentInput && smallOutput ? TERMINAL_INTERACTIVE_DATA_BATCH_MS : TERMINAL_DATA_BATCH_MS
}
