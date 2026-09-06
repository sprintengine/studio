import assert from 'node:assert/strict'

import { automationScheduleCron, automationScheduleWords } from './scheduleWords'

// The schedule said twice — the cron line and the words — is what the
// Automations rail and the built-in card each read (Extensions drawer ruling,
// 2026-09-05, frame 4). Both come off the same cadence here, so what the rail
// glances at and what the card states cannot disagree. The wording is a product
// decision the mockup fixes exactly ("Nightly 02:00", "Weekly, Monday 06:00"),
// so it is asserted verbatim rather than by shape.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function schedule(cadence: unknown): { kind: string; config: unknown } {
  return { kind: 'schedule', config: { kind: 'schedule', timezone: 'UTC', cadence } }
}

run('a small-hours daily cadence is nightly, and a daytime one is daily', () => {
  assert.equal(automationScheduleWords(schedule({ type: 'daily', timeLocal: '02:00' })), 'Nightly 02:00')
  assert.equal(automationScheduleWords(schedule({ type: 'daily', timeLocal: '03:30' })), 'Nightly 03:30')
  assert.equal(automationScheduleWords(schedule({ type: 'daily', timeLocal: '23:15' })), 'Nightly 23:15')
  assert.equal(automationScheduleWords(schedule({ type: 'daily', timeLocal: '18:00' })), 'Daily 18:00')
  assert.equal(automationScheduleWords(schedule({ type: 'daily', timeLocal: '06:00' })), 'Daily 06:00')
})

run('a weekly cadence names its days, and never says nightly', () => {
  assert.equal(
    automationScheduleWords(schedule({ type: 'weekly', timeLocal: '06:00', daysOfWeek: [1] })),
    'Weekly, Monday 06:00',
  )
  assert.equal(
    automationScheduleWords(schedule({ type: 'weekly', timeLocal: '17:00', daysOfWeek: [5] })),
    'Weekly, Friday 17:00',
  )
  assert.equal(
    automationScheduleWords(schedule({ type: 'weekly', timeLocal: '02:00', daysOfWeek: [4, 1] })),
    'Weekly, Monday, Thursday 02:00',
    'days are read in week order regardless of how they were written, and 02:00 stays weekly',
  )
})

run('an interval and a one-shot say what they are', () => {
  assert.equal(automationScheduleWords(schedule({ type: 'interval', everyMinutes: 30 })), 'Every 30 min')
  assert.equal(automationScheduleWords(schedule({ type: 'interval', everyMinutes: 180 })), 'Every 3h')
  assert.equal(
    automationScheduleWords(schedule({ type: 'at', datetime: '2026-07-09T09:30' })),
    'Once 2026-07-09 09:30',
  )
})

run('the cron line is derived from the cadence, and only where one exists', () => {
  assert.equal(automationScheduleCron(schedule({ type: 'daily', timeLocal: '02:00' })), '0 2 * * *')
  assert.equal(automationScheduleCron(schedule({ type: 'daily', timeLocal: '02:30' })), '30 2 * * *')
  assert.equal(automationScheduleCron(schedule({ type: 'weekly', timeLocal: '06:00', daysOfWeek: [1] })), '0 6 * * 1')
  assert.equal(automationScheduleCron(schedule({ type: 'interval', everyMinutes: 30 })), '*/30 * * * *')
  assert.equal(automationScheduleCron(schedule({ type: 'interval', everyMinutes: 180 })), '0 */3 * * *')
  // A one-shot has no recurrence to express, so the card shows the words alone
  // rather than an expression that would claim it repeats.
  assert.equal(automationScheduleCron(schedule({ type: 'at', datetime: '2026-07-09T09:30' })), null)
})

run('a cron cadence reads back in the same words a cadence does', () => {
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 2 * * *' })), 'Nightly 02:00')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 6 * * 1' })), 'Weekly, Monday 06:00')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '*/15 * * * *' })), 'Every 15 min')
  assert.equal(automationScheduleCron(schedule({ type: 'cron', expression: '0 2 * * *' })), '0 2 * * *')
})

// A paraphrase of a schedule that is subtly wrong is worse than the expression
// the author wrote, so anything outside the shapes above is named, not guessed.
run('a cron expression it cannot phrase is quoted rather than paraphrased', () => {
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 2 1 * *' })), 'Cron · 0 2 1 * *')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 2,14 * * *' })), 'Cron · 0 2,14 * * *')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: 'nonsense' })), 'Cron · nonsense')
})

// Cron takes BOTH 0 and 7 for Sunday. Reading 7 off the end of the weekday
// table dropped it, which is the worst of the three outcomes: `0 6 * * 7` read
// as a weekly with no day, and `0 6 * * 1,7` claimed Monday only — words that
// deny a day the schedule actually runs on.
run('cron Sunday is 0 or 7, and neither is dropped', () => {
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 6 * * 0' })), 'Weekly, Sunday 06:00')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 6 * * 7' })), 'Weekly, Sunday 06:00')
  assert.equal(
    automationScheduleWords(schedule({ type: 'cron', expression: '0 6 * * 1,7' })),
    'Weekly, Sunday, Monday 06:00',
  )
  assert.equal(
    automationScheduleWords(schedule({ type: 'cron', expression: '0 6 * * 0,7' })),
    'Weekly, Sunday 06:00',
    'one day said twice is still one day',
  )
  // A day outside 0-7 places nothing, so nothing is paraphrased — the whole
  // expression stands rather than a weekly missing one of its days.
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 6 * * 9' })), 'Cron · 0 6 * * 9')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 6 * * 1,9' })), 'Cron · 0 6 * * 1,9')
})

// A step only means the interval it looks like while it fits inside its field:
// cron applies `*/n` across 0-59, so `*/90` fires at minute 0 and nothing else.
run('a step wider than its field is quoted, not read back as an interval', () => {
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '*/90 * * * *' })), 'Cron · */90 * * * *')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '*/60 * * * *' })), 'Cron · */60 * * * *')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '*/0 * * * *' })), 'Cron · */0 * * * *')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 */25 * * *' })), 'Cron · 0 */25 * * *')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '*/59 * * * *' })), 'Every 59 min')
  assert.equal(automationScheduleWords(schedule({ type: 'cron', expression: '0 */23 * * *' })), 'Every 23h')
})

run('a malformed or non-schedule trigger answers without inventing a time', () => {
  assert.equal(automationScheduleWords({ kind: 'repo-event', config: {} }), 'On a trigger')
  assert.equal(automationScheduleCron({ kind: 'repo-event', config: {} }), null)
  assert.equal(automationScheduleWords(schedule({ type: 'daily', timeLocal: 'later' })), 'Daily')
  assert.equal(automationScheduleCron(schedule({ type: 'daily', timeLocal: 'later' })), null)
  assert.equal(
    automationScheduleWords(schedule({ type: 'weekly', timeLocal: '06:00', daysOfWeek: [] })),
    'Weekly 06:00',
    'never "Weekly," with nothing after the comma',
  )
})

console.log('all automation schedule-words tests passed')
