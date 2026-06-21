import assert from 'node:assert/strict'

import { RUN_SIGNAL_FILENAME, parseRunSignal, runSignalPath } from './run-signal'

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
  assert.equal(parseRunSignal('{"status":"completed","summary":""}'), null)
}

function assertRejectsEmptyInput(): void {
  assert.equal(parseRunSignal(''), null)
  assert.equal(parseRunSignal('   '), null)
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
  assertRejectsEmptyInput()
  console.log('automations run-signal tests passed')
}

main()
