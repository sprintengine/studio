/**
 * Batches a pane's flow-control acknowledgements to main.
 *
 * xterm reports each parsed write separately — up to 32K units apiece, several
 * a frame under load — and one IPC message per report would be chatter for
 * nothing. Acks are gathered and sent once ACK_BATCH_UNITS have built up, or
 * ACK_FLUSH_DELAY_MS after the first one, whichever comes first. Main resumes a
 * paused pty once the backlog drops under its low watermark (5,000 units), so a
 * batch much larger than that would hold the pty paused after the pane had
 * already caught up; the timer bounds that to a frame.
 */
export const ACK_BATCH_UNITS = 4 * 1024
export const ACK_FLUSH_DELAY_MS = 16

export function createTerminalAckReporter(send: (units: number) => void) {
  let pending = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending <= 0) return
    const units = pending
    pending = 0
    send(units)
  }

  return {
    ack: (units: number) => {
      if (disposed || !(units > 0)) return
      pending += units
      if (pending >= ACK_BATCH_UNITS) {
        flush()
        return
      }
      timer ??= setTimeout(flush, ACK_FLUSH_DELAY_MS)
    },
    /** Send what is pending and stop. */
    dispose: () => {
      if (disposed) return
      flush()
      disposed = true
    },
  }
}

/** The reporter for one local session's pane: acks go to main over `terminal:ack`. */
export function createSessionAckReporter(sessionId: string) {
  return createTerminalAckReporter((units) => {
    // A narrower preload (an aux window, a test harness) has no ack channel;
    // main then simply never waits on this pane.
    if (typeof window.api.terminalAck === 'function') window.api.terminalAck(sessionId, units)
  })
}
