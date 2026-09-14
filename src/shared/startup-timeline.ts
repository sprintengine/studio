// The startup timeline: the named boot phases, the collector that assembles
// them across the two processes, and the read-out.
//
// Why it exists: `scripts/check-bundle-budget.mjs` gates boot on KB because KB
// was the only thing anyone could measure. This module measures the thing the
// ceiling is a proxy for — the wall clock between process start and the app
// being on screen — so the ceiling can be argued from a number instead of a
// round one (MC-2075).
//
// Two processes, one clock. Main and renderer each own their own
// `performance.now()` origin, so a mark is reported as an EPOCH millisecond
// (`performance.timeOrigin + performance.now()`) and converted to an offset from
// the main process's origin here. Both processes read the same wall clock, so
// the offsets compose; nothing depends on the two `now()` origins agreeing.

import { readStudioEnv } from './studio-env'

type StartupMarkSource = 'main' | 'renderer'

export type StartupMarkId =
  | 'main.process-start'
  | 'main.module-evaluated'
  | 'main.app-ready'
  | 'main.splash-shown'
  | 'main.window-created'
  | 'main.reveal'
  | 'main.discovery-settled'
  | 'renderer.navigation-start'
  | 'renderer.script-start'
  | 'renderer.third-party-modules-settled'
  | 'renderer.module-wiring-settled'
  | 'renderer.root-rendered'
  | 'renderer.first-paint'

type StartupMarkSpec = {
  id: StartupMarkId
  label: string
  source: StartupMarkSource
}

// Declaration order is the order these are EXPECTED to happen and the order the
// read-out falls back to for equal offsets; the report itself sorts by measured
// offset, so a phase that lands out of order shows up as exactly that.
const STARTUP_MARKS: readonly StartupMarkSpec[] = [
  { id: 'main.process-start', label: 'main process start', source: 'main' },
  { id: 'main.module-evaluated', label: 'main entry evaluated (modules registered)', source: 'main' },
  { id: 'main.app-ready', label: 'app ready', source: 'main' },
  { id: 'main.splash-shown', label: 'splash window created', source: 'main' },
  { id: 'main.window-created', label: 'main window created', source: 'main' },
  { id: 'renderer.navigation-start', label: 'renderer document navigation start', source: 'renderer' },
  { id: 'renderer.script-start', label: 'renderer entry script running', source: 'renderer' },
  { id: 'renderer.third-party-modules-settled', label: 'third-party renderer modules settled', source: 'renderer' },
  { id: 'renderer.root-rendered', label: 'React root render returned', source: 'renderer' },
  { id: 'renderer.first-paint', label: 'renderer first paint (boot-complete sent)', source: 'renderer' },
  { id: 'main.reveal', label: 'splash closed, main window revealed', source: 'main' },
  { id: 'renderer.module-wiring-settled', label: 'deferred store/module wiring settled', source: 'renderer' },
  { id: 'main.discovery-settled', label: 'boot discovery settled (CLI, editors, updates)', source: 'main' },
]

const MARK_BY_ID = new Map(STARTUP_MARKS.map((mark) => [mark.id, mark]))
const MARK_ORDER = new Map(STARTUP_MARKS.map((mark, index) => [mark.id, index]))

function isStartupMarkId(value: unknown): value is StartupMarkId {
  return typeof value === 'string' && MARK_BY_ID.has(value as StartupMarkId)
}

