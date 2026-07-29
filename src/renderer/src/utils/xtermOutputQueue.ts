import type { Terminal } from '@xterm/xterm'
import { TERMINAL_RECENT_REPLAY_BYTES } from '../../../shared/terminal-history'

const MAX_TERMINAL_WRITE_CHARS = 32 * 1024
const MAX_QUEUED_TERMINAL_CHARS = TERMINAL_RECENT_REPLAY_BYTES
const TERMINAL_WRITE_FRAME_BUDGET_MS = 8
const TERMINAL_THROTTLE_MESSAGE = '\r\n[Terminal output throttled to keep the UI responsive]\r\n'

type TerminalOutputQueueOptions = {
  recordWrite: (data: string, elapsedMs: number) => void
}

type XtermOutputQueue = ReturnType<typeof createXtermOutputQueue>

/**
 * Replay reveal lifecycle, surfaced to the renderer so it can show a terminal
 * skeleton instead of a blank panel while retained scrollback is restored.
 *
 * - `idle`: no replay activity (fresh terminal or after dispose).
 * - `awaiting`: a reattach is in flight; we do not yet know if replay exists.
 * - `replaying`: retained replay is draining but no content is visible yet.
 * - `ready`: the first replay chunk (or an empty-replay release) is on screen.
 */
export type XtermReplayPhase = 'idle' | 'awaiting' | 'replaying' | 'ready'

export type XtermReplayState = {
  phase: XtermReplayPhase
  /** Byte size of the retained replay payload, or 0 before any replay arrives. */
  payloadBytes: number
  /** Whether terminal content is on screen (skeleton should be hidden). */
  visible: boolean
}

/** One-shot timing/size summary emitted when a reattach settles. */
export type XtermReplayProfile = {
  payloadChars: number
  payloadBytes: number
  writeCount: number
  maxWriteMs: number
  totalReplayMs: number
  timeToFirstContentMs: number
  liveBufferedCount: number
  endedVia: 'replay' | 'finish-wait'
}

type XtermReplayGateOptions = {
  recordWrite?: (data: string, elapsedMs: number) => void
  onReplayStateChange?: (state: XtermReplayState) => void
  onReplayProfile?: (profile: XtermReplayProfile) => void
}

function replayByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

