import { afterEach, expect, test } from 'vitest'

import { formatClockTime, formatMessageDateTime } from '../components/panels/agentChat/liveElapsed'
import { clockFormat, clockFormatter, formatTimeOfDay, setClockFormat } from './clockFormat'

// Five past three in the afternoon, local time.
const AFTERNOON = new Date(2026, 9, 8, 15, 5, 0).getTime()

afterEach(() => setClockFormat('system'))

test('the system clock is the locale’s own', () => {
  expect(clockFormat()).toBe('system')
  const locale = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(AFTERNOON)
  expect(formatTimeOfDay(AFTERNOON)).toBe(locale)
})

test('a 24-hour clock writes the afternoon as 15', () => {
  setClockFormat('24h')
  expect(formatTimeOfDay(AFTERNOON)).toMatch(/15.05/u)
  expect(formatClockTime(AFTERNOON)).toMatch(/15.05/u)
  expect(formatMessageDateTime(AFTERNOON)).toMatch(/15.05.00/u)
})

test('a 12-hour clock writes the afternoon as 3 with a day period', () => {
  setClockFormat('12h')
  expect(formatTimeOfDay(AFTERNOON)).toMatch(/^3.05\s?\S+/u)
  expect(formatClockTime(AFTERNOON)).not.toMatch(/15/u)
  expect(formatMessageDateTime(AFTERNOON)).not.toMatch(/15.05/u)
})

test('formatters are built once per setting and rebuilt when it changes', () => {
  setClockFormat('24h')
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  const first = clockFormatter(options)
  expect(clockFormatter({ ...options })).toBe(first)
  setClockFormat('12h')
  expect(clockFormatter(options)).not.toBe(first)
})
