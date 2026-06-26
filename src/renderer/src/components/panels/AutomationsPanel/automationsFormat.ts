import type { LifecycleState, SelectItem } from '../../ui'
import {
  isAgentCliAvailable,
  type AgentCliCatalogOption,
} from '../../workspace/newWorkspace/cliRuntimeOptions'
import type {
  AutomationDefinition,
  AutomationRunStatus,
  AutomationStatus,
  ScheduleTriggerConfig,
  TriggerKind,
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

// ---------------------------------------------------------------------------
// Human-readable copy — actions and non-schedule trigger families read as
// sentences, not the machine kind strings the providers register under.
// AutomationsProviderView carries no display copy, so the renderer owns these
// maps; unknown third-party kinds fall back to their raw kind.
// ---------------------------------------------------------------------------

export const ACTION_LABEL: Record<string, string> = {
  'spawn-agent': 'Spawn an agent',
  'run-skill-loop': 'Run a skill loop',
  'watchtower-review': 'Run a code review',
  'sprint-engine-run': 'Run a Sprint Engine pass',
  'switchboard-runner-tick': 'Advance the Switchboard queue',
}

// Sentence-case action label for a kind, falling back to the raw kind for
// unknown third-party actions.
export function actionLabel(kind: string): string {
  return ACTION_LABEL[kind] ?? kind
}

// Summary copy for the non-schedule trigger families (schedule cadences are
// summarized by cadenceSummary). Unknown families fall back to the raw kind.
export const TRIGGER_SUMMARY: Record<string, string> = {
  'repo-event': 'On GitHub/Jira event',
  webhook: 'On webhook',
}

// Quiet family prefix for the list's supporting line — the most load-bearing
// dimension, scannable ahead of the cadence/summary ('Schedule · Every 2h',
// 'Event · On GitHub/Jira event', 'Webhook · On webhook'). Unknown third-party
// families fall back to their raw kind.
export const TRIGGER_FAMILY_LABEL: Record<string, string> = {
  schedule: 'Schedule',
  'repo-event': 'Event',
  webhook: 'Webhook',
}

export function triggerFamilyLabel(trigger: AutomationDefinition['trigger']): string {
  return TRIGGER_FAMILY_LABEL[trigger.kind] ?? trigger.kind
}

export function cadenceSummary(trigger: AutomationDefinition['trigger']): string {
  if (trigger.kind !== 'schedule' || !isScheduleConfig(trigger.config)) {
    return TRIGGER_SUMMARY[trigger.kind] ?? trigger.kind
  }
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
// Trigger round-trip — build the trigger to persist without rewriting families
// the editor cannot author yet.
// ---------------------------------------------------------------------------
// The schedule editor only authors interval/daily/weekly cadences. A loaded
// repo-event/webhook trigger (no editor until T4) or a cron schedule (no cron
// authoring control) must survive an edit verbatim instead of being silently
// rewritten to an interval schedule. These helpers are pure so the round-trip
// guarantee is unit-testable without rendering the form.

export type ScheduleCadenceType = 'interval' | 'daily' | 'weekly'

// The cadence sub-state the schedule editor controls. A loaded cron cadence is
// not represented here — it is preserved verbatim, not edited.
export type ScheduleCadenceForm = {
  cadenceType: ScheduleCadenceType
  everyMinutes: number
  timeLocal: string
  daysOfWeek: number[]
}

// True only when the loaded trigger is a schedule whose cadence the editor can
// actually author (interval/daily/weekly). Cron, repo-event, webhook, and any
// other family are read-only here.
export function isEditableScheduleTrigger(trigger: AutomationDefinition['trigger']): boolean {
  if (trigger.kind !== 'schedule' || !isScheduleConfig(trigger.config)) return false
  return trigger.config.cadence.type !== 'cron'
}

export function buildScheduleCadence(form: ScheduleCadenceForm): ScheduleTriggerConfig['cadence'] {
  if (form.cadenceType === 'daily') return { type: 'daily', timeLocal: form.timeLocal }
  if (form.cadenceType === 'weekly') return { type: 'weekly', timeLocal: form.timeLocal, daysOfWeek: form.daysOfWeek }
  return { type: 'interval', everyMinutes: form.everyMinutes }
}

// Resolve the trigger to persist from the ACTIVE family. For create or an
// editable schedule, build a fresh schedule trigger from the cadence form
// (preserving the loaded timezone on edit). For every other loaded trigger —
// cron schedule, repo-event, webhook, unknown — return it verbatim so a save
// never converts a trigger the editor cannot author.
export function resolveSubmitTrigger(
  editor: EditorState,
  form: ScheduleCadenceForm,
  fallbackTimezone: string,
): { kind: TriggerKind; config: unknown } {
  if (editor.mode === 'edit' && !isEditableScheduleTrigger(editor.definition.trigger)) {
    return editor.definition.trigger
  }
  const loaded = editor.mode === 'edit' ? editor.definition.trigger.config : null
  const timezone = isScheduleConfig(loaded) ? loaded.timezone : fallbackTimezone
  return {
    kind: 'schedule',
    config: {
      kind: 'schedule',
      timezone,
      cadence: buildScheduleCadence(form),
    } satisfies ScheduleTriggerConfig,
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

// ---------------------------------------------------------------------------
// spawn-agent `cli` field — constrained to the agent-picker catalog
// ---------------------------------------------------------------------------
// The spawn-agent action launches a delegated agent under `agent-<cli>-<id>`,
// which only reaches launch-confirm when the workspace-sync bus observes that
// id. CLIs the picker hides (e.g. `generic-shell`) never launch that way, so a
// free-text cli value could be saved that always fails. The editor reuses the
// same `selectAgentCliCatalog` source SpawnAgentMenu uses and rejects any value
// the catalog does not offer. These helpers are pure so the constraint is unit-
// testable without rendering the form.

// Empty cli is valid — the executor falls back to the app's last-selected CLI
// (a picker-valid id) at launch, matching the field's optional schema. A
// non-empty value must be provably present in the offered catalog: we fail
// closed against `selectAgentCliCatalog`, which is never empty while the plugin
// registry is loading or after a load error (it falls back to the bundled
// codex/claude-code options, and never surfaces hidden ids like generic-shell).
// So a stale unlaunchable value is rejected in every registry state, not just
// once the registry reaches `ready`.
export function automationCliFieldError(
  cli: string | undefined,
  catalog: AgentCliCatalogOption[],
): string | null {
  const value = cli?.trim()
  if (!value) return null
  if (!isAgentCliAvailable(value, catalog)) {
    return `"${value}" is not an available agent CLI. Pick an installed CLI.`
  }
  return null
}

// Options for the cli Select: a leading "use default" entry, the picker catalog,
// and — when editing a definition whose stored cli is no longer available — a
// trailing disabled entry so the unlaunchable value is visible instead of
// silently blank. The empty-value entry maps back to "omit cli" on save.
export function automationCliSelectItems(
  cli: string | undefined,
  catalog: AgentCliCatalogOption[],
): SelectItem[] {
  const items: SelectItem[] = [{ value: '', label: 'Default (use selected CLI)' }]
  for (const option of catalog) items.push({ value: option.value, label: option.label })
  const value = cli?.trim()
  if (value && !isAgentCliAvailable(value, catalog)) {
    items.push({ value, label: `${value} (unavailable)`, disabled: true, tone: 'warn' })
  }
  return items
}

// Editable-target guard so list shortcuts stay inert while typing.
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
