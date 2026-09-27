import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  isSupportedMobileControlProtocolVersion,
  mobileControlMinSupportedProtocolVersion,
  mobileControlProtocolVersion,
  mobileControlSupportedProtocolVersions,
  mobileSnapshotCollections,
  unsupportedMobileControlProtocolVersion,
  validateMobileControlSnapshot,
  type MobileControlSnapshot,
} from './protocol'

const now = '2026-04-28T19:00:00.000Z'

const validSnapshot: MobileControlSnapshot = {
  protocolVersion: mobileControlProtocolVersion,
  generatedAt: now,
  desktopSessionId: 'desktop_session_1',
  snapshotVersion: 'snap_root_1',
  commands: ['snapshot.request', 'backlog.update'],
  backlog: [
    {
      workspaceId: 'backlog:ws_acme',
      workspacePath: 'ws_acme',
      projectKey: 'ws_acme',
      workspaceName: 'acme',
      updatedAt: now,
      items: [{ itemId: 'MC-1', relativePath: 'backlog/2026-04-28-example.md', title: 'Example', status: 'ready' }],
    },
  ],
  automations: [
    {
      automationId: 'auto_1',
      projectKey: 'ws_acme',
      name: 'nightly',
      status: 'enabled',
      triggerKind: 'schedule',
      cadence: 'Daily 06:00',
      lastRunStatus: 'completed',
      recentRuns: [{ runId: 'run_1', status: 'completed', startedAt: now, completedAt: now }],
    },
  ],
}

test('a well-formed snapshot is accepted', () => {
  assert.equal(validateMobileControlSnapshot(validSnapshot).ok, true)
})

test('an unknown advertised command still reads: the phone gates controls on raw strings', () => {
  const result = validateMobileControlSnapshot({ ...validSnapshot, commands: ['some.future.command'] })
  assert.equal(result.ok, true)
})

test('a snapshot is read at the current version only', () => {
  // The desktop SENDS snapshots, so the window buys nothing: an older one can
  // carry collections this wire has since retired.
  for (const version of [3, 2, 999, undefined]) {
    const result = validateMobileControlSnapshot({ ...validSnapshot, protocolVersion: version as never })
    assert.equal(result.ok, false, `a v${String(version)} snapshot is refused`)
    assert.equal(result.ok === false && result.error.code, 'unsupported_protocol_version')
  }
})

test('automation statuses are closed; a stray one is refused', () => {
  const badRun = validateMobileControlSnapshot({
    ...validSnapshot,
    automations: [{ ...validSnapshot.automations![0], recentRuns: [{ runId: 'run_1', status: 'nope' as never }] }],
  })
  assert.equal(badRun.ok, false)
  const badStatus = validateMobileControlSnapshot({
    ...validSnapshot,
    automations: [{ ...validSnapshot.automations![0], status: 'off' as never }],
  })
  assert.equal(badStatus.ok, false)
})

test('the version window ends at the version this build stamps', () => {
  assert.equal(mobileControlSupportedProtocolVersions.at(-1), mobileControlProtocolVersion)
  assert.equal(isSupportedMobileControlProtocolVersion(mobileControlMinSupportedProtocolVersion), true)
  assert.equal(isSupportedMobileControlProtocolVersion(mobileControlMinSupportedProtocolVersion - 1), false)
  assert.equal(isSupportedMobileControlProtocolVersion(String(mobileControlProtocolVersion)), false)
})

test('a refusal names both the version seen and what this build speaks', () => {
  const message = unsupportedMobileControlProtocolVersion(999)
  assert.match(message, /\b999\b/u)
  assert.match(message, new RegExp(`${mobileControlMinSupportedProtocolVersion}.${mobileControlProtocolVersion}`, 'u'))
  assert.match(
    unsupportedMobileControlProtocolVersion(3, 'current'),
    new RegExp(`speaks ${mobileControlProtocolVersion}$`, 'u'),
  )
})

test('the snapshot collections are backlog and automations', () => {
  assert.deepEqual([...mobileSnapshotCollections].sort(), ['automations', 'backlog'])
})
