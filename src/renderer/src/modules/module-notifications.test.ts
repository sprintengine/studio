import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ModuleNotificationDelivery } from '../../../shared/modules/notifications'
import type { DiagnosticLogEntry } from '../types/workspace'
import { moduleNotificationEntry, startModuleNotificationIngest } from './module-notifications'

function delivery(over: Partial<ModuleNotificationDelivery> = {}): ModuleNotificationDelivery {
  return {
    id: 'k1-1',
    sourceModuleId: 'acme.radar',
    sourceModuleName: 'PR Radar',
    severity: 'warning',
    title: 'Changes requested on acme/app#12',
    emittedAt: Date.UTC(2026, 9, 9, 12, 0, 0),
    ...over,
  }
}

test('a delivery becomes a bell row under the stamped module identity', () => {
  const entry = moduleNotificationEntry(
    delivery({ body: 'Two comments.', target: { surfaceId: 'acme.radar', viewId: 'activity' } }),
  )
  assert.deepEqual(entry, {
    id: 'module:k1-1',
    timestamp: '2026-10-09T12:00:00.000Z',
    level: 'warning',
    source: 'module',
    title: 'Changes requested on acme/app#12',
    message: 'Two comments.',
    sourceModule: { id: 'acme.radar', name: 'PR Radar' },
    surfaceTarget: { surfaceId: 'acme.radar', viewId: 'activity' },
    extensionsRow: 'acme.radar',
  })
  const bare = moduleNotificationEntry(delivery())
  assert.equal(bare.message, '', 'no body is an empty message, never undefined')
  assert.equal(bare.surfaceTarget, undefined)
  assert.equal(bare.extensionsRow, undefined, 'an untargeted row names no drawer row itself')
})

test('live rows and the backlog are filed once each; junk is ignored', async () => {
  const filed = new Map<string, DiagnosticLogEntry>()
  let push: ((notification: ModuleNotificationDelivery) => void) | null = null
  let unsubscribed = false
  const stop = startModuleNotificationIngest({
    subscribe: (cb) => {
      push = cb
      return () => {
        unsubscribed = true
      }
    },
    listRecent: async () => [delivery({ id: 'k1-0', title: 'Failed to load' }), delivery()],
    file: (id, entry) => {
      if (filed.has(id)) return false
      filed.set(id, entry)
      return true
    },
  })
  push!(delivery())
  push!({ nonsense: true } as never)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual([...filed.keys()], ['k1-1', 'k1-0'], 'the live row first; the backlog adds only what was missed')
  stop()
  assert.equal(unsubscribed, true)
  push!(delivery({ id: 'k1-2' }))
  assert.equal(filed.has('k1-2'), false, 'nothing is filed after stopping')
})

test('a client that cannot read the backlog still files live rows', async () => {
  const filed: string[] = []
  let push: ((notification: ModuleNotificationDelivery) => void) | null = null
  startModuleNotificationIngest({
    subscribe: (cb) => {
      push = cb
      return () => undefined
    },
    listRecent: () => Promise.reject(new Error('desktop only')),
    file: (id) => {
      filed.push(id)
      return true
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  push!(delivery())
  assert.deepEqual(filed, ['k1-1'])
})
