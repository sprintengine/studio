import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  DefinitionList,
  Field,
  GhostButton,
  InlineNotice,
  Input,
  PrimaryButton,
  Select,
  type SelectItem,
  Switch,
  Textarea,
} from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { selectAgentCliCatalog } from '../../workspace/newWorkspace/cliRuntimeOptions'
import { AutomationTypeGlyph } from './AutomationTypeGlyph'
import type { AgentCli, CliPermissionPreset } from '../../../types/workspace'
import { AUTOMATION_DEFAULT_PERMISSION_PRESET } from '../../../../../shared/automations/contracts'
import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationDefinitionPatch,
  AutomationsProviderView,
  AutomationsProviders,
  TriggerKind,
} from '../../../../../shared/automations/contracts'
import {
  EMPTY_WEBHOOK_FORM,
  WEBHOOK_TRIGGER_KIND,
  actionLabel,
  automationCliFieldError,
  isAuthorableTrigger,
  isScheduleConfig,
  missingProviderReason,
  providerUnavailableReason,
  resolveSubmitTrigger,
  shouldSendWebhookTrigger,
  triggersEquivalent,
  webhookFormFromConfig,
  webhookTriggerError,
  type EditorState,
  type ScheduleCadenceForm,
  type WebhookForm,
} from './automationsFormat'
import { ModelField, PermissionField } from './AgentFields'
import { AttachmentFields } from './AttachmentFields'
import { TriggerFields, selectedFamilyUnavailableReason } from './TriggerFields'

// Composes ScheduleCadenceForm (the authoritative cadence sub-state shape in
// automationsFormat.ts) so a new cadence field is declared exactly once.
type EditorFormState = ScheduleCadenceForm & {
  name: string
  enabled: boolean
  // Whether an agent-backed run executes in its own per-run worktree (isolation
  // from the user's checkout, and the prerequisite for opening a PR).
  runInWorktree: boolean
  // Run once, then pause: after one triggered fire the automation pauses itself;
  // re-enabling arms it again. Works for any trigger kind.
  disableAfterRun: boolean
  actionKind: string
  // Discriminates the active trigger family. Each family is authored from its own
  // sub-state below; resolveSubmitTrigger builds the trigger from the active one.
  triggerKind: TriggerKind
  webhook: WebhookForm
  config: Record<string, string>
}

// Action config keys the engine owns internally — never exposed as form fields
// and never loaded into the editable form.
const INTERNAL_CONFIG_KEYS = new Set(['workspaceId', 'folderPath', 'requiredIntegrations'])

// Keys owned by a dedicated picker control (the model, the permission preset,
// and the connector target). They are loaded into the form and persisted, but
// rendered by their picker rather than as generic free-text string fields.
const PICKER_CONFIG_KEYS = new Set(['cliModel', 'permissionPreset', 'connectorId', 'spawnSkillId'])

const CONFIG_FIELD_LABEL: Record<string, string> = {
  prompt: 'Prompt',
  cli: 'CLI',
  name: 'Agent name',
  skill: 'Skill',
  backlogItem: 'Backlog item',
}

// The control box is `ui/Input`, not a constant here. This file used to declare
// `CONTROL_BASE` and `TriggerFields.tsx` declared a literal duplicate of it,
// under comments in both files admitting the two were kept in sync by hand —
// which is the mechanism, not the exception. Its `h-7` was 28px, off
// the 26/30/34 ramp entirely; the kit's `sm` step is 30px.
// The name, edited in place as the page's own title (mockup §.head). The chrome
// is `Input variant="inline"` — the promoted `INLINE_TITLE_EDIT_CLASS`; what
// stays here is the type step, which is this surface's own decision.
const NAME_INPUT = 'text-title font-semibold tracking-tight text-[color:var(--text-strong)]'
// Auto-grows with its content (field-sizing: content) from the rows={4} floor up
// to a cap, then scrolls internally — no native drag handle. The `rows` attribute
// sets the minimum height; max-h caps the growth so the form stays usable.
// The prompt field grows with its content (field-sizing: content) from the
// rows={9} floor to a cap, then scrolls internally — no native drag handle,
// which is why it opts out of the kit's default `resize-y`.
const PROMPT_TEXTAREA = 'max-h-[280px] overflow-y-auto field-sizing-content'

