import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  TERMINAL_WEBGL_CONTEXT_LIMIT,
  WEBGL_RECOVERY_DELAYS_MS,
  createTerminalWebglBudget,
  type TerminalWebglPresence,
} from './terminalWebglBudget'

function harness(limit = 3) {
  let clock = 0
  const timers = new Map<number, { at: number; handler: () => void }>()
  let nextTimer = 1
  const budget = createTerminalWebglBudget({
    limit,
    now: () => clock,
    setTimer: (handler, ms) => {
      const id = nextTimer++
      timers.set(id, { at: clock + ms, handler })
      return id
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
  })
  const advance = (ms: number) => {
    clock += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at > clock) continue
      timers.delete(id)
      timer.handler()
    }
  }
  const pane = (name: string, presence: TerminalWebglPresence = 'on-screen', gpu: 'ok' | 'refuse' = 'ok') => {
    const state = { presence, attaches: 0, detaches: 0 }
    const lease = budget.join({
      presence: () => state.presence,
      attach: () => {
        state.attaches += 1
        return gpu === 'ok' ? 'webgl' : 'unavailable'
      },
      detach: () => {
        state.detaches += 1
      },
    })
    const show = (next: TerminalWebglPresence) => {
      state.presence = next
      clock += 1
      lease.update()
    }
    return { name, state, lease, show }
  }
  return { budget, pane, advance, pendingTimers: () => timers.size }
}

test('the limit sits below the sixteen contexts Chromium allows a renderer', () => {
  assert.ok(TERMINAL_WEBGL_CONTEXT_LIMIT < 16)
})

test('only an on-screen pane acquires a context', () => {
  const { budget, pane } = harness()
  const visible = pane('visible')
  const warm = pane('warm', 'parked')
  const cold = pane('cold', 'off')
  for (const p of [visible, warm, cold]) p.lease.update()
  assert.equal(visible.lease.holding(), true)
  assert.equal(warm.lease.holding(), false, 'a warm layer never acquires one')
  assert.equal(cold.lease.holding(), false)
  assert.equal(budget.liveCount(), 1)
})

test('a parked pane keeps its context; a cold one gives it back; reveal re-acquires', () => {
  const { budget, pane } = harness()
  const a = pane('a')
  a.lease.update()
  a.show('parked')
  assert.equal(a.lease.holding(), true, 'flicking to another layer and back costs nothing')
  a.show('off')
  assert.equal(a.lease.holding(), false, 'the layer went cold')
  assert.equal(a.state.detaches, 1)
  a.show('on-screen')
  assert.equal(a.lease.holding(), true, 're-acquired on reveal')
  assert.equal(a.state.attaches, 2)
  assert.equal(budget.liveCount(), 1)
})

test('the budget never goes over its limit, and evicts the pane off screen longest', () => {
  const { budget, pane } = harness(3)
  const a = pane('a')
  const b = pane('b')
  const c = pane('c')
  for (const p of [a, b, c]) p.show('on-screen')
  assert.equal(budget.liveCount(), 3)

  // a was on screen more recently than b; both are then parked.
  a.show('on-screen')
  b.show('parked')
  a.show('parked')
  const d = pane('d')
  d.lease.update()
  assert.equal(budget.liveCount(), 3)
  assert.equal(d.lease.holding(), true)
  assert.equal(b.lease.holding(), false, 'the least recently seen parked pane gave its context up')
  assert.equal(a.lease.holding(), true)

  // A pane that is on screen is never evicted; when every holder is on screen
  // the newcomer stays on the DOM renderer rather than breaking the limit.
  a.show('on-screen')
  const e = pane('e')
  e.lease.update()
  assert.equal(e.lease.holding(), false)
  assert.equal(budget.liveCount(), 3)

  // ...and gets the next context that comes free.
  c.lease.dispose()
  assert.equal(e.lease.holding(), true, 'the freed context went to the pane that was turned away')
  assert.equal(budget.liveCount(), 3)
})

