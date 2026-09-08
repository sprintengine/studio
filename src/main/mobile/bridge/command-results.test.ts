import assert from 'node:assert/strict'
import { summarizeCommandResult } from './command-results'
import type { MobileSprintEngineCommandResult } from '../sprintengine/command'

// A failing command whose error names a local path used to reach the relay
// unredacted, and the relay refuses the whole summary, so the phone never saw
// the error at all: it polled to its own timeout. The message and the audit
// go through the same redaction as data.
function failing(message: string): MobileSprintEngineCommandResult {
  return {
    ok: false,
    commandId: 'cmd-1',
    commandType: 'artifact.approve',
    error: { protocolVersion: 2, code: 'command_not_supported', message, retryable: false },
    audit: {
      auditId: 'audit-1',
      commandId: 'cmd-1',
      deviceId: 'device-1',
      commandType: 'artifact.approve',
      status: 'rejected',
      code: 'command_not_supported',
      message,
      recordedAt: '2026-09-08T00:00:00.000Z',
    },
  }
}

const localPath = process.platform === 'win32' ? 'C:\\Users\\dev\\repo\\plan.md' : '/Users/dev/repo/plan.md'
const summary = summarizeCommandResult(failing(`Could not read ${localPath}`))
const flat = JSON.stringify(summary)
assert.equal(summary.ok, false)
assert.equal(summary.code, 'command_not_supported')
assert.ok(!flat.includes(localPath), `summary still carries the local path: ${flat}`)
assert.ok(typeof summary.message === 'string' && summary.message.length > 0, 'the message survives redaction')
console.log('ok - a failing command result reaches the relay without a local path in its message or audit')
