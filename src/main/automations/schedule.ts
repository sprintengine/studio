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
    default:
      return invalid('Unsupported schedule cadence type.')
  }
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
    default:
      return null
  }
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

function isValidTimeZone(timeZone: string): boolean {
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
