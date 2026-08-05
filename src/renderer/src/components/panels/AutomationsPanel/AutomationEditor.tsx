import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { CliModelPickerButton, DefinitionList, Field, GhostButton, INLINE_TITLE_EDIT_CLASS, InlineNotice, Input, Popover, PrimaryButton, Select, type SelectItem, Switch, Textarea } from '../../ui'
import { SkillPickerPopover } from '../../ui/SkillPickerPopover'
import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { selectAgentCliCatalog } from '../../workspace/newWorkspace/cliRuntimeOptions'
import { orderSpecialistActions } from '../../../specialists/specialistActions'
import { listSpecialistPacks, resolveEnabledSpecialists } from '../../../specialists/specialistPacks'
import AgentComposerPopover from '../../workspace/agentComposer/AgentComposerPopover'
import type { AgentComposerSelection } from '../../workspace/agentComposer/AgentComposer'
import { SpecialistActionIcon } from '../../AppIcons'
import { AutomationTypeGlyph } from './AutomationTypeGlyph'
import type { AgentCli, McpCatalogServer, SpecialistActionId, SprintEngineCliPermissionPreset } from '../../../types/workspace'
import { launchableConnectors } from '../ConnectorsPanel/connectorsFacets'
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
  EMPTY_REPO_EVENT_FORM,
  EMPTY_SPRINT_LANDED_FORM,
  EMPTY_WEBHOOK_FORM,
  REPO_EVENT_TRIGGER_KIND,
  SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
  WEBHOOK_TRIGGER_KIND,
  actionLabel,
  automationCliFieldError,
  isAuthorableTrigger,
  isScheduleConfig,
  providerUnavailableReason,
  repoEventFormFromConfig,
  resolveSubmitTrigger,
  shouldSendWebhookTrigger,
  sprintLandedFormFromConfig,
  triggersEquivalent,
  webhookFormFromConfig,
  webhookTriggerError,
  type EditorState,
  type RepoEventForm,
  type ScheduleCadenceForm,
  type SprintLandedForm,
  type WebhookForm,
} from './automationsFormat'
import { TriggerFields, selectedFamilyUnavailableReason } from './TriggerFields'
import { BacklogItemSearchPicker, type BacklogItemSearchOption } from '../../backlog/BacklogItemSearchPicker'
import { useBacklogScan } from '../../workspace/newWorkspace/useBacklogScan'
import type { SprintEngineRoster } from '../../../types/workspace'

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
  repoEvent: RepoEventForm
  webhook: WebhookForm
  sprintLanded: SprintLandedForm
  config: Record<string, string>
}

// Action config keys the engine owns internally — never exposed as form fields
// and never loaded into the editable form.
const INTERNAL_CONFIG_KEYS = new Set(['workspaceId', 'folderPath', 'requiredIntegrations'])

// Keys owned by a dedicated picker control (agent specialist / model / permission,
// and the connector target). They are loaded into the form and persisted, but
// rendered by their picker rather than as generic free-text string fields.
const PICKER_CONFIG_KEYS = new Set(['cliModel', 'permissionPreset', 'specialistId', 'connectorId', 'spawnSkillId'])

// Sentinel option value for "target no connector" — the Select emits a string, so
// the cleared choice is a real item rather than null, and it maps back to removing
// the connectorId key from the action config on submit.
const NO_CONNECTOR = ''

const CONFIG_FIELD_LABEL: Record<string, string> = {
  prompt: 'Prompt',
  cli: 'CLI',
  name: 'Agent name',
  skill: 'Skill',
  backlogItem: 'Backlog item',
  sprintName: 'Sprint name',
  team: 'Team',
}

// The permission field's options. Each label states the preset and what it means
// for a run nobody is watching — the control text is the state, so an automation
// on the unattended default reads "Bypass all — runs unattended" without a
// caption explaining it. Bypass carries the warn tone, as it does everywhere else.
const PERMISSION_PRESET_ITEMS: SelectItem<SprintEngineCliPermissionPreset>[] = [
  { value: 'default', label: 'Default — asks before acting' },
  { value: 'auto_workspace', label: 'Auto in workspace — fewer prompts' },
  { value: 'bypass_all', label: 'Bypass all — runs unattended', tone: 'warn' },
]