// Derived spans worth naming: the numbers the bundle-ceiling argument turns on.
// Each is only reported when both of its marks arrived.
const STARTUP_SPANS: readonly {
  id: string
  label: string
  fromId: StartupMarkId
  toId: StartupMarkId
}[] = [
  {
    id: 'main-boot',
    label: 'main entry evaluation (module registration, sync discovery)',
    fromId: 'main.process-start',
    toId: 'main.module-evaluated',
  },
  {
    id: 'electron-ready',
    label: 'Electron runtime start → app ready',
    fromId: 'main.module-evaluated',
    toId: 'main.app-ready',
  },
  {
    // Measured from the splash, not from `main.window-created`: the main window
    // starts loading its document inside `createMainWindow`, so the mark after
    // that call lands a hair AFTER navigation start and the pair would read as a
    // negative span.
    id: 'window-setup',
    label: 'splash on screen → renderer document starts (main window creation)',
    fromId: 'main.splash-shown',
    toId: 'renderer.navigation-start',
  },
  {
    // The one the KB ceiling is a proxy for: HTML parse + eager chunk fetch,
    // compile and evaluate, all of it before a single line of app code runs.
    id: 'eager-chunk',
    label: 'document start → entry script running (eager chunk fetch+compile+eval)',
    fromId: 'renderer.navigation-start',
    toId: 'renderer.script-start',
  },
  {
    id: 'third-party-modules',
    label: 'entry script → third-party modules settled',
    fromId: 'renderer.script-start',
    toId: 'renderer.third-party-modules-settled',
  },
  {
    id: 'react-mount',
    label: 'third-party modules settled → React root rendered',
    fromId: 'renderer.third-party-modules-settled',
    toId: 'renderer.root-rendered',
  },
  {
    id: 'paint',
    label: 'React root rendered → first paint',
    fromId: 'renderer.root-rendered',
    toId: 'renderer.first-paint',
  },
  {
    // The handshake itself: boot-complete over IPC, splash destroyed, window
    // shown. Anything large here is the reveal, not the bundle.
    id: 'reveal',
    label: 'first paint → app on screen',
    fromId: 'renderer.first-paint',
    toId: 'main.reveal',
  },
  {
    // What the user actually waits through: process start to the app on screen.
    id: 'time-to-app',
    label: 'process start → app on screen',
    fromId: 'main.process-start',
    toId: 'main.reveal',
  },
]

type StartupTimelineRow = {
  id: StartupMarkId
  label: string
  source: StartupMarkSource
  offsetMs: number
  // Gap from the previous row in offset order; 0 for the first row.
  sincePreviousMs: number
}

type StartupTimelineSpan = {
  id: string
  label: string
  ms: number
}

export type StartupTimelineReport = {
  originEpochMs: number
  // True when every expected mark arrived before finalization.
  complete: boolean
  finalizedBecause: 'complete' | 'timeout'
  missing: StartupMarkId[]
  rows: StartupTimelineRow[]
  spans: StartupTimelineSpan[]
  // Offset of the last mark received — the full measured boot, not just the
  // part the user waits through (see the `time-to-app` span for that).
  lastMarkMs: number
}

