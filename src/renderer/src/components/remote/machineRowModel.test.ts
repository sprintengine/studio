import assert from 'node:assert/strict'

import type { FleetLiveAttachment, FleetMachineReachability } from '../../../../shared/tailnet-fleet'
import {
  fleetMachinePhase,
  machinePhaseText,
  machineRowAction,
  platformLabel,
  shortMachineName,
  since,
} from './machineRowModel'
import { test } from 'vitest'

test('machineRowModel', async () => {
  // The machine row's vocabulary (pair-from-the-scan-and-stay-paired phase 4,
  // remote-settings-rebuild). Was `peerPickerModel.test.ts`, which also drove the
  // peer picker the merged Machines list replaced.

  const NOW = Date.parse('2026-01-01T12:00:00.000Z')

  const reach = (over: Partial<FleetMachineReachability> = {}): FleetMachineReachability => ({
    connectionId: 'tnc_1',
    machineName: 'air',
    checking: false,
    checkedAt: NOW - 5_000,
    reachable: true,
    unauthorized: false,
    detail: null,
    lastReachedAt: NOW - 5_000,
    ...over,
  })

  const attachment = (over: Partial<FleetLiveAttachment> = {}): FleetLiveAttachment => ({
    attachId: 'a1',
    connectionId: 'tnc_1',
    machineName: 'air',
    sessionId: 's1',
    state: 'live',
    detail: '',
    ...over,
  })

  const attachments = new Map<string, FleetLiveAttachment>()

  assert.deepEqual(
    fleetMachinePhase('tnc_1', attachments),
    { phase: 'paired' },
    'no link and no check: paired, nothing more claimed',
  )
  assert.deepEqual(
    fleetMachinePhase('tnc_1', attachments, new Map([['tnc_1', reach({ checking: true, checkedAt: null })]])),
    { phase: 'checking' },
  )
  assert.deepEqual(fleetMachinePhase('tnc_1', attachments, new Map([['tnc_1', reach()]])), {
    phase: 'reachable',
    checkedAt: NOW - 5_000,
  })
  assert.deepEqual(
    fleetMachinePhase(
      'tnc_1',
      attachments,
      new Map([['tnc_1', reach({ reachable: false, detail: 'Could not reach it.', lastReachedAt: NOW - 60_000 })]]),
    ),
    { phase: 'unreachable', detail: 'Could not reach it.', lastReachedAt: NOW - 60_000 },
  )
  assert.equal(
    fleetMachinePhase(
      'tnc_1',
      attachments,
      new Map([['tnc_1', reach({ reachable: false, unauthorized: true, detail: 'Unauthorized.' })]]),
    ).phase,
    'revoked',
  )
  // A live pane outranks a probe that ran a minute ago, revoked included: the
  // link in front of the person is the stronger fact.
  const live = new Map<string, FleetLiveAttachment>([['a1', attachment()]])
  assert.equal(
    fleetMachinePhase('tnc_1', live, new Map([['tnc_1', reach({ reachable: false, unauthorized: true })]])).phase,
    'connected',
  )

  assert.equal(machinePhaseText('air', { phase: 'reachable', checkedAt: NOW - 10_000 }, NOW), '')
  assert.equal(
    machinePhaseText('air', { phase: 'unreachable', detail: 'x', lastReachedAt: NOW - 2 * 3_600_000 }, NOW),
    'not answering · 2 h',
  )
  assert.equal(
    machinePhaseText('air', { phase: 'unreachable', detail: 'x', lastReachedAt: null }, NOW),
    'not answering · never reached',
  )
  assert.equal(
    machinePhaseText('air', { phase: 'revoked', detail: 'x' }, NOW),
    'revoked there — pair again to reconnect',
  )

  assert.equal(machineRowAction({ phase: 'unreachable', detail: 'x', lastReachedAt: null }), 'retry')
  assert.equal(machineRowAction({ phase: 'offline', detail: 'x' }), 'retry')
  assert.equal(machineRowAction({ phase: 'revoked', detail: 'x' }), 'pair-again')
  assert.equal(machineRowAction({ phase: 'reachable', checkedAt: NOW }), null)
  assert.equal(machineRowAction({ phase: 'connected', liveSessions: 1 }), null)

  assert.equal(since(NOW - 10_000, NOW), 'under a min')
  assert.equal(since(NOW - 5 * 60_000, NOW), '5 min')
  assert.equal(since(NOW - 26 * 3_600_000, NOW), '1 day')

  assert.equal(shortMachineName('sam-macbook-air.tailabc.ts.net'), 'sam-macbook-air')
  assert.equal(shortMachineName('100.64.0.101'), '100.64.0.101')

  // The platform word: every spelling the four sources use, and null for the
  // ones that say nothing a person would recognise.
  assert.equal(platformLabel('macOS'), 'macOS')
  assert.equal(platformLabel('darwin'), 'macOS')
  // 'darwin' contains 'win', so the macOS test has to come first or every Mac
  // on the tailnet reads as a Windows box.
  assert.equal(platformLabel('windows'), 'Windows')
  assert.equal(platformLabel('win32'), 'Windows')
  assert.equal(platformLabel('linux'), 'Linux')
  assert.equal(platformLabel('android'), 'Android')
  assert.equal(platformLabel('iOS'), 'iOS')
  assert.equal(platformLabel(null), null)
  assert.equal(platformLabel(''), null)
  assert.equal(platformLabel('plan9'), null)

  console.log('machineRowModel.test.ts: machine row contracts ok')
})