/**
 * The runtime an agent-backed run will ACTUALLY launch on, in the launch's own
 * order of preference. An automation whose config names no cli is not
 * unconfigured: `launchAgent` (main's agent-launch-service.ts) falls back to the
 * last-selected CLI and fails loudly with `no_cli_selected` when there is none.
 * The editor reads the same order so it can never show a runtime the run would
 * not use — and never an empty picker on an enabled automation.
 *
 * Pure and exported so that order is provable: reading it off a rendered picker
 * proves only what the picker chose to display.
 */
export function resolveAutomationRuntimeCli(
  configuredCli: string | undefined,
  lastSelectedCli: string | undefined,
  catalog: ReadonlyArray<{ value: string }>,
): AgentCli {
  return (configuredCli?.trim() || lastSelectedCli?.trim() || catalog[0]?.value || 'claude-code') as AgentCli
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

// Whether the action's config schema exposes a given string field. Used to gate
// the connector picker on the same signal the agent block uses for `cli`: the
// control only renders for an action that actually consumes the key.
function schemaHasStringProp(schema: AutomationsProviderView['configSchema'], key: string): boolean {
  const properties = (schema as { properties?: Record<string, unknown> }).properties
  const prop = properties?.[key]
  return Boolean(prop) && typeof prop === 'object' && (prop as { type?: unknown }).type === 'string'
}

const EMPTY_FORM: EditorFormState = {
  name: '',
  enabled: true,
  runInWorktree: true,
  disableAfterRun: false,
  actionKind: '',
  triggerKind: 'schedule',
  cadenceType: 'interval',
  everyMinutes: 30,
  timeLocal: '09:00',
  daysOfWeek: [1, 2, 3, 4, 5],
  atDatetime: '',
  webhook: { ...EMPTY_WEBHOOK_FORM },
  config: {},
}

function initialFormState(editor: EditorState, providers: AutomationsProviders): EditorFormState {
  const firstAvailableAction = providers.actions.find((a) => !providerUnavailableReason(a)) ?? providers.actions[0]
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
    // Absent on existing definitions ⇒ true (they were always worktree runs).
    runInWorktree: def.runInWorktree ?? true,
    disableAfterRun: def.disableAfterRun ?? false,
    actionKind: def.action.kind,
    triggerKind: def.trigger.kind,
    cadenceType:
      cadence?.type === 'daily' || cadence?.type === 'weekly' || cadence?.type === 'at' ? cadence.type : 'interval',
    everyMinutes: cadence?.type === 'interval' ? cadence.everyMinutes : 30,
    timeLocal: cadence && (cadence.type === 'daily' || cadence.type === 'weekly') ? cadence.timeLocal : '09:00',
    daysOfWeek: cadence?.type === 'weekly' ? cadence.daysOfWeek : [1, 2, 3, 4, 5],
    atDatetime: cadence?.type === 'at' ? cadence.datetime : '',
    webhook:
      def.trigger.kind === WEBHOOK_TRIGGER_KIND ? webhookFormFromConfig(def.trigger.config) : { ...EMPTY_WEBHOOK_FORM },
    config,
  }
}