// Stable empty fallback so the saved-teams selector doesn't churn refs per render.
const EMPTY_SAVED_TEAMS: SprintEngineRoster[] = []

// The control box is `ui/Input`, not a constant here. This file used to declare
// `CONTROL_BASE` and `TriggerFields.tsx` declared a literal duplicate of it,
// under comments in both files admitting the two were kept in sync by hand —
// which is the mechanism, not the exception (MC-2114). Its `h-7` was 28px, off
// the 26/30/34 ramp entirely; the kit's `sm` step is 30px.
// The name, edited in place as the page's own title (mockup §.head). The chrome
// is the kit's `INLINE_TITLE_EDIT_CLASS` — the New sprint dialog's run-name field
// is the same idiom and used to spell its own copy (MC-2114); what stays here is
// the type step, which is this surface's own decision.
const NAME_INPUT = `${INLINE_TITLE_EDIT_CLASS} text-title font-semibold tracking-tight text-[color:var(--text-strong)]`
// Auto-grows with its content (field-sizing: content) from the rows={4} floor up
// to a cap, then scrolls internally — no native drag handle. The `rows` attribute
// sets the minimum height; max-h caps the growth so the form stays usable.
// The prompt field grows with its content (field-sizing: content) from the
// rows={9} floor to a cap, then scrolls internally — no native drag handle,
// which is why it opts out of the kit's default `resize-y`.
const PROMPT_TEXTAREA = 'max-h-[280px] overflow-y-auto field-sizing-content'

// Stable empty fallbacks so the roster store selectors don't churn refs per render.
const EMPTY_SPECIALIST_ORDER: SpecialistActionId[] = []
const EMPTY_DISABLED_PACKS: string[] = []

