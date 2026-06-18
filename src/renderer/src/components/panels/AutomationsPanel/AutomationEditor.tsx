import { useCallback, useMemo, useState } from 'react'

import { Field, GhostButton, InlineNotice, PrimaryButton, Select, type SelectItem, Switch } from '../../ui'
import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationsProviderView,
  AutomationsProviders,
  ScheduleTriggerConfig,
} from '../../../../../shared/automations/contracts'
import { WEEKDAY_SHORT, isScheduleConfig, type EditorState } from './automationsFormat'

type CadenceType = 'interval' | 'daily' | 'weekly'

type EditorFormState = {
  name: string
  enabled: boolean
  autonomy: AutomationDefinition['autonomyDefault']
  actionKind: string
  cadenceType: CadenceType
  everyMinutes: number
  timeLocal: string
  daysOfWeek: number[]
  config: Record<string, string>
}

// Action config keys the engine owns internally — never exposed as form fields.
const INTERNAL_CONFIG_KEYS = new Set(['workspaceId', 'folderPath', 'requiredIntegrations'])

const CONFIG_FIELD_LABEL: Record<string, string> = {
  prompt: 'Prompt',
  cli: 'CLI',
  name: 'Agent name',
  skill: 'Skill',
}

function schemaStringKeys(schema: AutomationsProviderView['configSchema']): string[] {
  const properties = (schema as { properties?: Record<string, unknown> }).properties
  if (!properties) return []
  return Object.keys(properties).filter((key) => {
    if (INTERNAL_CONFIG_KEYS.has(key)) return false
    const prop = properties[key]
    return Boolean(prop) && typeof prop === 'object' && (prop as { type?: unknown }).type === 'string'
  })
}

function schemaRequiredKeys(schema: AutomationsProviderView['configSchema']): Set<string> {
  const required = (schema as { required?: unknown }).required
  return new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [])
}

const EMPTY_FORM: EditorFormState = {
  name: '', enabled: true, autonomy: 'review_only', actionKind: '',
  cadenceType: 'interval', everyMinutes: 30, timeLocal: '09:00', daysOfWeek: [1, 2, 3, 4, 5], config: {},
}

function initialFormState(editor: EditorState, providers: AutomationsProviders): EditorFormState {
  const firstAvailableAction =
    providers.actions.find((a) => a.missingIntegrations.length === 0) ?? providers.actions[0]
  if (editor.mode === 'create') {
    return { ...EMPTY_FORM, actionKind: firstAvailableAction?.kind ?? '' }
  }
  const def = editor.definition
  const schedule = isScheduleConfig(def.trigger.config) ? def.trigger.config : null
  const cadence = schedule?.cadence
  const config: Record<string, string> = {}
  if (def.action.config && typeof def.action.config === 'object') {
    for (const [key, value] of Object.entries(def.action.config as Record<string, unknown>)) {
      if (!INTERNAL_CONFIG_KEYS.has(key) && typeof value === 'string') config[key] = value
    }
  }
  return {
    name: def.name,
    enabled: def.status !== 'paused',
    autonomy: def.autonomyDefault,
    actionKind: def.action.kind,
    cadenceType: cadence?.type === 'daily' || cadence?.type === 'weekly' ? cadence.type : 'interval',
    everyMinutes: cadence?.type === 'interval' ? cadence.everyMinutes : 30,
    timeLocal: cadence && (cadence.type === 'daily' || cadence.type === 'weekly') ? cadence.timeLocal : '09:00',
    daysOfWeek: cadence?.type === 'weekly' ? cadence.daysOfWeek : [1, 2, 3, 4, 5],
    config,
  }
}

function buildCadence(form: EditorFormState): ScheduleTriggerConfig['cadence'] {
  if (form.cadenceType === 'daily') return { type: 'daily', timeLocal: form.timeLocal }
  if (form.cadenceType === 'weekly') return { type: 'weekly', timeLocal: form.timeLocal, daysOfWeek: form.daysOfWeek }
  return { type: 'interval', everyMinutes: form.everyMinutes }
}

