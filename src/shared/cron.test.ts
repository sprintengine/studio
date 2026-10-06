import assert from 'node:assert/strict'
import { test } from 'vitest'

import { describeCronSchedule, nextCronRuns, parseCronSchedule, type CronSchedule } from './cron'

function parsed(text: string): CronSchedule {
  const result = parseCronSchedule(text)
  if (!result.ok) throw new Error(`expected ${text} to parse: ${result.error}`)
  return result.schedule
}

function words(text: string): string {
  return describeCronSchedule(parsed(text))
}

function iso(instants: number[]): string[] {
  return instants.map((instant) => new Date(instant).toISOString())
}

// Wednesday 30 September 2026, 12:10 UTC.
const WEDNESDAY_NOON = Date.UTC(2026, 8, 30, 12, 10)

test('the everyday shapes read as people say them', () => {
  assert.equal(words('0 21 * * 0'), 'Every Sunday at 9:00 PM')
  assert.equal(words('0 21 * * sun'), 'Every Sunday at 9:00 PM')
  assert.equal(words('0 21 * * 7'), 'Every Sunday at 9:00 PM')
  assert.equal(words('0 9,13 * * *'), 'Daily at 9:00 AM and 1:00 PM')
  assert.equal(words('0 9 * * 1-5'), 'Weekdays at 9:00 AM')
  assert.equal(words('30 10 * * 0,6'), 'Weekends at 10:30 AM')
  assert.equal(words('0 9 * * mon,wed,fri'), 'Every Monday, Wednesday and Friday at 9:00 AM')
  assert.equal(words('0 7 1 * *'), 'On the 1st of every month at 7:00 AM')
  assert.equal(words('0 0 1,15 * *'), 'On the 1st and 15th of every month at 12:00 AM')
  assert.equal(words('0 12 22 * *'), 'On the 22nd of every month at 12:00 PM')
})

test('repeats read as repeats, not as a list of clock times', () => {
  assert.equal(words('*/15 * * * *'), 'Every 15 minutes')
  assert.equal(words('* * * * *'), 'Every minute')
  assert.equal(words('0 * * * *'), 'Every hour')
  assert.equal(words('15 * * * *'), 'Every hour at :15')
  assert.equal(words('0 */6 * * *'), 'Every 6 hours')
  assert.equal(words('*/30 8-18 * * 1-5'), 'Every 30 minutes, 8:00 AM–6:30 PM, on weekdays')
})

test('several expressions on the same days are one sentence', () => {
  assert.equal(words('0 9 * * *; 30 13 * * *'), 'Daily at 9:00 AM and 1:30 PM')
  assert.equal(words('0 9 * * 1-5; 0 12 * * 0'), 'Weekdays at 9:00 AM; Every Sunday at 12:00 PM')
})

test('shorthands expand to what they stand for', () => {
  assert.equal(words('@daily'), 'Daily at 12:00 AM')
  assert.equal(words('@hourly'), 'Every hour')
  assert.equal(words('@weekly'), 'Every Sunday at 12:00 AM')
  assert.equal(words('@monthly'), 'On the 1st of every month at 12:00 AM')
})

test('a shape with no short phrasing is said field by field, never approximated', () => {
  assert.equal(words('5,10,20,25,35,40,50 9 * * *'), 'Daily at minutes 5, 10, 20, 25, 35, 40 and 50 past 9 AM')
  assert.equal(words('0 9 * 1,7 *'), 'Every day in January and July at 9:00 AM')
})

test('a wrong field is named, with the range it takes', () => {
  const hour = parseCronSchedule('0 25 * * *')
  assert.equal(hour.ok, false)
  if (!hour.ok) {
    assert.equal(hour.field, 'hour')
    assert.equal(hour.error, 'Hour 25 doesn’t exist — use 0–23.')
  }
  const weekday = parseCronSchedule('0 9 * * funday')
  assert.equal(weekday.ok, false)
  if (!weekday.ok) assert.equal(weekday.field, 'weekday')
  const backwards = parseCronSchedule('0 9 * * 5-1')
  assert.equal(backwards.ok, false)
  if (!backwards.ok) assert.equal(backwards.error, 'Weekday range 5-1 runs backwards.')
  const count = parseCronSchedule('0 9 * *')
  assert.equal(count.ok, false)
  if (!count.ok) {
    assert.equal(count.field, undefined)
    assert.match(count.error, /five parts/u)
  }
  assert.equal(parseCronSchedule('   ').ok, false)
  assert.equal(parseCronSchedule('*/0 * * * *').ok, false)
})