type StartupTimelineTimers = {
  setTimer: (handler: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export type StartupTimelineOptions = {
  // Epoch ms the offsets are measured from: the main process's time origin.
  originEpochMs: number
  // Marks that must arrive before the timeline is considered complete.
  // Defaults to every declared mark.
  expected?: readonly string[]
  // Backstop. A renderer that never paints, or a discovery leg that never
  // settles, must still produce a (partial, honestly labelled) read-out.
  timeoutMs?: number
  onFinalize: (report: StartupTimelineReport) => void
  timers?: StartupTimelineTimers
}

export type StartupTimeline = {
  // First write per id wins: a dev HMR reload re-runs the renderer entry, and
  // the boot being measured is the first one.
  record: (id: string, atEpochMs: number) => void
  finalize: (reason?: 'complete' | 'timeout') => void
  readonly finalized: boolean
}

const STARTUP_TIMELINE_TIMEOUT_MS = 20_000

const defaultTimers: StartupTimelineTimers = {
  setTimer: (handler, ms) => setTimeout(handler, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createStartupTimeline({
  originEpochMs,
  expected = STARTUP_MARKS.map((mark) => mark.id),
  timeoutMs = STARTUP_TIMELINE_TIMEOUT_MS,
  onFinalize,
  timers = defaultTimers,
}: StartupTimelineOptions): StartupTimeline {
  const expectedIds = expected.filter(isStartupMarkId)
  const recorded = new Map<StartupMarkId, number>()
  let finalized = false
  let timeoutHandle: unknown = timers.setTimer(() => finalize('timeout'), timeoutMs)

  function finalize(reason: 'complete' | 'timeout' = 'complete'): void {
    if (finalized) return
    finalized = true
    if (timeoutHandle !== null) {
      timers.clearTimer(timeoutHandle)
      timeoutHandle = null
    }
    onFinalize(buildStartupTimelineReport({ originEpochMs, recorded, expectedIds, finalizedBecause: reason }))
  }

  return {
    record(id, atEpochMs) {
      if (finalized) return
      // An unknown id or a non-finite time is dropped rather than stored: this
      // is fed by an IPC channel, and the collector must not become somewhere a
      // renderer can push unbounded keys.
      if (!isStartupMarkId(id) || typeof atEpochMs !== 'number' || !Number.isFinite(atEpochMs)) return
      if (recorded.has(id)) return
      recorded.set(id, atEpochMs)
      if (expectedIds.every((expectedId) => recorded.has(expectedId))) finalize('complete')
    },
    finalize,
    get finalized() {
      return finalized
    },
  }
}

function buildStartupTimelineReport({
  originEpochMs,
  recorded,
  expectedIds,
  finalizedBecause,
}: {
  originEpochMs: number
  recorded: Map<StartupMarkId, number>
  expectedIds: readonly StartupMarkId[]
  finalizedBecause: 'complete' | 'timeout'
}): StartupTimelineReport {
  const rows: StartupTimelineRow[] = [...recorded.entries()]
    .map(([id, atEpochMs]) => {
      const spec = MARK_BY_ID.get(id)
      return {
        id,
        label: spec?.label ?? id,
        source: spec?.source ?? 'main',
        offsetMs: round(atEpochMs - originEpochMs),
        sincePreviousMs: 0,
      }
    })
    .sort((a, b) => a.offsetMs - b.offsetMs || (MARK_ORDER.get(a.id) ?? 0) - (MARK_ORDER.get(b.id) ?? 0))

  let previousOffset = 0
  for (const row of rows) {
    row.sincePreviousMs = round(row.offsetMs - previousOffset)
    previousOffset = row.offsetMs
  }

  const spans: StartupTimelineSpan[] = []
  for (const span of STARTUP_SPANS) {
    const from = recorded.get(span.fromId)
    const to = recorded.get(span.toId)
    if (from === undefined || to === undefined) continue
    spans.push({ id: span.id, label: span.label, ms: round(to - from) })
  }

  const missing = expectedIds.filter((id) => !recorded.has(id))
  return {
    originEpochMs,
    complete: missing.length === 0,
    finalizedBecause,
    missing,
    rows,
    spans,
    lastMarkMs: rows.length > 0 ? rows[rows.length - 1].offsetMs : 0,
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

// Human read-out. One line per mark with its offset and the gap it opened, then
// the named spans. Printed by the main process; also what the measurement
// harness shows per run.
export function formatStartupTimeline(report: StartupTimelineReport): string {
  const lines: string[] = []
  const width = report.rows.reduce((max, row) => Math.max(max, `${row.offsetMs}`.length), 0)
  for (const row of report.rows) {
    const offset = `${row.offsetMs}`.padStart(width)
    const delta = row.sincePreviousMs > 0 ? ` (+${row.sincePreviousMs})` : ''
    lines.push(`  ${offset} ms  ${row.label}${delta}`)
  }
  if (report.spans.length > 0) {
    lines.push('  --')
    for (const span of report.spans) lines.push(`  ${`${span.ms}`.padStart(width)} ms  ${span.label}`)
  }
  if (!report.complete) {
    lines.push(`  incomplete (${report.finalizedBecause}) — never arrived: ${report.missing.join(', ')}`)
  }
  return lines.join('\n')
}

// Both processes resolve the gate from the same environment, so main's listener
// and the renderer's reporting can never disagree about whether boot is being
// measured. Off by default: this is a diagnostic, not a always-on cost.
export function startupTimelineEnabledFor(env: Record<string, string | undefined>): boolean {
  return (
    readStudioEnv('SPRINTENGINE_STARTUP_TIMELINE', env) === '1' ||
    readStudioEnv('SPRINTENGINE_DIAGNOSTICS', env) === '1'
  )
}

export const STARTUP_MARK_CHANNEL = 'app:startup-mark'
