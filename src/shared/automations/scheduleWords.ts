import { SCHEDULE_TRIGGER_KIND, type ScheduleTriggerConfig } from './contracts'

// A schedule said twice, for the two readers the Automations surface has
// (Extensions drawer ruling, 2026-09-05, frame 4): the cron line, which is what
// the automation actually is, and the same thing in words, which is what a rail
// row can be read at a glance. "Nightly 02:00" and `0 2 * * *` are one fact in
// two registers — so they are computed here, from the same cadence, and cannot
// disagree.
//
// Deliberately NOT in cadence.ts: that module's job is the panel/phone summary
// ("Daily at 02:00" and its timezone qualifier), which is a longer, zone-aware
// sentence for a detail row. This is the short glanceable form the rail needs,
// and it has a cron counterpart. Two audiences, two rules, one each.
//
// Pure over the trigger — no clock, no store, no Intl — so both processes and
// the tests read the same answer.

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// A daily cadence in this window is what people call "nightly" rather than
// "daily": it is the small-hours slot an unattended review job is put in so it
// is finished before anyone opens the repo. Outside it, a time of day is just a
// time of day and the word would be a lie (the mockup's own 18:00 row reads
// "Daily 18:00").
const NIGHT_FROM_HOUR = 22
const NIGHT_UNTIL_HOUR = 6

function scheduleConfig(trigger: { kind: string; config: unknown }): ScheduleTriggerConfig | null {
  if (trigger.kind !== SCHEDULE_TRIGGER_KIND) return null
  const config = trigger.config
  if (!config || typeof config !== 'object') return null
  const cadence = (config as ScheduleTriggerConfig).cadence
  return cadence && typeof cadence === 'object' ? (config as ScheduleTriggerConfig) : null
}

