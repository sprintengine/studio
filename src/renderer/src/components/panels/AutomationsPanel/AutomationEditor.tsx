import { useCallback, useMemo, useState } from 'react'

import { Field, GhostButton, InlineNotice, PrimaryButton, Select, type SelectItem, Switch, Tooltip } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { selectAgentCliCatalog } from '../../workspace/newWorkspace/cliRuntimeOptions'
import { orderSpecialistActions } from '../../../specialists/specialistActions'
import { AGENT_SPAWN_PERMISSION_OPTIONS } from '../../workspace/SpawnAgentMenu'
import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationsProviderView,
  AutomationsProviders,
  TriggerKind,
} from '../../../../../shared/automations/contracts'
import {
  WEEKDAY_SHORT,
  actionLabel,
  automationCliFieldError,
  automationCliSelectItems,
  cadenceSummary,
  isEditableScheduleTrigger,
  isScheduleConfig,
  resolveSubmitTrigger,
  type EditorState,
  type ScheduleCadenceType,
} from './automationsFormat'

type EditorFormState = {
  name: string
  enabled: boolean
  autonomy: AutomationDefinition['autonomyDefault']
  actionKind: string
  // Discriminates which trigger family the loaded definition uses. The schedule
  // editor only authors the cadence sub-state below; other families are
  // preserved verbatim through save (see resolveSubmitTrigger).
  triggerKind: TriggerKind
  cadenceType: ScheduleCadenceType
  everyMinutes: number
  timeLocal: string
  daysOfWeek: number[]
  config: Record<string, string>
}

// Action config keys the engine owns internally — never exposed as form fields
// and never loaded into the editable form.
const INTERNAL_CONFIG_KEYS = new Set(['workspaceId', 'folderPath', 'requiredIntegrations'])

// Keys owned by the agent picker (specialist / model / permission). They are
// loaded into the form and persisted, but rendered by the picker controls rather
// than as generic free-text string fields.
const PICKER_CONFIG_KEYS = new Set(['cliModel', 'permissionPreset', 'specialistId'])

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
    if (INTERNAL_CONFIG_KEYS.has(key) || PICKER_CONFIG_KEYS.has(key)) return false
    const prop = properties[key]
    return Boolean(prop) && typeof prop === 'object' && (prop as { type?: unknown }).type === 'string'
  })
}

function schemaRequiredKeys(schema: AutomationsProviderView['configSchema']): Set<string> {
  const required = (schema as { required?: unknown }).required
  return new Set(Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [])
}

const EMPTY_FORM: EditorFormState = {
  name: '', enabled: true, autonomy: 'review_only', actionKind: '', triggerKind: 'schedule',
  cadenceType: 'interval', everyMinutes: 30, timeLocal: '09:00', daysOfWeek: [1, 2, 3, 4, 5], config: {},
}

function initialFormState(editor: EditorState, providers: AutomationsProviders): EditorFormState {
  const firstAvailableAction =
    providers.actions.find((a) => !providerUnavailableReason(a)) ?? providers.actions[0]
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
  // Cadence sub-state seeds the schedule editor; for a cron cadence or a
  // non-schedule family these stay at their defaults and are never persisted —
  // resolveSubmitTrigger returns the loaded trigger verbatim instead.
  return {
    name: def.name,
    enabled: def.status !== 'paused',
    autonomy: def.autonomyDefault,
    actionKind: def.action.kind,
    triggerKind: def.trigger.kind,
    cadenceType: cadence?.type === 'daily' || cadence?.type === 'weekly' ? cadence.type : 'interval',
    everyMinutes: cadence?.type === 'interval' ? cadence.everyMinutes : 30,
    timeLocal: cadence && (cadence.type === 'daily' || cadence.type === 'weekly') ? cadence.timeLocal : '09:00',
    daysOfWeek: cadence?.type === 'weekly' ? cadence.daysOfWeek : [1, 2, 3, 4, 5],
    config,
  }
}