// Schema-driven create / edit form. The action's fields are derived from the
// selected provider's configSchema (providers:list); an action whose required
// integration is missing is disabled with an explicit unavailable state.
export function AutomationEditor({
  editor, providers, workspaceRoot, onCancel, onSaved,
}: {
  editor: EditorState
  providers: AutomationsProviders | null
  workspaceRoot: string
  onCancel: () => void
  onSaved: (saved: AutomationDefinition) => void
}) {
  const [form, setForm] = useState<EditorFormState>(() =>
    providers ? initialFormState(editor, providers) : EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const actionProvider = providers?.actions.find((a) => a.kind === form.actionKind) ?? null
  const actionMissing = actionProvider?.missingIntegrations ?? []
  const configKeys = actionProvider ? schemaStringKeys(actionProvider.configSchema) : []
  const requiredKeys = actionProvider ? schemaRequiredKeys(actionProvider.configSchema) : new Set<string>()

  const update = useCallback(<K extends keyof EditorFormState>(key: K, value: EditorFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const validationError = useMemo((): string | null => {
    if (!form.name.trim()) return 'Give the automation a name.'
    if (!actionProvider) return 'No action provider is available.'
    if (actionMissing.length > 0) return `The "${form.actionKind}" action needs ${actionMissing.join(', ')}, which is not available.`
    if (form.cadenceType === 'interval' && form.everyMinutes < 5) return 'Interval must be at least 5 minutes.'
    if (form.cadenceType === 'weekly' && form.daysOfWeek.length === 0) return 'Pick at least one day for a weekly schedule.'
    for (const key of requiredKeys) {
      if (INTERNAL_CONFIG_KEYS.has(key)) continue
      if (!form.config[key]?.trim()) return `${CONFIG_FIELD_LABEL[key] ?? key} is required.`
    }
    return null
  }, [form, actionProvider, actionMissing, requiredKeys])

  const handleSubmit = useCallback(async () => {
    if (validationError || !workspaceRoot) { setError(validationError); return }
    setSaving(true)
    setError(null)
    const config: Record<string, string> = {}
    for (const key of configKeys) {
      const value = form.config[key]?.trim()
      if (value) config[key] = value
    }
    const draft: AutomationDefinitionDraft = {
      name: form.name.trim(),
      status: form.enabled ? 'enabled' : 'paused',
      autonomyDefault: form.autonomy,
      trigger: {
        kind: 'schedule',
        config: {
          kind: 'schedule',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          cadence: buildCadence(form),
        } satisfies ScheduleTriggerConfig,
      },
      action: { kind: form.actionKind, config },
    }
    try {
      const result = editor.mode === 'create'
        ? await window.api.createAutomation({ workspaceRoot, definition: draft })
        : await window.api.updateAutomation({
          workspaceRoot,
          automationId: editor.definition.id,
          patch: {
            name: draft.name,
            status: draft.status,
            autonomyDefault: draft.autonomyDefault,
            trigger: draft.trigger,
            action: draft.action,
          },
        })
      if (!result.ok) { setError(result.message); return }
      onSaved(result.value)
    } catch (err) {
      // A rejected IPC invoke would otherwise leave the form stuck on "Saving…".
      setError(err instanceof Error ? err.message : 'The automations service did not respond.')
    } finally {
      setSaving(false)
    }
  }, [validationError, workspaceRoot, configKeys, form, editor, onSaved])

  const actionItems: SelectItem[] = (providers?.actions ?? []).map((a) => ({
    value: a.kind,
    label: a.missingIntegrations.length > 0 ? `${a.kind} (needs ${a.missingIntegrations.join(', ')})` : a.kind,
    disabled: a.missingIntegrations.length > 0,
  }))

  return (
    <form
      className="flex flex-col gap-4 px-4 py-4"
      onSubmit={(e) => { e.preventDefault(); void handleSubmit() }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[color:var(--text-strong)]">
          {editor.mode === 'create' ? 'New automation' : 'Edit automation'}
        </h3>
        <GhostButton type="button" onClick={onCancel} className="h-6 px-2 text-[11px]">Cancel</GhostButton>
      </div>

      <Field label="Name" htmlFor="automation-name" required>
        <input
          id="automation-name"
          type="text"
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          placeholder="Nightly review of this repo"
          className="w-full rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
        />
      </Field>

      {/* Schedule (trigger) — the schedule provider's cadence oneOf. */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-[color:var(--border-subtle)] p-3">
        <legend className="px-1 text-[11px] font-medium text-[color:var(--text-muted)]">Schedule</legend>
        <Field label="Cadence" htmlFor="automation-cadence">
          <Select<CadenceType>
            ariaLabel="Cadence"
            value={form.cadenceType}
            onChange={(value) => update('cadenceType', value)}
            items={[
              { value: 'interval', label: 'Every N minutes' },
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
            ]}
          />
        </Field>
        {form.cadenceType === 'interval' ? (
          <Field label="Run every (minutes)" htmlFor="automation-interval" help="Minimum 5 minutes.">
            <input
              id="automation-interval"
              type="number"
              min={5}
              value={form.everyMinutes}
              onChange={(e) => update('everyMinutes', Number(e.target.value) || 0)}
              className="w-32 rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] tabular-nums text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
            />
          </Field>
        ) : (
          <Field label="Time" htmlFor="automation-time" help="Local time, 24-hour (HH:MM).">
            <input
              id="automation-time"
              type="time"
              value={form.timeLocal}
              onChange={(e) => update('timeLocal', e.target.value)}
              className="w-32 rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] tabular-nums text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
            />
          </Field>
        )}
        {form.cadenceType === 'weekly' ? (
          <fieldset>
            <legend className="mb-1 text-[11px] text-[color:var(--text-subtle)]">Days</legend>
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_SHORT.map((label, day) => {
                const checked = form.daysOfWeek.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => update('daysOfWeek', checked ? form.daysOfWeek.filter((d) => d !== day) : [...form.daysOfWeek, day])}
                    className={[
                      'h-7 w-9 rounded-md border text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary)]',
                      checked
                        ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                        : 'border-[color:var(--border-strong)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </fieldset>
        ) : null}
      </fieldset>

      {/* Action — schema-driven from providers:list. */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-[color:var(--border-subtle)] p-3">
        <legend className="px-1 text-[11px] font-medium text-[color:var(--text-muted)]">Action</legend>
        <Field label="Action" htmlFor="automation-action">
          <Select
            ariaLabel="Action"
            value={form.actionKind || null}
            onChange={(value) => update('actionKind', value)}
            items={actionItems}
            placeholder="Select an action…"
          />
        </Field>
        {actionMissing.length > 0 ? (
          <InlineNotice tone="warn">
            This action needs {actionMissing.join(', ')}, which is not connected. Connect it to enable this action.
          </InlineNotice>
        ) : (
          configKeys.map((key) => {
            const required = requiredKeys.has(key)
            const label = CONFIG_FIELD_LABEL[key] ?? key
            const id = `automation-config-${key}`
            return (
              <Field key={key} label={label} htmlFor={id} required={required}>
                {key === 'prompt' ? (
                  <textarea
                    id={id}
                    rows={4}
                    value={form.config[key] ?? ''}
                    onChange={(e) => update('config', { ...form.config, [key]: e.target.value })}
                    placeholder="Review the changes on this repo and summarise risks."
                    className="w-full resize-y rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] leading-5 text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
                  />
                ) : (
                  <input
                    id={id}
                    type="text"
                    value={form.config[key] ?? ''}
                    onChange={(e) => update('config', { ...form.config, [key]: e.target.value })}
                    className="w-full rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12px] text-[color:var(--text-default)] outline-none focus-visible:border-[color:var(--accent-primary)]"
                  />
                )}
              </Field>
            )
          })
        )}
      </fieldset>

      <div className="flex items-center justify-between gap-3">
        <label htmlFor="automation-autonomy" className="flex items-center gap-2 text-[12px] text-[color:var(--text-default)]">
          <Switch
            id="automation-autonomy"
            checked={form.autonomy === 'allow_changes'}
            onChange={(next) => update('autonomy', next ? 'allow_changes' : 'review_only')}
            ariaLabel="Allow the agent to change files"
          />
          Allow changes
          <span className="text-[11px] text-[color:var(--text-subtle)]">{form.autonomy === 'allow_changes' ? '(agent may edit files)' : '(review only)'}</span>
        </label>
        <label htmlFor="automation-enabled" className="flex items-center gap-2 text-[12px] text-[color:var(--text-default)]">
          <Switch
            id="automation-enabled"
            checked={form.enabled}
            onChange={(next) => update('enabled', next)}
            ariaLabel="Enable this automation"
          />
          Enabled
        </label>
      </div>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

      <div className="flex items-center gap-2">
        <PrimaryButton type="submit" disabled={saving || validationError !== null}>
          {saving ? 'Saving…' : editor.mode === 'create' ? 'Create automation' : 'Save changes'}
        </PrimaryButton>
        <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>
        {validationError ? (
          <span className="text-[11px] text-[color:var(--text-subtle)]">{validationError}</span>
        ) : null}
      </div>
    </form>
  )
}