test('a cold holder is evicted before a parked one', () => {
  const { pane } = harness(2)
  const parked = pane('parked')
  const cold = pane('cold')
  parked.lease.update()
  cold.lease.update()
  cold.state.presence = 'off' // went cold; nobody has told the lease yet
  parked.show('parked')
  const next = pane('next')
  next.lease.update()
  assert.equal(cold.lease.holding(), false)
  assert.equal(parked.lease.holding(), true)
})

test('updateAll hands contexts from the layer that left to the layer that arrived', () => {
  const { budget, pane } = harness(2)
  const oldA = pane('oldA')
  const oldB = pane('oldB')
  oldA.lease.update()
  oldB.lease.update()
  const newA = pane('newA', 'off')
  const newB = pane('newB', 'off')
  newA.lease.update()
  newB.lease.update()

  oldA.state.presence = 'off'
  oldB.state.presence = 'off'
  newA.state.presence = 'on-screen'
  newB.state.presence = 'on-screen'
  budget.updateAll()
  assert.equal(newA.lease.holding(), true)
  assert.equal(newB.lease.holding(), true)
  assert.equal(budget.liveCount(), 2)
})

test('a lost context is re-acquired after a back-off instead of staying on the DOM renderer', () => {
  const { budget, pane, advance } = harness()
  const a = pane('a')
  a.lease.update()
  a.lease.contextLost()
  assert.equal(a.lease.holding(), false)
  a.lease.update()
  assert.equal(a.state.attaches, 1, 'not straight away: the GPU is mid-reset')
  advance(WEBGL_RECOVERY_DELAYS_MS[0])
  assert.equal(a.lease.holding(), true, 'recovered')
  assert.equal(a.state.attaches, 2)
  assert.equal(budget.liveCount(), 1)
})

test('a pane that keeps losing its context settles on the DOM renderer', () => {
  const { pane, advance, pendingTimers } = harness()
  const a = pane('a')
  a.lease.update()
  for (const delay of WEBGL_RECOVERY_DELAYS_MS) {
    a.lease.contextLost()
    advance(delay)
    assert.equal(a.lease.holding(), true)
  }
  a.lease.contextLost()
  assert.equal(pendingTimers(), 0, 'no further retry is scheduled')
  a.show('on-screen')
  assert.equal(a.lease.holding(), false)

  // Losses spread out over time are separate incidents, each recoverable.
  const b = pane('b')
  b.lease.update()
  for (let index = 0; index < 5; index += 1) {
    b.lease.contextLost()
    advance(61_000)
    assert.equal(b.lease.holding(), true)
  }
})

test('a context lost while the addon is still loading is retried, not written off', () => {
  const { budget, advance } = harness()
  let attaches = 0
  let lease: ReturnType<typeof budget.join> | null = null
  lease = budget.join({
    presence: () => 'on-screen',
    attach: () => {
      attaches += 1
      if (attaches === 1) {
        lease?.contextLost()
        return 'lost'
      }
      return 'webgl'
    },
    detach: () => undefined,
  })
  lease.update()
  assert.equal(lease.holding(), false)
  advance(WEBGL_RECOVERY_DELAYS_MS[0])
  assert.equal(lease.holding(), true)
  assert.equal(attaches, 2)
})

test('a GPU that refuses is not asked again, and a retry does not outlive its pane', () => {
  const { budget, pane, advance, pendingTimers } = harness()
  const refused = pane('refused', 'on-screen', 'refuse')
  refused.lease.update()
  refused.show('parked')
  refused.show('on-screen')
  assert.equal(refused.state.attaches, 1)
  assert.equal(budget.liveCount(), 0)

  const lost = pane('lost')
  lost.lease.update()
  lost.lease.contextLost()
  lost.lease.dispose()
  assert.equal(pendingTimers(), 0)
  advance(10_000)
  assert.equal(lost.state.attaches, 1)
})