function parseTimeLocal(timeLocal: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(timeLocal.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null
  return { hour, minute }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function isNightHour(hour: number): boolean {
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR
}

/**
 * The cron line for a cadence, or null when the cadence names no cron shape —
 * a one-shot `at` has no recurrence to express, and an interval that is not a
 * whole number of minutes-under-an-hour or hours cannot be written as one.
 * Null means "there is no cron line to show", never "unknown": the card omits
 * the expression rather than printing an approximation of it.
 */
export function automationScheduleCron(trigger: { kind: string; config: unknown }): string | null {
  const config = scheduleConfig(trigger)
  if (!config) return null
  const cadence = config.cadence
  switch (cadence.type) {
    case 'cron':
      return cadence.expression.trim() || null
    case 'daily': {
      const time = parseTimeLocal(cadence.timeLocal)
      return time ? `${time.minute} ${time.hour} * * *` : null
    }
    case 'weekly': {
      const time = parseTimeLocal(cadence.timeLocal)
      if (!time) return null
      const days = [...cadence.daysOfWeek].sort((a, b) => a - b)
      if (days.length === 0) return null
      return `${time.minute} ${time.hour} * * ${days.join(',')}`
    }
    case 'interval': {
      const minutes = cadence.everyMinutes
      if (!Number.isInteger(minutes) || minutes <= 0) return null
      if (minutes < 60) return `*/${minutes} * * * *`
      if (minutes % 60 === 0 && minutes / 60 < 24) return `0 */${minutes / 60} * * *`
      return null
    }
    case 'at':
      return null
  }
}

/**
 * The schedule as a rail row reads it: "Nightly 02:00", "Daily 18:00",
 * "Weekly, Monday 06:00", "Every 30 min". Always answers — a cadence this
 * cannot phrase falls back to naming itself rather than rendering an empty
 * line under a row title.
 */
export function automationScheduleWords(trigger: { kind: string; config: unknown }): string {
  const config = scheduleConfig(trigger)
  if (!config) return 'On a trigger'
  const cadence = config.cadence
  switch (cadence.type) {
    case 'interval': {
      const minutes = cadence.everyMinutes
      if (!Number.isInteger(minutes) || minutes <= 0) return 'On a schedule'
      return minutes % 60 === 0 ? `Every ${minutes / 60}h` : `Every ${minutes} min`
    }
    case 'daily':
      return dailyWords(cadence.timeLocal)
    case 'weekly':
      return weeklyWords(cadence.timeLocal, cadence.daysOfWeek)
    case 'at':
      return `Once ${cadence.datetime.replace('T', ' ')}`
    case 'cron':
      return cronWords(cadence.expression)
  }
}

function dailyWords(timeLocal: string): string {
  const time = parseTimeLocal(timeLocal)
  if (!time) return 'Daily'
  const clock = `${pad(time.hour)}:${pad(time.minute)}`
  return `${isNightHour(time.hour) ? 'Nightly' : 'Daily'} ${clock}`
}

function weeklyWords(timeLocal: string, daysOfWeek: number[]): string {
  const time = parseTimeLocal(timeLocal)
  const clock = time ? ` ${pad(time.hour)}:${pad(time.minute)}` : ''
  const days = [...daysOfWeek]
    .sort((a, b) => a - b)
    .map((day) => WEEKDAY_LONG[day])
    .filter((day): day is string => Boolean(day))
  // Never "Weekly," with nothing after the comma: a weekly cadence naming no day
  // is malformed, and the words say only what they can stand behind.
  if (days.length === 0) return `Weekly${clock}`
  return `Weekly, ${days.join(', ')}${clock}`
}

/**
 * The everyday cron shapes said in the same words the cadences use, so a cron
 * automation and a daily one read alike in the rail. Anything richer — a list
 * of hours, a day-of-month, a step in an odd field — is named as a cron
 * expression rather than paraphrased: a wrong paraphrase of a schedule is worse
 * than the expression the author wrote.
 */
function cronWords(expression: string): string {
  const literal = `Cron · ${expression.trim()}`
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) return literal
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  if (dayOfMonth !== '*' || month !== '*') return literal

  // A step is only the interval it looks like while it fits inside its field:
  // cron applies `*/n` across 0-59 (or 0-23), so `*/90` fires at minute 0 and
  // nothing else — hourly, not "every 90 min". Saying the number back would be
  // the wrong-paraphrase failure this function exists to avoid, so an
  // out-of-range step falls back to the expression the author wrote.
  const everyMinutes = /^\*\/(\d+)$/u.exec(minute)
  if (everyMinutes && hour === '*' && dayOfWeek === '*') {
    const step = Number(everyMinutes[1])
    return step >= 1 && step <= 59 ? `Every ${step} min` : literal
  }

  const everyHours = /^\*\/(\d+)$/u.exec(hour)
  if (everyHours && /^\d+$/u.test(minute) && dayOfWeek === '*') {
    const step = Number(everyHours[1])
    return step >= 1 && step <= 23 ? `Every ${step}h` : literal
  }

  if (!/^\d+$/u.test(minute) || !/^\d+$/u.test(hour)) return literal
  const timeLocal = `${pad(Number(hour))}:${pad(Number(minute))}`
  if (dayOfWeek === '*') return dailyWords(timeLocal)
  if (!/^\d+(,\d+)*$/u.test(dayOfWeek)) return literal
  const days = cronDaysOfWeek(dayOfWeek)
  // A day this cannot place is not a day to leave out: dropping one turned
  // `0 6 * * 1,7` into "Weekly, Monday", a schedule that runs on a day the
  // words deny. Either every day resolves or the expression stands as written.
  return days ? weeklyWords(timeLocal, days) : literal
}

/**
 * Cron's day-of-week field, as the weekday indices `weeklyWords` reads. Cron
 * accepts BOTH 0 and 7 for Sunday, which the cadence contract does not — so 7
 * is folded onto 0 here rather than falling off the end of the weekday table.
 * Null when any entry is outside 0-7, so the caller can decline to paraphrase
 * rather than paraphrase incompletely. Deduped, because `0,7` is one day said
 * twice and "Sunday, Sunday" is not a schedule.
 */
function cronDaysOfWeek(field: string): number[] | null {
  const days = new Set<number>()
  for (const raw of field.split(',')) {
    const day = Number(raw)
    if (!Number.isInteger(day) || day < 0 || day > 7) return null
    days.add(day === 7 ? 0 : day)
  }
  return days.size > 0 ? [...days] : null
}
