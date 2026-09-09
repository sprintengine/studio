import { logPerfEvent, perfDiagnosticsEnabled } from './perfDiagnostics'
import { recordTerminalWrite } from './diagnostics/terminalThroughputStore'
import type { TerminalFileLinkDrop } from './terminalFileLinks'

type TerminalDiagnosticsInput = {
  scope: string
  sessionId: string
  workspaceId?: string
  agentId?: string
  terminalId?: string
  kind: 'agent' | 'terminal'
  rendererMode?: 'default' | 'webgl'
}

type TerminalDiagnosticsCounters = {
  keydownCount: number
  spaceKeydownCount: number
  containerKeydownCount: number
  containerSpaceKeydownCount: number
  focusCount: number
  inputEventCount: number
  inputBytes: number
  inputDispatchCount: number
  inputDispatchBytes: number
  inputWriteCount: number
  inputWriteBytes: number
  inputWriteSlowCount: number
  inputWriteErrorCount: number
  inputWriteMaxMs: number
  inputWriteTotalMs: number
  outputEventCount: number
  outputBytes: number
  outputWriteCount: number
  outputWriteSlowCount: number
  outputWriteMaxMs: number
  outputWriteTotalMs: number
  fileLinkDropNoRootCount: number
  fileLinkDropNoRangeCount: number
}

const TERMINAL_DIAGNOSTIC_FLUSH_MS = 1_000
const SLOW_TERMINAL_INPUT_WRITE_MS = 50
const SLOW_TERMINAL_OUTPUT_WRITE_MS = 32

function emptyCounters(): TerminalDiagnosticsCounters {
  return {
    keydownCount: 0,
    spaceKeydownCount: 0,
    containerKeydownCount: 0,
    containerSpaceKeydownCount: 0,
    focusCount: 0,
    inputEventCount: 0,
    inputBytes: 0,
    inputDispatchCount: 0,
    inputDispatchBytes: 0,
    inputWriteCount: 0,
    inputWriteBytes: 0,
    inputWriteSlowCount: 0,
    inputWriteErrorCount: 0,
    inputWriteMaxMs: 0,
    inputWriteTotalMs: 0,
    outputEventCount: 0,
    outputBytes: 0,
    outputWriteCount: 0,
    outputWriteSlowCount: 0,
    outputWriteMaxMs: 0,
    outputWriteTotalMs: 0,
    fileLinkDropNoRootCount: 0,
    fileLinkDropNoRangeCount: 0,
  }
}

function byteLength(value: string): number {
  return new Blob([value]).size
}

