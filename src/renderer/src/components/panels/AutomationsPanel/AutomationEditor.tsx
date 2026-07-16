import { useCallback, useEffect, useMemo, useState } from 'react'

import { CliModelPickerButton, Field, GhostButton, InlineNotice, Popover, PrimaryButton, Select, type SelectItem, Switch } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { selectAgentCliCatalog } from '../../workspace/newWorkspace/cliRuntimeOptions'
import { orderSpecialistActions } from '../../../specialists/specialistActions'
import { listSpecialistPacks, resolveEnabledSpecialists } from '../../../specialists/specialistPacks'
import AgentComposerPopover from '../../workspace/agentComposer/AgentComposerPopover'
import type { AgentComposerSelection } from '../../workspace/agentComposer/AgentComposer'
import { PermissionPresetChips } from '../../workspace/agentComposer/agentSpawnShared'
import { SpecialistActionIcon } from '../../AppIcons'
import type { AgentCli, McpCatalogServer, SpecialistActionId, SprintEngineCliPermissionPreset } from '../../../types/workspace'
import { launchableConnectors } from '../ConnectorsPanel/connectorsFacets'
import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationDefinitionPatch,
  AutomationsProviderView,
  AutomationsProviders,
  TriggerKind,
} from '../../../../../shared/automations/contracts'
import {
  formatAtDatetime,
  EMPTY_REPO_EVENT_FORM,
  EMPTY_WEBHOOK_FORM,
  REPO_EVENT_TRIGGER_KIND,
  WEBHOOK_TRIGGER_KIND,
  actionLabel,
  automationCliFieldError,
  isAuthorableTrigger,
  isScheduleConfig,
  providerUnavailableReason,
  repoEventFormFromConfig,
  resolveSubmitTrigger,
  shouldSendWebhookTrigger,
  triggersEquivalent,
  webhookFormFromConfig,
  webhookTriggerError,
  type EditorState,
  type RepoEventForm,
  type ScheduleCadenceForm,
  type WebhookForm,
} from './automationsFormat'
import { TriggerFields, selectedFamilyUnavailableReason } from './TriggerFields'

// Composes ScheduleCadenceForm (the authoritative cadence sub-state shape in
// automationsFormat.ts) so a new cadence field is declared exactly once.
type EditorFormState = ScheduleCadenceForm & {
  name: string
  enabled: boolean
  autonomy: AutomationDefinition['autonomyDefault']
  // Whether an agent-backed run executes in its own per-run worktree (isolation
  // from the user's checkout, and the prerequisite for opening a PR).
  runInWorktree: boolean
  actionKind: string
  // Discriminates the active trigger family. Each family is authored from its own
  // sub-state below; resolveSubmitTrigger builds the trigger from the active one.
  triggerKind: TriggerKind
  repoEvent: RepoEventForm
  webhook: WebhookForm
  config: Record<string, string>
}

// Action config keys the engine owns internally — never exposed as form fields
// and never loaded into the editable form.
const INTERNAL_CONFIG_KEYS = new Set(['workspaceId', 'folderPath', 'requiredIntegrations'])

// Keys owned by a dedicated picker control (agent specialist / model / permission,
// and the connector target). They are loaded into the form and persisted, but
// rendered by their picker rather than as generic free-text string fields.
const PICKER_CONFIG_KEYS = new Set(['cliModel', 'permissionPreset', 'specialistId', 'connectorId'])

// Sentinel option value for "target no connector" — the Select emits a string, so
// the cleared choice is a real item rather than null, and it maps back to removing
// the connectorId key from the action config on submit.
const NO_CONNECTOR = ''

const CONFIG_FIELD_LABEL: Record<string, string> = {
  prompt: 'Prompt',
  cli: 'CLI',
  name: 'Agent name',
  skill: 'Skill',
}

// One control box vocabulary shared by every text input and the Select trigger
// (h-7, 5px radius, --border-default on --bg-surface-raised) so inputs and
// dropdowns read as one family instead of two. See TriggerFields.INPUT_CLASS,
// kept in sync.
const CONTROL_BASE =
  'w-full rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[12px] text-[color:var(--text-default)] outline-none transition-colors hover:border-[color:var(--border-strong)] focus-visible:border-[color:var(--accent-primary)]'
