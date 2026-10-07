import assert from 'node:assert/strict'
import { test } from 'vitest'

import { dateFieldValue, defaultSendAt, quickSendTimes, sendTimeWords, withDay, withMinutesOfDay } from './sendTime'

// Wednesday 7 October 2026, 14:22, on this computer's clock.
const NOW = new Date(2026, 9, 7, 14, 22, 31).getTime()
const at = (hours: number, minutes = 0, day = 7) => new Date(2026, 9, day, hours, minutes).getTime()

test('the picker opens on the next whole hour at least half an hour away', () => {
  assert.equal(defaultSendAt(NOW), at(15))
  assert.equal(defaultSendAt(new Date(2026, 9, 7, 14, 40).getTime()), at(16))
})

test('the quick times land on five minutes past, and tomorrow morning is 9 AM', () => {
  assert.deepEqual(
    quickSendTimes(NOW).map((choice) => [choice.label, choice.at]),
    [
      ['In 1 hour', at(15, 25)],
      ['In 3 hours', at(17, 25)],
      ['In 5 hours', at(19, 25)],
      ['Tomorrow 9 AM', at(9, 0, 8)],
    ],
  )
})

test('a day and a time of day move the moment and keep the rest', () => {
  assert.equal(dateFieldValue(at(15)), '2026-10-07')
  assert.equal(withDay(at(15, 30), '2026-10-09'), at(15, 30, 9))
  assert.equal(withDay(at(15), 'not a day'), null)
  assert.equal(withMinutesOfDay(at(15, 30), 9 * 60 + 5), at(9, 5))
})

test('the time says the day the way a person would', () => {
  assert.match(sendTimeWords(at(15), NOW), /^Today /u)
  assert.match(sendTimeWords(at(9, 0, 8), NOW), /^Tomorrow /u)
  assert.doesNotMatch(sendTimeWords(at(9, 0, 14), NOW), /^(Today|Tomorrow) /u)
})