function hasActivity(counters: TerminalDiagnosticsCounters): boolean {
  return Object.values(counters).some((value) => value > 0)
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

export function createTerminalDiagnostics(input: TerminalDiagnosticsInput) {
  if (!perfDiagnosticsEnabled()) {
    return {
      recordFocus: () => {},
      recordKeydown: (_event: KeyboardEvent) => {},
      recordContainerKeydown: (_event: KeyboardEvent) => {},
      recordInput: (_data: string) => {},
      recordInputDispatch: (_data: string) => {},
      recordInputWrite: (_data: string, _startedAt: number, _ok: boolean) => {},
      recordOutputWrite: (_data: string, _elapsedMs: number) => {},
      recordFileLinkDrop: (_drop: TerminalFileLinkDrop) => {},
      flush: () => {},
      dispose: () => {},
    }
  }

  let counters = emptyCounters()
  let lastFlushAt = performance.now()

  const commonPayload = {
    sessionId: input.sessionId,
    kind: input.kind,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    terminalId: input.terminalId,
    rendererMode: input.rendererMode ?? 'default',
  }

  const flush = (reason: 'interval' | 'dispose' = 'interval') => {
    if (!hasActivity(counters)) return

    const now = performance.now()
    const elapsedMs = Math.max(now - lastFlushAt, 1)
    const inputWriteAvgMs = counters.inputWriteCount > 0
      ? counters.inputWriteTotalMs / counters.inputWriteCount
      : 0
    const outputWriteAvgMs = counters.outputWriteCount > 0
      ? counters.outputWriteTotalMs / counters.outputWriteCount
      : 0

    logPerfEvent(input.scope, 'terminal-profile', {
      ...commonPayload,
      reason,
      windowMs: Math.round(elapsedMs),
      keydownCount: counters.keydownCount,
      spaceKeydownCount: counters.spaceKeydownCount,
      containerKeydownCount: counters.containerKeydownCount,
      containerSpaceKeydownCount: counters.containerSpaceKeydownCount,
      focusCount: counters.focusCount,
      inputEventCount: counters.inputEventCount,
      inputBytes: counters.inputBytes,
      inputDispatchCount: counters.inputDispatchCount,
      inputDispatchBytes: counters.inputDispatchBytes,
      inputWriteCount: counters.inputWriteCount,
      inputWriteBytes: counters.inputWriteBytes,
      inputWriteSlowCount: counters.inputWriteSlowCount,
      inputWriteErrorCount: counters.inputWriteErrorCount,
      inputWriteAvgMs: round(inputWriteAvgMs),
      inputWriteMaxMs: round(counters.inputWriteMaxMs),
      outputEventCount: counters.outputEventCount,
      outputBytes: counters.outputBytes,
      outputBytesPerSecond: Math.round((counters.outputBytes * 1000) / elapsedMs),
      outputWriteCount: counters.outputWriteCount,
      outputWriteSlowCount: counters.outputWriteSlowCount,
      outputWriteAvgMs: round(outputWriteAvgMs),
      outputWriteMaxMs: round(counters.outputWriteMaxMs),
      fileLinkDropNoRootCount: counters.fileLinkDropNoRootCount,
      fileLinkDropNoRangeCount: counters.fileLinkDropNoRangeCount,
    })

    counters = emptyCounters()
    lastFlushAt = now
  }

  const intervalId = window.setInterval(() => flush(), TERMINAL_DIAGNOSTIC_FLUSH_MS)

  return {
    recordFocus: () => {
      counters.focusCount += 1
    },
    recordKeydown: (event: KeyboardEvent) => {
      counters.keydownCount += 1
      if (event.key === ' ') {
        counters.spaceKeydownCount += 1
      }
    },
    recordContainerKeydown: (event: KeyboardEvent) => {
      counters.containerKeydownCount += 1
      if (event.key === ' ') {
        counters.containerSpaceKeydownCount += 1
      }
    },
    recordInput: (data: string) => {
      counters.inputEventCount += 1
      counters.inputBytes += byteLength(data)
    },
    recordInputDispatch: (data: string) => {
      counters.inputDispatchCount += 1
      counters.inputDispatchBytes += byteLength(data)
    },
    recordInputWrite: (data: string, startedAt: number, ok: boolean) => {
      const elapsedMs = performance.now() - startedAt
      counters.inputWriteCount += 1
      counters.inputWriteBytes += byteLength(data)
      counters.inputWriteTotalMs += elapsedMs
      counters.inputWriteMaxMs = Math.max(counters.inputWriteMaxMs, elapsedMs)
      if (elapsedMs >= SLOW_TERMINAL_INPUT_WRITE_MS) {
        counters.inputWriteSlowCount += 1
      }
      if (!ok) {
        counters.inputWriteErrorCount += 1
      }
    },
    recordOutputWrite: (data: string, elapsedMs: number) => {
      const bytes = byteLength(data)
      // Feed the per-session throughput store so the panel can split byte rate
      // into on-screen vs hidden-but-rendering terminals.
      recordTerminalWrite(input.sessionId, bytes)
      counters.outputEventCount += 1
      counters.outputBytes += bytes
      counters.outputWriteCount += 1
      counters.outputWriteTotalMs += elapsedMs
      counters.outputWriteMaxMs = Math.max(counters.outputWriteMaxMs, elapsedMs)
      if (elapsedMs >= SLOW_TERMINAL_OUTPUT_WRITE_MS) {
        counters.outputWriteSlowCount += 1
      }
    },
    // A path the link pattern matched that never became a link. Silent by
    // construction — the text simply is not underlined — so the counter is the
    // only evidence that a pane is linkifying nothing. `no-root` means the pane
    // has neither an execution nor a workspace root, which is what a
    // folder-less workspace looks like from here; `no-range` should never fire
    // at all and means the link geometry has come apart.
    //
    // Switched exhaustively rather than `if/else`: a reason added later must
    // land in its own counter, not silently inflate whichever one caught the
    // fallthrough.
    recordFileLinkDrop: (drop: TerminalFileLinkDrop) => {
      switch (drop.reason) {
        case 'no-root':
          counters.fileLinkDropNoRootCount += 1
          break
        case 'no-range':
          counters.fileLinkDropNoRangeCount += 1
          break
      }
    },
    flush,
    dispose: () => {
      window.clearInterval(intervalId)
      flush('dispose')
    },
  }
}
