import type { LifecycleState } from '../../ui'
import type {
  AutomationDefinition,
  AutomationRunStatus,
  AutomationStatus,
  ScheduleTriggerConfig,
} from '../../../../../shared/automations/contracts'

// Shared async + editor state used across the control-center modules.
export type AsyncState = 'idle' | 'loading' | 'ready' | 'error'

export type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; definition: AutomationDefinition }

// ---------------------------------------------------------------------------
// Status mapping — status reads by glyph shape + text label, never colour alone
// (non-color-only accessibility). The shared LifecycleGlyph carries the shape.
// ---------------------------------------------------------------------------

export const DEFINITION_LIFECYCLE: Record<AutomationStatus, LifecycleState> = {
  enabled: 'ready',
  paused: 'paused',
  // No distinct "blocked" shape exists; map to needs_input (warn ring + "!").
  blocked: 'needs_input',
}

export const DEFINITION_STATUS_LABEL: Record<AutomationStatus, string> = {
  enabled: 'Enabled',
  paused: 'Paused',
  blocked: 'Blocked',
}

export const RUN_LIFECYCLE: Record<AutomationRunStatus, LifecycleState> = {
  queued: 'todo',
  running: 'in_progress',
  completed: 'done',
  failed: 'failed',
  blocked: 'needs_input',
  skipped: 'archived',
}

export const RUN_STATUS_LABEL: Record<AutomationRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
}

// ---------------------------------------------------------------------------
// Time + cadence formatting
// ---------------------------------------------------------------------------

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function relativeFromNow(at: number, now: number): string {
  const deltaSec = Math.round((at - now) / 1000)
  const abs = Math.abs(deltaSec)
  if (abs < 60) return RELATIVE.format(deltaSec, 'second')
  if (abs < 3600) return RELATIVE.format(Math.round(deltaSec / 60), 'minute')
  if (abs < 86400) return RELATIVE.format(Math.round(deltaSec / 3600), 'hour')
  return RELATIVE.format(Math.round(deltaSec / 86400), 'day')
}

export function absoluteTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function isScheduleConfig(config: unknown): config is ScheduleTriggerConfig {
  return Boolean(config) && typeof config === 'object' && (config as { kind?: unknown }).kind === 'schedule'
}

export function cadenceSummary(trigger: AutomationDefinition['trigger']): string {
  if (trigger.kind !== 'schedule' || !isScheduleConfig(trigger.config)) return trigger.kind
  const cadence = trigger.config.cadence
  switch (cadence.type) {
    case 'interval': {
      const m = cadence.everyMinutes
      return m % 60 === 0 ? `Every ${m / 60}h` : `Every ${m} min`
    }
    case 'daily':
      return `Daily at ${cadence.timeLocal}`
    case 'weekly': {
      const days = [...cadence.daysOfWeek].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d] ?? d).join(', ')
      return `Weekly · ${days} at ${cadence.timeLocal}`
    }
    case 'cron':
      return `Cron · ${cadence.expression}`
  }
}

// ---------------------------------------------------------------------------
// Default-focus ordering (Q1): blocked first, then overdue, then soonest due,
// then everything without a next run (paused / no schedule) at the bottom.
// ---------------------------------------------------------------------------

export function isOverdue(def: AutomationDefinition, now: number): boolean {
  if (def.status !== 'enabled') return false
  const next = parseTime(def.nextRunAt)
  return next !== null && next < now
}

export function sortDefinitions(defs: AutomationDefinition[], now: number): AutomationDefinition[] {
  const rank = (def: AutomationDefinition): number => {
    if (def.status === 'blocked') return 0
    if (isOverdue(def, now)) return 1
    if (def.status === 'enabled' && parseTime(def.nextRunAt) !== null) return 2
    return 3
  }
  return [...defs].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    const na = parseTime(a.nextRunAt)
    const nb = parseTime(b.nextRunAt)
    if (na !== null && nb !== null && na !== nb) return na - nb
    if (na !== null && nb === null) return -1
    if (na === null && nb !== null) return 1
    return a.name.localeCompare(b.name)
  })
}

// Editable-target guard so list shortcuts stay inert while typing.
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
