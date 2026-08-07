import type { AutomationTriggerProvider, ScheduleTriggerConfig } from '../../shared/automations/contracts'

export const MIN_INTERVAL_MINUTES = 5

export type ScheduleValidationResult =
  | { ok: true; value: ScheduleTriggerConfig }
  | { ok: false; error: string }

type LocalDateTime = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const MINUTE_MS = 60_000
const LOCAL_SEARCH_WINDOW_MS = 36 * 60 * MINUTE_MS
const MAX_TIMEOUT_MS = 2_147_483_647
const DATE_TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>()
const TIME_LOCAL_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
// Local wall-clock instant for the one-shot `at` cadence: date + 24h time,
// seconds optional (ignored — engine granularity is the minute), and no
// trailing Z/offset — the config's `timezone` field is the sole authority.
const AT_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/

export const scheduleTriggerProvider: AutomationTriggerProvider = {
  kind: 'schedule',
  configSchema: {
    type: 'object',
    required: ['kind', 'cadence', 'timezone'],
    properties: {
      kind: { const: 'schedule' },
      timezone: { type: 'string', minLength: 1 },
      cadence: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'everyMinutes'],
            properties: {
              type: { const: 'interval' },
              everyMinutes: { type: 'integer', minimum: MIN_INTERVAL_MINUTES },
            },
          },
          {
            type: 'object',
            required: ['type', 'timeLocal'],
            properties: {
              type: { const: 'daily' },
              timeLocal: { type: 'string', pattern: TIME_LOCAL_PATTERN.source },
            },
          },
          {
            type: 'object',
            required: ['type', 'timeLocal', 'daysOfWeek'],
            properties: {
              type: { const: 'weekly' },
              timeLocal: { type: 'string', pattern: TIME_LOCAL_PATTERN.source },
              daysOfWeek: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: { type: 'integer', minimum: 0, maximum: 6 },
              },
            },
          },
          {
            type: 'object',
            required: ['type', 'datetime'],
            properties: {
              type: { const: 'at' },
              datetime: { type: 'string', pattern: AT_DATETIME_PATTERN.source },
            },
          },
        ],
      },
    },
  },
  validateConfig(config) {
    const validation = validateScheduleTriggerConfig(config)
    return validation.ok ? { ok: true } : validation
  },
  subscribe(input) {
    const validation = validateScheduleTriggerConfig(input.config)
    if (!validation.ok) throw new Error(validation.error)

    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleNext = () => {
      if (disposed) return
      const after = input.now()
      const nextRun = computeNextRun(validation.value, after)
      if (nextRun === null) return

      const delay = Math.max(0, Math.min(nextRun - after, MAX_TIMEOUT_MS))
      timer = setTimeout(() => {
        if (disposed) return
        const now = input.now()
        if (now >= nextRun) {
          input.fire({ kind: 'schedule', dueAt: new Date(nextRun).toISOString() })
        }
        scheduleNext()
      }, delay)
    }

    scheduleNext()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  },
  computeNextRun(config, after) {
    const validation = validateScheduleTriggerConfig(config)
    if (!validation.ok) return null
    return computeNextRun(validation.value, after)
  },
}