/**
 * The runtime an agent-backed run will ACTUALLY launch on, in the launch's own
 * order of preference. An automation whose config names no cli is not
 * unconfigured: `launchAgent` (useAutomationRequests.ts) falls back to the
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
  name: '', enabled: true, runInWorktree: true, disableAfterRun: false, actionKind: '', triggerKind: 'schedule',
  cadenceType: 'interval', everyMinutes: 30, timeLocal: '09:00', daysOfWeek: [1, 2, 3, 4, 5], atDatetime: '',
  repoEvent: { ...EMPTY_REPO_EVENT_FORM }, webhook: { ...EMPTY_WEBHOOK_FORM },
  sprintLanded: { ...EMPTY_SPRINT_LANDED_FORM }, config: {},
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
    // Absent on existing definitions ⇒ true (they were always worktree runs).
    runInWorktree: def.runInWorktree ?? true,
    disableAfterRun: def.disableAfterRun ?? false,
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
    sprintLanded: def.trigger.kind === SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND
      ? sprintLandedFormFromConfig(def.trigger.config)
      : { ...EMPTY_SPRINT_LANDED_FORM },
    config,
  }
}

// Schema-driven create / edit form. The action's fields are derived from the
// selected provider's configSchema (providers:list); an action whose required
// integration is missing is disabled with an explicit unavailable state.
export function AutomationEditor({
  editor, providers, workspaceRoot, actionsSlot, onCancel, onSaved,
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
    providers ? initialFormState(editor, providers) : EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
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
  const lastSelectedCli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli)
  const selectedCli = resolveAutomationRuntimeCli(form.config.cli, lastSelectedCli, cliCatalog)
  const showAgentPicker = !actionUnavailableReason && configKeys.includes('cli')
  // An automation with no stored preset runs on the unattended default, so the
  // control shows that rather than "Default" — the editor must not read back a
  // preset the run will not use.
  const selectedPermissionPreset =
    (form.config.permissionPreset as SprintEngineCliPermissionPreset) || AUTOMATION_DEFAULT_PERMISSION_PRESET

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

  // A run-landed → sprint-start chain defaults "Run once, then pause" ON: left
  // firing forever, an A↔B pair of these ping-pongs unbounded (each landed run
  // re-fires the other). The default follows the selected pair only until the user
  // touches the toggle, so it stays a default, not a lock; edit mode seeds the
  // toggle from the stored definition and never re-applies it here.
  const disableAfterRunTouchedRef = useRef(false)
  useEffect(() => {
    if (editor.mode !== 'create' || disableAfterRunTouchedRef.current) return
    const isChainPair =
      form.triggerKind === SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND
      && form.actionKind === 'sprint-engine-start'
    setForm((prev) => (prev.disableAfterRun === isChainPair ? prev : { ...prev, disableAfterRun: isChainPair }))
  }, [editor.mode, form.triggerKind, form.actionKind])

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

  // Skill attachment — a spawn-agent run can attach a built-in skill (e.g.
  // `backlog`) that the terminal spawn installs into the run's worktree before
  // the CLI starts. Only built-in skills are offered: they are the ones that
  // install into the per-run worktree (a pack/custom skill would not follow the
  // agent there). Shown only for an action whose schema consumes `spawnSkillId`.
  const showSkillPicker =
    !actionUnavailableReason && actionProvider != null && schemaHasStringProp(actionProvider.configSchema, 'spawnSkillId')
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  // The selected skill's human name for display; config only stores the id, so
  // this is seeded on pick and falls back to the id when editing a saved run.
  const [pickedSkillLabel, setPickedSkillLabel] = useState<string | null>(null)
  const selectedSkillId = form.config.spawnSkillId?.trim() || ''
  const onPickSkill = useCallback((skill: WorkspaceSkill) => {
    setPickedSkillLabel(skill.name)
    setForm((prev) => ({ ...prev, config: { ...prev.config, spawnSkillId: skill.id } }))
  }, [])
  const onClearSkill = useCallback(() => {
    setPickedSkillLabel(null)
    setForm((prev) => {
      const config = { ...prev.config }
      delete config.spawnSkillId
      return { ...prev, config }
    })
  }, [])
  const onlyBuiltinSkills = useCallback((skill: WorkspaceSkill) => skill.source === 'builtin', [])

  // Sprint chaining action (sprint-engine-start): the backlog item and roster
  // fields get dedicated pickers — the shared Backlog search picker and a plain
  // Select over the saved teams — instead of the generic free-text inputs.
  const isSprintStartAction = form.actionKind === 'sprint-engine-start'
  const backlogScan = useBacklogScan(isSprintStartAction ? workspaceRoot : null)
  const backlogOptions = useMemo((): BacklogItemSearchOption[] =>
    backlogScan.result.items
      // The action chains from leaf items (epic launches bundle children — a
      // wizard flow), so epics are not offered.
      .filter((item) => !item.relativePath.startsWith('backlog/epics/'))
      .map((item) => ({
        id: item.id,
        value: item.relativePath,
        title: item.title,
        displayId: item.displayId,
        searchText: item.relativePath,
      })),
  [backlogScan.result.items])
  const sprintSavedTeams = useWorkspaceStore(
    (s) => s.appSettings.sprintEngineRoleSettings?.savedRosters ?? EMPTY_SAVED_TEAMS,
  )
  const sprintTeamItems: SelectItem[] = useMemo(() => {
    // The empty option resolves like the sprint wizard does (the last team you
    // used there, else the built-in default) — the label must say so, not
    // promise a fixed "default roster" the resolver doesn't deliver.
    const items: SelectItem[] = [{ value: '', label: 'Last used team' }]
    for (const team of sprintSavedTeams) items.push({ value: team.name, label: team.name })
    const stored = form.config.team?.trim()
    if (stored && !items.some((item) => item.value === stored)) {
      items.push({ value: stored, label: `${stored} — missing`, tone: 'warn' })
    }
    return items
  }, [sprintSavedTeams, form.config.team])

  // Provenance, stamped once by the install and never editable here (MC-2030):
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
    // Agent is a fact of an action that launches one; an action with no agent
    // gets no row rather than a default that would not be true of it.
    if (showAgentPicker) {
      facts.push({
        term: 'Agent',
        description: selectedSpecialist ? `Role — ${selectedSpecialist.shortLabel}` : 'Plain — no role, no soul',
      })
    }
    // Provenance the install stamps (MC-2030). The header names the publisher, so
    // this row names only where it came from — one fact each, not both twice.
    facts.push({
      term: 'Source',
      description: sourceCatalogueId ? 'Extensions shelf' : 'Written in this project',
    })
    return facts
  }, [form.runInWorktree, showAgentPicker, selectedSpecialist, sourceCatalogueId])

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
    if (!triggerReadOnly && form.triggerKind === SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND && !form.sprintLanded.team.trim()) {
      return 'Pick the sprint team to watch.'
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
      if (!result.ok) { setError(result.message); return }
      onSaved(result.value)
    } catch (err) {
      // A rejected IPC invoke would otherwise leave the form stuck on "Saving…".
      setError(err instanceof Error ? err.message : 'The automations service did not respond.')
    } finally {
      setSaving(false)
    }
  }, [validationError, workspaceRoot, configKeys, form, editor, onSaved, builtTrigger, shouldSendTrigger, showAgentPicker, showConnectorPicker, showSkillPicker])

  const actionItems: SelectItem[] = (providers?.actions ?? []).map((a) => ({
    value: a.kind,
    label: providerUnavailableReason(a) ? `${actionLabel(a.kind)} — unavailable` : actionLabel(a.kind),
    disabled: Boolean(providerUnavailableReason(a)),
  }))

  // Save and Cancel. One pair, wherever they paint: at the foot of the form in a
  // panel, or portaled into the host's bar (the Automations door, mockup
  // §.canvas-bar). The submit stays a real submit, so Enter in a field and the
  // button reach the same `handleSubmit`.
  const actions = (
    <>
      <PrimaryButton type="submit" form={formId} disabled={saving || validationError !== null}>
        {saving ? 'Saving…' : editor.mode === 'create' ? 'Create automation' : 'Save'}
      </PrimaryButton>
      <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>
    </>
  )

  return (
    <form
      id={formId}
      // The two columns key off THIS form's width, not the viewport: the same
      // editor is the door's full canvas and a narrow workspace panel, and only
      // the container knows which.
      className="@container flex flex-col gap-5 px-6 py-5"
      onSubmit={(e) => { e.preventDefault(); void handleSubmit() }}
    >
      {/* Head (§.head): the mark, the name edited in place, and — for something
          that came from the shelf — who published it, so a starter is
          distinguishable from an automation written here. */}
      <div className="flex items-start gap-3">
        <span className="mt-1.5 flex items-center">
          <AutomationTypeGlyph kind={form.actionKind} />
        </span>
        <div className="min-w-0 flex-1">
          <input
            id="automation-name"
            type="text"
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
              {/* Agent and Model (§.duo): who runs it, and on what. Both resolve
                  to something real on an automation with neither set — the
                  agent reads "No role", the runtime reads the CLI the launch
                  would actually fall back to — because an enabled automation
                  showing an empty picker reads broken. */}
              {showAgentPicker ? (
                <div className="grid gap-3 @[520px]:grid-cols-2 @[520px]:items-start">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-meta font-medium text-[color:var(--text-default)]">Agent</span>
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
                          className="grid w-full grid-cols-[24px_1fr_auto] items-center gap-2.5 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2.5 py-2 text-left transition-colors hover:border-[color:var(--border-strong)]"
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
                            <span className="block truncate text-meta font-medium text-[color:var(--text-strong)]">
                              {selectedSpecialist ? selectedSpecialist.shortLabel : 'No role'}
                            </span>
                            {/* A role's own description; a roleless agent gets
                                no second line, because the aside's Agent fact
                                already says what it is. */}
                            {selectedSpecialist ? (
                              <span className="block truncate text-micro text-[color:var(--text-subtle)]">
                                {selectedSpecialist.description}
                              </span>
                            ) : null}
                          </span>
                          <svg className="icon-sm shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                            <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                    >
                      <AgentComposerPopover
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
                          permissionPreset: selectedPermissionPreset,
                          onChangePermissionPreset: (preset) => update('config', { ...form.config, permissionPreset: preset }),
                        }}
                        onClose={() => setAgentPickerOpen(false)}
                      />
                    </Popover>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-meta font-medium text-[color:var(--text-default)]">Model</span>
                    {/* The picker names the model and leaves it unpinned by
                        default, so the runtime's own default is what runs. It
                        brings its own control box — a second one around it would
                        be two borders for one control — so the row only holds it
                        at the height of the Agent field beside it. */}
                    <div className="flex h-[38px] items-center">
                      <CliModelPickerButton
                        ariaLabel="Agent runtime and model"
                        options={cliCatalog}
                        cli={selectedCli}
                        effectiveModelFor={(candidate) => (candidate === selectedCli ? form.config.cliModel || undefined : undefined)}
                        onSelectCli={(cli) => update('config', { ...form.config, cli, cliModel: '' })}
                        onSelectModel={(cli, model) => update('config', { ...form.config, cli, cliModel: model ?? '' })}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {/* Runs and Permission (§.duo): when it fires, and what it may do
                  while nobody is watching. */}
              <div className="grid gap-3 @[520px]:grid-cols-2 @[520px]:items-start">
                <TriggerFields
                  editor={editor}
                  providers={providers}
                  workspaceRoot={workspaceRoot}
                  value={form}
                  onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
                />
                {showAgentPicker ? (
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-meta font-medium text-[color:var(--text-default)]">Permission</span>
                    <Select
                      ariaLabel="Permission"
                      value={selectedPermissionPreset}
                      onChange={(preset) => update('config', { ...form.config, permissionPreset: preset })}
                      items={PERMISSION_PRESET_ITEMS}
                    />
                  </div>
                ) : null}
              </div>

              {/* Sprint chaining fields — dedicated pickers for the backlog item
                  and the saved-team roster; the generic loop below skips both keys. */}
              {isSprintStartAction ? (
                <>
                  {/* No `htmlFor`: the row is a composite — the chosen item with a
                      Clear button, above a search picker — not one labellable
                      control, and the picker names itself. Passing one put the id
                      on the wrapper div, where a `<label for>` cannot reach. */}
                  <Field
                    label="Start from backlog item"
                    required
                    help="The chained sprint plans and works this item on the refreshed base branch."
                  >
                    <div className="flex flex-col gap-1.5">
                      {form.config.backlogItem ? (
                        <div className="flex items-center gap-1.5">
                          <code className="min-w-0 flex-1 truncate font-mono text-micro text-[color:var(--text-muted)]">
                            {form.config.backlogItem}
                          </code>
                          <GhostButton
                            type="button"
                            onClick={() => update('config', { ...form.config, backlogItem: '' })}
                            className="h-6 shrink-0 px-2 text-micro"
                          >
                            Clear
                          </GhostButton>
                        </div>
                      ) : null}
                      <BacklogItemSearchPicker
                        options={backlogOptions}
                        selectedValues={form.config.backlogItem ? [form.config.backlogItem] : []}
                        onSelect={(option) => update('config', { ...form.config, backlogItem: option.value })}
                        ariaLabel="Backlog item to start the next sprint from"
                        noOptionsMessage={backlogScan.isScanning ? 'Scanning the backlog…' : 'No backlog items found.'}
                        resultRole="listbox"
                      />
                    </div>
                  </Field>
                  <Field
                    label="Team"
                    htmlFor="automation-sprint-start-team"
                    help="Saved team that staffs the chained sprint. “Last used team” resolves like the sprint wizard: the team you last picked there, else the built-in default."
                  >
                    <Select
                      ariaLabel="Saved team for the chained sprint"
                      value={form.config.team?.trim() || ''}
                      onChange={(value) => update('config', { ...form.config, team: value })}
                      items={sprintTeamItems}
                    />
                  </Field>
                  <p className="text-micro leading-relaxed text-[color:var(--text-subtle)]">
                    Starts a new sprint each time the watched sprint finishes and lands. Deleting
                    and recreating the watched sprint counts as a fresh landing, so it starts again.
                    To stop two chained automations from restarting each other, chains default to
                    “Run once, then pause” — turn that off below to keep it firing.
                  </p>
                </>
              ) : null}

              {/* The action's own fields (§.field prompt). The prompt is where
                  reviewer-vs-fixer intent lives now that the autonomy control is
                  retired, so it gets the room to say so. */}
              {configKeys.filter((key) => key !== 'cli' && !(isSprintStartAction && (key === 'backlogItem' || key === 'team'))).map((key) => {
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

          {showSkillPicker || showConnectorPicker ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-meta text-[color:var(--text-subtle)]">Attachments</h3>
              {showSkillPicker ? (
                <div className="flex flex-col gap-1.5">
                  {selectedSkillId ? (
                    <div className="flex items-center gap-1.5">
                      <code className="min-w-0 flex-1 truncate rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 font-mono text-micro text-[color:var(--text-muted)]">
                        {pickedSkillLabel ?? selectedSkillId}
                      </code>
                      <GhostButton type="button" onClick={onClearSkill} className="h-6 shrink-0 px-2 text-micro">
                        Clear
                      </GhostButton>
                    </div>
                  ) : (
                    <SkillPickerPopover
                      open={skillPickerOpen}
                      onOpenChange={setSkillPickerOpen}
                      workspaceRoot={workspaceRoot || null}
                      onPick={onPickSkill}
                      filterSkill={onlyBuiltinSkills}
                      placement="bottom-start"
                      renderTrigger={({ ref, triggerProps, togglePopover }) => (
                        <button
                          ref={ref}
                          type="button"
                          onClick={togglePopover}
                          className="flex h-7 w-full items-center justify-between rounded-[5px] border border-dashed border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2.5 text-meta text-[color:var(--text-muted)] transition-colors hover:border-[color:var(--border-strong)]"
                          {...triggerProps}
                        >
                          Add a skill
                          <svg className="icon-xs shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    />
                  )}
                </div>
              ) : null}
              {showConnectorPicker ? (
                <div className="flex flex-col gap-1.5">
                  <Select
                    ariaLabel="Connector"
                    value={selectedConnectorId}
                    onChange={onSelectConnector}
                    items={connectorItems}
                    disabled={connectorLoad.status === 'loading'}
                    placeholder={connectorLoad.status === 'loading' ? 'Loading connectors…' : 'Add a connector'}
                  />
                  {connectorLoad.status === 'error' ? (
                    <InlineNotice tone="warn">Connectors are unavailable: {connectorLoad.message}</InlineNotice>
                  ) : connectorLoad.status === 'ready' && connectorItems.length === 1 ? (
                    <span className="text-micro text-[color:var(--text-subtle)]">
                      No connectors installed — the run uses the workspace defaults.
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-2.5">
            <label htmlFor="automation-worktree" className="flex items-center gap-2.5 text-meta text-[color:var(--text-default)]">
              <Switch
                id="automation-worktree"
                checked={form.runInWorktree}
                onChange={(next) => update('runInWorktree', next)}
                ariaLabel="Run the agent in an isolated git worktree"
              />
              Run in worktree
            </label>
            <label htmlFor="automation-run-once" className="flex items-center gap-2.5 text-meta text-[color:var(--text-default)]">
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
            <label htmlFor="automation-enabled" className="flex items-center gap-2.5 text-meta text-[color:var(--text-default)]">
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
      {validationError ? (
        <p className="text-micro text-[color:var(--text-subtle)]">{validationError}</p>
      ) : null}

      {/* One pair of buttons: in the host's bar when it offers a slot, at the
          foot of the form when it does not. */}
      {actionsSlot
        ? actionsSlot.el && createPortal(actions, actionsSlot.el)
        : <div className="flex items-center gap-2">{actions}</div>}
    </form>
  )
}
