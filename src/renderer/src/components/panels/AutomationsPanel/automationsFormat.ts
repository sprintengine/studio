import type { LifecycleState, SelectItem } from '../../ui'
import {
  isAgentCliAvailable,
  type AgentCliCatalogOption,
} from '../../workspace/newWorkspace/cliRuntimeOptions'
import type {
  AutomationDefinition,
  AutomationRunStatus,
  AutomationStatus,
  AutomationsProviderView,
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

// ---------------------------------------------------------------------------
// Trigger families the editor can author (T4). Schedule (interval/daily/weekly),
// repo-event, and webhook are authored from their own form sub-state. A loaded
// cron schedule (the engine rejects cron — schedule.ts has no cron cadence) and
// any unknown third-party family stay read-only and round-trip verbatim.
// ---------------------------------------------------------------------------

export type RepoEventProvider = 'github' | 'jira' | 'any'
export type RepoEventType = 'created' | 'updated'

// The repo-event editor sub-state (src/main/automations/triggers/repo-event.ts
// schema: provider github|jira|any, eventTypes created|updated, externalKey, label).
export type RepoEventForm = {
  provider: RepoEventProvider
  eventTypes: RepoEventType[]
  externalKey: string
  label: string
}

// The webhook editor sub-state. `secret` is the write-only NEW secret generated
// this session — never the stored value (the IPC redacts it). `hasSecret` mirrors
// the redacted config's hasSecret so the editor can show a "secret set" state.
export type WebhookForm = {
  enabled: boolean
  port: string
  path: string
  secret: string
  hasSecret: boolean
  eventType: string
  label: string
}

export const EMPTY_REPO_EVENT_FORM: RepoEventForm = { provider: 'any', eventTypes: [], externalKey: '', label: '' }
export const EMPTY_WEBHOOK_FORM: WebhookForm = {
  enabled: false, port: '', path: '', secret: '', hasSecret: false, eventType: '', label: '',
}

// The full trigger sub-state resolveSubmitTrigger reads. EditorFormState extends
// this structurally.
export type SubmitTriggerForm = ScheduleCadenceForm & {
  triggerKind: TriggerKind
  repoEvent: RepoEventForm
  webhook: WebhookForm
}

export const REPO_EVENT_TRIGGER_KIND = 'repo-event'
export const WEBHOOK_TRIGGER_KIND = 'webhook'
// /automations/webhooks/<path> — mirrors WEBHOOK_ROUTE_PREFIX in the receiver.
export const WEBHOOK_ROUTE_PREFIX = '/automations/webhooks/'
export const WEBHOOK_SIGNATURE_HEADER = 'x-multicode-signature'
export const MIN_WEBHOOK_SECRET_LENGTH = 16
// Mirrors the receiver's path rule (webhook.ts WEBHOOK_PATH_PATTERN).
const WEBHOOK_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

// A loaded trigger the editor can author. Cron schedules and unknown third-party
// families return false — they stay read-only and round-trip verbatim.
export function isAuthorableTrigger(trigger: AutomationDefinition['trigger']): boolean {
  if (trigger.kind === REPO_EVENT_TRIGGER_KIND || trigger.kind === WEBHOOK_TRIGGER_KIND) return true
  if (trigger.kind === 'schedule') return isEditableScheduleTrigger(trigger)
  return false
}

export function buildRepoEventConfig(form: RepoEventForm): Record<string, unknown> {
  const config: Record<string, unknown> = { kind: REPO_EVENT_TRIGGER_KIND, provider: form.provider }
  if (form.eventTypes.length > 0) config.eventTypes = [...form.eventTypes]
  const externalKey = form.externalKey.trim()
  if (externalKey) config.externalKey = externalKey
  const label = form.label.trim()
  if (label) config.label = label
  return config
}

export function buildWebhookConfig(form: WebhookForm): Record<string, unknown> {
  const config: Record<string, unknown> = { kind: WEBHOOK_TRIGGER_KIND, enabled: form.enabled }
  const port = form.port.trim()
  if (port) {
    const parsed = Number(port)
    if (Number.isInteger(parsed)) config.port = parsed
  }
  const path = form.path.trim()
  if (path) config.path = path
  const eventType = form.eventType.trim()
  if (eventType) config.eventType = eventType
  const label = form.label.trim()
  if (label) config.label = label
  // Only persist a freshly generated secret. An empty secret omits the field so
  // the engine keeps the stored one (the renderer never sees it).
  if (form.secret) config.secret = form.secret
  return config
}

// Compares a built webhook config against the loaded (redacted) config, ignoring
// the write-only secret and the redaction marker, so the editor can tell whether
// the webhook trigger actually changed.
export function webhookConfigEquivalent(built: Record<string, unknown>, loaded: unknown): boolean {
  if (!loaded || typeof loaded !== 'object') return false
  const a: Record<string, unknown> = { ...built }
  delete a.secret
  const b: Record<string, unknown> = { ...(loaded as Record<string, unknown>) }
  delete b.secret
  delete b.hasSecret
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

// Save-blocking validation for the webhook family. `sendingTrigger` is false when
// the webhook is unchanged on edit (the trigger patch is omitted and the stored
// secret preserved), so secret requirements only apply when a trigger is written.
export function webhookTriggerError(form: WebhookForm, opts: { sendingTrigger: boolean }): string | null {
  if (form.secret && form.secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    return `Webhook secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.`
  }
  if (form.port.trim()) {
    const parsed = Number(form.port.trim())
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      return 'Webhook port must be a whole number between 0 and 65535.'
    }
  }
  if (form.path.trim() && !WEBHOOK_PATH_PATTERN.test(form.path.trim())) {
    return 'Webhook path may use letters, numbers, dot, underscore and hyphen, and must start with a letter or number.'
  }
  if (!opts.sendingTrigger) return null
  if (form.enabled) {
    if (!form.path.trim()) return 'Add a webhook path to enable delivery.'
    if (!form.port.trim()) return 'Add a webhook port to enable delivery.'
    if (!form.secret && !form.hasSecret) return 'Generate a webhook secret to enable delivery.'
    if (!form.secret && form.hasSecret) return 'Regenerate the webhook secret to save changes to an enabled webhook.'
  }
  return null
}

// Seed the repo-event / webhook form sub-state from a loaded (redacted) config.
export function repoEventFormFromConfig(config: unknown): RepoEventForm {
  if (!config || typeof config !== 'object') return { ...EMPTY_REPO_EVENT_FORM }
  const record = config as Record<string, unknown>
  const provider = record.provider
  const eventTypes = Array.isArray(record.eventTypes)
    ? record.eventTypes.filter((e): e is RepoEventType => e === 'created' || e === 'updated')
    : []
  return {
    provider: provider === 'github' || provider === 'jira' ? provider : 'any',
    eventTypes,
    externalKey: typeof record.externalKey === 'string' ? record.externalKey : '',
    label: typeof record.label === 'string' ? record.label : '',
  }
}

export function webhookFormFromConfig(config: unknown): WebhookForm {
  if (!config || typeof config !== 'object') return { ...EMPTY_WEBHOOK_FORM }
  const record = config as Record<string, unknown>
  return {
    enabled: record.enabled === true,
    port: typeof record.port === 'number' ? String(record.port) : '',
    path: typeof record.path === 'string' ? record.path : '',
    secret: '',
    hasSecret: record.hasSecret === true,
    eventType: typeof record.eventType === 'string' ? record.eventType : '',
    label: typeof record.label === 'string' ? record.label : '',
  }
}

// A cryptographically-random hex secret (48 chars), generated in the renderer and
// shown once. The engine stores and HMAC-verifies it; it is never read back.
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Disabled-with-reason text for an unavailable trigger or action provider. Mirrors
// the action-availability pattern; `noun` tailors the missing-integration copy.
export function providerUnavailableReason(
  provider: AutomationsProviderView | null | undefined,
  noun: 'action' | 'trigger' = 'action',
): string | null {
  if (!provider) return null
  if (provider.blockedReason) return provider.blockedReason
  if (provider.missingIntegrations.length > 0) {
    return `This ${noun} needs ${provider.missingIntegrations.join(', ')}, which is not connected.`
  }
  return null
}

// Resolve the trigger to persist from the ACTIVE family. A loaded cron schedule
// or unknown family is returned verbatim (read-only — no authoring control), so a
// save never converts a trigger the editor cannot author. Schedule/repo-event/
// webhook are built from their form sub-state.
export function resolveSubmitTrigger(
  editor: EditorState,
  form: SubmitTriggerForm,
  fallbackTimezone: string,
): { kind: TriggerKind; config: unknown } {
  if (editor.mode === 'edit' && !isAuthorableTrigger(editor.definition.trigger)) {
    return editor.definition.trigger
  }
  if (form.triggerKind === REPO_EVENT_TRIGGER_KIND) {
    return { kind: REPO_EVENT_TRIGGER_KIND, config: buildRepoEventConfig(form.repoEvent) }
  }
  if (form.triggerKind === WEBHOOK_TRIGGER_KIND) {
    return { kind: WEBHOOK_TRIGGER_KIND, config: buildWebhookConfig(form.webhook) }
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

// True when an edit must write a webhook trigger patch. Unchanged webhooks with no
// new secret omit the trigger so the engine preserves the stored secret.
export function shouldSendWebhookTrigger(form: WebhookForm, loadedConfig: unknown): boolean {
  if (form.secret) return true
  return !webhookConfigEquivalent(buildWebhookConfig(form), loadedConfig)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const aKeys = Object.keys(a as Record<string, unknown>)
    const bKeys = Object.keys(b as Record<string, unknown>)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  }
  return false
}

// Whether a freshly built trigger matches the loaded one (key-order-insensitive).
// Used to omit an unchanged trigger from an update patch — required so a webhook's
// stored secret survives a name/action edit, and so an existing repo-event whose
// provider is no longer registered (Switchboard disabled) can still be renamed.
export function triggersEquivalent(
  built: { kind: TriggerKind; config: unknown },
  loaded: { kind: TriggerKind; config: unknown } | null | undefined,
): boolean {
  if (!loaded || built.kind !== loaded.kind) return false
  if (built.kind === WEBHOOK_TRIGGER_KIND) {
    return webhookConfigEquivalent(built.config as Record<string, unknown>, loaded.config)
  }
  return deepEqual(built.config, loaded.config)
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