// Alt-screen enter sequences (DECSET 1049 / 1047 / 47). A CLI relaunched on
// resume re-enters its full-screen TUI with one of these; we use it to know the
// transitional normal-buffer boot noise is over and the real repaint has begun.
const ALT_SCREEN_ENTER_RE = /\x1b\[\?(?:1049|1047|47)h/

// Default ceiling for how long resume-suppression withholds boot output while
// waiting for the alt-screen repaint. For a TUI agent the alt-screen scan fires
// first, so this only matters as a fallback for a CLI that never enters an
// alt-screen (plain shell, some Codex modes) — and withholding LONGER is strictly
// safer for a merely-slow resume, so the only cost of a generous value is a
// slightly later reveal for the uncommon non-TUI case. Sized to comfortably
// outlast a slow `--resume` repaint without stranding non-TUI output for long.
const RESUME_SUPPRESSION_TIMEOUT_MS = 750

/**
 * Split a replay payload into bounded chunks so it can be written across
 * animation frames instead of in one monolithic `term.write`. Chunks break on
 * the last newline inside the budget when possible so ANSI/control sequences
 * are less likely to be split mid-line; a single line longer than `maxChars`
 * falls back to a hard character-boundary split.
 */
export function splitReplayIntoChunks(data: string, maxChars: number): string[] {
  if (!data) return []
  if (data.length <= maxChars) return [data]

  const chunks: string[] = []
  let index = 0
  while (index < data.length) {
    const remaining = data.length - index
    if (remaining <= maxChars) {
      chunks.push(data.slice(index))
      break
    }
    const windowEnd = index + maxChars
    const lastNewline = data.lastIndexOf('\n', windowEnd - 1)
    const end = lastNewline > index ? lastNewline + 1 : windowEnd
    chunks.push(data.slice(index, end))
    index = end
  }
  return chunks
}

export function createXtermOutputQueue(
  term: Terminal,
  { recordWrite }: TerminalOutputQueueOptions
) {
  const queue: string[] = []
  let scheduled = false
  let writing = false
  let disposed = false
  let queuedChars = 0
  let throttled = false

  const trimQueue = () => {
    if (queuedChars <= MAX_QUEUED_TERMINAL_CHARS) return

    const prefix = throttled ? '' : TERMINAL_THROTTLE_MESSAGE
    const targetChars = Math.max(MAX_QUEUED_TERMINAL_CHARS - prefix.length, 0)
    const retained: string[] = []
    let retainedChars = 0

    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const chunk = queue[index] ?? ''
      if (retainedChars + chunk.length <= targetChars) {
        retained.unshift(chunk)
        retainedChars += chunk.length
        continue
      }

      const remainingChars = targetChars - retainedChars
      if (remainingChars > 0) {
        const tail = chunk.slice(-remainingChars)
        retained.unshift(tail)
        retainedChars += tail.length
      }
      break
    }

    queue.length = 0
    if (prefix) queue.push(prefix)
    queue.push(...retained)
    queuedChars = prefix.length + retainedChars
    throttled = true
  }

  const takeChunk = (): string | null => {
    const next = queue.shift()
    if (!next) {
      throttled = false
      return null
    }

    queuedChars -= next.length

    if (next.length <= MAX_TERMINAL_WRITE_CHARS) return next

    const head = next.slice(0, MAX_TERMINAL_WRITE_CHARS)
    const tail = next.slice(MAX_TERMINAL_WRITE_CHARS)
    queue.unshift(tail)
    queuedChars += tail.length
    return head
  }

  const scheduleDrain = () => {
    if (scheduled || writing || disposed) return
    scheduled = true
    window.requestAnimationFrame(drain)
  }

  const drain = () => {
    scheduled = false
    if (disposed || writing) return

    const frameStartedAt = performance.now()

    const writeNext = () => {
      if (disposed) return

      const data = takeChunk()
      if (!data) return

      const writeStartedAt = performance.now()
      writing = true
      term.write(data, () => {
        writing = false
        recordWrite(data, performance.now() - writeStartedAt)

        if (disposed) return
        if (performance.now() - frameStartedAt >= TERMINAL_WRITE_FRAME_BUDGET_MS) {
          scheduleDrain()
          return
        }

        writeNext()
      })
    }

    writeNext()
  }

  return {
    enqueue: (data: string) => {
      if (disposed || !data) return
      queue.push(data)
      queuedChars += data.length
      trimQueue()
      scheduleDrain()
    },
    clear: () => {
      // Drop everything queued-but-not-yet-written without tearing the queue
      // down (used when a hidden terminal is revealed and resynced via replay).
      queue.length = 0
      queuedChars = 0
      throttled = false
    },
    dispose: () => {
      disposed = true
      queue.length = 0
      queuedChars = 0
    },
  }
}

