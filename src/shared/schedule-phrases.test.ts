import assert from 'node:assert/strict'
import { test } from 'vitest'

import { scheduleSuggestionsFor } from './schedule-phrases'

function first(text: string): string | undefined {
  return scheduleSuggestionsFor(text)[0]?.cron
}

test('the everyday phrasings become the cron people mean', () => {
  assert.equal(first('every weekday at 9am'), '0 9 * * 1-5')
  assert.equal(first('weekdays 9'), '0 9 * * 1-5')
  assert.equal(first('every sunday at 9pm'), '0 21 * * 0')
  assert.equal(first('sundays 21:00'), '0 21 * * 0')
  assert.equal(first('daily at 9am and 1pm'), '0 9,13 * * *')
  assert.equal(first('every day at 9:30'), '30 9 * * *')
  assert.equal(first('mon, wed and fri at 8:15am'), '15 8 * * 1,3,5')
  assert.equal(first('weekends at noon'), '0 12 * * 0,6')
  assert.equal(first('every night at midnight'), '0 0 * * *')
})

test('repeats become steps', () => {
  assert.equal(first('every 15 minutes'), '*/15 * * * *')
  assert.equal(first('every 2 hours'), '0 */2 * * *')
  assert.equal(first('hourly'), '0 * * * *')
  assert.equal(first('every minute'), '* * * * *')
})

test('monthly days are read as days of the month', () => {
  assert.equal(first('monthly on the 1st at 7am'), '0 7 1 * *')
  assert.equal(first('on the 1st and 15th at 9'), '0 9 1,15 * *')
  assert.equal(first('every month'), '0 9 1 * *')
})

test('a bare hour offers both readings, the likelier first', () => {
  assert.deepEqual(
    scheduleSuggestionsFor('every weekday at 9').map((entry) => entry.cron),
    ['0 9 * * 1-5', '0 21 * * 1-5'],
  )
  assert.deepEqual(
    scheduleSuggestionsFor('daily at 5').map((entry) => entry.cron),
    ['0 17 * * *', '0 5 * * *'],
  )
})

test('times on different minutes become one expression per minute', () => {
  assert.equal(first('daily at 9am and 1:30pm'), '0 9 * * *; 30 13 * * *')
})

test('each suggestion says its schedule in the cron module’s own words', () => {
  assert.deepEqual(scheduleSuggestionsFor('every sunday at 9pm')[0], {
    cron: '0 21 * * 0',
    words: 'Every Sunday at 9:00 PM',
  })
})

test('cron typed after /schedule is offered back as itself', () => {
  assert.deepEqual(scheduleSuggestionsFor('0 9 * * 1-5'), [{ cron: '0 9 * * 1-5', words: 'Weekdays at 9:00 AM' }])
})

test('with no time named, 9 AM is assumed', () => {
  assert.equal(first('every friday'), '0 9 * * 5')
  assert.equal(first('weekly'), '0 9 * * 1')
})

test('nothing typed is nothing offered', () => {
  assert.deepEqual(scheduleSuggestionsFor('   '), [])
})