const CONTROL_INPUT = `${CONTROL_BASE} h-7 px-2.5`
// Auto-grows with its content (field-sizing: content) from the rows={4} floor up
// to a cap, then scrolls internally — no native drag handle. The `rows` attribute
// sets the minimum height; max-h caps the growth so the form stays usable.
const CONTROL_TEXTAREA = `${CONTROL_BASE} max-h-[280px] resize-none overflow-y-auto field-sizing-content px-2.5 py-1.5 leading-5`

// Stable empty fallbacks so the roster store selectors don't churn refs per render.
const EMPTY_SPECIALIST_ORDER: SpecialistActionId[] = []
const EMPTY_DISABLED_PACKS: string[] = []

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

// Whether the action's config schema exposes a given string field. Used to gate
// the connector picker on the same signal the agent block uses for `cli`: the
// control only renders for an action that actually consumes the key.
function schemaHasStringProp(schema: AutomationsProviderView['configSchema'], key: string): boolean {
  const properties = (schema as { properties?: Record<string, unknown> }).properties
  const prop = properties?.[key]
  return Boolean(prop) && typeof prop === 'object' && (prop as { type?: unknown }).type === 'string'
}

// A launchable connector follows connectorsFacets.connectorCanLaunch — a
// catalog entry carrying a `skill` link, or any server installed (enabled) in
// MCP settings; the picker population comes from the shared
// launchableConnectors so it cannot drift from the Connectors surface. The
// load carries the raw catalog so the installed merge happens reactively in
// the picker memo; it is undefined-free so a catalog failure renders an
// explicit notice (installed servers still list — they launch without the
// catalog) rather than a silently empty picker.
type ConnectorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; connectors: McpCatalogServer[] }

