import type { ScheduleTriggerConfig } from './contracts'

// Cadence copy lives in shared, not in the Automations panel, because two very
// different readers render the same schedule: the desktop panel (AutomationsPanel/
// automationsFormat.ts) and the mobile snapshot projection (src/main/mobile/
// sprintengine/automations.ts). The phone must never parse a raw cadence — trigger
// `config` is provider-owned `unknown` — so the desktop pre-renders the string and
// puts only that on the wire. One rule, one place, so the two cannot drift.

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The one rendering rule for an `at` datetime ("2026-07-09 09:30") — shared by the
// cadence summary and the editor read-back so they can never drift.
export function formatAtDatetime(datetime: string): string {
  return datetime.replace('T', ' ')
}

export function scheduleCadenceSummary(config: ScheduleTriggerConfig): string {
  const cadence = config.cadence
  switch (cadence.type) {
    case 'interval': {
      const minutes = cadence.everyMinutes
      return minutes % 60 === 0 ? `Every ${minutes / 60}h` : `Every ${minutes} min`
    }
    case 'daily':
      return `Daily at ${cadence.timeLocal}`
    case 'weekly': {
      const days = [...cadence.daysOfWeek].sort((a, b) => a - b).map((day) => WEEKDAY_SHORT[day] ?? day).join(', ')
      return `Weekly · ${days} at ${cadence.timeLocal}`
    }
    case 'at':
      return `Once at ${formatAtDatetime(cadence.datetime)}`
    case 'cron':
      return `Cron · ${cadence.expression}`
  }
}

/**
 * The cadence as read by someone who does NOT share the desktop's clock — the
 * phone. A wall-clock cadence (daily/weekly/at/cron) is written in the trigger's
 * own timezone, which the desktop panel can leave implicit and a phone in another
 * timezone cannot: "Daily at 09:00" is a different moment in Dublin than in
 * Kolkata. An interval cadence names no wall-clock time, so it gets no suffix.
 *
 * `at` fixes the instant the zone label describes, because a zone's short name is
 * offset-dependent (Dublin is GMT+1 in July, GMT in January).
 */
export function scheduleCadenceSummaryWithZone(config: ScheduleTriggerConfig, at: Date): string {
  const summary = scheduleCadenceSummary(config)
  if (config.cadence.type === 'interval') return summary
  const zone = timeZoneLabel(config.timezone, at)
  return zone ? `${summary} ${zone}` : summary
}

// "PDT", "UTC", "GMT+5:30" — whatever the runtime's zone data has for that instant.
// Null when the zone is unknown to the runtime (Intl throws on an invalid zone) or
// the instant is invalid: the caller then leaves the cadence unqualified rather
// than stamping an offset it cannot stand behind.
function timeZoneLabel(timeZone: string, at: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(at)
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? null
  } catch {
    return null
  }
}