// Schema-driven create / edit form. The action's fields are derived from the
// selected provider's configSchema (providers:list); an action whose required
// integration is missing is disabled with an explicit unavailable state.
export function AutomationEditor({
  editor,
  providers,
  workspaceRoot,
  actionsSlot,
  onCancel,
  onSaved,
}: {
  editor: EditorState
  providers: AutomationsProviders | null
  workspaceRoot: string
  /**
   * Where Save/Cancel paint. Supplied by a host whose own chrome carries the
   * call to action — the Automations door, whose bar is info plus ONE CTA
   * (mockup 2026-07-30-automation-starter-editor §.canvas-bar). The form keeps
   * its save state and portals the buttons into `el`, so there is one save
   * affordance and one save path rather than a second copy in the host.
   * Omitted (the panel) renders them inline at the foot of the form. `el` is
   * null only for the brief settle before the host's slot attaches; the buttons
   * wait rather than flashing in at the foot and jumping.
   */
  actionsSlot?: { el: HTMLElement | null }
  onCancel: () => void
  onSaved: (saved: AutomationDefinition) => void
}) {
  const [form, setForm] = useState<EditorFormState>(() =>
    providers ? initialFormState(editor, providers) : EMPTY_FORM,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // This form's own id, so its Save button reaches it through the `form`
  // attribute even when the host paints that button outside the form's DOM (the
  // door bar). Per INSTANCE, not a constant: the door paints over the workspace,
  // so the door's editor and the panel's can be mounted at the same time, and a
  // shared literal id would point the door's Save at the panel's form.
  const formId = useId()

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
  const actionUnavailableReason = actionProvider
    ? providerUnavailableReason(actionProvider)
    : editor.mode === 'edit' && form.actionKind
      ? missingProviderReason(form.actionKind, 'action')
      : null
  const configKeys = actionProvider ? schemaStringKeys(actionProvider.configSchema) : []
  const requiredKeys = actionProvider ? schemaRequiredKeys(actionProvider.configSchema) : new Set<string>()

  // What the model group (AgentFields.tsx) renders from, resolved here because
  // the submit and the aside's Every-run facts read the same values: a group
  // holding its own copy could disagree with what actually gets saved.
  const lastSelectedCli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli)
  const selectedCli = resolveAutomationRuntimeCli(form.config.cli, lastSelectedCli, cliCatalog)
  const showAgentPicker = !actionUnavailableReason && configKeys.includes('cli')
  // An automation with no stored preset runs on the unattended default, so the
  // control shows that rather than "Default" — the editor must not read back a
  // preset the run will not use.
  const selectedPermissionPreset =
    (form.config.permissionPreset as CliPermissionPreset) || AUTOMATION_DEFAULT_PERMISSION_PRESET

  // A trigger paired with the action that feeds it defaults "Run once, then
  // pause" ON: left firing forever, an A↔B pair of these ping-pongs unbounded
  // (each landing re-fires the other). The default follows the selected pair
  // only until the user touches the toggle, so it stays a default, not a lock;
  // edit mode seeds the toggle from the stored definition and never re-applies
  // it here.
  const disableAfterRunTouchedRef = useRef(false)
  useEffect(() => {
    if (editor.mode !== 'create' || disableAfterRunTouchedRef.current) return
    const pairing = providers?.triggers.find((trigger) => trigger.kind === form.triggerKind)?.pairsWith
    const isChainPair = pairing?.actionKind === form.actionKind && pairing.defaultDisableAfterRun === true
    setForm((prev) => (prev.disableAfterRun === isChainPair ? prev : { ...prev, disableAfterRun: isChainPair }))
  }, [editor.mode, form.triggerKind, form.actionKind, providers])

  // The two attachments a run can carry, each shown only for an action whose
  // schema consumes it — and each persisted by the submit below, which is why
  // the flags live here rather than inside the group that renders them.
  const showSkillPicker =
    !actionUnavailableReason &&
    actionProvider != null &&
    schemaHasStringProp(actionProvider.configSchema, 'spawnSkillId')
  const showConnectorPicker =
    !actionUnavailableReason &&
    actionProvider != null &&
    schemaHasStringProp(actionProvider.configSchema, 'connectorId')
  // Provenance, stamped once by the install and never editable here:
  // the shelf entry this automation came from and who published it. It is how a
  // person tells a starter they added from something they wrote themselves.
  const sourceCatalogueId = editor.mode === 'edit' ? editor.definition.sourceCatalogueId?.trim() : undefined
  const sourcePublisher = editor.mode === 'edit' ? editor.definition.sourcePublisher?.trim() : undefined

  // What every run of this automation does, as facts rather than a second set of
  // fields (mockup §aside "Every run"). Each row is derived from the form, so
  // flipping "Run in worktree" restates the consequence here instead of the
  // switch carrying a parenthetical of its own. The plain-language read-back this
  // replaces said the cadence, agent and runtime a third time, beside the three
  // controls that set them.
  const everyRunFacts = useMemo(() => {
    const facts = [
      {
        term: 'Produces',
        description: form.runInWorktree
          ? 'A branch it can open a pull request from'
          : 'Changes in this project’s checkout',
      },
      {
        term: 'Isolation',
        description: form.runInWorktree ? 'Own worktree and branch' : 'This project’s checkout',
      },
    ]
    // Provenance the install stamps. The header names the publisher, so
    // this row names only where it came from — one fact each, not both twice.
    facts.push({
      term: 'Source',
      description: sourceCatalogueId ? 'Plugins shelf' : 'Written in this project',
    })
    return facts
  }, [form.runInWorktree, sourceCatalogueId])

  // A loaded cron schedule (or unknown third-party family) has no authoring
  // control — it is read-only and round-trips verbatim. Schedule and webhook
  // are authored from their own sub-state.
  const loadedTrigger = editor.mode === 'edit' ? editor.definition.trigger : null
  const triggerReadOnly = loadedTrigger ? !isAuthorableTrigger(loadedTrigger) : false
  const triggerUnavailableReason = triggerReadOnly ? null : selectedFamilyUnavailableReason(form.triggerKind, providers)

  const update = useCallback(<K extends keyof EditorFormState>(key: K, value: EditorFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  // How a field group reports a choice: the editor stays the one owner of the
  // form, so a group never holds a copy of the config it edits.
  const patchConfig = useCallback((patch: Record<string, string>) => {
    setForm((prev) => ({ ...prev, config: { ...prev.config, ...patch } }))
  }, [])
  // Cleared, not blanked: the key leaves the config so the run falls back to its
  // default rather than carrying an empty string the submit would have to strip.
  const clearConfigKey = useCallback((key: string) => {
    setForm((prev) => {
      const config = { ...prev.config }
      delete config[key]
      return { ...prev, config }
    })
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
  }, [
    editor.mode,
    triggerReadOnly,
    triggerUnavailableReason,
    form.triggerKind,
    form.webhook,
    builtTrigger,
    loadedTrigger,
  ])

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
      if (form.cadenceType === 'weekly' && form.daysOfWeek.length === 0)
        return 'Pick at least one day for a weekly schedule.'
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
  }, [
    form,
    actionProvider,
    actionUnavailableReason,
    requiredKeys,
    configKeys,
    cliCatalog,
    triggerReadOnly,
    triggerUnavailableReason,
    shouldSendTrigger,
  ])

  const handleSubmit = useCallback(async () => {
    if (validationError || !workspaceRoot) {
      setError(validationError)
      return
    }
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
      for (const key of ['cliModel', 'permissionPreset'] as const) {
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
    // Attached skill: persist spawnSkillId when one is chosen; a cleared choice
    // omits the key so the run launches with no attached skill.
    if (showSkillPicker) {
      const spawnSkillId = form.config.spawnSkillId?.trim()
      if (spawnSkillId) config.spawnSkillId = spawnSkillId
    }
    const draft: AutomationDefinitionDraft = {
      name: form.name.trim(),
      status: form.enabled ? 'enabled' : 'paused',
      runInWorktree: form.runInWorktree,
      disableAfterRun: form.disableAfterRun,
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
          runInWorktree: draft.runInWorktree,
          disableAfterRun: draft.disableAfterRun,
          action: draft.action,
        }
        // Omit an unchanged trigger so the engine preserves the stored webhook
        // secret (never sent to the renderer) and so a now-unregistered family
        // does not block an otherwise valid name/action edit.
        if (shouldSendTrigger) patch.trigger = draft.trigger
        result = await window.api.updateAutomation({ workspaceRoot, automationId: editor.definition.id, patch })
      }
      if (!result.ok) {
        setError(result.message)
        return
      }
      onSaved(result.value)
    } catch (err) {
      // A rejected IPC invoke would otherwise leave the form stuck on "Saving…".
      setError(err instanceof Error ? err.message : 'The automations service did not respond.')
    } finally {
      setSaving(false)
    }
  }, [
    validationError,
    workspaceRoot,
    configKeys,
    form,
    editor,
    onSaved,
    builtTrigger,
    shouldSendTrigger,
    showAgentPicker,
    showConnectorPicker,
    showSkillPicker,
  ])

  const actionItems: SelectItem[] = (providers?.actions ?? []).map((a) => ({
    value: a.kind,
    label: providerUnavailableReason(a)
      ? `${actionLabel(a.kind, providers)} — unavailable`
      : actionLabel(a.kind, providers),
    disabled: Boolean(providerUnavailableReason(a)),
  }))
  if (form.actionKind && !actionItems.some((item) => item.value === form.actionKind)) {
    actionItems.push({
      value: form.actionKind,
      label: `${actionLabel(form.actionKind, providers)} — unavailable`,
      disabled: true,
    })
  }

  // Save and Cancel. One pair, wherever they paint: at the foot of the form in a
  // panel, or portaled into the host's bar (the Automations door, mockup
  // §.canvas-bar). The submit stays a real submit, so Enter in a field and the
  // button reach the same `handleSubmit`.
  const actions = (
    <>
      <PrimaryButton type="submit" form={formId} disabled={saving || validationError !== null}>
        {saving ? 'Saving…' : editor.mode === 'create' ? 'Create automation' : 'Save'}
      </PrimaryButton>
      <GhostButton type="button" onClick={onCancel}>
        Cancel
      </GhostButton>
    </>
  )

  return (
    <form
      id={formId}
      // The two columns key off THIS form's width, not the viewport: the same
      // editor is the door's full canvas and a narrow workspace panel, and only
      // the container knows which.
      className="@container flex flex-col gap-5 px-6 py-5"
      onSubmit={(e) => {
        e.preventDefault()
        void handleSubmit()
      }}
    >
      {/* Head (§.head): the mark, the name edited in place, and — for something
          that came from the shelf — who published it, so a starter is
          distinguishable from an automation written here. */}
      <div className="flex items-start gap-3">
        <span className="mt-1.5 flex items-center">
          <AutomationTypeGlyph
            kind={form.actionKind}
            glyph={actionProvider?.glyph}
            label={actionLabel(form.actionKind, providers)}
          />
        </span>
        <div className="min-w-0 flex-1">
          <Input
            id="automation-name"
            variant="inline"
            aria-label="Name"
            aria-required="true"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder={editor.mode === 'create' ? 'Name this automation' : ''}
            className={NAME_INPUT}
          />
          {sourcePublisher ? (
            <div className="mt-0.5 truncate text-meta text-[color:var(--text-muted)]">{sourcePublisher}</div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-x-8 gap-y-6 @[720px]:grid-cols-[minmax(0,1fr)_260px] @[720px]:items-start">
        <div className="flex min-w-0 flex-col gap-4">
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
            <InlineNotice tone="warn">{actionUnavailableReason}</InlineNotice>
          ) : (
            <>
              <ModelField
                show={showAgentPicker}
                config={form.config}
                cliCatalog={cliCatalog}
                selectedCli={selectedCli}
                onPatchConfig={patchConfig}
              />

              {/* Runs and Permission (§.duo): when it fires, and what it may do
                  while nobody is watching. */}
              <div className="grid gap-3 @[520px]:grid-cols-2 @[520px]:items-start">
                <TriggerFields
                  editor={editor}
                  providers={providers}
                  value={form}
                  onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
                />
                <PermissionField
                  show={showAgentPicker}
                  value={selectedPermissionPreset}
                  onChange={(preset) => patchConfig({ permissionPreset: preset })}
                />
              </div>

              {/* The action's own fields (§.field prompt). The prompt is where
                  reviewer-vs-fixer intent lives now that the autonomy control is
                  retired, so it gets the room to say so. */}
              {configKeys
                .filter((key) => key !== 'cli')
                .map((key) => {
                  const required = requiredKeys.has(key)
                  const label = CONFIG_FIELD_LABEL[key] ?? key
                  const id = `automation-config-${key}`
                  return (
                    <Field key={key} label={label} htmlFor={id} required={required}>
                      {key === 'prompt' ? (
                        <Textarea
                          id={id}
                          rows={9}
                          value={form.config[key] ?? ''}
                          onChange={(e) => update('config', { ...form.config, [key]: e.target.value })}
                          placeholder="Review the changes on this repo and summarise risks."
                          resize="none"
                          className={PROMPT_TEXTAREA}
                        />
                      ) : (
                        <Input
                          id={id}
                          value={form.config[key] ?? ''}
                          onChange={(e) => update('config', { ...form.config, [key]: e.target.value })}
                        />
                      )}
                    </Field>
                  )
                })}
            </>
          )}
        </div>

        {/* The aside (§aside): what every run does, stated as facts rather than a
            second set of fields; what can ride along with it; and the switches
            that decide how it runs and whether it runs at all. */}
        <aside className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h3 className="text-meta text-[color:var(--text-subtle)]">Every run</h3>
            <DefinitionList items={everyRunFacts} />
          </div>

          <AttachmentFields
            showSkillPicker={showSkillPicker}
            showConnectorPicker={showConnectorPicker}
            workspaceRoot={workspaceRoot}
            spawnSkillId={form.config.spawnSkillId}
            connectorId={form.config.connectorId}
            onPatchConfig={patchConfig}
            onClearConfigKey={clearConfigKey}
          />

          <div className="flex flex-col gap-2.5">
            <label
              htmlFor="automation-worktree"
              className="flex items-center gap-2.5 text-meta text-[color:var(--text-default)]"
            >
              <Switch
                id="automation-worktree"
                checked={form.runInWorktree}
                onChange={(next) => update('runInWorktree', next)}
                ariaLabel="Run the agent in an isolated git worktree"
              />
              Run in worktree
            </label>
            <label
              htmlFor="automation-run-once"
              className="flex items-center gap-2.5 text-meta text-[color:var(--text-default)]"
            >
              <Switch
                id="automation-run-once"
                checked={form.disableAfterRun}
                onChange={(next) => {
                  // Mark the toggle user-owned so the chain default effect stops
                  // overriding it, then apply the choice.
                  disableAfterRunTouchedRef.current = true
                  update('disableAfterRun', next)
                }}
                ariaLabel="Run once, then pause this automation"
              />
              Run once, then pause
            </label>
            <label
              htmlFor="automation-enabled"
              className="flex items-center gap-2.5 text-meta text-[color:var(--text-default)]"
            >
              <Switch
                id="automation-enabled"
                checked={form.enabled}
                onChange={(next) => update('enabled', next)}
                ariaLabel="Enable this automation"
              />
              Enabled
            </label>
          </div>
        </aside>
      </div>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {validationError ? <p className="text-micro text-[color:var(--text-subtle)]">{validationError}</p> : null}

      {/* One pair of buttons: in the host's bar when it offers a slot, at the
          foot of the form when it does not. */}
      {actionsSlot ? (
        actionsSlot.el && createPortal(actions, actionsSlot.el)
      ) : (
        <div className="flex items-center gap-2">{actions}</div>
      )}
    </form>
  )
}
