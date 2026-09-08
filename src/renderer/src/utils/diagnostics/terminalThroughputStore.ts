// Per-session record of bytes written to xterm, fed from the existing
// terminalDiagnostics.recordOutputWrite seam. The summarizer splits the recent
// byte rate into on-screen vs hidden-but-rendering terminals, quantifying the
// "hidden tabs still doing work" cost the panel already names as a warning.
const TERMINAL_WRITE_HISTORY_LIMIT = 4000

export type TerminalWriteSample = {
  sessionId: string
  bytes: number
  recordedAt: number
}

export type TerminalThroughput = {
  windowMs: number
  totalBytesPerSec: number
  hiddenBytesPerSec: number
  visibleBytesPerSec: number
}

const samples: TerminalWriteSample[] = []
const listeners = new Set<() => void>()

export function recordTerminalWrite(sessionId: string, bytes: number, recordedAt = Date.now()): void {
  if (bytes <= 0) return
  samples.push({ sessionId, bytes, recordedAt })
  if (samples.length > TERMINAL_WRITE_HISTORY_LIMIT) {
    samples.splice(0, samples.length - TERMINAL_WRITE_HISTORY_LIMIT)
  }
  for (const listener of listeners) listener()
}

export function getTerminalWriteSamples(): TerminalWriteSample[] {
  return [...samples]
}

export function summarizeTerminalThroughput(
  input: readonly TerminalWriteSample[],
  options: { hiddenSessionIds: ReadonlySet<string>; windowMs?: number; now?: number }
): TerminalThroughput {
  const now = options.now ?? Date.now()
  const windowMs = options.windowMs ?? 5_000
  const scoped = input.filter((sample) => now - sample.recordedAt <= windowMs)

  let total = 0
  let hidden = 0
  for (const sample of scoped) {
    total += sample.bytes
    if (options.hiddenSessionIds.has(sample.sessionId)) hidden += sample.bytes
  }
  const perSec = (bytes: number) => Math.round((bytes * 1000) / windowMs)
  return {
    windowMs,
    totalBytesPerSec: perSec(total),
    hiddenBytesPerSec: perSec(hidden),
    visibleBytesPerSec: perSec(total - hidden),
  }
}
