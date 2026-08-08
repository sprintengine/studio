import assert from 'node:assert/strict'

import { createBuildSkewWatch } from './build-skew'
import type { BuildStamp } from '../shared/build-stamp'

function stamp(commit: string | null, builtAt = '2026-08-07T00:08:11.000Z'): BuildStamp {
  return {
    commit,
    source: commit ? 'git' : 'unavailable',
    builtAt,
    mode: 'development',
  }
}

const MAIN = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const THIRD = 'c'.repeat(40)

function watchWithSpies(mainCommit: string | null = MAIN) {
  const lines: string[] = []
  const notices: { headline: string; detail: string }[] = []
  const watch = createBuildSkewWatch({
    mainStamp: stamp(mainCommit),
    log: (line) => lines.push(line),
    announce: (notice) => notices.push(notice),
  })
  return { watch, lines, notices }
}

// The quiet path. Matching halves say nothing at all — this runs on every boot,
// and a check that narrates itself is a check people learn to ignore.
{
  const { watch, lines, notices } = watchWithSpies()
  const verdict = watch.recordRendererStamp(stamp(MAIN, '2026-08-07T05:31:44.000Z'))
  assert.deepEqual(verdict, { status: 'match' })
  assert.deepEqual(lines, [])
  assert.deepEqual(notices, [])
}

// A skew is announced, and announced once: the second window on the same
// divergent commit is the same fact, not a second incident.
{
  const { watch, lines, notices } = watchWithSpies()
  watch.recordRendererStamp(stamp(OTHER))
  watch.recordRendererStamp(stamp(OTHER))
  watch.recordRendererStamp(stamp(OTHER))
  assert.equal(notices.length, 1, 'the operator is told once')
  assert.equal(lines.filter((line) => line.includes('build_skew_detected')).length, 1)
  assert.ok(lines.some((line) => line.includes('aaaaaaa') && line.includes('bbbbbbb')))
}

// Two commits sharing a short prefix are two incidents, not one: the dedup key
// is the full sha, while the messages print the abbreviation.
{
  const { watch, notices } = watchWithSpies()
  watch.recordRendererStamp(stamp('bbbbbbb' + '1'.repeat(33)))
  watch.recordRendererStamp(stamp('bbbbbbb' + '2'.repeat(33)))
  assert.equal(notices.length, 2)
}

// A third commit appearing later is new information — one more announcement,
// not a repeat suppressed by the first.
{
  const { watch, notices } = watchWithSpies()
  watch.recordRendererStamp(stamp(OTHER))
  watch.recordRendererStamp(stamp(THIRD))
  watch.recordRendererStamp(stamp(OTHER))
  assert.equal(notices.length, 2)
}

// A window matching main after a skew was reported still reads `match`: each
// report is judged on its own, and nothing is sticky except the announcement.
{
  const { watch, notices } = watchWithSpies()
  watch.recordRendererStamp(stamp(OTHER))
  assert.deepEqual(watch.recordRendererStamp(stamp(MAIN)), { status: 'match' })
  assert.equal(notices.length, 1)
}

// No commit on either side turns the check off. It is logged so the absence is
// visible, once, and never shown to a person as a skew.
{
  const { watch, lines, notices } = watchWithSpies(null)
  watch.recordRendererStamp(stamp(OTHER))
  watch.recordRendererStamp(stamp(THIRD))
  assert.deepEqual(notices, [], 'an unknown identity is not a skew')
  assert.equal(lines.length, 1, 'said once')
  assert.ok(lines[0]?.includes('build_skew_check_unavailable'))
  assert.ok(lines[0]?.includes('missing=main'))
}

// The IPC payload is untrusted: a malformed report is rejected and logged, never
// compared against.
{
  const { watch, lines, notices } = watchWithSpies()
  assert.equal(watch.recordReportedPayload({ commit: 42 }), null)
  assert.equal(watch.recordReportedPayload(undefined), null)
  assert.deepEqual(notices, [])
  assert.equal(lines.filter((line) => line.includes('build_stamp_report_rejected')).length, 2)
}

// A well-formed payload over the wire behaves exactly like a direct report.
{
  const { watch, notices } = watchWithSpies()
  const verdict = watch.recordReportedPayload({
    commit: OTHER,
    source: 'git',
    builtAt: '2026-08-07T05:31:44.000Z',
    mode: 'development',
  })
  assert.deepEqual(verdict, { status: 'skew' })
  assert.equal(notices.length, 1)
  assert.ok(notices[0]?.detail.includes('bbbbbbb'))
}

console.log('build-skew watch ok')