export function validateScheduleTriggerConfig(config: unknown): ScheduleValidationResult {
  if (!isRecord(config)) return invalid('Schedule trigger config must be an object.')
  if (config.kind !== 'schedule') return invalid('Schedule trigger kind must be "schedule".')
  if (typeof config.timezone !== 'string' || config.timezone.trim() === '') {
    return invalid('Schedule trigger timezone is required.')
  }

  if (!isValidTimeZone(config.timezone)) return invalid(`Schedule trigger timezone "${config.timezone}" is invalid.`)
  if (!isRecord(config.cadence)) return invalid('Schedule trigger cadence must be an object.')

  switch (config.cadence.type) {
    case 'interval': {
      const everyMinutes = config.cadence.everyMinutes
      if (typeof everyMinutes !== 'number' || !Number.isInteger(everyMinutes)) {
        return invalid('Interval cadence everyMinutes must be an integer.')
      }
      if (everyMinutes < MIN_INTERVAL_MINUTES) {
        return invalid(`Interval cadence everyMinutes must be at least ${MIN_INTERVAL_MINUTES}.`)
      }
      return { ok: true, value: config as ScheduleTriggerConfig }
    }
    case 'daily': {
      if (!isValidLocalTime(config.cadence.timeLocal)) return invalid('Daily cadence timeLocal must use HH:mm.')
      return { ok: true, value: config as ScheduleTriggerConfig }
    }
    case 'weekly': {
      if (!isValidLocalTime(config.cadence.timeLocal)) return invalid('Weekly cadence timeLocal must use HH:mm.')
      const daysOfWeek = config.cadence.daysOfWeek
      if (
        !Array.isArray(daysOfWeek)
        || daysOfWeek.length === 0
        || !daysOfWeek.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        || new Set(daysOfWeek).size !== daysOfWeek.length
      ) {
        return invalid('Weekly cadence daysOfWeek must be unique integers from 0 to 6.')
      }
      return { ok: true, value: config as ScheduleTriggerConfig }
    }
    case 'at': {
      const parsed = parseAtDatetime(config.cadence.datetime)
      if (!parsed.ok) return invalid(parsed.error)
      return { ok: true, value: config as ScheduleTriggerConfig }
    }
    default:
      return invalid('Unsupported schedule cadence type.')
  }
}

/**
 * One-shot cadences legitimately run out: once an `at` automation's fire time
 * has passed, a null next run is the terminal "no upcoming run" state, not a
 * scheduling failure. Recurring cadences (interval/daily/weekly) must always
 * compute a next run, so null stays an error for them.
 */
export function scheduleCadenceCanExhaust(config: ScheduleTriggerConfig): boolean {
  return config.cadence.type === 'at'
}

export function computeNextRun(config: ScheduleTriggerConfig, after: number): number | null {
  const validation = validateScheduleTriggerConfig(config)
  if (!validation.ok || !Number.isFinite(after)) return null

  switch (config.cadence.type) {
    case 'interval':
      return after + config.cadence.everyMinutes * MINUTE_MS
    case 'daily':
      return computeNextDailyRun(config.timezone, config.cadence.timeLocal, after)
    case 'weekly':
      return computeNextWeeklyRun(config.timezone, config.cadence.timeLocal, config.cadence.daysOfWeek, after)
    case 'at':
      return computeAtRun(config.timezone, config.cadence.datetime, after)
    default:
      return null
  }
}

// One-shot: the configured wall-clock resolved in the configured timezone, or
// null once it has passed. The engine and the definition-write path treat that
// null as the legitimate terminal state for exhaustible cadences (see
// scheduleCadenceCanExhaust): after a fire, nextRunAt is cleared to null so
// the automation fires exactly once and then simply shows no upcoming run.
// A nonexistent wall-clock (DST spring-forward gap) resolves to the first
// instant after the gap via instantForLocalDateTime, the same rule
// daily/weekly use.
function computeAtRun(timeZone: string, datetime: string, after: number): number | null {
  const parsed = parseAtDatetime(datetime)
  if (!parsed.ok) return null
  const instant = instantForLocalDateTime(parsed.value, timeZone)
  return instant !== null && instant > after ? instant : null
}

type AtDatetimeParseResult = { ok: true; value: LocalDateTime } | { ok: false; error: string }

function parseAtDatetime(value: unknown): AtDatetimeParseResult {
  const match = typeof value === 'string' ? AT_DATETIME_PATTERN.exec(value) : null
  if (!match) {
    return {
      ok: false,
      error: 'At cadence datetime must be local time as YYYY-MM-DDTHH:mm (seconds optional, no timezone suffix — the timezone field applies).',
    }
  }
  const target: LocalDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  }
  const probe = new Date(Date.UTC(target.year, target.month - 1, target.day))
  if (
    probe.getUTCFullYear() !== target.year
    || probe.getUTCMonth() !== target.month - 1
    || probe.getUTCDate() !== target.day
  ) {
    return { ok: false, error: `At cadence datetime "${value}" is not a real calendar date.` }
  }
  return { ok: true, value: target }
}

