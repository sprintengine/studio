import assert from 'node:assert/strict'
import { summarizeCommandResult } from './command-results'
import type { MobileControlCommandResult } from '../control/command'
import { mobileControlProtocolVersion } from '../../../../packages/mobile-control-protocol/src/index'

// A failing command whose error names a local path used to reach the relay
// unredacted, and the relay refuses the whole summary, so the phone never saw
// the error at all: it polled to its own timeout. The message and the audit
// go through the same redaction as data.
function failing(message: string): MobileControlCommandResult {
  return {
    ok: false,
    commandId: 'cmd-1',
    commandType: 'backlog.update',
    error: { protocolVersion: mobileControlProtocolVersion, code: 'path_not_allowed', message, retryable: false },
    audit: {
      auditId: 'audit-1',
      commandId: 'cmd-1',
      deviceId: 'device-1',
      commandType: 'backlog.update',
      status: 'rejected',
      code: 'path_not_allowed',
      message,
      recordedAt: '2026-09-08T00:00:00.000Z',
    },
  }
}

const localPath = process.platform === 'win32' ? 'C:\\Users\\dev\\repo\\plan.md' : '/Users/dev/repo/plan.md'
const summary = summarizeCommandResult(failing(`Could not read ${localPath}`))
const flat = JSON.stringify(summary)
assert.equal(summary.ok, false)
assert.equal(summary.code, 'path_not_allowed')
assert.ok(!flat.includes(localPath), `summary still carries the local path: ${flat}`)
assert.ok(typeof summary.message === 'string' && summary.message.length > 0, 'the message survives redaction')
console.log('ok - a failing command result reaches the relay without a local path in its message or audit')
