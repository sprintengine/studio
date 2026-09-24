import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { TerminalSessionSnapshot } from '../../../shared/electron-api'
import { TERMINAL_SESSION_RECOVERY_POLL_MS, startTerminalSessionRecovery } from './terminalSessionRecovery'
import { createTerminalSessionsStore } from './terminalSessionsStore'

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

function harness(outcomes: Array<'in-sync' | 'missed' | 'throw'>) {
  let clock = 0
  let returnListener: (() => void) | null = null
  let poll: (() => void) | null = null
  let armed = 0
  let checks = 0
  const stop = startTerminalSessionRecovery({
    reconcile: async () => {
      checks += 1
      const outcome = outcomes.shift() ?? 'in-sync'
      if (outcome === 'throw') throw new Error('ipc down')
      return outcome
    },
    subscribeReturn: (listener) => {
      returnListener = listener
      return () => {
        returnListener = null
      }
    },
    now: () => clock,
    timers: {
      setInterval: (handler, ms) => {
        assert.equal(ms, TERMINAL_SESSION_RECOVERY_POLL_MS)
        armed += 1
        poll = handler
        return armed
      },
      clearInterval: () => {
        poll = null
      },
    },
  })
  return {
    stop,
    comeBack: async () => {
      clock += 10_000
      returnListener?.()
      await settle()
    },
    tick: async () => {
      poll?.()
      await settle()
    },
    polling: () => poll !== null,
    checks: () => checks,
    subscribed: () => returnListener !== null,
  }
}

test('no poll runs while the pushes are keeping up', async () => {
  const h = harness(['in-sync', 'in-sync'])
  assert.equal(h.polling(), false, 'nothing at mount')
  await h.comeBack()
  await h.comeBack()
  assert.equal(h.checks(), 2, 'one check each time the person comes back')
  assert.equal(h.polling(), false)
  h.stop()
  assert.equal(h.subscribed(), false)
})

test('a missed push starts the poll, and agreement stops it', async () => {
  const h = harness(['missed', 'missed', 'in-sync'])
  await h.comeBack()
  assert.equal(h.polling(), true)
  await h.tick()
  assert.equal(h.polling(), true, 'still behind')
  await h.tick()
  assert.equal(h.polling(), false, 'caught up: back to push only')
  assert.equal(h.checks(), 3)
})

test('a check that fails counts as missed', async () => {
  const h = harness(['throw'])
  await h.comeBack()
  assert.equal(h.polling(), true)
  h.stop()
  assert.equal(h.polling(), false, 'stopping clears the poll')
})

test('the store reconciles against what the pushes delivered', async () => {
  const session = (sessionId: string) =>
    ({
      sessionId,
      processAlive: true,
      activity: { kind: 'idle', since: 1 },
      kind: 'agent',
      reapExempt: false,
    }) as unknown as TerminalSessionSnapshot
  let mainList: TerminalSessionSnapshot[] = [session('a')]
  let push: ((sessions: TerminalSessionSnapshot[]) => void) | null = null
  const store = createTerminalSessionsStore(() => ({
    terminalList: async () => mainList,
    onTerminalSessionsChanged: (cb) => {
      push = cb
      return () => {
        push = null
      }
    },
  }))
  const unsubscribe = store.subscribeSemantic(() => undefined)
  await settle()
  assert.equal(await store.reconcile(), 'in-sync')

  mainList = [session('a'), session('b')]
  push!(mainList)
  assert.equal(await store.reconcile(), 'in-sync', 'the push delivered it')

  mainList = [session('a'), session('b'), session('c')]
  assert.equal(await store.reconcile(), 'missed', 'main holds a session no push brought')
  assert.equal(store.getSemanticSnapshot().length, 3, 'and the fresh list was applied')
  assert.equal(await store.reconcile(), 'in-sync')
  unsubscribe()
})
