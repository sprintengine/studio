import { expect, test } from 'vitest'

import type { UsageLimitHit, UsageLimitsState } from '../../shared/usage-limits'
import { createUsageLimitsStore } from './store'

const HOUR = 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 7, 9, 0, 0)

function storeAt(start = T0) {
  let now = start
  const store = createUsageLimitsStore({ now: () => now })
  const pushes: UsageLimitsState[] = []
  store.onChanged((state) => pushes.push(state))
  return {
    store,
    pushes,
    advance: (ms: number) => {
      now += ms
    },
  }
}

test('a partial update merges into the window of the same id and keeps what it left out', () => {
  const { store } = storeAt()
  store.noteWindows('claude', [
    { id: 'five_hour', label: 'Session (5h)', usedPercent: 20, resetsAt: T0 + 3 * HOUR, durationMs: 5 * HOUR },
    { id: 'seven_day', label: 'Weekly', usedPercent: 40, resetsAt: T0 + 50 * HOUR },
  ])
  // A rate-limit event says where one window stands, without a share.
  store.noteWindows('claude', [{ id: 'five_hour', status: 'warning' }], T0 + 1000)
  const [claude] = store.state().snapshots
  expect(claude.provider).toBe('claude')
  expect(claude.billing).toBe('subscription')
  expect(claude.observedAt).toBe(T0 + 1000)
  expect(claude.windows).toEqual([
    {
      id: 'five_hour',
      label: 'Session (5h)',
      usedPercent: 20,
      resetsAt: T0 + 3 * HOUR,
      durationMs: 5 * HOUR,
      status: 'warning',
      observedAt: T0 + 1000,
    },
    { id: 'seven_day', label: 'Weekly', usedPercent: 40, resetsAt: T0 + 50 * HOUR, status: 'allowed', observedAt: T0 },
  ])
})

test('a full window without a word on status is at its limit, and a window that reset starts allowed', () => {
  const { store } = storeAt()
  store.noteWindows('codex', [{ id: 'codex:primary', usedPercent: 100, resetsAt: T0 + HOUR }])
  expect(store.state().snapshots[0].windows[0].status).toBe('rejected')
  // The same window, read again lower, is still the window that refused.
  store.noteWindows('codex', [{ id: 'codex:primary', usedPercent: 99, resetsAt: T0 + HOUR }])
  expect(store.state().snapshots[0].windows[0].status).toBe('rejected')
  // A new reset time is a new window.
  store.noteWindows('codex', [{ id: 'codex:primary', usedPercent: 2, resetsAt: T0 + 6 * HOUR }])
  expect(store.state().snapshots[0].windows[0].status).toBe('allowed')
})

test('an API-billed provider shows nothing and forgets what a subscription reported', () => {
  const { store } = storeAt()
  store.noteWindows('claude', [{ id: 'five_hour', usedPercent: 10, resetsAt: T0 + HOUR }])
  store.noteWindows('codex', [{ id: 'codex:primary', usedPercent: 30, resetsAt: T0 + HOUR }])
  store.noteBilling('claude', 'api')
  expect(store.state().snapshots.map((snapshot) => snapshot.provider)).toEqual(['codex'])
  expect(store.persisted().map((snapshot) => snapshot.provider)).toEqual(['codex'])
  expect(store.rateLimit('claude')).toEqual({ limited: false, resetsAt: null, windowId: null })
  // A limit hit on an API key is not a plan limit.
  const hits: UsageLimitHit[] = []
  store.onLimitHit((hit) => hits.push(hit))
  store.noteLimitHit({ provider: 'claude', sessionId: 's1', resetsAt: null, windowId: null })
  expect(hits).toEqual([])
})

test('a subscription with nothing reported yet shows nothing rather than a guess', () => {
  const { store, pushes } = storeAt()
  store.noteBilling('codex', 'subscription', 'plus')
  expect(store.state()).toEqual({ snapshots: [] })
  store.noteWindows('codex', [{ id: 'codex:primary', usedPercent: 5, resetsAt: T0 + HOUR }])
  expect(store.state().snapshots[0].plan).toBe('plus')
  expect(pushes.at(-1)?.snapshots).toHaveLength(1)
})

test('only a change in what is drawn is pushed', () => {
  const { store, pushes, advance } = storeAt()
  store.noteWindows('claude', [{ id: 'five_hour', usedPercent: 10.2, resetsAt: T0 + HOUR }])
  expect(pushes).toHaveLength(1)
  advance(1000)
  // A status line refreshed with the same whole percent.
  store.noteWindows('claude', [{ id: 'five_hour', usedPercent: 10.4, resetsAt: T0 + HOUR }])
  expect(pushes).toHaveLength(1)
  store.noteWindows('claude', [{ id: 'five_hour', usedPercent: 12, resetsAt: T0 + HOUR }])
  expect(pushes).toHaveLength(2)
  // An unchanged reading is still pushed once it is old enough for its "as of" to move.
  advance(10 * 60 * 1000)
  store.noteWindows('claude', [{ id: 'five_hour', usedPercent: 12, resetsAt: T0 + HOUR }])
  expect(pushes).toHaveLength(3)
})

