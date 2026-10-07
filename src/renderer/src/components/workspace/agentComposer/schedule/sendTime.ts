// A single moment to send at, as the one-time picker writes it: the Once tab
// of a scheduled agent, and a message scheduled into an open chat. Read and
// written in this computer's own zone, because that is the clock main sends
// by and the one the person reads the time off.

import { formatUsageResetIn } from '../../../../../../shared/usage-limits'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** A minute-precise instant: a send time carries no seconds. */
function toMinute(at: number): number {
  const date = new Date(at)
  date.setSeconds(0, 0)
  return date.getTime()
}

/** Up to the next five minutes past the hour: "In 1 hour" at 14:22 reads 15:25, not 15:22. */
function upToFiveMinutes(at: number): number {
  const date = new Date(toMinute(at))
  const minutes = date.getMinutes()
  const nextFive = Math.ceil(minutes / 5) * 5
  if (nextFive !== minutes) date.setMinutes(nextFive)
  return date.getTime()
}

/** The time the picker opens on: the next whole hour at least half an hour away. */
export function defaultSendAt(now: number): number {
  const date = new Date(now)
  date.setMinutes(0, 0, 0)
  date.setHours(date.getHours() + 1)
  if (date.getTime() - now < 30 * MINUTE_MS) date.setHours(date.getHours() + 1)
  return date.getTime()
}

export type SendTimeChoice = { label: string; at: number }

/**
 * The times most sends want, one press each. Five hours is a session usage
 * limit's length: a message written as the limit is hit goes out once it has
 * reset.
 */
export function quickSendTimes(now: number): SendTimeChoice[] {
  const tomorrowMorning = new Date(now + DAY_MS)
  tomorrowMorning.setHours(9, 0, 0, 0)
  return [
    { label: 'In 1 hour', at: upToFiveMinutes(now + HOUR_MS) },
    { label: 'In 3 hours', at: upToFiveMinutes(now + 3 * HOUR_MS) },
    { label: 'In 5 hours', at: upToFiveMinutes(now + 5 * HOUR_MS) },
    { label: 'Tomorrow 9 AM', at: tomorrowMorning.getTime() },
  ]
}

/** The day, as a date field holds it: "2026-10-07". */
export function dateFieldValue(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `at` moved to another day, at the same time of day; null when the field does not read as a day. */
export function withDay(at: number, field: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(field)
  if (!match) return null
  const date = new Date(at)
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : toMinute(date.getTime())
}

/** Minutes past midnight, as the time field holds them. */
export function minutesOfDay(at: number): number {
  const date = new Date(at)
  return date.getHours() * 60 + date.getMinutes()
}

/** `at` moved to another time of day, on the same day. */
export function withMinutesOfDay(at: number, minutes: number): number {
  const date = new Date(at)
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return date.getTime()
}

/** "Today 3:00 PM", "Tomorrow 9:00 AM", "Wed 14 Oct, 9:00 AM". */
export function sendTimeWords(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const day = date.toDateString()
  if (day === new Date(now).toDateString()) return `Today ${time}`
  if (day === new Date(now + DAY_MS).toDateString()) return `Tomorrow ${time}`
  const weekday = date.toLocaleDateString([], { weekday: 'short' })
  const dayMonth = date.toLocaleDateString([], { day: 'numeric', month: 'short' })
  return `${weekday} ${dayMonth}, ${time}`
}

/** How far off it is, for the readout: "in 2h 13m"; null once it has passed. */
export function sendTimeFromNow(at: number, now: number): string | null {
  return at > now ? `in ${formatUsageResetIn(at, now)}` : null
}
