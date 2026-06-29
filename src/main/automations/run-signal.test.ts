import assert from 'node:assert/strict'

import {
  MAX_RUN_SIGNAL_REPORTS,
  MAX_RUN_SIGNAL_REPORT_PATH_LENGTH,
  RUN_SIGNAL_FILENAME,
  parseRunSignal,
  runSignalPath,
} from './run-signal'

function assertPathJoinsFilenameToWorktree(): void {
  assert.equal(RUN_SIGNAL_FILENAME, '.multicode-automation-run-status.json')
  assert.equal(runSignalPath('/runs/wt'), `/runs/wt/${RUN_SIGNAL_FILENAME}`)
}

function assertParsesValidCompleted(): void {
  assert.deepEqual(parseRunSignal('{"status":"completed"}'), { outcome: 'completed' })
}

function assertParsesValidFailed(): void {
  assert.deepEqual(parseRunSignal('{"status":"failed"}'), { outcome: 'failed' })
}

function assertParsesValidWithSummary(): void {
  assert.deepEqual(parseRunSignal('{"status":"completed","summary":"opened PR #7"}'), {
    outcome: 'completed',
    summary: 'opened PR #7',
  })
}

function assertIgnoresUnknownKeys(): void {
  assert.deepEqual(parseRunSignal('{"status":"failed","extra":true,"nested":{"a":1}}'), {
    outcome: 'failed',
  })
}

function assertRejectsMalformedJson(): void {
  assert.equal(parseRunSignal('{not json'), null)
  assert.equal(parseRunSignal('"completed"'), null)
  assert.equal(parseRunSignal('["completed"]'), null)
  assert.equal(parseRunSignal('null'), null)
}

function assertRejectsMissingStatus(): void {
  assert.equal(parseRunSignal('{"summary":"done"}'), null)
}

function assertRejectsUnrecognizedStatus(): void {
  assert.equal(parseRunSignal('{"status":"queued"}'), null)
  assert.equal(parseRunSignal('{"status":"blocked"}'), null)
  assert.equal(parseRunSignal('{"status":"COMPLETED"}'), null)
}

function assertRejectsNonStringSummary(): void {
  assert.equal(parseRunSignal('{"status":"completed","summary":123}'), null)
  assert.equal(parseRunSignal('{"status":"completed","summary":null}'), null)
}

function assertTreatsEmptySummaryAsAbsent(): void {
  // An empty/whitespace summary is cosmetic, not a parse failure: the run still
  // finalizes (regression guard for the stranded-run bug, F1).
  assert.deepEqual(parseRunSignal('{"status":"completed","summary":""}'), { outcome: 'completed' })
  assert.deepEqual(parseRunSignal('{"status":"completed","summary":"   "}'), { outcome: 'completed' })
  assert.deepEqual(parseRunSignal('{"status":"failed","summary":"\\n\\t"}'), { outcome: 'failed' })
}

function assertRejectsEmptyInput(): void {
  assert.equal(parseRunSignal(''), null)
  assert.equal(parseRunSignal('   '), null)
}

function assertParsesValidReports(): void {
  assert.deepEqual(
    parseRunSignal('{"status":"completed","reports":["reports/a.md","reports/sub/b.html"]}'),
    { outcome: 'completed', reports: ['reports/a.md', 'reports/sub/b.html'] },
  )
  // Entries are trimmed; non-empty after trim survive.
  assert.deepEqual(
    parseRunSignal('{"status":"failed","reports":["  reports/a.md  "]}'),
    { outcome: 'failed', reports: ['reports/a.md'] },
  )
  // reports coexist with a summary.
  assert.deepEqual(
    parseRunSignal('{"status":"completed","summary":"done","reports":["reports/a.md"]}'),
    { outcome: 'completed', summary: 'done', reports: ['reports/a.md'] },
  )
  // Containment (under reports/) is NOT enforced here — parse keeps structurally
  // valid strings; the engine drops out-of-reports paths later.
  assert.deepEqual(
    parseRunSignal('{"status":"completed","reports":["../etc/passwd"]}'),
    { outcome: 'completed', reports: ['../etc/passwd'] },
  )
  // Exactly at the count cap is accepted.
  const atCap = Array.from({ length: MAX_RUN_SIGNAL_REPORTS }, (_, i) => `reports/r${i}.md`)
  assert.deepEqual(parseRunSignal(JSON.stringify({ status: 'completed', reports: atCap })), {
    outcome: 'completed',
    reports: atCap,
  })
}

function assertCoercesInvalidReportsToAbsent(): void {
  // A malformed reports value must never strand the terminal outcome: it is
  // coerced to absent (mirror of the empty-summary rule), keeping the outcome.
  const absent = { outcome: 'completed' as const }
  assert.deepEqual(parseRunSignal('{"status":"completed","reports":"reports/a.md"}'), absent, 'non-array')
  assert.deepEqual(parseRunSignal('{"status":"completed","reports":[]}'), absent, 'empty array')
  assert.deepEqual(parseRunSignal('{"status":"completed","reports":["reports/a.md",123]}'), absent, 'non-string entry')
  assert.deepEqual(parseRunSignal('{"status":"completed","reports":["reports/a.md",null]}'), absent, 'null entry')
  assert.deepEqual(parseRunSignal('{"status":"completed","reports":[""]}'), absent, 'empty-string entry')
  assert.deepEqual(parseRunSignal('{"status":"completed","reports":["   "]}'), absent, 'whitespace entry')

  // One over the count cap → absent (not truncated): a flood is treated as bad.
  const overCap = Array.from({ length: MAX_RUN_SIGNAL_REPORTS + 1 }, (_, i) => `reports/r${i}.md`)
  assert.deepEqual(parseRunSignal(JSON.stringify({ status: 'completed', reports: overCap })), absent, 'over count cap')

  // Over-length path → absent.
  const longPath = `reports/${'a'.repeat(MAX_RUN_SIGNAL_REPORT_PATH_LENGTH)}.md`
  assert.deepEqual(parseRunSignal(JSON.stringify({ status: 'failed', reports: [longPath] })), { outcome: 'failed' }, 'over-length path')
}

function main(): void {
  assertPathJoinsFilenameToWorktree()
  assertParsesValidCompleted()
  assertParsesValidFailed()
  assertParsesValidWithSummary()
  assertIgnoresUnknownKeys()
  assertRejectsMalformedJson()
  assertRejectsMissingStatus()
  assertRejectsUnrecognizedStatus()
  assertRejectsNonStringSummary()
  assertTreatsEmptySummaryAsAbsent()
  assertRejectsEmptyInput()
  assertParsesValidReports()
  assertCoercesInvalidReportsToAbsent()
  console.log('automations run-signal tests passed')
}

main()
