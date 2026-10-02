import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioServerStatus } from '../../../../shared/studio-server-status'
import { studioServerNotice, uptimeWords } from './studioServerWords'

const base: StudioServerStatus = {
  mode: 'out-of-process',
  savedMode: 'out-of-process',
  fromEnvironment: false,
  phase: 'running',
  reason: null,
  pid: 4242,
  restarts: 0,
  startedAt: 0,
  fellBack: null,
}

test('a running server, and one inside the app, say nothing', () => {
  assert.equal(studioServerNotice(base, { showStarting: true }), null)
  assert.equal(studioServerNotice({ ...base, mode: 'in-process', phase: 'in-process' }, { showStarting: true }), null)
})

test('starting is said only once it has taken a moment; reconnecting always', () => {
  assert.equal(studioServerNotice({ ...base, phase: 'starting' }, { showStarting: false }), null)
  assert.deepEqual(studioServerNotice({ ...base, phase: 'starting' }, { showStarting: true }), {
    tone: 'warn',
    message: 'Starting Studio server…',
    recoverable: false,
  })
  assert.equal(
    studioServerNotice({ ...base, phase: 'reconnecting' }, { showStarting: false })?.message,
    'Reconnecting to Studio server…',
  )
})

test('a stopped server says why and can be recovered; a fallback says why it runs inside the app', () => {
  const stopped = studioServerNotice(
    { ...base, phase: 'stopped', reason: 'The Studio server failed to start 3 times.' },
    { showStarting: false },
  )
  assert.equal(stopped?.tone, 'error')
  assert.equal(stopped?.recoverable, true)
  assert.match(stopped?.message ?? '', /stopped\. The Studio server failed to start 3 times\./)
  const fellBack = studioServerNotice(
    { ...base, mode: 'in-process', phase: 'in-process', fellBack: 'The data directory is not writable.' },
    { showStarting: false },
  )
  assert.match(fellBack?.message ?? '', /runs inside the app this time\. The data directory is not writable\./)
})

test('uptime in words', () => {
  assert.equal(uptimeWords(10_000), 'under a minute')
  assert.equal(uptimeWords(5 * 60_000), '5 min')
  assert.equal(uptimeWords(125 * 60_000), '2 h 5 min')
})