function computeNextDailyRun(timeZone: string, timeLocal: string, after: number): number | null {
  const afterLocal = localDateTimeFromInstant(after, timeZone)
  for (let offset = 0; offset <= 1; offset += 1) {
    const date = addLocalDays(afterLocal, offset)
    const candidate = instantForLocalDateTime({ ...date, ...parseTimeLocal(timeLocal) }, timeZone)
    if (candidate !== null && candidate > after) return candidate
  }
  return null
}

function computeNextWeeklyRun(timeZone: string, timeLocal: string, daysOfWeek: number[], after: number): number | null {
  const scheduledDays = new Set(daysOfWeek)
  const afterLocal = localDateTimeFromInstant(after, timeZone)
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = addLocalDays(afterLocal, offset)
    const weekday = localWeekday(date)
    if (!scheduledDays.has(weekday)) continue

    const candidate = instantForLocalDateTime({ ...date, ...parseTimeLocal(timeLocal) }, timeZone)
    if (candidate !== null && candidate > after) return candidate
  }
  return null
}

function instantForLocalDateTime(target: LocalDateTime, timeZone: string): number | null {
  const estimate = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute)
  const start = estimate - LOCAL_SEARCH_WINDOW_MS
  const end = estimate + LOCAL_SEARCH_WINDOW_MS
  let previous: LocalDateTime | null = null

  for (let instant = start; instant <= end; instant += MINUTE_MS) {
    const current = localDateTimeFromInstant(instant, timeZone)
    if (sameLocalDateTime(current, target)) return instant

    if (previous && compareLocalDateTime(previous, target) < 0 && compareLocalDateTime(current, target) > 0) {
      return instant
    }
    previous = current
  }

  return null
}

function localDateTimeFromInstant(instant: number, timeZone: string): LocalDateTime {
  const formatter = formatterForTimeZone(timeZone)
  const parts = formatter.formatToParts(new Date(instant))
  return {
    year: numberPart(parts, 'year'),
    month: numberPart(parts, 'month'),
    day: numberPart(parts, 'day'),
    hour: numberPart(parts, 'hour'),
    minute: numberPart(parts, 'minute'),
  }
}

function formatterForTimeZone(timeZone: string): Intl.DateTimeFormat {
  const existing = DATE_TIME_FORMATTERS.get(timeZone)
  if (existing) return existing

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  DATE_TIME_FORMATTERS.set(timeZone, formatter)
  return formatter
}

function addLocalDays(date: Pick<LocalDateTime, 'year' | 'month' | 'day'>, days: number): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  }
}

function localWeekday(date: Pick<LocalDateTime, 'year' | 'month' | 'day'>): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

function parseTimeLocal(timeLocal: string): Pick<LocalDateTime, 'hour' | 'minute'> {
  const match = TIME_LOCAL_PATTERN.exec(timeLocal)
  if (!match) return { hour: 0, minute: 0 }
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

function numberPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const part = parts.find((entry) => entry.type === type)
  return Number(part?.value ?? 0)
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return compareLocalDateTime(left, right) === 0
}

function compareLocalDateTime(left: LocalDateTime, right: LocalDateTime): number {
  return (
    left.year - right.year
    || left.month - right.month
    || left.day - right.day
    || left.hour - right.hour
    || left.minute - right.minute
  )
}

// Exported because the catalogue install path resolves a zone of its own (the
// host's) and must hold it to the same bar the config field is held to, rather
// than keeping a second opinion about what a usable zone is.
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterForTimeZone(timeZone)
    return true
  } catch {
    return false
  }
}

function isValidLocalTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_LOCAL_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invalid(error: string): ScheduleValidationResult {
  return { ok: false, error }
}
