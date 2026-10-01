import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { TailnetMachine } from '../../../../shared/tailnet-machines'
import { pairRoute } from './pairRouteModel'

const machine = (over: Partial<TailnetMachine> = {}): TailnetMachine => ({
  key: 'dev-macbook-air.example.ts.net',
  name: 'dev-macbook-air',
  os: 'macOS',
  isSelf: false,
  online: true,
  studio: true,
  live: false,
  lastSeenAt: null,
  inbound: null,
  outbound: null,
  ...over,
})

test('a machine a Studio answers on is asked to pair', () => {
  assert.deepEqual(pairRoute(machine()), { route: 'ask' })
})

test('this machine and a paired one offer no pairing', () => {
  assert.deepEqual(pairRoute(machine({ isSelf: true })), { route: 'none' })
  assert.deepEqual(pairRoute(machine({ inbound: { deviceId: 'tnd_1', scopes: [] } })), { route: 'none' })
  assert.deepEqual(pairRoute(machine({ outbound: { connectionId: 'tnc_1', scopes: [] } })), { route: 'none' })
})

test('a machine with no Studio answering says to turn Remote on there', () => {
  assert.deepEqual(pairRoute(machine({ studio: false })), {
    route: 'unavailable',
    reason: 'No Studio answering — turn on Remote there',
  })
})

test('an asleep machine says so rather than blaming Remote', () => {
  // Offline machines are never probed, so `studio` is false for them too; the
  // reason must be the sleep, not a switch nobody can see from here.
  assert.deepEqual(pairRoute(machine({ online: false, studio: false })), { route: 'unavailable', reason: 'Asleep' })
})

test('a phone pairs by link, asleep or not', () => {
  for (const os of ['iOS', 'android']) {
    assert.deepEqual(pairRoute(machine({ name: 'android-phone', os, studio: false })), { route: 'link' })
    assert.deepEqual(pairRoute(machine({ name: 'android-phone', os, studio: false, online: false })), { route: 'link' })
  }
})