const EMPTY_FORM: EditorFormState = {
  name: '', enabled: true, autonomy: 'review_only', runInWorktree: true, actionKind: '', triggerKind: 'schedule',
  cadenceType: 'interval', everyMinutes: 30, timeLocal: '09:00', daysOfWeek: [1, 2, 3, 4, 5], atDatetime: '',
  repoEvent: { ...EMPTY_REPO_EVENT_FORM }, webhook: { ...EMPTY_WEBHOOK_FORM }, config: {},
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
  // Each family's sub-state seeds from the loaded config. Inactive families stay
  // at their defaults; resolveSubmitTrigger only reads the active family (and a
  // read-only cron schedule round-trips verbatim).
  return {
    name: def.name,
    enabled: def.status !== 'paused',
    autonomy: def.autonomyDefault,
    // Absent on existing definitions ⇒ true (they were always worktree runs).
    runInWorktree: def.runInWorktree ?? true,
    actionKind: def.action.kind,
    triggerKind: def.trigger.kind,
    cadenceType: cadence?.type === 'daily' || cadence?.type === 'weekly' || cadence?.type === 'at' ? cadence.type : 'interval',
    everyMinutes: cadence?.type === 'interval' ? cadence.everyMinutes : 30,
    timeLocal: cadence && (cadence.type === 'daily' || cadence.type === 'weekly') ? cadence.timeLocal : '09:00',
    daysOfWeek: cadence?.type === 'weekly' ? cadence.daysOfWeek : [1, 2, 3, 4, 5],
    atDatetime: cadence?.type === 'at' ? cadence.datetime : '',
    repoEvent: def.trigger.kind === REPO_EVENT_TRIGGER_KIND
      ? repoEventFormFromConfig(def.trigger.config)
      : { ...EMPTY_REPO_EVENT_FORM },
    webhook: def.trigger.kind === WEBHOOK_TRIGGER_KIND
      ? webhookFormFromConfig(def.trigger.config)
      : { ...EMPTY_WEBHOOK_FORM },
    config,
  }
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
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)

  // The cli config field is constrained to the same agent-picker catalog the
  // shared composer uses (T2 plugin registry), not a new hardcoded list, so an
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

  // The agent block reuses the shared AgentComposerPopover (select mode) for the
  // specialist + permission preset, and CliModelPickerButton for the runtime —
  // the same components every spawn surface uses — so the picker never drifts.
  // The choice is persisted into the action config so a scheduled run reproduces it.
  // Resolve the specialist descriptor from the SAME enabled-pack roster the
  // embedded picker offers, so a custom-pack specialist the picker can select
  // also labels correctly on the trigger row (not just the built-in set).
  const specialistOrder = useWorkspaceStore((s) => s.appSettings.specialistOrder ?? EMPTY_SPECIALIST_ORDER)
  const disabledSpecialistPacks = useWorkspaceStore((s) => s.appSettings.specialistPacks?.disabled ?? EMPTY_DISABLED_PACKS)
  const sprintEngineRoleRegistry = useWorkspaceStore((s) => s.sprintEngineRoleRegistry)
  const specialistRoster = useMemo(
    () => orderSpecialistActions(
      specialistOrder,
      resolveEnabledSpecialists(disabledSpecialistPacks, listSpecialistPacks(sprintEngineRoleRegistry)),
    ),
    [specialistOrder, disabledSpecialistPacks, sprintEngineRoleRegistry],
  )
  const selectedSpecialist = form.config.specialistId
    ? specialistRoster.find((action) => action.id === form.config.specialistId) ?? null
    : null
  const selectedCli = (form.config.cli || cliCatalog[0]?.value || 'claude-code') as AgentCli
  const selectedCliLabel = cliCatalog.find((option) => option.value === selectedCli)?.label ?? selectedCli
  const showAgentPicker = !actionUnavailableReason && configKeys.includes('cli')

  // Connector target — a spawn-agent run can be pinned to a connector (its
  // isolated worktree + MCP, plus the driving skill when the catalog pairs one).
  // The picker is populated from the real MCP catalog and the installed MCP
  // settings, never a placeholder list, and shown only for an action whose
  // schema consumes `connectorId`.
  const showConnectorPicker =
    !actionUnavailableReason && actionProvider != null && schemaHasStringProp(actionProvider.configSchema, 'connectorId')
  const [connectorLoad, setConnectorLoad] = useState<ConnectorLoad>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    if (typeof window.api.mcpListCatalog !== 'function') {
      setConnectorLoad({ status: 'error', message: 'Connectors need an app restart before they are available.' })
      return () => { cancelled = true }
    }
    void window.api.mcpListCatalog().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setConnectorLoad({ status: 'ready', connectors: result.servers })
      } else {
        setConnectorLoad({ status: 'error', message: result.message })
      }
    }).catch((error) => {
      if (!cancelled) {
        setConnectorLoad({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to load the connector catalog.',
        })
      }
    })
    return () => { cancelled = true }
  }, [])

  const selectedConnectorId = form.config.connectorId ?? NO_CONNECTOR
  const installedMcpServers = useWorkspaceStore((s) => s.appSettings.mcp?.servers)
  const connectorItems: SelectItem[] = useMemo(() => {
    const items: SelectItem[] = [{ value: NO_CONNECTOR, label: 'No connector' }]
    if (connectorLoad.status !== 'loading') {
      // A failed catalog load still lists the installed servers — they launch
      // without the catalog.
      const catalog = connectorLoad.status === 'ready' ? connectorLoad.connectors : []
      for (const server of launchableConnectors(catalog, installedMcpServers)) {
        items.push({ value: server.id, label: server.name })
      }
    }
    // A stored connector no longer in the catalog still round-trips and is shown
    // as unavailable (once the catalog has resolved) rather than silently dropped.
    if (selectedConnectorId && !items.some((item) => item.value === selectedConnectorId)) {
      const resolved = connectorLoad.status === 'ready'
      items.push({
        value: selectedConnectorId,
        label: resolved ? `${selectedConnectorId} — unavailable` : selectedConnectorId,
        tone: resolved ? 'warn' : undefined,
      })
    }
    return items
  }, [connectorLoad, selectedConnectorId, installedMcpServers])

  const onSelectConnector = useCallback((value: string) => {
    setForm((prev) => {
      const config = { ...prev.config }
      if (value) config.connectorId = value
      else delete config.connectorId
      return { ...prev, config }
    })
  }, [])

  // Plain-language read-back of the whole automation (altitude / friendliness):
  // shown only for the scheduled spawn-agent shape it describes.
  const scheduleReadback =
    showAgentPicker && form.triggerKind === 'schedule'
      ? `Runs ${
          form.cadenceType === 'interval'
            ? `every ${form.everyMinutes} min`
            : form.cadenceType === 'at'
              ? `once at ${form.atDatetime ? formatAtDatetime(form.atDatetime) : '…'}`
              : `${form.cadenceType === 'weekly' ? 'weekly' : 'daily'} at ${form.timeLocal}`
        }, ${selectedSpecialist ? `spawns ${selectedSpecialist.shortLabel}` : 'runs a general agent'} on ${selectedCliLabel}.`
      : null

  // A loaded cron schedule (or unknown third-party family) has no authoring
  // control — it is read-only and round-trips verbatim. Schedule/repo-event/
  // webhook are authored from their own sub-state.
  const loadedTrigger = editor.mode === 'edit' ? editor.definition.trigger : null
  const triggerReadOnly = loadedTrigger ? !isAuthorableTrigger(loadedTrigger) : false
  const triggerUnavailableReason = triggerReadOnly
    ? null
    : selectedFamilyUnavailableReason(form.triggerKind, providers)

  const update = useCallback(<K extends keyof EditorFormState>(key: K, value: EditorFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const builtTrigger = useMemo(
    () => resolveSubmitTrigger(editor, form, Intl.DateTimeFormat().resolvedOptions().timeZone),
    [editor, form],
  )

  // An edit writes the trigger patch unless it can be safely omitted: an unchanged
  // webhook (preserves the stored secret the renderer can't read) or an unchanged
  // family whose provider is no longer registered (lets the rest of the row save).
  const shouldSendTrigger = useMemo((): boolean => {
    if (editor.mode === 'create') return true
    if (triggerReadOnly) return false
    if (form.triggerKind === WEBHOOK_TRIGGER_KIND) {
      return shouldSendWebhookTrigger(form.webhook, loadedTrigger?.config)
    }
    if (triggerUnavailableReason) return !triggersEquivalent(builtTrigger, loadedTrigger)
    return true
  }, [editor.mode, triggerReadOnly, triggerUnavailableReason, form.triggerKind, form.webhook, builtTrigger, loadedTrigger])

  const validationError = useMemo((): string | null => {
    if (!form.name.trim()) return 'Give the automation a name.'
    if (!actionProvider) return 'No action provider is available.'
    if (actionUnavailableReason) return actionUnavailableReason
    // Trigger family. An unavailable family cannot run, so block saving it active;
    // and a new trigger config cannot be written against a missing provider.
    if (triggerUnavailableReason) {
      if (form.enabled) return `${triggerUnavailableReason} Disable it to save.`
      if (shouldSendTrigger) return triggerUnavailableReason
    }
    if (!triggerReadOnly && form.triggerKind === WEBHOOK_TRIGGER_KIND) {
      const webhookError = webhookTriggerError(form.webhook, { sendingTrigger: shouldSendTrigger })
      if (webhookError) return webhookError
    }
    if (!triggerReadOnly && form.triggerKind === 'schedule') {
      if (form.cadenceType === 'interval' && form.everyMinutes < 5) return 'Interval must be at least 5 minutes.'
      if (form.cadenceType === 'weekly' && form.daysOfWeek.length === 0) return 'Pick at least one day for a weekly schedule.'
      if (form.cadenceType === 'at' && !form.atDatetime.trim()) return 'Pick a date and time for a one-time schedule.'
    }
    if (configKeys.includes('cli')) {
      const cliError = automationCliFieldError(form.config.cli, cliCatalog)
      if (cliError) return cliError
    }
    for (const key of requiredKeys) {
      if (INTERNAL_CONFIG_KEYS.has(key)) continue
      if (!form.config[key]?.trim()) return `${CONFIG_FIELD_LABEL[key] ?? key} is required.`
    }
    return null
  }, [form, actionProvider, actionUnavailableReason, requiredKeys, configKeys, cliCatalog, triggerReadOnly, triggerUnavailableReason, shouldSendTrigger])

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
    // Connector target: persist connectorId when one is selected; a cleared choice
    // (No connector) simply omits the key so the run falls back to the default.
    if (showConnectorPicker) {
      const connectorId = form.config.connectorId?.trim()
      if (connectorId) config.connectorId = connectorId
    }
    const draft: AutomationDefinitionDraft = {
      name: form.name.trim(),
      status: form.enabled ? 'enabled' : 'paused',
      autonomyDefault: form.autonomy,
      runInWorktree: form.runInWorktree,
      // Built from the active family (a read-only cron schedule round-trips verbatim).
      trigger: builtTrigger,
      action: { kind: form.actionKind, config },
    }
    try {
      let result
      if (editor.mode === 'create') {
        result = await window.api.createAutomation({ workspaceRoot, definition: draft })
      } else {
        const patch: AutomationDefinitionPatch = {
          name: draft.name,
          status: draft.status,
          autonomyDefault: draft.autonomyDefault,
          runInWorktree: draft.runInWorktree,
          action: draft.action,
        }
        // Omit an unchanged trigger so the engine preserves the stored webhook
        // secret (never sent to the renderer) and so a now-unregistered family
        // does not block an otherwise valid name/action edit.
        if (shouldSendTrigger) patch.trigger = draft.trigger
        result = await window.api.updateAutomation({ workspaceRoot, automationId: editor.definition.id, patch })
      }
      if (!result.ok) { setError(result.message); return }
      onSaved(result.value)
    } catch (err) {
      // A rejected IPC invoke would otherwise leave the form stuck on "Saving…".
      setError(err instanceof Error ? err.message : 'The automations service did not respond.')
    } finally {
      setSaving(false)
    }
  }, [validationError, workspaceRoot, configKeys, form, editor, onSaved, builtTrigger, shouldSendTrigger, showAgentPicker, showConnectorPicker])

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
          className={CONTROL_INPUT}
        />
      </Field>
      {scheduleReadback ? (
        <p className="-mt-1 text-[11px] text-[color:var(--text-subtle)]">{scheduleReadback}</p>
      ) : null}

      <TriggerFields
        editor={editor}
        providers={providers}
        value={form}
        onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
      />

      {/* Action — schema-driven from providers:list. */}
      <fieldset className="flex flex-col gap-3">
        <legend className="text-[11px] font-medium text-[color:var(--text-muted)]">Action</legend>
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
          <>
            {/* Agent block — the live spawn picker (select mode) for the specialist
                + permission preset and CliModelPickerButton for the runtime, reused
                from the top-bar spawn menu instead of bespoke flat dropdowns. */}
            {showAgentPicker ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-[color:var(--text-default)]">Agent</span>
                <div className="overflow-hidden rounded-lg border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)]">
                  <Popover
                    open={agentPickerOpen}
                    onOpenChange={setAgentPickerOpen}
                    ariaLabel="Choose agent"
                    popupRole="menu"
                    placement="bottom-start"
                    renderTrigger={({ ref, triggerProps, togglePopover }) => (
                      <button
                        ref={ref}
                        type="button"
                        aria-label="Choose agent"
                        onClick={togglePopover}
                        className="grid w-full grid-cols-[24px_1fr_auto] items-center gap-3 px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--bg-hover)]"
                        {...triggerProps}
                      >
                        <span className="flex h-6 w-6 items-center justify-center text-[color:var(--text-muted)]">
                          {selectedSpecialist ? (
                            <SpecialistActionIcon icon={selectedSpecialist.icon} className="h-4 w-4" />
                          ) : (
                            <svg className="icon-md" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.7" />
                              <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                            </svg>
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-[color:var(--text-strong)]">
                            {selectedSpecialist ? selectedSpecialist.shortLabel : 'General agent'}
                          </span>
                          <span className="block truncate text-[11px] text-[color:var(--text-subtle)]">
                            {selectedSpecialist ? selectedSpecialist.description : 'No soul — runs the prompt as written'}
                          </span>
                        </span>
                        <svg className="icon-sm shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    )}
                  >
                    <AgentComposerPopover
                      roster="specialist"
                      conversationAvailable={false}
                      initialSelection={
                        (form.config.specialistId
                          ? { kind: 'specialist', specialistId: form.config.specialistId as SpecialistActionId }
                          : { kind: 'general' }) as AgentComposerSelection
                      }
                      action={{
                        kind: 'select',
                        selectedSpecialistId: (form.config.specialistId as SpecialistActionId) || null,
                        cli: selectedCli,
                        model: form.config.cliModel || undefined,
                        onSelectSpecialist: (id, cli, model) =>
                          setForm((prev) => ({ ...prev, config: { ...prev.config, specialistId: id, cli, cliModel: model ?? '' } })),
                        onSelectGeneral: (cli, model) =>
                          setForm((prev) => ({ ...prev, config: { ...prev.config, specialistId: '', cli, cliModel: model ?? '' } })),
                        permissionPreset: (form.config.permissionPreset as SprintEngineCliPermissionPreset) || 'default',
                        onChangePermissionPreset: (preset) => update('config', { ...form.config, permissionPreset: preset }),
                      }}
                      onClose={() => setAgentPickerOpen(false)}
                    />
                  </Popover>
                  {/* flex-wrap: in a narrow pane the permissions group drops to
                      its own line instead of the Bypass chip clipping invisibly. */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[color:var(--border-subtle)] px-2.5 py-2">
                    <span className="text-[11px] text-[color:var(--text-subtle)]">Runtime</span>
                    <CliModelPickerButton
                      ariaLabel="Agent runtime"
                      options={cliCatalog}
                      cli={selectedCli}
                      effectiveModelFor={(candidate) => (candidate === selectedCli ? form.config.cliModel || undefined : undefined)}
                      onSelectCli={(cli) => update('config', { ...form.config, cli, cliModel: '' })}
                      onSelectModel={(cli, model) => update('config', { ...form.config, cli, cliModel: model ?? '' })}
                    />
                    {/* Inline preset chips (not a read-only summary): permissions
                        must be settable without diving into the picker popover. */}
                    <div className="ml-auto flex items-center gap-1">
                      <span className="text-[11px] text-[color:var(--text-subtle)]">Permissions</span>
                      <PermissionPresetChips
                        value={(form.config.permissionPreset as SprintEngineCliPermissionPreset) || 'default'}
                        onChange={(preset) => update('config', { ...form.config, permissionPreset: preset })}
                      />
                    </div>
                  </div>
                </div>
                <span className="text-[11px] text-[color:var(--text-subtle)]">Same team, runtimes, and permission presets as the spawn menu.</span>
              </div>
            ) : null}

            {/* Connector target — pins the run to a connector's isolated worktree
                + MCP (plus its driving skill when the catalog pairs one).
                Defaults to "No connector" (workspace run). Mirrors the agent
                block's label/control/helper rhythm; the Select's ariaLabel
                carries the accessible name. */}
            {showConnectorPicker ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-[color:var(--text-default)]">Connector</span>
                <Select
                  ariaLabel="Connector"
                  value={selectedConnectorId}
                  onChange={onSelectConnector}
                  items={connectorItems}
                  disabled={connectorLoad.status === 'loading'}
                  placeholder={connectorLoad.status === 'loading' ? 'Loading connectors…' : 'No connector'}
                />
                {connectorLoad.status === 'error' ? (
                  <InlineNotice tone="warn">Connectors are unavailable: {connectorLoad.message}</InlineNotice>
                ) : (
                  <span className="text-[11px] text-[color:var(--text-subtle)]">
                    {connectorLoad.status === 'ready' && connectorItems.length === 1
                      ? 'No connectors installed — the run uses the workspace defaults.'
                      : 'Runs the agent against this connector’s isolated worktree and MCP server.'}
                  </span>
                )}
              </div>
            ) : null}

            {configKeys.filter((key) => key !== 'cli').map((key) => {
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
                      className={CONTROL_TEXTAREA}
                    />
                  ) : (
                    <input
                      id={id}
                      type="text"
                      value={form.config[key] ?? ''}
                      onChange={(e) => update('config', { ...form.config, [key]: e.target.value })}
                      className={CONTROL_INPUT}
                    />
                  )}
                </Field>
              )
            })}
          </>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        {/* Run-config toggles grouped together on the left; lifecycle (Enabled) on
            the right. Keeps related controls adjacent instead of spread edge-to-edge. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
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
          <label htmlFor="automation-worktree" className="flex items-center gap-2 text-[12px] text-[color:var(--text-default)]">
            <Switch
              id="automation-worktree"
              checked={form.runInWorktree}
              onChange={(next) => update('runInWorktree', next)}
              ariaLabel="Run the agent in an isolated git worktree"
            />
            Run in worktree
            <span className="text-[11px] text-[color:var(--text-subtle)]">{form.runInWorktree ? '(isolated branch; can open a PR)' : '(runs in the workspace checkout; no PR)'}</span>
          </label>
        </div>
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