test('next runs are the schedule’s own wall-clock in the given zone', () => {
  assert.deepEqual(iso(nextCronRuns(parsed('0 21 * * 0'), 'UTC', WEDNESDAY_NOON, 3)), [
    '2026-10-04T21:00:00.000Z',
    '2026-10-11T21:00:00.000Z',
    '2026-10-18T21:00:00.000Z',
  ])
  assert.deepEqual(iso(nextCronRuns(parsed('0 9,13 * * *'), 'UTC', WEDNESDAY_NOON, 3)), [
    '2026-09-30T13:00:00.000Z',
    '2026-10-01T09:00:00.000Z',
    '2026-10-01T13:00:00.000Z',
  ])
  // London is on BST (UTC+1) at the end of September.
  assert.deepEqual(iso(nextCronRuns(parsed('0 21 * * 0'), 'Europe/London', WEDNESDAY_NOON, 1)), [
    '2026-10-04T20:00:00.000Z',
  ])
})

test('a run exactly at the start instant is not the next run', () => {
  const at = Date.UTC(2026, 8, 30, 13, 0)
  assert.deepEqual(iso(nextCronRuns(parsed('0 13 * * *'), 'UTC', at, 1)), ['2026-10-01T13:00:00.000Z'])
})

test('both day fields restricted means either one matches', () => {
  // The 1st of October 2026 is a Thursday; Mondays are the 5th and the 12th.
  assert.deepEqual(iso(nextCronRuns(parsed('0 9 1 * 1'), 'UTC', WEDNESDAY_NOON, 3)), [
    '2026-10-01T09:00:00.000Z',
    '2026-10-05T09:00:00.000Z',
    '2026-10-12T09:00:00.000Z',
  ])
})

test('a leap day is found years out, and a day no calendar has runs out', () => {
  assert.deepEqual(iso(nextCronRuns(parsed('0 0 29 2 *'), 'UTC', WEDNESDAY_NOON, 1)), ['2028-02-29T00:00:00.000Z'])
  assert.deepEqual(nextCronRuns(parsed('0 0 30 2 *'), 'UTC', WEDNESDAY_NOON, 1), [])
})

test('a time a DST change skips runs just after the gap, and a repeated one runs once', () => {
  // New York springs forward at 02:00 on 8 March 2026: 02:30 never happens.
  const beforeSpring = Date.UTC(2026, 2, 7, 12, 0)
  assert.deepEqual(iso(nextCronRuns(parsed('30 2 * * *'), 'America/New_York', beforeSpring, 2)), [
    '2026-03-08T07:00:00.000Z',
    '2026-03-09T06:30:00.000Z',
  ])
  // New York falls back at 02:00 on 1 November 2026: 01:30 happens twice.
  const beforeFall = Date.UTC(2026, 9, 31, 12, 0)
  assert.deepEqual(iso(nextCronRuns(parsed('30 1 * * *'), 'America/New_York', beforeFall, 2)), [
    '2026-11-01T05:30:00.000Z',
    '2026-11-02T06:30:00.000Z',
  ])
  // East of UTC the same rule holds: Berlin falls back at 03:00 CEST on 25
  // October 2026, so 02:00 happens twice and runs at the first, on CEST.
  const beforeBerlinFall = Date.UTC(2026, 9, 24, 12, 0)
  assert.deepEqual(iso(nextCronRuns(parsed('0 2 * * *'), 'Europe/Berlin', beforeBerlinFall, 2)), [
    '2026-10-25T00:00:00.000Z',
    '2026-10-26T01:00:00.000Z',
  ])
  // And a half-hourly schedule keeps its rhythm up to the change instead of
  // going quiet for an hour and a half.
  assert.deepEqual(iso(nextCronRuns(parsed('*/30 * * * *'), 'Europe/Berlin', Date.UTC(2026, 9, 24, 23, 15), 4)), [
    '2026-10-24T23:30:00.000Z',
    '2026-10-25T00:00:00.000Z',
    '2026-10-25T00:30:00.000Z',
    '2026-10-25T02:00:00.000Z',
  ])
})
