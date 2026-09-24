import type { WebContents } from 'electron'
import type { TerminalSession } from './terminal-session'

type TerminalOutputCause = 'timer' | 'exit' | 'dispose' | 'visibility'

/**
 * One attached viewer of a session's output.
 *
 * This buffer used to hold exactly ONE pending batch per session, forwarded to
 * the renderer behind a single per-session gate (`session.visible`). A remote
 * attach is a second, independent viewer of the same pty: it must
 * keep streaming while the local pane is hidden, and a slow remote consumer
 * must not stall the local one. So the batch, the gate, and the byte bound are
 * all per SINK now, and the renderer is simply the sink the runtime always has.
 *
 * `shouldForward` is the per-sink flush gate. For the renderer it is the
 * session's visibility (a hidden xterm is frozen, so forwarding to it would be
 * dropped bytes the reveal has to resend anyway). For a remote viewer it
 * is its own socket — deliberately NOT the local pane's visibility.
 */
export type TerminalOutputSink = {
  /** Unique within a session. The renderer's is `TERMINAL_RENDERER_SINK_ID`. */
  id: string
  shouldForward(session: TerminalSession | undefined): boolean
  forward(data: string): void
  /** Bound on bytes buffered but not yet forwarded, per sink. */
  pendingLimitBytes: number
  /** Text put in place of the bytes dropped at the bound; omit for a sink that resyncs instead. */
  droppedNotice?: string
  /** Called when the bound was hit and older bytes were dropped. */
  onDropped?(): void
}

const TERMINAL_RENDERER_SINK_ID = 'renderer'

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
  /** Viewers attached beyond the renderer; empty for every session nobody remote is watching. */
  resolveExtraSinks?(sessionId: string): readonly TerminalOutputSink[]
  flowControl?: TerminalFlowControl
}

const TERMINAL_INTERACTIVE_DATA_BATCH_MS = 0
const TERMINAL_DATA_BATCH_MS = 16
const TERMINAL_RECENT_INPUT_WINDOW_MS = 250
const TERMINAL_INTERACTIVE_DATA_LIMIT = 4096
const TERMINAL_PENDING_DATA_LIMIT = 256 * 1024

const TERMINAL_THROTTLE_NOTICE = '\r\n[Terminal output throttled to keep the UI responsive]\r\n'

