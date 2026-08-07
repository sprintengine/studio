import assert from 'node:assert/strict'
import {
  createStartupTimeline,
  formatStartupTimeline,
  startupTimelineEnabledFor,
  type StartupTimelineReport,
} from './startup-timeline'

const ORIGIN = 1_000_000

function collector(options: { expected?: string[]; timeoutMs?: number } = {}) {
  const reports: StartupTimelineReport[] = []
  let timerHandler: (() => void) | null = null
  let cleared = 0
  const timeline = createStartupTimeline({
    originEpochMs: ORIGIN,
    expected: options.expected,
    timeoutMs: options.timeoutMs,
    onFinalize: (report) => reports.push(report),
    timers: {
      setTimer: (handler) => {
        timerHandler = handler
        return 'handle'
      },
      clearTimer: () => {
        cleared += 1
      },
    },
  })
  return {
    timeline,
    reports,
    fireTimeout: () => timerHandler?.(),
    get cleared() {
      return cleared
    },
  }
}

// Finalizes as soon as every expected mark has arrived, with offsets measured
// from the origin rather than from the first mark.
{
  const { timeline, reports, cleared } = collector({ expected: ['main.process-start', 'main.app-ready'] })
  timeline.record('main.process-start', ORIGIN)
  assert.equal(reports.length, 0, 'does not finalize while a mark is outstanding')
  timeline.record('main.app-ready', ORIGIN + 250)
  assert.equal(reports.length, 1)
  const [report] = reports
  assert.equal(report.complete, true)
  assert.equal(report.finalizedBecause, 'complete')
  assert.deepEqual(report.missing, [])
  assert.deepEqual(
    report.rows.map((row) => [row.id, row.offsetMs, row.sincePreviousMs]),
    [
      ['main.process-start', 0, 0],
      ['main.app-ready', 250, 250],
    ]
  )
  assert.ok(cleared >= 0)
  assert.equal(timeline.finalized, true)
}

// A renderer that never paints still produces a read-out, labelled as partial
// and naming what never arrived.
{
  const { timeline, reports, fireTimeout } = collector({
    expected: ['main.process-start', 'renderer.first-paint'],
  })
  timeline.record('main.process-start', ORIGIN)
  fireTimeout()
  assert.equal(reports.length, 1)
  assert.equal(reports[0].complete, false)
  assert.equal(reports[0].finalizedBecause, 'timeout')
  assert.deepEqual(reports[0].missing, ['renderer.first-paint'])
  assert.match(formatStartupTimeline(reports[0]), /incomplete \(timeout\) — never arrived: renderer\.first-paint/)
}

// The IPC-fed side: unknown ids, non-numeric times, and repeats are dropped
// rather than stored, and nothing arrives after finalization.
{
  const { timeline, reports } = collector({ expected: ['main.process-start'] })
  timeline.record('not-a-mark', ORIGIN + 1)
  timeline.record('main.app-ready', Number.NaN)
  timeline.record('main.app-ready', 'soon' as unknown as number)
  timeline.record('main.process-start', ORIGIN + 5)
  timeline.record('main.process-start', ORIGIN + 999)
  timeline.record('main.reveal', ORIGIN + 10)
  assert.equal(reports.length, 1)
  assert.deepEqual(
    reports[0].rows.map((row) => [row.id, row.offsetMs]),
    [['main.process-start', 5]],
    'only the first write of a known id with a finite time is kept'
  )
}

// Named spans are computed only from marks that arrived, so a partial boot
// reports the phases it measured instead of inventing the rest.
{
  const { timeline, reports, fireTimeout } = collector({
    expected: ['main.process-start', 'renderer.navigation-start', 'renderer.script-start', 'main.reveal'],
  })
  timeline.record('main.process-start', ORIGIN)
  timeline.record('renderer.navigation-start', ORIGIN + 400)
  timeline.record('renderer.script-start', ORIGIN + 690)
  fireTimeout()
  const spans = new Map(reports[0].spans.map((span) => [span.id, span.ms]))
  assert.equal(spans.get('eager-chunk'), 290, 'document start → entry script is the eager chunk cost')
  assert.equal(spans.has('time-to-app'), false, 'no reveal mark, no time-to-app claim')
}

// Rows sort by measured offset, so a phase that lands out of the expected order
// reads as exactly that.
{
  const { timeline, reports } = collector({ expected: ['main.reveal', 'main.discovery-settled'] })
  timeline.record('main.discovery-settled', ORIGIN + 1_800)
  timeline.record('main.reveal', ORIGIN + 900)
  assert.deepEqual(
    reports[0].rows.map((row) => row.id),
    ['main.reveal', 'main.discovery-settled']
  )
}

// The gate both processes read.
{
  assert.equal(startupTimelineEnabledFor({}), false)
  assert.equal(startupTimelineEnabledFor({ MULTICODE_STARTUP_TIMELINE: '1' }), true)
  assert.equal(startupTimelineEnabledFor({ MULTICODE_DIAGNOSTICS: '1' }), true)
  assert.equal(startupTimelineEnabledFor({ MULTICODE_STARTUP_TIMELINE: 'yes' }), false)
}

console.log('startup-timeline tests passed')
