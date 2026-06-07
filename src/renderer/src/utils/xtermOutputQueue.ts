import type { Terminal } from '@xterm/xterm'
import { TERMINAL_RECENT_REPLAY_BYTES } from '../../../shared/terminal-history'

const MAX_TERMINAL_WRITE_CHARS = 32 * 1024
const MAX_QUEUED_TERMINAL_CHARS = TERMINAL_RECENT_REPLAY_BYTES
const TERMINAL_WRITE_FRAME_BUDGET_MS = 8
const TERMINAL_THROTTLE_MESSAGE = '\r\n[Multicode: renderer terminal output throttled to keep the UI responsive]\r\n'

type TerminalOutputQueueOptions = {
  recordWrite: (data: string, elapsedMs: number) => void
}

type XtermOutputQueue = ReturnType<typeof createXtermOutputQueue>

type XtermReplayGateOptions = {
  container?: HTMLElement
  recordWrite?: (data: string, elapsedMs: number) => void
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
  { container, recordWrite }: XtermReplayGateOptions = {}
) {
  const liveBuffer: string[] = []
  let disposed = false
  let awaitingReplay = false
  let replaying = false
  let previousVisibility: string | null = null

  const hide = () => {
    if (!container || previousVisibility !== null) return
    previousVisibility = container.style.visibility
    container.style.visibility = 'hidden'
  }

  const reveal = () => {
    if (!container || previousVisibility === null) return
    container.style.visibility = previousVisibility
    previousVisibility = null
  }

  const flushLiveBuffer = () => {
    if (awaitingReplay || replaying) return
    while (liveBuffer.length > 0) {
      const next = liveBuffer.shift()
      if (next) outputQueue.enqueue(next)
    }
  }

  return {
    beginReplayWait: () => {
      if (disposed) return
      awaitingReplay = true
      hide()
    },
    finishReplayWait: () => {
      if (disposed || replaying) return
      awaitingReplay = false
      reveal()
      flushLiveBuffer()
    },
    handleReplay: (data: string) => {
      if (disposed || !data) return
      awaitingReplay = false
      replaying = true
      hide()
      const writeStartedAt = performance.now()
      term.write(data, () => {
        recordWrite?.(data, performance.now() - writeStartedAt)
        term.scrollToBottom()
        replaying = false
        reveal()
        flushLiveBuffer()
      })
    },
    handleLiveData: (data: string) => {
      if (disposed || !data) return
      if (awaitingReplay || replaying) {
        liveBuffer.push(data)
        return
      }
      outputQueue.enqueue(data)
    },
    dispose: () => {
      disposed = true
      liveBuffer.length = 0
      reveal()
    },
  }
}