type PendingBatch = {
  sink: TerminalOutputSink
  chunks: string[]
  bytes: number
  units: number
  // The session's stream offset once the newest chunk in this batch was
  // appended — how far the viewer has been sent when this batch goes out.
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
  resolveExtraSinks,
  flowControl,
}: TerminalOutputBufferOptions) {
  // sessionId -> sinkId -> the batch waiting for that one viewer.
  const pendingTerminalData = new Map<string, Map<string, PendingBatch>>()
  // One renderer sink per session object, reading the session's CURRENT sender
  // when it forwards (a reveal can adopt a new window between the first chunk of
  // a batch and its flush). It used to be rebuilt, closure and all, per chunk.
  const rendererSinks = new WeakMap<TerminalSession, TerminalOutputSink>()
  const rendererFlow = new Map<string, RendererFlow>()

  function flush(sessionId: string, cause: TerminalOutputCause = 'timer'): void {
    const bySink = pendingTerminalData.get(sessionId)
    if (!bySink) return

    pendingTerminalData.delete(sessionId)
    const session = getSession(sessionId)
    for (const pending of bySink.values()) {
      clearTimeout(pending.timer)
      const data = pending.chunks.length === 1 ? (pending.chunks[0] as string) : pending.chunks.join('')
      const isRenderer = pending.sink.id === TERMINAL_RENDERER_SINK_ID
      if (pending.sink.shouldForward(session)) {
        pending.sink.forward(data)
        if (isRenderer && session) {
          session.rendererDeliveredOffset = pending.endOffset
          session.rendererDeliveredTo = session.sender
          noteRendererForwarded(sessionId, data.length)
        }
      }
      // Diagnostics describe the UI's data path, so they stay the renderer's:
      // counting a remote viewer's batches too would silently double the
      // throughput the Diagnostics panel reports.
      if (isRenderer) {
        recordDataBatch(session, cause, pending.chunks.length, pending.bytes)
        if (session) evaluateFlow(session)
      }
    }
  }

  /** Drop one viewer's queued batch — used when it detaches mid-flight. */
  function discard(sessionId: string, sinkId: string): void {
    const bySink = pendingTerminalData.get(sessionId)
    const pending = bySink?.get(sinkId)
    if (!bySink || !pending) return
    clearTimeout(pending.timer)
    bySink.delete(sinkId)
    if (bySink.size === 0) pendingTerminalData.delete(sessionId)
  }

  /**
   * Queue one pty chunk for every viewer. `bytes` is the chunk's UTF-8 length,
   * already measured when it was appended to the replay buffer.
   */
  function send(session: TerminalSession, data: string, bytes: number): void {
    queue(session, rendererSink(session), data, bytes)
    const extra = resolveExtraSinks?.(session.sessionId)
    if (extra) for (const sink of extra) queue(session, sink, data, bytes)
  }

  function queue(session: TerminalSession, sink: TerminalOutputSink, data: string, bytes: number): void {
    let bySink = pendingTerminalData.get(session.sessionId)
    if (!bySink) {
      bySink = new Map<string, PendingBatch>()
      pendingTerminalData.set(session.sessionId, bySink)
    }
    const pending = bySink.get(sink.id)
    const isRenderer = sink.id === TERMINAL_RENDERER_SINK_ID
    if (pending) {
      pending.sink = sink
      pending.chunks.push(data)
      pending.bytes += bytes
      pending.units += data.length
      pending.endOffset = session.output.endOffset
      if (pending.bytes > sink.pendingLimitBytes) {
        const trimmed = trimPendingTerminalChunks(pending.chunks, sink.pendingLimitBytes, sink.droppedNotice)
        pending.chunks = trimmed.chunks
        pending.bytes = trimmed.bytes
        pending.units = trimmed.chunks.reduce((total, chunk) => total + chunk.length, 0)
        if (trimmed.dropped) sink.onDropped?.()
      }
      if (isRenderer) evaluateFlow(session)
      return
    }

    const delayMs = getTerminalDataBatchDelay(session, bytes)
    const timer = setTimeout(() => {
      flush(session.sessionId, 'timer')
    }, delayMs)
    bySink.set(sink.id, {
      sink,
      chunks: [data],
      bytes,
      units: data.length,
      endOffset: session.output.endOffset,
      timer,
    })
    if (isRenderer) evaluateFlow(session)
  }

  function rendererSink(session: TerminalSession): TerminalOutputSink {
    const cached = rendererSinks.get(session)
    if (cached) return cached
    const channel = `terminal:data:${session.sessionId}`
    const sink: TerminalOutputSink = {
      id: TERMINAL_RENDERER_SINK_ID,
      // Unchanged from before the multi-sink split: while a pane is hidden the
      // bytes are held in the retained replay buffer and the reveal path
      // resends them, so forwarding here would only duplicate the tail.
      shouldForward: (current) => current?.visible !== false,
      forward: (data) => sendTerminalEvent(session.sender, channel, data),
      pendingLimitBytes: TERMINAL_PENDING_DATA_LIMIT,
      droppedNotice: TERMINAL_THROTTLE_NOTICE,
    }
    rendererSinks.set(session, sink)
    return sink
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

  function rendererBacklog(sessionId: string): number {
    const flow = rendererFlow.get(sessionId)
    const pendingUnits = pendingTerminalData.get(sessionId)?.get(TERMINAL_RENDERER_SINK_ID)?.units ?? 0
    return (flow?.inflight ?? 0) + pendingUnits
  }

  function evaluateFlow(session: TerminalSession): void {
    if (!flowControl) return
    const flow = rendererFlow.get(session.sessionId)
    if (!flow) return
    // A hidden pane is sent nothing, so there is nothing to wait on it for —
    // and the renderer bucket still fills with every chunk until the flush
    // drops it, so counting it would pause the pty of an agent nobody is
    // looking at (a minimized window) at the pane's parse speed.
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
    /** Drop the renderer's queued batch: a replay about to be sent already holds it. */
    discardRenderer: (sessionId: string): void => discard(sessionId, TERMINAL_RENDERER_SINK_ID),
    ack,
    resetRendererFlow,
    forgetSession,
    /** Test and diagnostics seam: units the pane has in flight or queued for it. */
    rendererBacklog,
    isFlowPaused: (sessionId: string): boolean => rendererFlow.get(sessionId)?.paused === true,
  }
}

function trimPendingTerminalChunks(
  chunks: string[],
  maxBytes: number,
  notice?: string,
): { chunks: string[]; bytes: number; dropped: boolean } {
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
    if (notice) retained.unshift(notice)
    return {
      chunks: retained,
      bytes: retained.reduce((total, value) => total + Buffer.byteLength(value), 0),
      dropped: true,
    }
  }

  return { chunks: retained, bytes, dropped: false }
}

function getTerminalDataBatchDelay(session: TerminalSession, bytes: number): number {
  const recentInput =
    session.lastInputAt !== null && Date.now() - session.lastInputAt <= TERMINAL_RECENT_INPUT_WINDOW_MS
  const smallOutput = bytes <= TERMINAL_INTERACTIVE_DATA_LIMIT

  return recentInput && smallOutput ? TERMINAL_INTERACTIVE_DATA_BATCH_MS : TERMINAL_DATA_BATCH_MS
}
