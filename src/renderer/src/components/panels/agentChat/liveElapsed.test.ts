import { expect, test } from 'vitest'
import { formatClockTime, formatMessageTime } from './liveElapsed'

// Local-time instants, so the calendar arithmetic is what the reader sees.
const at = (year: number, month: number, day: number, hour = 14, minute = 5) =>
  new Date(year, month - 1, day, hour, minute).getTime()
const now = at(2026, 9, 27, 9, 30)

test('a time from today is the clock alone', () => {
  expect(formatMessageTime(at(2026, 9, 27, 0, 10), now)).toBe(formatClockTime(at(2026, 9, 27, 0, 10)))
  expect(formatMessageTime(now, now)).toBe(formatClockTime(now))
})

test('yesterday is named, even when it was less than a day ago', () => {
  const lateLastNight = at(2026, 9, 26, 23, 50)
  expect(formatMessageTime(lateLastNight, now)).toBe(`Yesterday ${formatClockTime(lateLastNight)}`)
})

test('within the week the weekday stands in for the date', () => {
  const tuesday = at(2026, 9, 22)
  const weekday = new Date(tuesday).toLocaleDateString([], { weekday: 'short' })
  expect(formatMessageTime(tuesday, now)).toBe(`${weekday} ${formatClockTime(tuesday)}`)
})

test('a week or more back reads as a date, with the year once it is not this one', () => {
  const lastWeek = at(2026, 9, 20)
  const thisYear = formatMessageTime(lastWeek, now)
  expect(thisYear).toBe(
    `${new Date(lastWeek).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${formatClockTime(lastWeek)}`,
  )
  expect(thisYear).not.toContain('2026')
  expect(formatMessageTime(at(2025, 12, 30), now)).toContain('2025')
})

test('a time ahead of now is not called yesterday or a weekday', () => {
  const tomorrow = at(2026, 9, 28)
  expect(formatMessageTime(tomorrow, now)).toBe(
    `${new Date(tomorrow).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${formatClockTime(tomorrow)}`,
  )
})
