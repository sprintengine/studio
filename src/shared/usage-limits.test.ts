import { expect, test } from 'vitest'

import {
  formatUsageResetIn,
  usageEpochMs,
  usageWindowHasReset,
  usageWindowIsWarning,
  usageWindowLabelForMinutes,
  usageWindowPace,
  type UsageLimitWindow,
} from './usage-limits'

const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)

function windowOf(overrides: Partial<UsageLimitWindow>): UsageLimitWindow {
  return {
    id: 'five_hour',
    label: 'Session (5h)',
    usedPercent: 50,
    resetsAt: NOW + 2 * HOUR,
    durationMs: 5 * HOUR,
    status: 'allowed',
    observedAt: NOW,
    ...overrides,
  }
}

test('a reset time in seconds, in ms or as ISO is read as ms, and anything else is none', () => {
  expect(usageEpochMs(1_791_370_800)).toBe(1_791_370_800_000)
  expect(usageEpochMs(1_791_370_800_000)).toBe(1_791_370_800_000)
  expect(usageEpochMs('2026-10-07T12:00:00Z')).toBe(NOW)
  expect(usageEpochMs(0)).toBe(null)
  expect(usageEpochMs('soon')).toBe(null)
  expect(usageEpochMs(null)).toBe(null)
})

test('a window is labelled by its length', () => {
  expect(usageWindowLabelForMinutes(300)).toBe('Session (5h)')
  expect(usageWindowLabelForMinutes(10080)).toBe('Weekly')
  expect(usageWindowLabelForMinutes(1440)).toBe('1-day')
  expect(usageWindowLabelForMinutes(120)).toBe('2h')
  expect(usageWindowLabelForMinutes(null)).toBe('Usage')
})

test('the time to a reset reads in the two largest units', () => {
  expect(formatUsageResetIn(NOW + 2 * HOUR + 13 * 60_000 + 5_000, NOW)).toBe('2h 13m')
  expect(formatUsageResetIn(NOW + 3 * 24 * HOUR + 4 * HOUR, NOW)).toBe('3d 4h')
  expect(formatUsageResetIn(NOW + 12 * 60_000, NOW)).toBe('12m')
  expect(formatUsageResetIn(NOW + 5 * HOUR, NOW)).toBe('5h')
  expect(formatUsageResetIn(NOW + 30_000, NOW)).toBe('under a minute')
})

test('a window at 90% or refused warns; one that has reset neither warns nor counts', () => {
  expect(usageWindowIsWarning(windowOf({ usedPercent: 89 }), NOW)).toBe(false)
  expect(usageWindowIsWarning(windowOf({ usedPercent: 90 }), NOW)).toBe(true)
  expect(usageWindowIsWarning(windowOf({ usedPercent: 40, status: 'rejected' }), NOW)).toBe(true)
  const lapsed = windowOf({ usedPercent: 100, status: 'rejected', resetsAt: NOW - 1 })
  expect(usageWindowHasReset(lapsed, NOW)).toBe(true)
  expect(usageWindowIsWarning(lapsed, NOW)).toBe(false)
})

test('pace compares the share used with the share of the window gone by', () => {
  // Three of five hours gone: 60% elapsed.
  expect(usageWindowPace(windowOf({ usedPercent: 85 }), NOW)).toEqual({ pace: 'ahead', elapsedPercent: 60 })
  expect(usageWindowPace(windowOf({ usedPercent: 62 }), NOW)).toEqual({ pace: 'on', elapsedPercent: 60 })
  expect(usageWindowPace(windowOf({ usedPercent: 20 }), NOW)).toEqual({ pace: 'under', elapsedPercent: 60 })
  expect(usageWindowPace(windowOf({ durationMs: undefined }), NOW)).toBe(null)
  expect(usageWindowPace(windowOf({ usedPercent: null }), NOW)).toBe(null)
  expect(usageWindowPace(windowOf({ resetsAt: NOW - 1 }), NOW)).toBe(null)
})
