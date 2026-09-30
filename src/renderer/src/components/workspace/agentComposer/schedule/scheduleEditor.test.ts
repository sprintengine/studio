import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  cronFromEditorState,
  editorStateFromCron,
  formatRunTimes,
  parseScheduleTime,
  switchTab,
} from './scheduleEditor'

test('a cron the tabs can say opens on its tab, with its days and times', () => {
  assert.deepEqual(editorStateFromCron('0 9,13 * * *'), {
    tab: 'daily',
    weekdays: [1, 2, 3, 4, 5],
    monthDays: [1],
    times: [540, 780],
    cronText: '0 9,13 * * *',
  })
  const weekly = editorStateFromCron('0 21 * * 0')
  assert.equal(weekly.tab, 'weekly')
  assert.deepEqual(weekly.weekdays, [0])
  assert.deepEqual(weekly.times, [1260])
  const monthly = editorStateFromCron('0 7 1,15 * *')
  assert.equal(monthly.tab, 'monthly')
  assert.deepEqual(monthly.monthDays, [1, 15])
  assert.deepEqual(editorStateFromCron('0 9 * * *; 30 13 * * *').times, [540, 810])
})

test('a cron the tabs cannot say opens on Cron, as written', () => {
  for (const cron of ['*/30 8-18 * * 1-5', '0 9 1 * 1', '0 9 * 1 *', 'nonsense']) {
    const state = editorStateFromCron(cron)
    assert.equal(state.tab, 'cron', cron)
    assert.equal(state.cronText, cron)
  }
})

test('each tab adds up to its cron, one expression per minute', () => {
  const base = editorStateFromCron('0 9 * * 1-5')
  assert.equal(cronFromEditorState(base), '0 9 * * 1,2,3,4,5')
  assert.equal(cronFromEditorState({ ...base, tab: 'daily', times: [780, 540] }), '0 9,13 * * *')
  assert.equal(cronFromEditorState({ ...base, tab: 'daily', times: [540, 810] }), '0 9 * * *; 30 13 * * *')
  assert.equal(cronFromEditorState({ ...base, tab: 'monthly', monthDays: [15, 1], times: [420] }), '0 7 1,15 * *')
  assert.equal(cronFromEditorState({ ...base, tab: 'weekly', weekdays: [] }), null)
  assert.equal(cronFromEditorState({ ...base, tab: 'daily', times: [] }), null)
})

test('switching to Cron starts from what the tab said, and back keeps the times', () => {
  const daily = { ...editorStateFromCron('0 9,13 * * *') }
  const cron = switchTab(daily, 'cron')
  assert.equal(cron.cronText, '0 9,13 * * *')
  const back = switchTab({ ...cron, cronText: '15 6 * * *' }, 'weekly')
  assert.deepEqual(back.times, [375])
})

test('a typed time reads with or without AM/PM', () => {
  assert.equal(parseScheduleTime('9', 'AM'), 540)
  assert.equal(parseScheduleTime('9', 'PM'), 1260)
  assert.equal(parseScheduleTime('9:30pm', 'AM'), 1290)
  assert.equal(parseScheduleTime('21:00', 'AM'), 1260)
  assert.equal(parseScheduleTime('12 am', 'PM'), 0)
  assert.equal(parseScheduleTime('12', 'PM'), 720)
  assert.equal(parseScheduleTime('25', 'AM'), null)
  assert.equal(parseScheduleTime('soon', 'AM'), null)
})

test('run times read as today, tomorrow, or the date, and repeat no shared day', () => {
  // Wednesday 30 September 2026, 12:10 UTC.
  const now = Date.UTC(2026, 8, 30, 12, 10)
  assert.deepEqual(
    formatRunTimes([Date.UTC(2026, 8, 30, 13, 0), Date.UTC(2026, 9, 1, 9, 0), Date.UTC(2026, 9, 1, 13, 0)], 'UTC', now),
    ['Today 13:00', 'Tomorrow 09:00', '13:00'],
  )
  assert.deepEqual(
    formatRunTimes(
      [Date.UTC(2026, 9, 4, 21, 0), Date.UTC(2026, 9, 11, 21, 0), Date.UTC(2026, 9, 18, 21, 0)],
      'UTC',
      now,
    ),
    ['Sun 4 Oct 21:00', 'Sun 11 Oct', 'Sun 18 Oct'],
  )
})