function providerUnavailableReason(provider: AutomationsProviderView | null | undefined): string | null {
  if (!provider) return null
  if (provider.blockedReason) return provider.blockedReason
  if (provider.missingIntegrations.length > 0) {
    return `This action needs ${provider.missingIntegrations.join(', ')}, which is not connected.`
  }
  return null
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

  // The cli config field is constrained to the same agent-picker catalog
  // SpawnAgentMenu uses (T2 plugin registry), not a new hardcoded list, so an
  // unlaunchable CLI cannot be saved.
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliCatalog = useMemo(
    () => selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes],
  )

  const actionProvider = providers?.actions.find((a) => a.kind === form.actionKind) ?? null
  const actionUnavailableReason = providerUnavailableReason(actionProvider)
  const configKeys = actionProvider ? schemaStringKeys(actionProvider.configSchema) : []
  const requiredKeys = actionProvider ? schemaRequiredKeys(actionProvider.configSchema) : new Set<string>()

  // Agent picker options (same catalogs the live SpawnAgentMenu uses), persisted
  // into the automation's action config so a scheduled run reproduces the choice.
  const specialistItems = useMemo<SelectItem[]>(
    () => [
      { value: '', label: 'General agent' },
      ...orderSpecialistActions([]).map((action) => ({ value: action.id as string, label: action.shortLabel ?? action.label ?? action.id })),
    ],
    [],
  )
  const modelItems = useMemo<SelectItem[]>(() => {
    const entry = cliCatalog.find((option) => option.value === (form.config.cli || cliCatalog[0]?.value))
    const options = entry?.modelSelection?.options ?? []
    return [{ value: '', label: 'CLI default' }, ...options.map((model) => ({ value: model.id, label: model.label ?? model.id }))]
  }, [cliCatalog, form.config.cli])
  const showAgentPicker = !actionUnavailableReason && configKeys.includes('cli')

  // The schedule cadence editor only renders for create and for a loaded
  // schedule whose cadence it can author. A cron schedule or a repo-event /
  // webhook trigger (authoring lands in T4) is read-only and preserved verbatim.
  const triggerEditable = editor.mode === 'create' || isEditableScheduleTrigger(editor.definition.trigger)
  const loadedTrigger = editor.mode === 'edit' ? editor.definition.trigger : null

  const update = useCallback(<K extends keyof EditorFormState>(key: K, value: EditorFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const validationError = useMemo((): string | null => {
    if (!form.name.trim()) return 'Give the automation a name.'
    if (!actionProvider) return 'No action provider is available.'
    if (actionUnavailableReason) return actionUnavailableReason
    if (triggerEditable && form.cadenceType === 'interval' && form.everyMinutes < 5) return 'Interval must be at least 5 minutes.'
    if (triggerEditable && form.cadenceType === 'weekly' && form.daysOfWeek.length === 0) return 'Pick at least one day for a weekly schedule.'
    if (configKeys.includes('cli')) {
      const cliError = automationCliFieldError(form.config.cli, cliCatalog)
      if (cliError) return cliError
    }
    for (const key of requiredKeys) {
      if (INTERNAL_CONFIG_KEYS.has(key)) continue
      if (!form.config[key]?.trim()) return `${CONFIG_FIELD_LABEL[key] ?? key} is required.`
    }
    return null
  }, [form, actionProvider, actionUnavailableReason, requiredKeys, configKeys, cliCatalog, triggerEditable])

  const handleSubmit = useCallback(async () => {
    if (validationError || !workspaceRoot) { setError(validationError); return }
    setSaving(true)
    setError(null)
    const config: Record<string, string> = {}
    for (const key of configKeys) {
      const value = form.config[key]?.trim()
      if (value) config[key] = value
    }
    // Picker-owned fields (not in configKeys: they are not free-text inputs) are
    // persisted into the action config so a scheduled run reproduces the choice.
    if (showAgentPicker) {
      for (const key of ['specialistId', 'cliModel', 'permissionPreset'] as const) {
        const value = form.config[key]?.trim()
        if (value) config[key] = value
      }
    }
    const draft: AutomationDefinitionDraft = {
      name: form.name.trim(),
      status: form.enabled ? 'enabled' : 'paused',
      autonomyDefault: form.autonomy,
      // Build the trigger from the active family: the schedule cadence form when
      // editable, otherwise the loaded trigger unchanged (no data loss).
      trigger: resolveSubmitTrigger(editor, form, Intl.DateTimeFormat().resolvedOptions().timeZone),
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
    label: providerUnavailableReason(a) ? `${actionLabel(a.kind)} — unavailable` : actionLabel(a.kind),
    disabled: Boolean(providerUnavailableReason(a)),
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

      {/* Trigger — the schedule cadence editor, or a read-only summary for a
          trigger family the editor cannot author yet (cron, repo-event,
          webhook). Read-only families are preserved verbatim on save. */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-[color:var(--border-subtle)] p-3">
        <legend className="px-1 text-[11px] font-medium text-[color:var(--text-muted)]">
          {triggerEditable ? 'Schedule' : 'Trigger'}
        </legend>
        {triggerEditable ? (
          <>
            <Field label="Cadence" htmlFor="automation-cadence">
              <Select<ScheduleCadenceType>
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
          </>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-[color:var(--text-default)]">
              {loadedTrigger ? cadenceSummary(loadedTrigger) : ''}
            </span>
            <span className="text-[11px] text-[color:var(--text-subtle)]">
              Editing this trigger type isn’t supported yet. Saving keeps the current trigger unchanged.
            </span>
          </div>
        )}
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
        {actionUnavailableReason ? (
          <InlineNotice tone="warn">
            {actionUnavailableReason}
          </InlineNotice>
        ) : (
          configKeys.map((key) => {
            const required = requiredKeys.has(key)
            const label = CONFIG_FIELD_LABEL[key] ?? key
            const id = `automation-config-${key}`
            return (
              <Field key={key} label={label} htmlFor={id} required={required}>
                {key === 'cli' ? (
                  <Select
                    ariaLabel="Agent CLI"
                    value={form.config[key] ?? ''}
                    onChange={(value) => update('config', { ...form.config, [key]: value })}
                    items={automationCliSelectItems(form.config[key], cliCatalog)}
                  />
                ) : key === 'prompt' ? (
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

        {showAgentPicker ? (
          <>
            <Field label="Specialist" htmlFor="automation-config-specialistId" help="Run as a specialist agent, or a general agent.">
              <Select
                ariaLabel="Specialist"
                value={form.config.specialistId ?? ''}
                onChange={(value) => update('config', { ...form.config, specialistId: value })}
                items={specialistItems}
              />
            </Field>
            <Field label="Model" htmlFor="automation-config-cliModel" help="Model passed at launch; empty uses the CLI default.">
              <Select
                ariaLabel="Agent model"
                value={form.config.cliModel ?? ''}
                onChange={(value) => update('config', { ...form.config, cliModel: value })}
                items={modelItems}
              />
            </Field>
            <Field label="Permissions" htmlFor="automation-config-permissionPreset" help="Bypass skips CLI permission prompts — use only in trusted repos.">
              <div className="flex flex-wrap gap-1" role="group" aria-label="Permission preset">
                {AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => {
                  const current = form.config.permissionPreset || 'default'
                  const active = option.value === current
                  const isBypass = option.value === 'bypass_all'
                  return (
                    <Tooltip key={option.value} content={option.title}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => update('config', { ...form.config, permissionPreset: option.value })}
                        className={[
                          'rounded px-2 py-1 text-[11px] font-medium transition-colors',
                          active
                            ? isBypass
                              ? 'bg-[color:var(--tone-warn)]/12 text-[color:var(--tone-warn)]'
                              : 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                            : 'border border-[color:var(--border-strong)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]',
                        ].join(' ')}
                      >
                        {option.label}
                      </button>
                    </Tooltip>
                  )
                })}
              </div>
            </Field>
          </>
        ) : null}
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
