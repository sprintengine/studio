// A schedule said in plain words, turned into cron: what `/schedule` in the New
// chat prompt offers as it is typed. "every weekday at 9" → `0 9 * * 1-5`,
// "daily at 9am and 1pm" → `0 9,13 * * *`, "sundays 9pm" → `0 21 * * 0`.
//
// It answers with candidates rather than one reading, most likely first, each
// with the words the schedule itself says (the cron module's own reading, so
// the suggestion and what gets saved cannot disagree). A bare hour with no
// AM/PM is both, and both are offered. Anything it cannot read is no
// candidates, never a guess.

import { describeCronSchedule, parseCronSchedule } from './cron'

export type ScheduleSuggestion = { cron: string; words: string }

type Clock = { hour: number; minute: number }

const DAY_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^sun(day)?s?$/u, 0],
  [/^mon(day)?s?$/u, 1],
  [/^tue(s|sday)?s?$/u, 2],
  [/^wed(nesday)?s?$/u, 3],
  [/^thu(r|rs|rsday)?s?$/u, 4],
  [/^fri(day)?s?$/u, 5],
  [/^sat(urday)?s?$/u, 6],
]

const MAX_SUGGESTIONS = 3

export function scheduleSuggestionsFor(text: string): ScheduleSuggestion[] {
  const phrase = text
    .toLowerCase()
    .replace(/[.,!?]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!phrase) return []

  // Already cron: offer it back as itself, read aloud.
  const asCron = suggestion(phrase)
  if (asCron && /^[\d*@]/u.test(phrase)) return [asCron]

  const interval = intervalCron(phrase)
  if (interval) return compact([interval])

  const days = dayField(phrase)
  const timeReadings = clockReadings(phrase)
  const crons = timeReadings.map((times) => cronFor(times, days))
  return compact(crons)
}

function compact(crons: Array<string | null>): ScheduleSuggestion[] {
  const out: ScheduleSuggestion[] = []
  for (const cron of crons) {
    if (!cron || out.some((entry) => entry.cron === cron)) continue
    const read = suggestion(cron)
    if (read) out.push(read)
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

function suggestion(cron: string): ScheduleSuggestion | null {
  const parsed = parseCronSchedule(cron)
  return parsed.ok ? { cron, words: describeCronSchedule(parsed.schedule) } : null
}

// "every 15 minutes", "every 2 hours", "hourly", "every hour", "every minute".
function intervalCron(phrase: string): string | null {
  const minutes = /\bevery (\d+) ?(m|min|mins|minute|minutes)\b/u.exec(phrase)
  if (minutes) {
    const step = Number(minutes[1])
    return step >= 1 && step <= 59 ? `*/${step} * * * *` : null
  }
  const hours = /\bevery (\d+) ?(h|hr|hrs|hour|hours)\b/u.exec(phrase)
  if (hours) {
    const step = Number(hours[1])
    return step >= 1 && step <= 23 ? `0 */${step} * * *` : null
  }
  if (/\bevery minute\b/u.test(phrase)) return '* * * * *'
  if (/\b(hourly|every hour)\b/u.test(phrase)) return '0 * * * *'
  return null
}

// The day-of-month, month and day-of-week fields, as "dom month dow". Every
// day unless the phrase names days.
function dayField(phrase: string): string {
  const monthDays = [...phrase.matchAll(/\b(\d{1,2})(st|nd|rd|th)\b/gu)]
    .map((match) => Number(match[1]))
    .filter((day) => day >= 1 && day <= 31)
  if (/\b(monthly|every month|of the month|each month)\b/u.test(phrase) || monthDays.length > 0) {
    const days = monthDays.length > 0 ? [...new Set(monthDays)].sort((a, b) => a - b) : [1]
    return `${days.join(',')} * *`
  }
  if (/\b(weekdays?|every weekday|workdays?|mon ?- ?fri)\b/u.test(phrase)) return '* * 1-5'
  if (/\bweekends?\b/u.test(phrase)) return '* * 0,6'
  const named = new Set<number>()
  for (const word of phrase.split(' ')) {
    for (const [pattern, day] of DAY_WORDS) if (pattern.test(word)) named.add(day)
  }
  if (named.size > 0) return `* * ${[...named].sort((a, b) => a - b).join(',')}`
  if (/\bweekly\b|\bevery week\b/u.test(phrase)) return '* * 1'
  return '* * *'
}

// Each reading of the phrase's clock times: one list of times per way the
// phrase can be read. "at 9 and 1" has an AM and a PM reading.
function clockReadings(phrase: string): Clock[][] {
  const tokens: Clock[][] = []
  if (/\bnoon\b|\bmidday\b/u.test(phrase)) tokens.push([{ hour: 12, minute: 0 }])
  if (/\bmidnight\b/u.test(phrase)) tokens.push([{ hour: 0, minute: 0 }])
  // "9", "9am", "9 am", "9:30", "9:30pm", "21:00" — but not "15th" or "every 2 hours".
  const pattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m|p\.m|a|p)?(?![\d:]|st|nd|rd|th)\b/gu
  for (const match of phrase.matchAll(pattern)) {
    const hour = Number(match[1])
    const minute = match[2] === undefined ? 0 : Number(match[2])
    if (minute > 59 || hour > 23) continue
    const meridiem = match[3]?.startsWith('a') ? 'am' : match[3]?.startsWith('p') ? 'pm' : null
    // A number after "every" is a count, not a time.
    const before = phrase.slice(0, match.index).trimEnd()
    if (/\bevery$/u.test(before)) continue
    tokens.push(readingsOf(hour, minute, meridiem))
  }
  if (tokens.length === 0) return [[{ hour: 9, minute: 0 }]]
  // Each token's first reading, then with each ambiguous token flipped.
  const first = tokens.map((options) => options[0] as Clock)
  const readings: Clock[][] = [first]
  if (tokens.some((options) => options.length > 1)) {
    readings.push(tokens.map((options) => (options[1] ?? options[0]) as Clock))
  }
  return readings
}

// A bare hour from 1 to 12 is both; the likelier one leads — morning for 7 to
// 11, afternoon for 1 to 6, the way people say "at 9" and "at 5".
function readingsOf(hour: number, minute: number, meridiem: 'am' | 'pm' | null): Clock[] {
  if (meridiem === 'am') return [{ hour: hour % 12, minute }]
  if (meridiem === 'pm') return [{ hour: (hour % 12) + 12, minute }]
  if (hour === 0 || hour > 12) return [{ hour, minute }]
  if (hour === 12)
    return [
      { hour: 12, minute },
      { hour: 0, minute },
    ]
  const am = { hour, minute }
  const pm = { hour: hour + 12, minute }
  return hour >= 7 ? [am, pm] : [pm, am]
}

// One cron line when every time shares a minute; otherwise one line per
// minute, joined the way the cron module reads several expressions.
function cronFor(times: Clock[], days: string): string | null {
  if (times.length === 0) return null
  const byMinute = new Map<number, number[]>()
  for (const time of times) {
    const hours = byMinute.get(time.minute) ?? []
    if (!hours.includes(time.hour)) hours.push(time.hour)
    byMinute.set(time.minute, hours)
  }
  return [...byMinute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([minute, hours]) => `${minute} ${hours.sort((a, b) => a - b).join(',')} ${days}`)
    .join('; ')
}