test('a turn that hit a limit is told with when the limit lifts, and the provider reads limited until then', () => {
  const { store, advance } = storeAt()
  const hits: UsageLimitHit[] = []
  store.onLimitHit((hit) => hits.push(hit))
  store.noteWindows('claude', [
    { id: 'five_hour', usedPercent: 100, resetsAt: T0 + 2 * HOUR, status: 'rejected' },
    { id: 'seven_day', usedPercent: 60, resetsAt: T0 + 30 * HOUR },
  ])
  store.noteLimitHit({ provider: 'claude', sessionId: 's1', resetsAt: null, windowId: null })
  expect(hits).toEqual([{ provider: 'claude', sessionId: 's1', resetsAt: T0 + 2 * HOUR, windowId: null, at: T0 }])
  expect(store.rateLimit('claude')).toEqual({ limited: true, resetsAt: T0 + 2 * HOUR, windowId: 'five_hour' })
  expect(store.rateLimit('codex').limited).toBe(false)
  // Once the window has reset it holds nothing back.
  advance(2 * HOUR)
  expect(store.rateLimit('claude')).toEqual({ limited: false, resetsAt: null, windowId: null })
})

test('a hit with no window known stays limited until a later reading allows the provider again', () => {
  const { store } = storeAt()
  store.noteWindows('codex', [{ id: 'codex:primary', usedPercent: 40, resetsAt: T0 + HOUR }])
  store.noteLimitHit({ provider: 'codex', sessionId: 's2', resetsAt: null, windowId: null })
  expect(store.rateLimit('codex')).toEqual({ limited: true, resetsAt: null, windowId: null })
  store.noteWindows('codex', [{ id: 'codex:primary', usedPercent: 41, resetsAt: T0 + HOUR, status: 'allowed' }])
  expect(store.rateLimit('codex').limited).toBe(false)
})

test('the window a hit names is marked refused, with the reset the turn gave', () => {
  const { store } = storeAt()
  store.noteWindows('claude', [{ id: 'seven_day', usedPercent: 97, resetsAt: T0 + 20 * HOUR }])
  store.noteLimitHit({ provider: 'claude', sessionId: 's1', resetsAt: T0 + 21 * HOUR, windowId: 'seven_day' })
  expect(store.state().snapshots[0].windows[0]).toMatchObject({ status: 'rejected', resetsAt: T0 + 21 * HOUR })
  expect(store.rateLimit('claude')).toEqual({ limited: true, resetsAt: T0 + 21 * HOUR, windowId: 'seven_day' })
})

test('a cached reading is restored without its windows that reset, and never over a live one', () => {
  const { store } = storeAt()
  store.noteWindows('codex', [{ id: 'codex:primary', usedPercent: 7, resetsAt: T0 + HOUR }])
  store.restore([
    {
      provider: 'claude',
      billing: 'subscription',
      windows: [
        { id: 'five_hour', label: 'Session (5h)', usedPercent: 80, resetsAt: T0 - 1, status: 'allowed', observedAt: 1 },
        { id: 'seven_day', label: 'Weekly', usedPercent: 30, resetsAt: T0 + HOUR, status: 'allowed', observedAt: 1 },
      ],
      observedAt: 1,
    },
    {
      provider: 'codex',
      billing: 'subscription',
      windows: [
        {
          id: 'codex:primary',
          label: 'Session (5h)',
          usedPercent: 90,
          resetsAt: T0 + HOUR,
          status: 'allowed',
          observedAt: 1,
        },
      ],
      observedAt: 1,
    },
  ])
  const [claude, codex] = store.state().snapshots
  expect(claude.windows.map((window) => window.id)).toEqual(['seven_day'])
  expect(claude.observedAt).toBe(1)
  expect(codex.windows[0].usedPercent).toBe(7)
})

test('a window whose reset passed is still listed (to read "reset") but is not persisted', () => {
  const { store, advance } = storeAt()
  store.noteWindows('claude', [
    { id: 'five_hour', usedPercent: 50, resetsAt: T0 + HOUR },
    { id: 'seven_day', usedPercent: 50, resetsAt: T0 + 40 * HOUR },
  ])
  advance(HOUR + 1)
  expect(store.state().snapshots[0].windows).toHaveLength(2)
  expect(store.persisted()[0].windows.map((window) => window.id)).toEqual(['seven_day'])
})