export function createXtermReplayGate(
  term: Terminal,
  outputQueue: XtermOutputQueue,
  { recordWrite, onReplayStateChange, onReplayProfile }: XtermReplayGateOptions = {}
) {
  const liveBuffer: string[] = []
  let disposed = false
  let awaitingReplay = false
  let replaying = false
  let replayHandled = false
  // True once this terminal has shown content. Unlike the per-reattach counters
  // below, it persists across a hide/reveal cycle within the same gate instance
  // so handleReplay can tell an initial attach (empty xterm, no reset) from a
  // revisible resync (stale xterm, reset before replay).
  let revealedOnce = false

  // Chunked replay drain state.
  let replayChunks: string[] = []
  let replayIndex = 0
  let drainScheduled = false
  let writing = false

  // Resume-suppression state. On a freeze-the-view resume the CLI is relaunched
  // under this same xterm; its boot output paints to the normal screen buffer
  // (focus-report echo `^[[I`, the trust/permissions warning, shell fragments)
  // before it re-enters its alt-screen TUI. Withhold that transitional output
  // and flush it in one write once the alt-screen repaint begins, so the noise
  // lands on the now-hidden normal buffer and never gets its own painted frame.
  let resumeSuppressing = false
  let resumeHold = ''
  let resumeTimer: ReturnType<typeof setTimeout> | null = null

  // Per-reattach diagnostics, reset on each `beginReplayWait`/`handleReplay`.
  let payloadChars = 0
  let payloadBytes = 0
  let waitStartedAt = 0
  let replayStartedAt = 0
  let firstContentAt = 0
  let writeCount = 0
  let maxWriteMs = 0
  let liveBufferedCount = 0

  const emitState = (phase: XtermReplayPhase, visible: boolean) => {
    onReplayStateChange?.({ phase, payloadBytes, visible })
  }

  const flushLiveBuffer = () => {
    if (awaitingReplay || replaying) return
    while (liveBuffer.length > 0) {
      const next = liveBuffer.shift()
      if (next) outputQueue.enqueue(next)
    }
  }

  // End resume-suppression and paint the held boot output. The hold buffer is
  // written as a single chunk (boot output is small, well under the queue's
  // split threshold), so xterm parses the normal→alt-screen transition in one
  // write and the visible end state is the clean repainted TUI. Nothing is
  // dropped — scrollback/serialize stay faithful.
  //
  // If a snapshot replay is still draining (e.g. resume clicked while the frozen
  // view is mid-paint over deep scrollback), enqueuing now would interleave the
  // held buffer with the remaining replay chunks — and since the held buffer
  // enters the alt-screen, any later replay chunk would corrupt the TUI repaint.
  // Route it through `liveBuffer` instead, which `settleReplay` flushes in order
  // once the snapshot has fully drained.
  const revealResume = (): void => {
    if (!resumeSuppressing) return
    resumeSuppressing = false
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    const held = resumeHold
    resumeHold = ''
    if (!held || disposed) return
    if (replaying) liveBuffer.push(held)
    else outputQueue.enqueue(held)
  }

  const emitProfile = (endedVia: XtermReplayProfile['endedVia']) => {
    onReplayProfile?.({
      payloadChars,
      payloadBytes,
      writeCount,
      maxWriteMs: Math.round(maxWriteMs * 10) / 10,
      totalReplayMs: replayStartedAt > 0 ? Math.round(performance.now() - replayStartedAt) : 0,
      timeToFirstContentMs:
        firstContentAt > 0 && waitStartedAt > 0 ? Math.round(firstContentAt - waitStartedAt) : 0,
      liveBufferedCount,
      endedVia,
    })
  }

  const settleReplay = () => {
    replaying = false
    replayChunks = []
    replayIndex = 0
    if (!disposed) {
      // Pin to the newest output once replay has fully drained; this is the
      // second and final scroll, so older chunks never yank the viewport.
      term.scrollToBottom()
      emitState('ready', true)
      flushLiveBuffer()
    }
    emitProfile('replay')
  }

  const scheduleDrain = () => {
    if (drainScheduled || writing || disposed) return
    drainScheduled = true
    window.requestAnimationFrame(drainReplay)
  }

  function drainReplay() {
    drainScheduled = false
    if (disposed || writing) return

    const frameStartedAt = performance.now()

    const writeNext = () => {
      if (disposed) return
      if (replayIndex >= replayChunks.length) {
        settleReplay()
        return
      }

      const chunk = replayChunks[replayIndex] ?? ''
      replayIndex += 1
      const writeStartedAt = performance.now()
      writing = true
      term.write(chunk, () => {
        writing = false
        const elapsedMs = performance.now() - writeStartedAt
        writeCount += 1
        maxWriteMs = Math.max(maxWriteMs, elapsedMs)
        recordWrite?.(chunk, elapsedMs)
        if (disposed) return

        // Reveal as soon as the first chunk lands so the user sees terminal
        // content instead of a blank/skeleton region. xterm sticks to the
        // bottom as later chunks append, so we scroll once here and once on
        // settle rather than after every chunk.
        if (firstContentAt === 0) {
          firstContentAt = performance.now()
          revealedOnce = true
          term.scrollToBottom()
          emitState('ready', true)
        }

        if (performance.now() - frameStartedAt >= TERMINAL_WRITE_FRAME_BUDGET_MS) {
          scheduleDrain()
          return
        }
        writeNext()
      })
    }

    writeNext()
  }

  return {
    beginReplayWait: () => {
      if (disposed) return
      awaitingReplay = true
      replayHandled = false
      payloadChars = 0
      payloadBytes = 0
      waitStartedAt = performance.now()
      replayStartedAt = 0
      firstContentAt = 0
      writeCount = 0
      maxWriteMs = 0
      liveBufferedCount = 0
      emitState('awaiting', false)
    },
    finishReplayWait: () => {
      // Only releases a pending wait once: a real replay (replayHandled) takes
      // over the reveal itself, and a second call after release is a no-op.
      if (disposed || replaying || replayHandled || !awaitingReplay) return
      awaitingReplay = false
      firstContentAt = performance.now()
      revealedOnce = true
      emitState('ready', true)
      flushLiveBuffer()
      emitProfile('finish-wait')
    },
    handleReplay: (data: string) => {
      if (disposed || !data) return
      // A replay that arrives when we are NOT awaiting one, on a terminal that
      // has already shown content, is a revisible resync: the main process
      // re-sent the retained window because this hidden terminal became visible
      // again. Reset the stale screen + scrollback and drop any queued/buffered
      // output so the window is applied exactly once (no duplicated pre-hide
      // content). An initial attach (awaitingReplay) writes onto an empty xterm
      // and must NOT reset.
      if (!awaitingReplay && revealedOnce) {
        term.reset()
        outputQueue.clear()
        liveBuffer.length = 0
      }
      awaitingReplay = false
      replaying = true
      replayHandled = true
      payloadChars = data.length
      payloadBytes = replayByteLength(data)
      replayStartedAt = performance.now()
      firstContentAt = 0
      writeCount = 0
      maxWriteMs = 0
      replayChunks = splitReplayIntoChunks(data, MAX_TERMINAL_WRITE_CHARS)
      replayIndex = 0
      emitState('replaying', false)
      scheduleDrain()
    },
    handleLiveData: (data: string) => {
      if (disposed || !data) return
      // Resume-suppression takes precedence over the replay-buffer branch: while
      // a relaunch is in flight we withhold ALL live output until the alt-screen
      // repaint begins (or the fallback fires), regardless of replay state.
      if (resumeSuppressing) {
        resumeHold += data
        if (ALT_SCREEN_ENTER_RE.test(resumeHold)) revealResume()
        return
      }
      if (awaitingReplay || replaying) {
        liveBuffer.push(data)
        liveBufferedCount += 1
        return
      }
      outputQueue.enqueue(data)
    },
    // Arm resume-suppression for a freeze-the-view relaunch: until the relaunched
    // CLI re-enters its alt-screen TUI (or `timeoutMs` elapses), boot output is
    // withheld instead of painted. Call this immediately before kicking the
    // relaunch, so the first live chunk is already intercepted.
    armResumeSuppression: (timeoutMs: number = RESUME_SUPPRESSION_TIMEOUT_MS) => {
      if (disposed) return
      if (resumeTimer !== null) clearTimeout(resumeTimer)
      resumeSuppressing = true
      resumeHold = ''
      resumeTimer = setTimeout(revealResume, Math.max(0, timeoutMs))
    },
    // Flush any withheld boot output and disarm. Used as the fallback when the
    // relaunched process exits before painting an alt-screen, so a genuine boot
    // error still surfaces. A no-op when not suppressing.
    flushResumeSuppression: () => {
      revealResume()
    },
    dispose: () => {
      disposed = true
      awaitingReplay = false
      replaying = false
      liveBuffer.length = 0
      replayChunks = []
      replayIndex = 0
      resumeSuppressing = false
      resumeHold = ''
      if (resumeTimer !== null) {
        clearTimeout(resumeTimer)
        resumeTimer = null
      }
    },
  }
}
