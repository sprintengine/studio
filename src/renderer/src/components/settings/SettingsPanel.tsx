import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  VersionControlProviderId,
  VersionControlProviderProbe,
} from '../../../../shared/version-control'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import type { RegisteredSettingsSection } from '../../modules/renderer-host'
import { ModuleSettingsSectionHost } from './ModuleSettingsSection'
import type {
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
  SprintEngineRoleRegistryWarning,
} from '../../types/workspace'
import AppThemePicker from './AppThemePicker'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { basename } from '../../utils/paths'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import {
  buildSprintEngineRoleRegistry,
  getSprintEngineRoleLabel,
  sprintEngineRoleOrder,
} from '../../utils/sprintengine'
import { WorkspacePanel } from '../ui/WorkspacePanel'
import {
  type ActionResult,
  ActionResultMessage,
  CliProviderStateLine,
  EmptyState,
  Field,
  GhostButton,
  IconButton,
  InlineNotice,
  Input,
  OutlineButton,
  PrimaryButton,
  ProviderRow,
  ProviderStateId,
  RefreshIcon,
  resolveCliProviderState,
  SegmentedControl,
  Spinner,
  StatusDot,
  Switch,
  Textarea,
  type Tone,
  Tooltip,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import LearnCenter from '../learn/LearnCenter'
import { KeyboardShortcutsTab } from './KeyboardShortcutsTab'
import MobileSettingsTab from './MobileSettingsTab'
import { RemoteTailnetSettingsTab } from './RemoteTailnetSettingsTab'
import { ModulesSettingsTab } from './ModulesSettingsTab'
import { ProviderSettingsTab } from './ProviderSettingsTab'
import { MetaCell, SettingsRow, SettingsSectionTitle, formatNullableDate } from './SettingsAtoms'
import {
  resolveVersionControlRow,
  versionControlSections,
  type VersionControlProbeStatus,
  type VersionControlRowView,
} from './versionControlProviders'
import { ProjectKnowledgeList } from './ProjectKnowledgeList'
import { DesignSystemSettings } from './DesignSystemSettings'
import CliIcon from '../CliIcon'
import { cliRuntimeForPlugin, orderInstalledPlugins } from '../workspace/newWorkspace/cliRuntimeOptions'
import { CliInstallControl } from './CliInstallControl'
import { AgentConfigAdoptionStatus } from '../onboarding/agentConfigAdoption'
import SprintEngineFrond from '../brand/SprintEngineFrond'
import {
  GeneralSettingsIcon,
  ProfileSettingsIcon,
  AppearanceSettingsIcon,
  ShortcutsSettingsIcon,
  AgentsSettingsIcon,
  ProvidersSettingsIcon,
  RolesSettingsIcon,
  GithubSettingsIcon,
  TrackersSettingsIcon,
  KnowledgeGraphSettingsIcon,
  DesignSystemSettingsIcon,
  ModulesSettingsIcon,
  MobileSettingsIcon,
  RemoteSettingsIcon,
  LearnSettingsIcon,
  PlusIcon,
} from '../AppIcons'
import { AccountAvatar } from '../workspace/AccountAvatar'
import { hasPaidEntitlement, planDisplayTier } from '../workspace/accountEntitlements'
import { GlobalSurfaceShell } from '../workspace/globalSurface/GlobalSurfaceShell'
import { useSurfaceBackNav } from '../workspace/globalSurface/surfaceBackNav'
import { getSettingDescriptor, type SettingDescriptor } from './settingsRegistry'
import { TicketTrackersTab } from './TicketTrackersTab'
import {
  authoringFieldErrors,
  authoringStatusReducer,
  createRoleAuthoringDraft,
  editRoleAuthoringDraft,
  idleAuthoringStatus,
  isAuthoringBusy,
  mapIssuesToFieldErrors,
  validateRoleAuthoringDraft,
  type RoleAuthoringDraft,
  type RoleAuthoringFieldErrors,
  type RoleAuthoringMode,
} from './userRoleAuthoring'

interface Props {
  onClose: () => void
  checkForUpdatesOnOpen?: boolean
  checkForUpdatesRequestId?: number
  initialTab?: string | null
  onOpenSettingsTab?: (tabId: string) => void
  /**
   * `'panel'` (default) wraps the content in `WorkspacePanel` chrome.
   * `'overlay'` is how Settings actually opens (doors→modals, 2026-09-01): the
   * shared surface-shell anatomy inside the host's Modal — the same bar, rail
   * ground, and closing X as Plugins/Automations/Design.
   * `'door'` is the door-era full-page mount (owner, 2026-07-30), kept for a
   * host that routes the card region.
   */
  chrome?: 'panel' | 'overlay' | 'door'
}

type UpdateAction = 'check' | 'download' | 'restart'

type GitHubTokenUiStatus = Awaited<ReturnType<typeof window.api.getGitHubTokenStatus>>

const EMPTY_USER_MODELS: string[] = []
const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}

type SettingsTabId =
  | 'general'
  | 'profile'
  | 'appearance'
  | 'shortcuts'
  | 'modules'
  | 'github'
  | 'trackers'
  | 'agents'
  | 'providers'
  | 'roles'
  | 'knowledge-graph'
  | 'design-system'
  | 'learn'
  | 'mobile'
  | 'remote'

// Line-weight rail glyph. Built-in tabs carry one from AppIcons; module sections
// reuse their own contributed `moduleSection.icon` (same shape).
type SettingsTabIcon = React.ComponentType<{ className?: string }>

// Declared in rail order: the flat order of this array (filtered to visible
// tabs, then module sections appended) drives index-based roving focus, so it
// must match the grouped visual order in `settingsTabGroups` below. Built-in
// tabs carry no description — the rail label + glyph orient, and each tab body
// self-titles via its own section headings; only module-contributed sections
// take a host-supplied page header (see `bodyContent`).
const settingsTabs: Array<{ id: SettingsTabId; label: string; icon: SettingsTabIcon }> = [
  { id: 'general', label: 'General', icon: GeneralSettingsIcon },
  { id: 'profile', label: 'Profile', icon: ProfileSettingsIcon },
  { id: 'appearance', label: 'Appearance', icon: AppearanceSettingsIcon },
  { id: 'shortcuts', label: 'Shortcuts', icon: ShortcutsSettingsIcon },
  { id: 'agents', label: 'Agents', icon: AgentsSettingsIcon },
  { id: 'providers', label: 'Providers', icon: ProvidersSettingsIcon },
  { id: 'roles', label: 'Roles', icon: RolesSettingsIcon },
  // Covers both groups on the page (the VCS itself, then the hosting provider),
  // so the label is the subject rather than one of the two rows. The tab *id*
  // stays 'github' — it is a persisted deep-link target (menus, module routes).
  { id: 'github', label: 'Version control', icon: GithubSettingsIcon },
  { id: 'trackers', label: 'Ticket trackers', icon: TrackersSettingsIcon },
  { id: 'knowledge-graph', label: 'Knowledge graph', icon: KnowledgeGraphSettingsIcon },
  { id: 'design-system', label: 'Design system', icon: DesignSystemSettingsIcon },
  { id: 'modules', label: 'Modules', icon: ModulesSettingsIcon },
  { id: 'mobile', label: 'Mobile', icon: MobileSettingsIcon },
  { id: 'remote', label: 'Remote', icon: RemoteSettingsIcon },
  { id: 'learn', label: 'Learn', icon: LearnSettingsIcon },
]

// Rail groups. Labels are internal keys only — the rail separates groups by
// whitespace rather than printing a header (Cursor-parity). Module-contributed
// sections render after these under the trailing 'extensions' group.
const settingsTabGroups: Array<{ label: string; ids: SettingsTabId[] }> = [
  { label: 'app', ids: ['general', 'profile', 'appearance', 'shortcuts'] },
  { label: 'agents', ids: ['agents', 'providers', 'roles'] },
  { label: 'workspace', ids: ['github', 'trackers', 'knowledge-graph', 'design-system', 'modules'] },
  { label: 'companion', ids: ['mobile', 'remote', 'learn'] },
]

// A rail entry: a built-in tab, or a module-contributed section rendered after
// the built-ins. Contributed tab ids carry a prefix so they can never collide
// with (or spoof) a built-in tab id.
type SettingsTabDescriptor = {
  id: string
  label: string
  // Rail glyph: built-in tabs carry one directly; module sections fall back to
  // their contributed `moduleSection.icon` at render time.
  icon?: SettingsTabIcon
  // Only module-contributed sections carry a description; the host renders it in
  // the section's page header (built-in tabs self-title and take no header).
  description?: string
  moduleSection?: RegisteredSettingsSection
}

const MODULE_SECTION_TAB_PREFIX = 'module-section:'

function moduleSectionTabId(sectionId: string): string {
  return `${MODULE_SECTION_TAB_PREFIX}${sectionId}`
}

function isSettingsTabId(value: unknown): value is SettingsTabId {
  return (
    value === 'general'
    || value === 'profile'
    || value === 'appearance'
    || value === 'shortcuts'
    || value === 'modules'
    || value === 'github'
    || value === 'trackers'
    || value === 'agents'
    || value === 'providers'
    || value === 'roles'
    || value === 'knowledge-graph'
    || value === 'design-system'
    || value === 'learn'
    || value === 'mobile'
    || value === 'remote'
  )
}

// The 'updates' and 'telemetry' tabs folded into 'general' (their content now
// renders as sections on the General page), and 'specialist-packs' folded into
// 'modules'. Map any legacy deep-link that named the old tabs onto their new
// homes so bookmarked/menu routes still land correctly.
const GENERAL_FOLDED_SETTINGS_TABS = ['updates', 'telemetry'] as const

function resolveInitialSettingsTab(initialTab: string | null | undefined): string | null {
  if (initialTab && (GENERAL_FOLDED_SETTINGS_TABS as readonly string[]).includes(initialTab)) {
    return 'general'
  }
  if (initialTab === 'specialist-packs') return 'modules'
  // Voice dictation moved onto the module-contributed section path (MC-1861);
  // legacy deep-links (Learn center, persisted routes) land on its section tab.
  if (initialTab === 'voice-dictation') return moduleSectionTabId('voice-dictation')
  return initialTab ?? null
}

// This module used to declare `INPUT_CLASS` and `ROW_INPUT_CLASS` — and so did
// `ProviderSettingsTab` (a copy of the first) and `ProjectKnowledgeList` (a
// DIFFERENT field under the second's name: `--bg-surface` and full-width against
// this one's `--bg-app` and content-sized). All four are `ui/Input` now: the
// well recipe is the kit's `variant="well"`, and the settings inset is its `md`
// step (MC-2114).
//
// What stays here is per-field CONTENT, not chrome. `font-mono` because a row
// input holds an identifier (a command, a model id, a token) rather than prose,
// and the two textarea shapes below, which differ by what the author is writing.
const MONO_FIELD = 'font-mono'
// Row controls are sized to their expected content, never stretched to the panel
// — 240px is the standard row measure. Passed with `fullWidth={false}` because
// Tailwind resolves two width utilities by stylesheet order, not string order.
const ROW_FIELD = 'w-60 max-w-full font-mono'
// Instructions editor: the SKILL.md document the runtime parses, so it reads as a
// structured document (mono) rather than prose. Tall by default since the author
// is filling in a multi-section scaffold.
const DOCUMENT_TEXTAREA = 'min-h-[260px] font-mono'

type RoleRegistryStatus = 'idle' | 'loading' | 'ready' | 'unavailable'
// Was a local `MessageBlock` with its own four-tone `border-l-2` bar — the
// reject-on-sight pattern, two tabs away from the `InlineNotice` this file
// already imported (MC-2115). The kit's `ActionResultMessage` carries the
// ruling now: a failure or a degraded state is a notice, everything else is
// copy. `accent` and `neutral` folded into `info` on the way — there is no
// success notice in this system.
type RoleInstallMessage = ActionResult | null
type SprintEngineRoleInstallTarget = {
  sourcePath: string
  destinationKind: 'roles' | 'skills'
}

function StatusTag({
  tone,
  label,
}: {
  tone: Tone
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-body text-[color:var(--text-muted)]">
      <StatusDot tone={tone} label={label} />
      <span className="font-medium text-[color:var(--text-default)]">{label}</span>
    </span>
  )
}

// Per-plugin custom model ids. Multicode does not persist an app-level default
// model (the CLI's own default is used when no per-surface override is set), so
// this is purely the user-extended id list. Rendered only when the plugin
// declares modelSelection with `allowCustomId` — without declared launch args a
// model could not be passed, and terminal CLIs expose no live model catalog, so
// this list is how new models are adopted between plugin updates. Rendered
// inline inside the per-plugin configuration disclosure.
// API-key entry for a CLI whose manifest declares `auth` (e.g. Z.AI). Reads and
// writes through the shared credential store via the generic `credentialSecret*`
// IPC — the same store the chat Providers tab uses. Mirrors the Providers tab's
// masked/save/remove pattern; the value is write-only and never read back.
function CliCredentialRow({
  pluginId,
  displayName,
  label,
}: {
  pluginId: string
  displayName: string
  label: string
}) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.api.credentialSecretStatus>> | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.api.credentialSecretStatus({ id: pluginId }).then((result) => {
      if (active) setStatus(result)
    })
    return () => {
      active = false
    }
  }, [pluginId])

  const configured = status?.ok === true && status.status.configured
  const source = status?.ok === true ? status.status.source : 'none'
  const persistence = status?.ok === true ? status.status.persistence : 'encrypted'
  // Environment-sourced keys are owned outside the app; don't offer Remove.
  const canClear = configured && source !== 'environment'
  const inputId = `cli-credential-${pluginId}`

  const save = async (): Promise<void> => {
    const value = draft.trim()
    if (!value || busy) return
    setBusy(true)
    setMessage(null)
    const result = await window.api.credentialSecretSet({ id: pluginId, value })
    setBusy(false)
    if (result.ok) {
      setStatus(result)
      setDraft('')
      setMessage('API key saved.')
    } else {
      setMessage(result.message)
    }
  }

  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    const result = await window.api.credentialSecretClear({ id: pluginId })
    setBusy(false)
    if (result.ok) {
      setStatus(result)
      setMessage('API key removed.')
    } else {
      setMessage(result.message)
    }
  }

  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="text-body font-medium text-[color:var(--text-strong)]">{label}</div>
      <div className="mt-2 space-y-1.5">
        {configured ? (
          <div className="flex items-center gap-2">
            {/* The saved key is shown as the field it will be edited in, read-only
                — not as a div wearing a copy of the field's chrome. The value IS
                the mask, so the accessible name says what the dots mean. */}
            <Input
              readOnly
              value="••••••••••••"
              aria-label={`${displayName} API key is saved`}
              size="md"
              variant="well"
              fullWidth={false}
              className="min-w-0 flex-1 tracking-[0.3em] text-[color:var(--text-muted)]"
            />
            {canClear ? (
              <GhostButton size="md" onClick={() => void clear()} disabled={busy} className="shrink-0">
                {busy ? 'Removing…' : 'Remove'}
              </GhostButton>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
              {displayName} API key
            </label>
            <Input
              id={inputId}
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void save()
                }
              }}
              placeholder="Paste API key"
              autoComplete="off"
              disabled={busy}
              size="md"
              variant="well"
              fullWidth={false}
              className={`min-w-0 flex-1 ${MONO_FIELD}`}
            />
            <PrimaryButton size="md" onClick={() => void save()} disabled={busy || !draft.trim()} className="shrink-0">
              {busy ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>
        )}
        {configured && source === 'environment' ? (
          <p className="text-meta leading-5 text-[color:var(--text-subtle)]">
            Set from the environment. Remove it there to change it.
          </p>
        ) : configured && persistence === 'session' ? (
          <p className="text-meta leading-5 text-[color:var(--tone-warn)]">
            Stored for this session only — clears when the app quits.
          </p>
        ) : null}
        <div aria-live="polite" className="text-meta leading-5 text-[color:var(--text-muted)] empty:hidden">
          {message}
        </div>
      </div>
    </div>
  )
}

function PluginModelSettings({
  displayName,
  userModels,
  onUserModelsChange,
}: {
  displayName: string
  userModels: string[]
  onUserModelsChange: (models: string[]) => void
}) {
  const [draftModel, setDraftModel] = useState('')
  const addDraftModel = (): void => {
    const model = draftModel.trim()
    if (!model) return
    if (!userModels.includes(model)) onUserModelsChange([...userModels, model])
    setDraftModel('')
  }
  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="text-body font-medium text-[color:var(--text-strong)]">Custom model ids</div>
      <div className="mt-2 space-y-1">
        {userModels.map((model) => (
          <div key={model} className="group -mx-1 flex h-control-md items-center gap-2 rounded-sm px-1">
            <span className="min-w-0 flex-1 truncate font-mono text-body text-[color:var(--text-default)]">
              {model}
            </span>
            <GhostButton
              size="xs"
              onClick={() => onUserModelsChange(userModels.filter((id) => id !== model))}
              className="invisible focus-visible:visible group-focus-within:visible group-hover:visible"
            >
              Remove
              <span className="sr-only"> {model} from {displayName} models</span>
            </GhostButton>
          </div>
        ))}
        <Input
          value={draftModel}
          aria-label={`Add a model id for ${displayName}`}
          placeholder="Add model id and press Enter"
          onChange={(event) => setDraftModel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addDraftModel()
            }
          }}
          size="md"
          variant="well"
          className={MONO_FIELD}
        />
      </div>
    </div>
  )
}

function orderedSprintEngineRoles(registry: SprintEngineRoleRegistry | null): SprintEngineRoleRegistryMetadata[] {
  const roles = Object.values(registry?.roles ?? {})
  const bundledOrder = new Map<string, number>(sprintEngineRoleOrder.map((role, index) => [role, index]))
  return roles.sort((a, b) => {
    const aOrder = bundledOrder.get(a.id)
    const bOrder = bundledOrder.get(b.id)
    if (aOrder !== undefined || bOrder !== undefined) {
      return (aOrder ?? Number.MAX_SAFE_INTEGER) - (bOrder ?? Number.MAX_SAFE_INTEGER)
    }
    return getSprintEngineRoleLabel(a.id, registry).localeCompare(getSprintEngineRoleLabel(b.id, registry))
  })
}

function roleSourceLabel(role: SprintEngineRoleRegistryMetadata): string {
  const shadowed = role.shadowedSources?.map((source) => source.layer).join(', ')
  return shadowed ? `${role.source.layer} shadows ${shadowed}` : role.source.layer
}

function roleWarnings(role: SprintEngineRoleRegistryMetadata): SprintEngineRoleRegistryWarning[] {
  return role.warnings ?? []
}

function joinLocalPath(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/u, '')}${separator}${name}`
}

async function resolveSprintEngineRoleInstallTargets(selectedFolder: string): Promise<SprintEngineRoleInstallTarget[]> {
  const entries = await window.api.readdir(selectedFolder)
  const rolesDir = entries.find((entry) => entry.isDir && entry.name === 'roles')
  const skillsDir = entries.find((entry) => entry.isDir && entry.name === 'skills')

  if (rolesDir || skillsDir) {
    const targets: SprintEngineRoleInstallTarget[] = []
    if (rolesDir) {
      const rolesPath = joinLocalPath(selectedFolder, 'roles')
      const roleEntries = await window.api.readdir(rolesPath)
      targets.push(
        ...roleEntries
          .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith('.json'))
          .map((entry) => ({ sourcePath: joinLocalPath(rolesPath, entry.name), destinationKind: 'roles' as const }))
      )
    }
    if (skillsDir) {
      const skillsPath = joinLocalPath(selectedFolder, 'skills')
      const skillEntries = await window.api.readdir(skillsPath)
      targets.push(
        ...skillEntries
          .filter((entry) => entry.isDir)
          .map((entry) => ({ sourcePath: joinLocalPath(skillsPath, entry.name), destinationKind: 'skills' as const }))
      )
    }
    if (targets.length > 0) return targets
  }

  const roleManifests = entries.filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith('.json'))
  const skillDocuments = entries.filter((entry) => entry.isDir && entry.name.toLowerCase() !== 'skills')

  if (roleManifests.length > 0) {
    return roleManifests.map((entry) => ({
      sourcePath: joinLocalPath(selectedFolder, entry.name),
      destinationKind: 'roles',
    }))
  }

  if (skillDocuments.length > 0) {
    return skillDocuments.map((entry) => ({
      sourcePath: joinLocalPath(selectedFolder, entry.name),
      destinationKind: 'skills',
    }))
  }

  throw new Error('Select a role registry folder, a roles folder with JSON manifests, or a skills folder with SKILL.md directories.')
}

function RegistrySwitchRow({
  descriptor,
  checked,
  onChange,
  disabled,
}: {
  descriptor: SettingDescriptor
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  if (descriptor.field.type !== 'switch') return null
  const labelId = `setting-${descriptor.id}-label`
  const helpId = descriptor.help ? `setting-${descriptor.id}-help` : undefined
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <span id={labelId} className="block text-body font-medium text-[color:var(--text-strong)]">
          {descriptor.label}
        </span>
        {descriptor.help ? (
          <p id={helpId} className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">
            {descriptor.help}
          </p>
        ) : null}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        ariaLabelledBy={labelId}
        ariaDescribedBy={helpId}
        className="mt-0.5"
      />
    </div>
  )
}

// Number input for terminal-memory settings ("Pause idle terminals after",
// "Always keep running"). Edits live in local string state so a half-typed or
// briefly-empty value isn't clamped/rounded out from under the user; the store
// (which clamps to the field's min/max) is written on blur or Enter. A
// blank/invalid commit reverts to the persisted value.
function CommittedNumberField({
  descriptor,
  value,
  onCommit,
}: {
  descriptor: SettingDescriptor
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<string>(String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])
  if (descriptor.field.type !== 'number') return null
  const { min, max, step } = descriptor.field
  const commit = (): void => {
    // Revert a blank/whitespace field to the persisted value — `Number('')` is 0
    // (finite), which would otherwise clamp to the field floor rather than
    // restore what the user had.
    const parsed = draft.trim() === '' ? NaN : Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    // Clamp locally with the field's own bounds (they mirror the store
    // normalizer): when the clamped result equals the stored value the store
    // write is a no-op — no re-render, no sync effect — so the draft must be
    // corrected here or it keeps displaying the out-of-range text.
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, Math.round(parsed)))
    onCommit(clamped)
    setDraft(String(clamped))
  }
  return (
    <Field label={descriptor.label} htmlFor={descriptor.id} help={descriptor.help}>
      <Input
        id={descriptor.id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        size="md"
        className={MONO_FIELD}
      />
    </Field>
  )
}

function IdleSuspendField({ descriptor }: { descriptor: SettingDescriptor }) {
  const minutes = useWorkspaceStore((s) => s.appSettings.terminalIdleSuspendMinutes)
  const setMinutes = useWorkspaceStore((s) => s.setTerminalIdleSuspendMinutes)
  return <CommittedNumberField descriptor={descriptor} value={minutes} onCommit={setMinutes} />
}

function KeepRecentAliveField({ descriptor }: { descriptor: SettingDescriptor }) {
  const count = useWorkspaceStore((s) => s.appSettings.terminalKeepRecentAlive)
  const setCount = useWorkspaceStore((s) => s.setTerminalKeepRecentAlive)
  return <CommittedNumberField descriptor={descriptor} value={count} onCommit={setCount} />
}

// The Agent CLIs section band: title on the left, freshness meta and the two
// section controls on the right. The one chrome row for this list — the
// freshness fact and the control that refreshes it share a band rather than
// stacking a toolbar on a status line.
function AgentCliBand({
  count,
  checkedAt,
  now,
  addPending,
  onAdd,
  onRecheck,
}: {
  count?: number
  checkedAt: number | null
  now: number
  addPending: boolean
  onAdd: () => void
  onRecheck: () => void
}) {
  const freshness = formatRelativeMsAgo(checkedAt, now)
  return (
    <SettingsSectionTitle
      count={count}
      action={
        <div className="flex items-center gap-1.5">
          {freshness ? (
            <span className="text-micro text-[color:var(--text-subtle)]">{`Checked ${freshness}`}</span>
          ) : null}
          <Tooltip content={addPending ? 'Installing a CLI from a folder' : 'Install a CLI from a folder'}>
            <IconButton
              aria-label={addPending ? 'Installing a CLI from a folder' : 'Install a CLI from a folder'}
              disabled={addPending}
              onClick={onAdd}
            >
              {/* The glyph reports the install, so a dimmed plus is never the
                  only sign that something is happening. */}
              {addPending ? <Spinner className="icon-sm" /> : <PlusIcon className="icon-sm" />}
            </IconButton>
          </Tooltip>
          <Tooltip content="Re-check every CLI now">
            <IconButton aria-label="Re-check every CLI now" onClick={onRecheck}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </div>
      }
    >
      Agent CLIs
    </SettingsSectionTitle>
  )
}

// The mono mark for a version-control provider. The repo ships no brand logo for
// either of these — `git` and `gh` are command-line binaries whose identity IS
// their name — so the mark is the binary's name in the same 22px monogram box
// the tracker connections list uses, sized by ProviderRow's slot.
function VersionControlMark({ monogram }: { monogram: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-icon-lg items-center justify-center rounded-[var(--radius-xs)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] font-mono text-micro font-semibold text-[color:var(--text-muted)]"
    >
      {monogram}
    </span>
  )
}

// The state line for one provider row: the words from the view model, with the
// identifiers inside them mono. Every branch is a state the probe can actually
// report — there is no "unknown version" placeholder and no caption explaining
// what the provider is for.
//
// The install and auth lines are the only sentences on this page that carry more
// than a state, and they earn it: the one command that fixes the row is a
// consequence the screen cannot otherwise show.
function VersionControlStateLine({ view }: { view: VersionControlRowView }) {
  switch (view.kind) {
    case 'checking':
      return <>Checking…</>
    case 'available':
      return <>Available</>
    case 'authenticated':
      return (
        <>
          {'Authenticated as '}
          <ProviderStateId>{view.login}</ProviderStateId>
        </>
      )
    case 'unauthenticated':
      return (
        <>
          {'Not authenticated — '}
          <ProviderStateId>{view.command}</ProviderStateId>
        </>
      )
    case 'not-installed':
      return view.command ? (
        <>
          {'Not installed — '}
          <ProviderStateId>{view.command}</ProviderStateId>
          {view.thenAuthenticate ? ', then authenticate' : null}
        </>
      ) : (
        <>
          {'Not installed — no '}
          <ProviderStateId>{view.binary}</ProviderStateId>
          {' on PATH'}
        </>
      )
    case 'probe-failed':
      return <>Availability unknown — the check did not complete</>
  }
}

// The version-control tab body: two spaced sections of provider rows over the
// read-only probe, and the GitHub access token behind the GitHub row's own
// disclosure.
//
// Its own component so the probe runs when the tab mounts, not when the Settings
// dialog opens: the channel spawns a login shell per provider plus `gh auth
// status` and has no cache in front of it, so it is called on mount and on an
// explicit re-check, never per render.
//
// **No enablement switch, deliberately.** The mockup draws one per row, but this
// product has no git or GitHub enablement to write to: git's backend is
// foundational (always registered, because editor and explorer decorations call
// it unconditionally), the `git` module override governs the Git *panel* — a
// different fact, already owned by the Modules tab — and GitHub has no module at
// all. ProviderRow's contract is explicit that a host with no real enablement
// state passes no switch rather than rendering a dead one, and a switch that
// only looks like it does something is worse than the absence of one. The dot
// and the state line carry health; nothing here pretends to carry enablement.
export function VersionControlSections({
  githubToken,
}: {
  githubToken: React.ReactNode
}) {
  const [probes, setProbes] = useState<Partial<Record<VersionControlProviderId, VersionControlProviderProbe>>>({})
  const [probeStatus, setProbeStatus] = useState<VersionControlProbeStatus>('loading')
  const [probeError, setProbeError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [expandedId, setExpandedId] = useState<VersionControlProviderId | null>(null)
  const sections = useMemo(() => versionControlSections(), [])
  const platform = window.api.platform

  const runProbe = useCallback(async () => {
    if (typeof window.api.probeVersionControlProviders !== 'function') {
      // An older preload than this renderer. Named as the missing capability it
      // is, rather than letting the call throw a TypeError whose message would
      // reach the screen as "… is not a function".
      setProbeStatus('error')
      setProbeError(null)
      return
    }
    setChecking(true)
    try {
      const results = await window.api.probeVersionControlProviders()
      // Replace rather than merge: a re-check is a fresh reading of the machine,
      // so a provider that disappeared must not keep its old version line.
      setProbes(Object.fromEntries(results.map((result) => [result.id, result])))
      setProbeStatus('ready')
      setProbeError(null)
    } catch (error) {
      // The whole round-trip failed, which is one fact about the list — stated
      // once under the first band rather than repeated down every row. The rows
      // keep whatever they had already resolved; only the ones with no answer
      // read as unknown.
      setProbeStatus('error')
      setProbeError(error instanceof Error ? error.message : String(error))
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void runProbe()
  }, [runProbe])

  return (
    <div className="space-y-6">
      {sections.map((section, index) => (
        <section key={section.id} aria-labelledby={`version-control-${section.id}`} className="space-y-1">
          <SettingsSectionTitle
            id={`version-control-${section.id}`}
            // One chrome row for the whole page: both sections read from the same
            // round-trip, so the control that refreshes it belongs to the first
            // band, not to each one.
            action={
              index === 0 ? (
                <Tooltip content="Re-check now">
                  <IconButton
                    aria-label="Re-check now"
                    disabled={checking}
                    onClick={() => void runProbe()}
                  >
                    {checking ? <Spinner className="icon-sm" /> : <RefreshIcon />}
                  </IconButton>
                </Tooltip>
              ) : null
            }
          >
            {section.title}
          </SettingsSectionTitle>

          {/* The app's one error card, not a tone-bar: a 1px hairline, the soft
              tint, and the tone glyph, with the raw message behind "Show
              details" rather than inline. No action of its own — the re-check
              control that would retry it sits in this section's own band, two
              lines up. */}
          {index === 0 && probeStatus === 'error' ? (
            <InlineNotice
              tone="warn"
              title="Version control could not be checked."
              detail={probeError ?? undefined}
            />
          ) : null}

          {section.providers.map((spec) => {
            const view = resolveVersionControlRow(spec, probes[spec.id], probeStatus, platform)
            // Only GitHub has per-instance configuration to reveal (the app's own
            // access token). ProviderRow draws no chevron for a row with nothing
            // behind it, so git renders as a plain row rather than an empty
            // disclosure.
            const detail = spec.id === 'gh' ? githubToken : null
            return (
              <ProviderRow
                key={spec.id}
                icon={<VersionControlMark monogram={spec.monogram} />}
                health={view.tone}
                name={spec.label}
                version={view.version}
                stateLine={<VersionControlStateLine view={view} />}
                expanded={expandedId === spec.id}
                onExpandedChange={(next) => setExpandedId(next ? spec.id : null)}
              >
                {detail}
              </ProviderRow>
            )
          })}
        </section>
      ))}
    </div>
  )
}

function CompoundSwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  const labelId = React.useId()
  const helpId = description ? `${labelId}-help` : undefined
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <span id={labelId} className="block text-body font-medium text-[color:var(--text-strong)]">
          {label}
        </span>
        {description ? (
          <p id={helpId} className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        ariaLabelledBy={labelId}
        ariaDescribedBy={helpId}
        className="mt-0.5"
      />
    </div>
  )
}

// Authoring form for a single custom Sprint Engine role. Pure presentation: the
// draft, lifecycle, validation, and persistence live in the parent and the
// userRoleAuthoring view-model. The id is locked while editing (it is the role's
// durable identity); inline errors come from the view-model keyed by field.
function UserRoleAuthoringForm({
  mode,
  draft,
  errors,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  mode: RoleAuthoringMode
  draft: RoleAuthoringDraft
  errors: RoleAuthoringFieldErrors
  busy: boolean
  onChange: (patch: Partial<RoleAuthoringDraft>) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const editing = mode.kind === 'edit'
  return (
    <div className="space-y-4 rounded-[var(--radius-md)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-4">
      <div className="text-body font-semibold text-[color:var(--text-strong)]">
        {editing ? 'Edit custom role' : 'New custom role'}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Role id"
          htmlFor="user-role-id"
          required
          error={errors.id}
          help={editing ? 'Locked; the id is the role’s durable identity.' : 'Lowercase snake_case. Cannot change after creation.'}
        >
          <Input
            value={draft.id}
            onChange={(event) => onChange({ id: event.target.value })}
            disabled={editing || busy}
            placeholder="code_auditor"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            size="md"
            className={MONO_FIELD}
          />
        </Field>
        <Field label="Display name" htmlFor="user-role-label" required error={errors.label}>
          <Input
            value={draft.label}
            onChange={(event) => onChange({ label: event.target.value })}
            disabled={busy}
            placeholder="Code auditor"
            size="md"
          />
        </Field>
      </div>

      <Field
        label="Description"
        htmlFor="user-role-description"
        required
        error={errors.description}
        help="What this role does and when a sprint should staff it. The architect reads it when planning."
      >
        <Textarea
          value={draft.description}
          onChange={(event) => onChange({ description: event.target.value })}
          disabled={busy}
          rows={3}
          placeholder="Audits diffs for regressions before release. Staff this role when the run touches release-critical paths."
          size="md"
        />
      </Field>

      <Field
        label="Instructions"
        htmlFor="user-role-body"
        required
        error={errors.body}
        help="The role’s instructions, written as a skill document. Replace the seeded scaffold."
      >
        <Textarea
          value={draft.body}
          onChange={(event) => onChange({ body: event.target.value })}
          disabled={busy}
          spellCheck={false}
          size="md"
          className={DOCUMENT_TEXTAREA}
        />
      </Field>

      {errors.form ? <InlineNotice tone="error">{errors.form}</InlineNotice> : null}

      <div className="flex items-center justify-end gap-2">
        <GhostButton size="md" onClick={onCancel} disabled={busy}>
          Cancel
        </GhostButton>
        <PrimaryButton size="md" onClick={onSubmit} disabled={busy}>
          {busy ? 'Saving' : editing ? 'Save changes' : 'Create role'}
        </PrimaryButton>
      </div>
    </div>
  )
}

export default function SettingsPanel({
  onClose,
  checkForUpdatesOnOpen = false,
  checkForUpdatesRequestId,
  initialTab = null,
  onOpenSettingsTab,
  chrome = 'panel',
}: Props) {
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId) ?? null
  )
  // The door chrome's back chevron. Closes by Settings' own route — the generic
  // one clears the active surface but not the request that opened this door, so
  // the next cog press would reopen on the tab you left rather than the one you
  // asked for. Harmless in the other chromes, which never read it.
  const doorBack = useSurfaceBackNav(onClose)
  const dialog = useConfirmDialog()
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)
  const refreshPluginCatalog = useWorkspaceStore((s) => s.refreshPluginCatalog)
  const refreshCliAvailability = useWorkspaceStore((s) => s.refreshCliAvailability)
  // Session-scoped: adoption runs at the first workspace creation, and this is
  // where its outcome is reported. Null (and so silent) in every later session.
  const agentConfigAdoptionResult = useWorkspaceStore((s) => s.agentConfigAdoptionResult)
  // Detection map shared with the deployment pickers — drives the at-a-glance
  // status on every CLI row without a per-row probe.
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const cliAvailabilityError = useWorkspaceStore((s) => s.cliAvailabilityError)
  const cliAvailabilityCheckedAt = useWorkspaceStore((s) => s.cliAvailabilityCheckedAt)
  const installedPluginRows = useMemo(
    () => orderInstalledPlugins(pluginCatalogEntries),
    [pluginCatalogEntries],
  )
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? EMPTY_PROJECT_KNOWLEDGE_ROOTS)
  const usageTelemetry = useWorkspaceStore((s) => s.appSettings.usageTelemetry)
  // Profile tab reads the shared auth projection and drives the same auth IPC as
  // the sidebar account popover — no new state, just a fuller management surface.
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const [profileMessage, setProfileMessage] = useState<string | null>(null)
  const [profilePending, setProfilePending] = useState(false)
  const sprintEngineRoleSettings = useWorkspaceStore((s) => s.appSettings.sprintEngineRoleSettings)
  // The Mobile tab gates on the mobile-relay module; hide it when disabled.
  const mobileRelayEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'mobile-relay'))
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)
  // Module-contributed sections render after every built-in tab, in the
  // registry's stable order (order hint, then id). Disabling a module drops
  // its section reactively; persisted values stay in the module namespace.
  const moduleSections = useMemo(
    () => getRendererHost().getSettingsSections((moduleId) => selectModuleEnabled(moduleEnablement, moduleId)),
    [moduleEnablement],
  )
  const visibleSettingsTabs = useMemo(
    (): SettingsTabDescriptor[] => [
      ...settingsTabs.filter((tab) => tab.id !== 'mobile' || mobileRelayEnabled),
      ...moduleSections.map((section) => ({
        id: moduleSectionTabId(section.id),
        label: section.label,
        description: section.description ?? `From the ${section.moduleId} module`,
        moduleSection: section,
      })),
    ],
    [mobileRelayEnabled, moduleSections]
  )
  const appearanceTheme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const setAppearanceTheme = useWorkspaceStore((s) => s.setAppearanceTheme)
  const appearanceWindowMaterial = useWorkspaceStore(
    (s) => s.appSettings.appearance.windowMaterial
  )
  const setAppearanceWindowMaterial = useWorkspaceStore((s) => s.setAppearanceWindowMaterial)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const setUsageTelemetrySettings = useWorkspaceStore((s) => s.setUsageTelemetrySettings)
  const keepRunningInBackground = useWorkspaceStore((s) => s.appSettings.keepRunningInBackground)
  const setKeepRunningInBackground = useWorkspaceStore((s) => s.setKeepRunningInBackground)
  const setSprintEngineRoleEnabled = useWorkspaceStore((s) => s.setSprintEngineRoleEnabled)
  const activeKnowledgeConfig = resolveProjectKnowledgeConfig(
    activeWorkspace?.folderPath,
    projectKnowledgeRoots,
    activeWorkspace?.memory.relativeRoot
  )
  const activeProjectRoot = activeKnowledgeConfig?.projectRoot ?? activeWorkspace?.folderPath ?? null
  const activeSprintEngineRoot = activeWorkspace?.folderPath ?? null
  const isWindows = window.api.platform === 'win32'
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null)
  const [updateActionPending, setUpdateActionPending] = useState(false)
  const [githubTokenStatus, setGithubTokenStatus] = useState<GitHubTokenUiStatus | null>(null)
  const [githubTokenDraft, setGithubTokenDraft] = useState('')
  const [githubTokenMessage, setGithubTokenMessage] = useState('')
  const [githubTokenPending, setGithubTokenPending] = useState(false)
  // True while the user is replacing an already-saved token; the write-only
  // input only renders when there is nothing saved or a replace is underway.
  const [githubTokenEditing, setGithubTokenEditing] = useState(false)
  const [activityInstalled, setActivityInstalled] = useState(false)
  const [activityPending, setActivityPending] = useState(false)
  const [activityMessage, setActivityMessage] = useState<string | null>(null)
  const [roleRegistry, setRoleRegistry] = useState<SprintEngineRoleRegistry | null>(null)
  const [roleRegistryStatus, setRoleRegistryStatus] = useState<RoleRegistryStatus>('idle')
  const [roleRegistryMessage, setRoleRegistryMessage] = useState<string | null>(null)
  const [roleInstallPending, setRoleInstallPending] = useState(false)
  const [roleInstallMessage, setRoleInstallMessage] = useState<RoleInstallMessage>(null)
  const [cliInstallPending, setCliInstallPending] = useState(false)
  const [cliInstallMessage, setCliInstallMessage] = useState<RoleInstallMessage>(null)
  // The CLI card whose detail panel is open (null = grid only). `installIntentId`
  // marks a card whose Install button was pressed, so its detail opens straight
  // into the install flow.
  const [selectedCliId, setSelectedCliId] = useState<string | null>(null)
  const [installIntentId, setInstallIntentId] = useState<string | null>(null)
  const [userRoles, setUserRoles] = useState<Array<{ id: string; label: string; description?: string }>>([])
  const [globalInstallPending, setGlobalInstallPending] = useState(false)
  const [globalInstallMessage, setGlobalInstallMessage] = useState<RoleInstallMessage>(null)
  // Custom-role authoring form. `null` = closed; otherwise create or edit a single
  // user-authored role. The lifecycle reducer (idle/validating/saving/saved/error)
  // is owned by the DOM-free view-model so it stays unit-testable.
  const [roleAuthoring, setRoleAuthoring] = useState<{ mode: RoleAuthoringMode; draft: RoleAuthoringDraft } | null>(null)
  const [roleAuthoringStatus, dispatchRoleAuthoring] = React.useReducer(authoringStatusReducer, idleAuthoringStatus)
  const [roleEditLoadingId, setRoleEditLoadingId] = useState<string | null>(null)
  const [userRoleDeletePendingId, setUserRoleDeletePendingId] = useState<string | null>(null)
  const [userRoleMessage, setUserRoleMessage] = useState<RoleInstallMessage>(null)
  // Built-in tab ids plus `module-section:<id>` for contributed sections. An
  // initialTab may name either; unknown values fall back to the default tab.
  // (Deep-links to the folded MCPs / Skill packs / Extensions tabs are routed to
  // the Connectors surface upstream in the store, so they never reach here.)
  const [activeSettingsTab, setActiveSettingsTab] = useState<string>(() => {
    const resolved = resolveInitialSettingsTab(initialTab)
    if (isSettingsTabId(resolved)) return resolved
    // A deep-link may land on a contributed section (the voice-dictation tab
    // since MC-1861); a section that isn't actually visible falls back to the
    // first visible tab via the effect below.
    if (typeof resolved === 'string' && resolved.startsWith(MODULE_SECTION_TAB_PREFIX)) return resolved
    return 'general'
  })

  useEffect(() => {
    const resolved = resolveInitialSettingsTab(initialTab)
    if (
      isSettingsTabId(resolved) ||
      (typeof resolved === 'string' && resolved.startsWith(MODULE_SECTION_TAB_PREFIX))
    ) {
      setActiveSettingsTab(resolved)
      window.requestAnimationFrame(() => tabRefs.current[resolved]?.focus())
    }
  }, [initialTab])

  // Refresh CLI detection when the Agents tab opens so every row shows current
  // status. Cache-respecting (no force), so it's a cheap no-op when fresh.
  useEffect(() => {
    if (activeSettingsTab !== 'agents') return
    void refreshCliAvailability({ cliRuntimes })
  }, [activeSettingsTab, refreshCliAvailability, cliRuntimes])

  // The band's freshness meta has to age or it lies: "Checked just now" would
  // stay on screen for an hour. Re-read the clock every 30s while the tab is
  // open (and immediately on a new probe) — enough to keep the minute honest,
  // cheap enough not to matter.
  const [agentsFreshnessNow, setAgentsFreshnessNow] = useState(() => Date.now())
  useEffect(() => {
    if (activeSettingsTab !== 'agents') return
    setAgentsFreshnessNow(Date.now())
    const tick = window.setInterval(() => setAgentsFreshnessNow(Date.now()), 30_000)
    return () => window.clearInterval(tick)
  }, [activeSettingsTab, cliAvailabilityCheckedAt])

  // If the active tab is no longer visible (e.g. the Mobile module was disabled
  // while its tab was active), fall back to the first visible tab so the panel
  // body never goes blank on a hidden tab.
  useEffect(() => {
    if (!visibleSettingsTabs.some((tab) => tab.id === activeSettingsTab)) {
      setActiveSettingsTab(visibleSettingsTabs[0]?.id ?? 'general')
    }
  }, [visibleSettingsTabs, activeSettingsTab])
  // Keyed by tab id; contributed `module-section:*` ids join the built-ins, so
  // the map is open-keyed rather than a closed SettingsTabId record.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const autoCheckStartedRef = useRef(false)
  const lastUpdateRequestIdRef = useRef<number | null>(null)

  // Knowledge-graph activity tracking is workspace-scoped: probe install state
  // when a workspace is open, and reset it otherwise. (Built-in skills moved to
  // the Connectors surface with the folded MCPs/Skill packs/Extensions tabs.)
  useEffect(() => {
    let cancelled = false
    setActivityMessage(null)
    if (!activeProjectRoot) {
      setActivityInstalled(false)
      return
    }
    void window.api
      .memoryActivityIsInstalled({ workspaceRoot: activeProjectRoot })
      .then((installed) => {
        if (!cancelled) setActivityInstalled(installed)
      })
    return () => {
      cancelled = true
    }
  }, [activeProjectRoot])

  const toggleActivityTracking = useCallback(
    async (next: boolean) => {
      if (!activeProjectRoot) return
      const memoryRoot = activeKnowledgeConfig?.relativeRoot ?? null
      if (next && !memoryRoot) {
        setActivityMessage('Configure a knowledge folder before enabling activity tracking.')
        return
      }
      if (next) {
        const confirmed = await dialog.confirm({
          title: 'Enable activity tracking?',
          body: (
            <>
              <div>What happens:</div>
              <ul className="mt-1 list-disc pl-5">
                <li>Add a hook to <span className="font-mono">.claude/settings.local.json</span> in the project folder</li>
                <li>Copy a hook script to <span className="font-mono">.multicode/hooks/</span></li>
                <li>Record knowledge file touches to <span className="font-mono">.multicode/knowledge-trace/</span></li>
              </ul>
              <div className="mt-2">Only files under your knowledge folder are recorded. Add <span className="font-mono">.multicode/</span> to <span className="font-mono">.gitignore</span>.</div>
            </>
          ),
          confirmLabel: 'Enable tracking',
        })
        if (!confirmed) return
      }
      setActivityPending(true)
      setActivityMessage(null)
      try {
        if (next) {
          const result = await window.api.memoryActivityInstall({
            workspaceRoot: activeProjectRoot,
            memoryRelativeRoot: memoryRoot,
          })
          if (result.ok) {
            setActivityInstalled(true)
          } else {
            setActivityMessage(result.message)
          }
        } else {
          const result = await window.api.memoryActivityUninstall({
            workspaceRoot: activeProjectRoot,
          })
          if (result.ok) {
            setActivityInstalled(false)
          } else {
            setActivityMessage(result.message)
          }
        }
      } catch (error) {
        setActivityMessage(
          error instanceof Error ? error.message : 'Failed to update activity tracking.'
        )
      } finally {
        setActivityPending(false)
      }
    },
    [activeKnowledgeConfig?.relativeRoot, activeProjectRoot]
  )

  useEffect(() => {
    let cancelled = false
    void window.api.getGitHubTokenStatus().then((status) => {
      if (!cancelled) setGithubTokenStatus(status)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.updateGetState().then((state) => {
      if (!cancelled) setUpdateState(state)
    })
    const unsubscribe = window.api.onUpdateStateChanged((state) => setUpdateState(state))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const checkForUpdates = useCallback(async () => {
    setUpdateActionPending(true)
    try {
      const result = await window.api.updateCheck()
      setUpdateState(result.state)
    } finally {
      setUpdateActionPending(false)
    }
  }, [])

  // Profile actions — thin wrappers over the same auth IPC the sidebar account
  // menu uses, kept local so the Settings panel needs no auth props threaded in.
  const onProfileSignIn = useCallback(async () => {
    setProfileMessage('Opening sign-in.')
    setProfilePending(true)
    try {
      await window.api.authLogin(authState.selectedOrganization?.id ?? null)
      setProfileMessage(null)
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setProfilePending(false)
    }
  }, [authState.selectedOrganization?.id])

  const onProfileRefresh = useCallback(async () => {
    setProfileMessage('Checking access.')
    setProfilePending(true)
    try {
      setAuthState(await window.api.authRefreshEntitlements())
      setProfileMessage(null)
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setProfilePending(false)
    }
  }, [setAuthState])

  const onProfileSignOut = useCallback(async () => {
    setProfilePending(true)
    try {
      await window.api.authLogout()
      setProfileMessage(null)
    } finally {
      setProfilePending(false)
    }
  }, [])

  const onProfileUpgrade = useCallback(() => {
    void window.api.authOpenUpgrade('sprintengine')
  }, [])

  useEffect(() => {
    if (typeof checkForUpdatesRequestId === 'number') {
      if (lastUpdateRequestIdRef.current === checkForUpdatesRequestId) return
      lastUpdateRequestIdRef.current = checkForUpdatesRequestId
      void checkForUpdates()
      return
    }

    if (!checkForUpdatesOnOpen || autoCheckStartedRef.current) return
    autoCheckStartedRef.current = true
    void checkForUpdates()
  }, [checkForUpdates, checkForUpdatesOnOpen, checkForUpdatesRequestId])

  const downloadUpdate = useCallback(async () => {
    setUpdateActionPending(true)
    try {
      const result = await window.api.updateDownload()
      setUpdateState(result.state)
    } finally {
      setUpdateActionPending(false)
    }
  }, [])

  const restartToInstall = useCallback(async () => {
    const result = await window.api.updateQuitAndInstall()
    setUpdateState(result.state)
  }, [])

  const saveGitHubToken = useCallback(async () => {
    const token = githubTokenDraft.trim()
    if (!token) {
      setGithubTokenMessage('Paste a token before saving.')
      return
    }

    setGithubTokenPending(true)
    setGithubTokenMessage('')
    try {
      const status = await window.api.setGitHubToken(token)
      setGithubTokenStatus(status)
      setGithubTokenDraft('')
      setGithubTokenEditing(false)
      setGithubTokenMessage('Saved. Switchboard can now import private GitHub issues.')
    } catch (error) {
      setGithubTokenMessage(error instanceof Error ? error.message : 'Could not save the GitHub token.')
    } finally {
      setGithubTokenPending(false)
    }
  }, [githubTokenDraft])

  const clearGitHubToken = useCallback(async () => {
    setGithubTokenPending(true)
    setGithubTokenMessage('')
    try {
      const status = await window.api.clearGitHubToken()
      setGithubTokenStatus(status)
      setGithubTokenDraft('')
      setGithubTokenEditing(false)
      setGithubTokenMessage(status.configured && status.source === 'environment'
        ? 'Saved token cleared. GitHub imports are still using a token from the environment.'
        : 'GitHub token cleared.')
    } catch (error) {
      setGithubTokenMessage(error instanceof Error ? error.message : 'Could not clear the GitHub token.')
    } finally {
      setGithubTokenPending(false)
    }
  }, [])

  const nextUpdateAction: UpdateAction = updateState?.downloaded
    ? 'restart'
    : updateState?.status === 'available'
      ? 'download'
      : 'check'

  // Write-only token entry: render the input only when nothing is saved or the
  // user is replacing; a saved token reads as meta text plus Replace/Clear.
  const githubTokenInputVisible =
    githubTokenStatus !== null && (githubTokenEditing || !githubTokenStatus.configured)

  const activeTab = visibleSettingsTabs.find((tab) => tab.id === activeSettingsTab) ?? visibleSettingsTabs[0]
  const registryRoles = orderedSprintEngineRoles(roleRegistry)

  const idleSuspendDescriptor = getSettingDescriptor('terminal-idle-suspend-minutes')
  const keepRecentAliveDescriptor = getSettingDescriptor('terminal-keep-recent-alive')
  const backgroundModeDescriptor = getSettingDescriptor('keep-running-in-background')
  const telemetrySendDescriptor = getSettingDescriptor('usage-telemetry-send-data')
  const telemetryLocalDescriptor = getSettingDescriptor('usage-telemetry-local-export')
  const telemetryDiagnosticsDescriptor = getSettingDescriptor('usage-telemetry-export-diagnostics')

  const loadSprintEngineRoles = useCallback(async () => {
    if (!activeSprintEngineRoot) {
      setRoleRegistry(null)
      setRoleRegistryStatus('unavailable')
      setRoleRegistryMessage('Open a workspace folder before managing Sprint Engine roles.')
      return
    }
    if (typeof window.api.readSprintEngineRegistryRoles !== 'function') {
      setRoleRegistry(null)
      setRoleRegistryStatus('unavailable')
      setRoleRegistryMessage('This build does not expose Sprint Engine role registry reads.')
      return
    }
    setRoleRegistryStatus('loading')
    setRoleRegistryMessage(null)
    try {
      const result = await window.api.readSprintEngineRegistryRoles({
        workspaceRoot: activeSprintEngineRoot,
        includeShadowed: true,
      })
      if (!result.ok) {
        setRoleRegistry(null)
        setRoleRegistryStatus('unavailable')
        setRoleRegistryMessage(result.message || 'Sprint Engine role registry is unavailable.')
        return
      }
      const nextRegistry = buildSprintEngineRoleRegistry(result.data)
      setRoleRegistry(nextRegistry)
      setRoleRegistryStatus('ready')
      setRoleRegistryMessage(
        nextRegistry.warnings.length
          ? `${nextRegistry.warnings.length} registry warning${nextRegistry.warnings.length === 1 ? '' : 's'} found.`
          : null,
      )
    } catch (error) {
      setRoleRegistry(null)
      setRoleRegistryStatus('unavailable')
      setRoleRegistryMessage(error instanceof Error ? error.message : 'Sprint Engine role registry failed to load.')
    }
  }, [activeSprintEngineRoot])

  useEffect(() => {
    void loadSprintEngineRoles()
  }, [loadSprintEngineRoles])

  const installSprintEngineRoleFolder = useCallback(async () => {
    if (!activeSprintEngineRoot) {
      setRoleInstallMessage({
        tone: 'warn',
        text: 'Open a workspace folder before installing Sprint Engine roles.',
      })
      return
    }
    setRoleInstallPending(true)
    setRoleInstallMessage(null)
    try {
      const selectedFolder = await window.api.openDir()
      if (!selectedFolder) {
        setRoleInstallMessage(null)
        return
      }
      const sprintEngineDir = await window.api.ensureDir(activeSprintEngineRoot, '.sprintengine')
      const rolesDir = await window.api.ensureDir(sprintEngineDir, 'roles')
      const skillsDir = await window.api.ensureDir(sprintEngineDir, 'skills')
      const targets = await resolveSprintEngineRoleInstallTargets(selectedFolder)
      for (const target of targets) {
        const destinationDir = target.destinationKind === 'roles'
          ? rolesDir
          : skillsDir
        await window.api.copyPathInto(target.sourcePath, destinationDir, { overwrite: true })
      }
      setRoleInstallMessage({
        tone: 'info',
        text: 'Role registry files installed into .sprintengine/roles and .sprintengine/skills with matching names. Reloaded registry from the workspace source.',
      })
      await loadSprintEngineRoles()
    } catch (error) {
      setRoleInstallMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Role folder install failed.',
      })
    } finally {
      setRoleInstallPending(false)
    }
  }, [activeSprintEngineRoot, loadSprintEngineRoles])

  const installCliFromFolder = useCallback(async () => {
    if (typeof window.api.installPluginFolder !== 'function') {
      setCliInstallMessage({ tone: 'warn', text: 'Installing CLI plugins is not supported by this build.' })
      return
    }
    setCliInstallPending(true)
    setCliInstallMessage(null)
    try {
      const folder = await window.api.openDir()
      if (!folder) {
        setCliInstallMessage(null)
        return
      }
      const result = await window.api.installPluginFolder(folder)
      if (!result.ok) {
        const detail = result.issues?.length
          ? ` (${result.issues.map((issue) => issue.message).join('; ')})`
          : ''
        setCliInstallMessage({ tone: 'error', text: `${result.message}${detail}` })
        return
      }
      setCliInstallMessage({
        tone: 'info',
        text: `Installed "${result.displayName}". It's available to assign to agents now.`,
      })
      await refreshPluginCatalog()
    } catch (error) {
      setCliInstallMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'CLI folder install failed.',
      })
    } finally {
      setCliInstallPending(false)
    }
  }, [refreshPluginCatalog])

  const loadUserRoles = useCallback(async () => {
    if (typeof window.api.listUserSprintEngineRoles !== 'function') return
    try {
      const result = await window.api.listUserSprintEngineRoles()
      setUserRoles(result.roles)
    } catch {
      // Listing is best-effort; the install flow surfaces actionable errors.
    }
  }, [])

  useEffect(() => {
    void loadUserRoles()
  }, [loadUserRoles])

  const installGlobalRoleFolder = useCallback(async () => {
    if (typeof window.api.installUserSprintEngineRoleFolder !== 'function') return
    setGlobalInstallPending(true)
    setGlobalInstallMessage(null)
    try {
      const selectedFolder = await window.api.openDir()
      if (!selectedFolder) return
      const result = await window.api.installUserSprintEngineRoleFolder(selectedFolder)
      const installed = result.installedRoles.length
      const rejected = result.rejected.length
      if (!result.ok && installed === 0) {
        const reason = result.message
          ?? (rejected > 0
            ? `${rejected} manifest${rejected === 1 ? '' : 's'} rejected as invalid.`
            : 'Nothing to install.')
        setGlobalInstallMessage({ tone: 'error', text: reason })
      } else {
        const parts = [`${installed} role${installed === 1 ? '' : 's'} installed`]
        if (result.installedSkills.length > 0) {
          parts.push(`${result.installedSkills.length} skill${result.installedSkills.length === 1 ? '' : 's'}`)
        }
        if (rejected > 0) parts.push(`${rejected} rejected`)
        setGlobalInstallMessage({
          tone: rejected > 0 ? 'warn' : 'info',
          text: `${parts.join(', ')}. Reload to pick up new roles in open workspaces.`,
        })
      }
      await loadUserRoles()
    } catch (error) {
      setGlobalInstallMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Install failed.',
      })
    } finally {
      setGlobalInstallPending(false)
    }
  }, [loadUserRoles])

  // True only on builds whose preload exposes the T2 authoring bridge; gates the
  // Create/Edit/Delete affordances so an older renderer degrades to read-only.
  const userRoleAuthoringSupported = typeof window.api.saveUserSprintEngineRole === 'function'

  // Every id and alias already registered (any layer) plus the user-authored ids,
  // so create-mode collision detection rejects a new id that would shadow an
  // existing role. Edit locks its own id, so self-collision never triggers.
  const existingRoleKeys = useMemo(() => {
    const keys = new Set<string>()
    if (roleRegistry) {
      for (const id of Object.keys(roleRegistry.roles)) keys.add(id)
      for (const alias of Object.keys(roleRegistry.aliases)) keys.add(alias)
    }
    for (const role of userRoles) keys.add(role.id)
    return keys
  }, [roleRegistry, userRoles])

  const openCreateRole = useCallback(() => {
    setUserRoleMessage(null)
    dispatchRoleAuthoring({ type: 'reset' })
    setRoleAuthoring({ mode: { kind: 'create' }, draft: createRoleAuthoringDraft() })
  }, [])

  const openEditRole = useCallback(async (id: string) => {
    if (typeof window.api.getUserSprintEngineRole !== 'function') return
    setUserRoleMessage(null)
    setRoleEditLoadingId(id)
    try {
      const result = await window.api.getUserSprintEngineRole(id)
      if (result.ok) {
        dispatchRoleAuthoring({ type: 'reset' })
        setRoleAuthoring({ mode: { kind: 'edit', id }, draft: editRoleAuthoringDraft(result.manifest, result.body) })
      } else {
        setUserRoleMessage({ tone: 'error', text: `Could not open "${id}" for editing; its manifest may be invalid on disk.` })
      }
    } catch (error) {
      setUserRoleMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Could not load the role for editing.' })
    } finally {
      setRoleEditLoadingId(null)
    }
  }, [])

  const closeRoleAuthoring = useCallback(() => {
    setRoleAuthoring(null)
    dispatchRoleAuthoring({ type: 'reset' })
  }, [])

  // Mutating the open draft re-derives the form; the lifecycle drops back to idle
  // so a prior error/saved banner clears as soon as the author edits.
  const updateRoleDraft = useCallback((patch: Partial<RoleAuthoringDraft>) => {
    setRoleAuthoring((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))
    dispatchRoleAuthoring({ type: 'reset' })
  }, [])

  const submitRoleAuthoring = useCallback(async () => {
    if (!roleAuthoring || typeof window.api.saveUserSprintEngineRole !== 'function') return
    dispatchRoleAuthoring({ type: 'submit' })
    const validation = validateRoleAuthoringDraft(roleAuthoring.draft, {
      mode: roleAuthoring.mode,
      existingIdsAndAliases: existingRoleKeys,
    })
    if (!validation.ok) {
      dispatchRoleAuthoring({ type: 'invalid', errors: validation.errors })
      return
    }
    dispatchRoleAuthoring({ type: 'valid' })
    try {
      const result = await window.api.saveUserSprintEngineRole(validation.input)
      if (!result.ok) {
        dispatchRoleAuthoring({ type: 'failed', errors: mapIssuesToFieldErrors(result.issues ?? []) })
        return
      }
      const savedId = result.id ?? validation.input.id
      dispatchRoleAuthoring({ type: 'saved', id: savedId })
      // Reflect the new/edited role everywhere without a restart: the user-roles
      // list (Global section + roster wizard) and the live MCP registry.
      await Promise.all([loadUserRoles(), loadSprintEngineRoles()])
      setRoleAuthoring(null)
      setUserRoleMessage({
        tone: 'info',
        text: roleAuthoring.mode.kind === 'edit' ? `Saved changes to "${savedId}".` : `Created "${savedId}". Reload open workspaces to use it in a run.`,
      })
    } catch (error) {
      dispatchRoleAuthoring({ type: 'failed', errors: { form: error instanceof Error ? error.message : 'Save failed.' } })
    }
  }, [roleAuthoring, existingRoleKeys, loadUserRoles, loadSprintEngineRoles])

  const deleteUserRole = useCallback(async (id: string, label: string) => {
    if (typeof window.api.deleteUserSprintEngineRole !== 'function') return
    const confirmed = await dialog.confirm({
      title: `Delete "${label}"?`,
      body: (
        <>
          <div>This removes the custom role <span className="font-mono">{id}</span> and its soul document for every workspace.</div>
          <div className="mt-2">Runs already using it keep their copy; new runs will no longer see it.</div>
        </>
      ),
      confirmLabel: 'Delete role',
      tone: 'danger',
    })
    if (!confirmed) return
    setUserRoleDeletePendingId(id)
    setUserRoleMessage(null)
    try {
      const result = await window.api.deleteUserSprintEngineRole(id)
      if (result.ok) {
        if (roleAuthoring?.mode.kind === 'edit' && roleAuthoring.mode.id === id) closeRoleAuthoring()
        await Promise.all([loadUserRoles(), loadSprintEngineRoles()])
        setUserRoleMessage({ tone: 'info', text: `Deleted "${label}".` })
      } else {
        setUserRoleMessage({ tone: 'error', text: `Could not delete "${label}".` })
      }
    } catch (error) {
      setUserRoleMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Delete failed.' })
    } finally {
      setUserRoleDeletePendingId(null)
    }
  }, [dialog, roleAuthoring, closeRoleAuthoring, loadUserRoles, loadSprintEngineRoles])

  const selectSettingsTab = useCallback((tabId: string) => {
    setActiveSettingsTab(tabId)
  }, [])

  const onSettingsTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keyToIndex: Record<string, number> = {
      ArrowDown: (index + 1) % visibleSettingsTabs.length,
      ArrowRight: (index + 1) % visibleSettingsTabs.length,
      ArrowUp: (index - 1 + visibleSettingsTabs.length) % visibleSettingsTabs.length,
      ArrowLeft: (index - 1 + visibleSettingsTabs.length) % visibleSettingsTabs.length,
      Home: 0,
      End: visibleSettingsTabs.length - 1,
    }
    const nextIndex = keyToIndex[event.key]
    if (nextIndex === undefined) return
    event.preventDefault()
    const nextTab = visibleSettingsTabs[nextIndex]
    setActiveSettingsTab(nextTab.id)
    window.requestAnimationFrame(() => tabRefs.current[nextTab.id]?.focus())
  }, [visibleSettingsTabs])

  // Flat index into visibleSettingsTabs for roving focus; the grouped rail
  // renders in the same order, so arrow keys move in visual order.
  const tabIndexById = new Map(visibleSettingsTabs.map((tab, index) => [tab.id, index] as const))
  // Module-contributed sections trail the built-in groups as one final group.
  // (The built-in Extensions tab folded into the Connectors surface — T3.)
  const moduleSectionTabs = visibleSettingsTabs.filter((tab) => tab.moduleSection)
  const railGroups = [
    ...settingsTabGroups
      .map((group) => ({
        label: group.label,
        tabs: group.ids
          .map((id) => visibleSettingsTabs.find((tab) => tab.id === id))
          .filter((tab): tab is SettingsTabDescriptor => tab !== undefined),
      }))
      .filter((group) => group.tabs.length > 0),
    ...(moduleSectionTabs.length > 0 ? [{ label: 'extensions', tabs: moduleSectionTabs }] : []),
  ]

  // Groups carry no printed header — they read as one list separated by a
  // whitespace gap (Cursor-parity). `label` stays as the React key only.
  const sidebarNode = (
    <div role="tablist" aria-label="Settings categories" aria-orientation="vertical">
      {railGroups.map((group) => (
        <div key={group.label} className="mt-3 first:mt-0">
          <div className="grid grid-cols-2 gap-0.5 md:grid-cols-1">
            {group.tabs.map((tab) => (
              <SettingsTabButton
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tab.id] = node
                }}
                tab={tab}
                active={activeSettingsTab === tab.id}
                onClick={() => selectSettingsTab(tab.id)}
                onKeyDown={(event) => onSettingsTabKeyDown(event, tabIndexById.get(tab.id) ?? 0)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )

  // Form tabs read in a capped measure; catalog/table tabs (tile grids, the
  // shortcuts editor, Learn) keep the full panel width.
  const fullWidthTab = activeTab.id === 'shortcuts' || activeTab.id === 'learn'

  const bodyContent = (
    <div className={fullWidthTab ? undefined : 'mx-auto max-w-[640px]'}>
      {/* Built-in tabs self-title via their own section headings and the rail
          orientation, so they take no page header. Module-contributed sections
          render a third-party component with no title of its own, so the host
          supplies the section's heading (icon + label) here. */}
      {activeTab.moduleSection ? (
        <header className="mb-4 border-b border-[color:var(--border-subtle)] pb-3">
          <h3 className="flex items-center gap-2 text-title font-semibold text-[color:var(--text-strong)]">
            <activeTab.moduleSection.icon className="icon-md shrink-0" aria-hidden="true" />
            {activeTab.label}
          </h3>
          {activeTab.description ? (
            <p className="mt-1 text-body text-[color:var(--text-muted)]">
              {activeTab.description}
            </p>
          ) : null}
        </header>
      ) : null}

      {activeSettingsTab === 'appearance' ? (
        <div
          role="tabpanel"
          id="settings-panel-appearance"
          aria-labelledby="settings-tab-appearance"
          className="space-y-4"
        >
          <div className="space-y-2">
            <SettingsSectionTitle>Theme</SettingsSectionTitle>
            <p className="text-body leading-5 text-[color:var(--text-muted)]">
              Theme applies across every workspace and panel. Every theme is anti-temporal-dither baseline (channel values are multiples of 4) so surfaces don&apos;t flicker on 6-bit-FRC panels. &lsquo;Match system&rsquo; follows your operating system&apos;s light or dark preference.
            </p>
          </div>
          <AppThemePicker value={appearanceTheme} onChange={setAppearanceTheme} />
          {window.api.platform === 'darwin' ? (
            <div className="space-y-2">
              <SettingsSectionTitle>Window material</SettingsSectionTitle>
              {/* A value choice, so the kit's segmented control: one tab stop,
                  arrow keys, and a neutral selected segment — not an
                  aria-pressed pair painted with the accent. */}
              <SegmentedControl<'solid' | 'glass'>
                ariaLabel="Window material"
                items={[
                  { value: 'solid', label: 'Solid' },
                  { value: 'glass', label: 'Glass' },
                ]}
                value={appearanceWindowMaterial}
                onChange={setAppearanceWindowMaterial}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {activeSettingsTab === 'profile' ? (
        <div
          role="tabpanel"
          id="settings-panel-profile"
          aria-labelledby="settings-tab-profile"
          className="space-y-4"
        >
          <ProfileSection
            authState={authState}
            message={profileMessage}
            pending={profilePending}
            onSignIn={() => void onProfileSignIn()}
            onSignOut={() => void onProfileSignOut()}
            onRefresh={() => void onProfileRefresh()}
            onUpgrade={onProfileUpgrade}
          />
        </div>
      ) : null}

      {activeSettingsTab === 'general' ? (
        <div
          role="tabpanel"
          id="settings-panel-general"
          aria-labelledby="settings-tab-general"
          className="space-y-8"
        >
          <section className="space-y-4">
            <SettingsSectionTitle>Updates</SettingsSectionTitle>
            {/* Identity row with one state-driven action: the update flow is a
                line (check → download → restart), so only the current step's
                action renders instead of three buttons with two disabled. */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] pb-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <SprintEngineFrond tone="current" className="icon-md shrink-0" />
                <div className="min-w-0">
                  <div className="text-body font-medium text-[color:var(--text-strong)]">
                    Sprint Engine Studio <span className="tabular-nums">{updateState?.version ?? '…'}</span>
                  </div>
                  <div className="mt-0.5 text-body text-[color:var(--text-muted)]">
                    {formatUpdateChannel(updateState?.channel)} channel · last checked {formatNullableDate(updateState?.lastCheckedAt)}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <GhostButton size="md" onClick={() => void window.api.updateOpenReleaseNotes()}>
                  Release notes
                </GhostButton>
                {updateState && !updateState.packaged ? null : nextUpdateAction === 'restart' ? (
                  <PrimaryButton size="md" onClick={() => void restartToInstall()} disabled={updateActionPending}>
                    Restart to install
                  </PrimaryButton>
                ) : nextUpdateAction === 'download' ? (
                  <PrimaryButton
                    size="md"
                    onClick={() => void downloadUpdate()}
                    disabled={updateActionPending || updateState?.status === 'downloading'}
                  >
                    {updateState?.updateVersion ? `Download ${updateState.updateVersion}` : 'Download update'}
                  </PrimaryButton>
                ) : (
                  <OutlineButton
                    size="md"
                    onClick={() => void checkForUpdates()}
                    disabled={updateActionPending || updateState?.status === 'checking' || updateState?.status === 'downloading'}
                  >
                    {updateState?.status === 'error' ? 'Retry check' : 'Check for updates'}
                  </OutlineButton>
                )}
              </div>
            </div>

            <p
              className={`text-body leading-5 ${
                updateState?.status === 'error'
                  ? 'text-[color:var(--tone-error)]'
                  : 'text-[color:var(--text-muted)]'
              }`}
            >
              {formatUpdateStatus(updateState)}
            </p>
            {updateState?.progress ? (
              <div className="h-1 overflow-hidden rounded-full bg-[color:var(--bg-active)]">
                <div
                  className="h-full rounded-full bg-[color:var(--accent-primary)]"
                  style={{ width: `${Math.max(0, Math.min(100, updateState.progress.percent))}%` }}
                />
              </div>
            ) : null}
          </section>

          <section className="space-y-4">
            <SettingsSectionTitle>Background</SettingsSectionTitle>
            <div className="divide-y divide-[color:var(--border-subtle)]">
              {backgroundModeDescriptor ? (
                <RegistrySwitchRow
                  descriptor={backgroundModeDescriptor}
                  checked={keepRunningInBackground}
                  onChange={(enabled) => setKeepRunningInBackground(enabled)}
                />
              ) : null}
            </div>
          </section>

          <section className="space-y-4">
            <SettingsSectionTitle>Privacy &amp; telemetry</SettingsSectionTitle>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 text-title font-semibold text-[color:var(--text-strong)]">
                SprintEngine usage data and diagnostics
              </div>
              <StatusTag
                tone={import.meta.env.DEV ? 'warn' : 'neutral'}
                label={import.meta.env.DEV ? 'Development build' : 'Production build'}
              />
            </div>

            <div className="divide-y divide-[color:var(--border-subtle)]">
              {telemetrySendDescriptor ? (
                <RegistrySwitchRow
                  descriptor={telemetrySendDescriptor}
                  checked={usageTelemetry.sendUsageData}
                  onChange={(enabled) => setUsageTelemetrySettings({ sendUsageData: enabled })}
                />
              ) : null}
              {telemetryLocalDescriptor ? (
                <RegistrySwitchRow
                  descriptor={telemetryLocalDescriptor}
                  checked={usageTelemetry.localDevExportEnabled}
                  onChange={(enabled) => setUsageTelemetrySettings({ localDevExportEnabled: enabled })}
                />
              ) : null}
              {telemetryDiagnosticsDescriptor ? (
                <RegistrySwitchRow
                  descriptor={telemetryDiagnosticsDescriptor}
                  checked={usageTelemetry.exportDiagnostics}
                  onChange={(enabled) => setUsageTelemetrySettings({ exportDiagnostics: enabled })}
                />
              ) : null}
            </div>

            <p className="text-body leading-5 text-[color:var(--text-muted)]">
              Raw source, prompts, transcripts, artifact bodies, descriptions, notes, and file contents are not collected by default.
              Production upload is separate from local export and remains disabled until you turn on Send anonymous usage data.
            </p>

            <div className="grid gap-x-6 gap-y-3 border-t border-[color:var(--border-subtle)] pt-4 text-body sm:grid-cols-2">
              <MetaCell label="Last local export" value={formatNullableDate(usageTelemetry.lastExportAt)} />
              <MetaCell
                label="Upload consent"
                value={usageTelemetry.sendUsageData ? 'Enabled' : 'Disabled'}
                tone={usageTelemetry.sendUsageData ? 'positive' : undefined}
              />
            </div>
          </section>
        </div>
      ) : null}

      {activeSettingsTab === 'github' ? (
        <div
          role="tabpanel"
          id="settings-panel-github"
          aria-labelledby="settings-tab-github"
        >
          <VersionControlSections
            githubToken={
              <div className="space-y-2">
                <SettingsRow
                  label="Access token"
                  // No caption: the row above already names the provider and its
                  // state, and what a GitHub token is needs no explaining. The
                  // one line that survives is a consequence the screen cannot
                  // show — that without secure storage the token does not
                  // outlive the session — and it appears only when true.
                  help={
                    githubTokenStatus && !githubTokenStatus.encryptionAvailable
                      ? 'Secure storage is unavailable, so this is kept for the current session only.'
                      : undefined
                  }
                  htmlFor={githubTokenInputVisible ? 'github-token-input' : undefined}
                >
                  {githubTokenInputVisible ? (
                    <>
                      <Input
                        id="github-token-input"
                        type="password"
                        value={githubTokenDraft}
                        onChange={(event) => setGithubTokenDraft(event.target.value)}
                        placeholder="Fine-grained GitHub token"
                        autoComplete="off"
                        size="md"
                        variant="well"
                        fullWidth={false}
                        className={ROW_FIELD}
                      />
                      {/* Cancel before Save — the shared order every other
                          dialog and editor in the app uses (the role editor
                          above, `Modal.Footer`, `ConfirmDialog`). This row was
                          the one place that flipped it, so the confirming
                          button moved under the pointer depending on which
                          surface you were on (MC-2117). */}
                      {githubTokenStatus?.configured ? (
                        <GhostButton
                          size="md"
                          onClick={() => {
                            setGithubTokenEditing(false)
                            setGithubTokenDraft('')
                          }}
                        >
                          Cancel
                        </GhostButton>
                      ) : null}
                      <PrimaryButton
                        size="md"
                        onClick={() => void saveGitHubToken()}
                        disabled={githubTokenPending || !githubTokenDraft.trim()}
                      >
                        Save
                      </PrimaryButton>
                    </>
                  ) : (
                    <>
                      <span className="text-body font-medium text-[color:var(--text-default)]">
                        {formatGitHubTokenStatus(githubTokenStatus)}
                      </span>
                      <OutlineButton
                        size="md"
                        onClick={() => setGithubTokenEditing(true)}
                        disabled={githubTokenStatus === null}
                      >
                        Replace
                      </OutlineButton>
                      <OutlineButton
                        size="md"
                        onClick={() => void clearGitHubToken()}
                        disabled={githubTokenPending || githubTokenStatus?.source !== 'settings'}
                      >
                        Clear
                      </OutlineButton>
                    </>
                  )}
                </SettingsRow>

                {githubTokenMessage ? (
                  <p role="status" className="text-body leading-5 text-[color:var(--text-muted)]">
                    {githubTokenMessage}
                  </p>
                ) : null}
              </div>
            }
          />
        </div>
      ) : null}

      {activeSettingsTab === 'trackers' ? <TicketTrackersTab workspaceRoot={activeSprintEngineRoot} /> : null}

      {activeSettingsTab === 'agents' ? (
        <div
          role="tabpanel"
          id="settings-panel-agents"
          aria-labelledby="settings-tab-agents"
          className="space-y-3"
        >
          <AgentCliBand
            count={pluginCatalogStatus === 'ready' ? installedPluginRows.length : undefined}
            checkedAt={cliAvailabilityCheckedAt}
            now={agentsFreshnessNow}
            addPending={cliInstallPending}
            onAdd={() => void installCliFromFolder()}
            onRecheck={() => void refreshCliAvailability({ force: true, cliRuntimes })}
          />
          <ActionResultMessage message={cliInstallMessage} />
          {/* First-run agent-config adoption. It runs silently at the first
              workspace creation — the user is never asked — so this line is the
              only place it is ever reported. Renders nothing unless an adoption
              actually ran this session, and says so plainly when it failed. */}
          <AgentConfigAdoptionStatus adoption={agentConfigAdoptionResult} />
          {/* The batch availability probe failing is a different fact from a
              plugin registry failure, and until now it was surfaced nowhere at
              all: every row simply read "Not found". */}
          {cliAvailabilityStatus === 'error' && cliAvailabilityError ? (
            <InlineNotice tone="warn">{`Agent CLIs could not be checked: ${cliAvailabilityError}`}</InlineNotice>
          ) : null}

          {pluginCatalogStatus === 'loading' && installedPluginRows.length === 0 ? (
            <p className="text-body leading-5 text-[color:var(--text-muted)]">Loading installed agent plugins…</p>
          ) : pluginCatalogStatus === 'error' ? (
            // The failure carries its own recovery, per the notice contract —
            // a Retry parked below the message is a dead end with a button.
            <InlineNotice
              tone="error"
              title="The plugin registry could not be loaded."
              hint={pluginCatalogError ?? undefined}
              action={
                <OutlineButton size="md" onClick={() => void refreshPluginCatalog()}>
                  Retry
                </OutlineButton>
              }
            />
          ) : installedPluginRows.length === 0 ? (
            <EmptyState
              density="list"
              title="No agent plugins are installed."
              action={
                <OutlineButton size="md" onClick={() => void refreshPluginCatalog()}>
                  Refresh
                </OutlineButton>
              }
            />
          ) : (
            <div>
              {installedPluginRows.map((plugin) => {
                const override = cliRuntimeForPlugin(plugin.id, cliRuntimes)
                const declaredModels = plugin.modelSelection?.options ?? []
                const allowCustomModels = Boolean(plugin.modelSelection?.allowCustomId)
                const userModels = cliRuntimes?.[plugin.id]?.models ?? EMPTY_USER_MODELS
                const state = resolveCliProviderState(cliAvailability[plugin.id], cliAvailabilityStatus)
                return (
                  <ProviderRow
                    key={plugin.id}
                    icon={
                      <CliIcon
                        cli={plugin.id}
                        className="size-icon-lg text-[color:var(--text-default)]"
                      />
                    }
                    health={state.tone}
                    name={plugin.displayName}
                    version={state.version}
                    stateLine={
                      <>
                        <CliProviderStateLine
                          state={state}
                          binary={plugin.binary}
                          useWsl={override.useWsl}
                          // Deliberately not the reason: a failed batch probe
                          // wipes every entry, so the reason is one fact for the
                          // whole list and the section states it once below the
                          // band rather than nine times down the rows.
                          probeError={null}
                        />
                        {/* Provenance, only where it distinguishes: the retired
                            card stamped "Built-in" on all nine bundled rows,
                            which said nothing. A plugin the user installed from
                            a folder is the one this list cannot otherwise
                            explain. */}
                        {plugin.source === 'bundled' ? null : ' · installed from a folder'}
                      </>
                    }
                    expanded={selectedCliId === plugin.id}
                    onExpandedChange={(next) => {
                      setInstallIntentId(null)
                      setSelectedCliId(next ? plugin.id : null)
                    }}
                    // Install is offered only on a definitive negative probe. A
                    // CLI whose probe never completed may well be installed, so
                    // offering to install it would be a fake affordance — those
                    // rows say so on their state line and route to Re-check.
                    actions={
                      state.health === 'missing' ? (
                        <PrimaryButton
                          size="xs"
                          onClick={() => {
                            setInstallIntentId(plugin.id)
                            setSelectedCliId(plugin.id)
                          }}
                        >
                          Install
                        </PrimaryButton>
                      ) : null
                    }
                  >
                    {/* The per-instance form, in place: the install/detect
                        control, then how this CLI runs. The row above already
                        carries name, version, and state, so the control drops
                        its own name and status line rather than saying it
                        twice. */}
                    <CliInstallControl
                      cli={plugin.id}
                      displayName={plugin.displayName}
                      binary={plugin.binary}
                      command={override.command}
                      useWsl={override.useWsl}
                      showName={false}
                      showStatus={false}
                      autoOpenInstall={installIntentId === plugin.id}
                      onInstalled={(result) => {
                        if (result.resolvedPath && !override.command) {
                          setCliRuntime(plugin.id, { command: result.resolvedPath, useWsl: override.useWsl })
                        }
                        void refreshPluginCatalog()
                        // Force-refresh availability so the freshly installed CLI
                        // shows as detected on its row and in deployment pickers.
                        void refreshCliAvailability({ force: true, cliRuntimes })
                      }}
                    />

                    {declaredModels.length > 0 ? (
                      <div className="flex gap-2 text-body leading-5">
                        <span className="shrink-0 text-[color:var(--text-muted)]">Models</span>
                        <span className="min-w-0 font-mono text-[color:var(--text-default)]">
                          {declaredModels.map((model) => model.label ?? model.id).join(' · ')}
                        </span>
                      </div>
                    ) : null}

                    <div className="mt-2 divide-y divide-[color:var(--border-subtle)]">
                      <SettingsRow
                        label="Command override"
                        help={
                          <>
                            Runs <span className="font-mono text-[color:var(--text-default)]">{plugin.binary}</span> when blank.
                          </>
                        }
                        htmlFor={`cli-command-${plugin.id}`}
                      >
                        <Input
                          id={`cli-command-${plugin.id}`}
                          // Per-plugin accessible name so screen readers don't announce an
                          // identical "Command override" for every CLI.
                          aria-label={`${plugin.displayName} command override`}
                          value={override.command}
                          onChange={(event) => setCliRuntime(plugin.id, { command: event.target.value, useWsl: override.useWsl })}
                          placeholder={plugin.binary}
                          size="md"
                          variant="well"
                          fullWidth={false}
                          className={ROW_FIELD}
                        />
                      </SettingsRow>

                      {isWindows && (
                        <CompoundSwitchRow
                          label={`Run ${plugin.displayName} through WSL`}
                          checked={override.useWsl}
                          onChange={(enabled) => setCliRuntime(plugin.id, { command: override.command, useWsl: enabled })}
                        />
                      )}

                      {allowCustomModels ? (
                        <PluginModelSettings
                          displayName={plugin.displayName}
                          userModels={userModels}
                          onUserModelsChange={(models) => setCliRuntime(plugin.id, { models })}
                        />
                      ) : null}

                      {plugin.auth ? (
                        <CliCredentialRow
                          pluginId={plugin.id}
                          displayName={plugin.displayName}
                          label={plugin.auth.label}
                        />
                      ) : null}
                    </div>
                  </ProviderRow>
                )
              })}
            </div>
          )}

          {idleSuspendDescriptor ? (
            <div className="space-y-3 border-t border-[color:var(--border-subtle)] pt-4">
              <SettingsSectionTitle>Memory</SettingsSectionTitle>
              <p className="text-body leading-5 text-[color:var(--text-muted)]">
                Unused agent terminals are paused to free memory — their CLI process stops while the
                last screen stays painted, and they resume the moment you click or type. Agents
                waiting on you or actively working are never paused.
              </p>
              <IdleSuspendField descriptor={idleSuspendDescriptor} />
              {keepRecentAliveDescriptor ? (
                <KeepRecentAliveField descriptor={keepRecentAliveDescriptor} />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {activeSettingsTab === 'providers' ? <ProviderSettingsTab /> : null}

      {activeSettingsTab === 'roles' ? (
        <div
          role="tabpanel"
          id="settings-panel-roles"
          aria-labelledby="settings-tab-roles"
          className="space-y-5"
        >
          <div className="space-y-1">
            <SettingsSectionTitle
              count={roleRegistryStatus === 'ready' ? registryRoles.length : undefined}
              action={
                <PrimaryButton
                  size="md"
                  onClick={() => void installSprintEngineRoleFolder()}
                  disabled={roleInstallPending || !activeSprintEngineRoot}
                >
                  {roleInstallPending ? 'Installing' : 'Install folder'}
                </PrimaryButton>
              }
            >
              Workspace roles
            </SettingsSectionTitle>
            <p className="text-body leading-5 text-[color:var(--text-muted)]">
              Install accepts a registry folder, a roles folder of JSON manifests, or a skills folder of SKILL.md directories.
            </p>
          </div>

          {roleRegistryStatus === 'loading' ? (
            <p className="text-body leading-5 text-[color:var(--text-muted)]">
              Loading Sprint Engine roles from the workspace registry.
            </p>
          ) : null}

          {roleRegistryStatus === 'unavailable' ? (
            <InlineNotice tone="warn">
              {roleRegistryMessage ?? 'Sprint Engine role registry is unavailable for this workspace.'}
            </InlineNotice>
          ) : null}

          {roleRegistryStatus === 'ready' && registryRoles.length === 0 ? (
            <EmptyState
              density="list"
              title="No Sprint Engine roles were found in the registry for this workspace."
            />
          ) : null}

          {roleRegistryStatus === 'ready' && registryRoles.length > 0 ? (
            <div className="divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
              {registryRoles.map((role) => {
                const warnings = roleWarnings(role)
                const manifestDisabled = role.enabled === false
                const isArchitect = role.id === 'architect'
                const userEnabled = sprintEngineRoleSettings.enabled[role.id] !== false
                // Architect cannot be disabled: Sprint Engine planning depends
                // on it. Manifest disabling still wins so a custom manifest can
                // intentionally hide a role even when the user has not toggled
                // it off.
                const enabled = isArchitect ? !manifestDisabled : (!manifestDisabled && userEnabled)
                const switchDisabled = manifestDisabled || isArchitect
                const label = getSprintEngineRoleLabel(role.id, roleRegistry)
                const switchLabelId = `settings-role-${role.id}-label`
                const switchHelpId = `settings-role-${role.id}-help`
                return (
                  <div key={role.id} className="py-3">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <span
                          id={switchLabelId}
                          className="block truncate text-body font-medium text-[color:var(--text-strong)]"
                        >
                          {label}
                        </span>
                        <div
                          id={switchHelpId}
                          className="mt-0.5 truncate font-mono text-meta leading-4 text-[color:var(--text-subtle)]"
                        >
                          {role.id} · {roleSourceLabel(role)}
                        </div>
                        {role.description ? (
                          <p className="mt-1 text-body leading-5 text-[color:var(--text-muted)]">
                            {role.description}
                          </p>
                        ) : null}
                        {manifestDisabled ? (
                          <p className="mt-1 text-body leading-5 text-[color:var(--text-muted)]">
                            Disabled by the role manifest; the app setting cannot override it.
                          </p>
                        ) : isArchitect ? (
                          <p className="mt-1 text-body leading-5 text-[color:var(--text-muted)]">
                            Required for planning; cannot be disabled.
                          </p>
                        ) : null}
                        {warnings.map((warning) => (
                          // Degraded, not failed: the role still runs. The glyph
                          // and the role carry the tone; the copy stays readable.
                          <InlineNotice key={`${role.id}:${warning.code}:${warning.message}`} tone="warn" className="mt-1">
                            Warning: {warning.message}
                          </InlineNotice>
                        ))}
                      </div>
                      <Switch
                        checked={enabled}
                        disabled={switchDisabled}
                        onChange={(next) => setSprintEngineRoleEnabled(role.id, next)}
                        ariaLabelledBy={switchLabelId}
                        ariaDescribedBy={switchHelpId}
                        className="mt-0.5"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}

          {roleRegistry?.warnings.length ? (
            <InlineNotice tone="warn">
              <div className="space-y-1">
                {roleRegistry.warnings.map((warning) => (
                  <p key={`${warning.code}:${warning.message}`}>Registry warning: {warning.message}</p>
                ))}
              </div>
            </InlineNotice>
          ) : null}

          <ActionResultMessage message={roleInstallMessage} />

          <div className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5">
            <div className="space-y-1">
              <SettingsSectionTitle
                count={userRoles.length || undefined}
                action={
                  <div className="flex items-center gap-2">
                    {userRoleAuthoringSupported ? (
                      <PrimaryButton size="md" onClick={openCreateRole} disabled={Boolean(roleAuthoring)}>
                        Create custom role
                      </PrimaryButton>
                    ) : null}
                    <OutlineButton
                      size="md"
                      onClick={() => void installGlobalRoleFolder()}
                      disabled={globalInstallPending}
                    >
                      {globalInstallPending ? 'Installing' : 'Install from folder'}
                    </OutlineButton>
                  </div>
                }
              >
                Global roles
              </SettingsSectionTitle>
              <p className="text-body leading-5 text-[color:var(--text-muted)]">
                Authored or installed here and available to every workspace. Invalid manifests are skipped; reload open workspaces to pick up changes.
              </p>
            </div>

            {roleAuthoring ? (
              <UserRoleAuthoringForm
                mode={roleAuthoring.mode}
                draft={roleAuthoring.draft}
                errors={authoringFieldErrors(roleAuthoringStatus)}
                busy={isAuthoringBusy(roleAuthoringStatus)}
                onChange={updateRoleDraft}
                onSubmit={() => void submitRoleAuthoring()}
                onCancel={closeRoleAuthoring}
              />
            ) : null}

            <ActionResultMessage message={globalInstallMessage} />

            <ActionResultMessage message={userRoleMessage} />

            {userRoles.length === 0 ? (
              <p className="text-body leading-5 text-[color:var(--text-muted)]">
                No global roles yet. {userRoleAuthoringSupported ? 'Create a custom role or install a folder of manifests.' : 'Install a folder of manifests to add some.'}
              </p>
            ) : (
              <div className="divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
                {userRoles.map((role) => {
                  const editLoading = roleEditLoadingId === role.id
                  const deletePending = userRoleDeletePendingId === role.id
                  return (
                    <div key={role.id} className="group flex items-baseline justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-body font-medium text-[color:var(--text-default)]">{role.label}</div>
                        {role.description ? (
                          <div className="mt-0.5 text-body leading-5 text-[color:var(--text-muted)]">
                            {role.description}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        {userRoleAuthoringSupported ? (
                          // The reveal lives on the wrapper, not the buttons: a
                          // button's own `disabled:opacity-45` would otherwise
                          // fight the `opacity-0` rest state and lift a dead
                          // control into view on its own.
                          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            <GhostButton
                              size="xs"
                              onClick={() => void openEditRole(role.id)}
                              disabled={editLoading || deletePending}
                            >
                              {editLoading ? 'Opening' : 'Edit'}
                              <span className="sr-only"> {role.label}</span>
                            </GhostButton>
                            <GhostButton
                              size="xs"
                              tone="danger"
                              onClick={() => void deleteUserRole(role.id, role.label)}
                              disabled={editLoading || deletePending}
                            >
                              {deletePending ? 'Deleting' : 'Delete'}
                              <span className="sr-only"> {role.label}</span>
                            </GhostButton>
                          </div>
                        ) : null}
                        <span className="font-mono text-meta text-[color:var(--text-subtle)]">{role.id}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {activeSettingsTab === 'knowledge-graph' ? (
        <div
          role="tabpanel"
          id="settings-panel-knowledge-graph"
          aria-labelledby="settings-tab-knowledge-graph"
          className="space-y-4"
        >
          <div className="space-y-1">
            <SettingsSectionTitle
              action={
                activeProjectRoot ? (
                  <span
                    className="max-w-[260px] truncate font-mono text-meta text-[color:var(--text-subtle)]"
                    title={activeProjectRoot}
                  >
                    {basename(activeProjectRoot)}
                  </span>
                ) : undefined
              }
            >
              Markdown knowledge graph
            </SettingsSectionTitle>
            <p className="text-body leading-5 text-[color:var(--text-muted)]">
              Each project points at a knowledge folder; its workspaces and Sprint Engine runs inherit it.
            </p>
          </div>

          <ProjectKnowledgeList activeProjectRoot={activeProjectRoot} />

          <div className="border-t border-[color:var(--border-subtle)] pt-4">
            <CompoundSwitchRow
              label="Activity tracking (Claude Code)"
              description="Record which knowledge files Claude touches and animate the graph as they are read. What gets installed is shown before enabling."
              checked={activityInstalled}
              disabled={activityPending || !activeProjectRoot || !activeKnowledgeConfig?.relativeRoot}
              onChange={(next) => void toggleActivityTracking(next)}
            />
            {activityMessage ? (
              <div className="mt-2">
                <InlineNotice tone="warn">{activityMessage}</InlineNotice>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeSettingsTab === 'design-system' ? (
        <div
          role="tabpanel"
          id="settings-panel-design-system"
          aria-labelledby="settings-tab-design-system"
          className="space-y-4"
        >
          <div className="space-y-1">
            <SettingsSectionTitle
              action={
                activeSprintEngineRoot ? (
                  <span
                    className="max-w-[260px] truncate font-mono text-meta text-[color:var(--text-subtle)]"
                    title={activeSprintEngineRoot}
                  >
                    {basename(activeSprintEngineRoot)}
                  </span>
                ) : undefined
              }
            >
              Design system
            </SettingsSectionTitle>
            <p className="text-body leading-5 text-[color:var(--text-muted)]">
              Agents building UI in this workspace read the attached bundle and conform to it.
            </p>
          </div>

          <DesignSystemSettings workspaceRoot={activeSprintEngineRoot} />
        </div>
      ) : null}

      {activeSettingsTab === 'learn' ? (
        <div
          role="tabpanel"
          id="settings-panel-learn"
          aria-labelledby="settings-tab-learn"
        >
          <LearnCenter onSettingsTab={onOpenSettingsTab} />
        </div>
      ) : null}

      {activeSettingsTab === 'shortcuts' ? <KeyboardShortcutsTab /> : null}

      {activeSettingsTab === 'modules' ? <ModulesSettingsTab /> : null}

      {activeSettingsTab === 'mobile' && mobileRelayEnabled ? <MobileSettingsTab /> : null}

      {activeSettingsTab === 'remote' ? <RemoteTailnetSettingsTab /> : null}

      {activeTab.moduleSection ? (
        <div
          role="tabpanel"
          id={`settings-panel-${activeTab.id}`}
          aria-labelledby={`settings-tab-${activeTab.id}`}
          className="space-y-4"
        >
          <ModuleSettingsSectionHost section={activeTab.moduleSection} />
        </div>
      ) : null}

      {chrome === 'panel' ? (
        <div className="mt-6 flex justify-end border-t border-[color:var(--border-subtle)] pt-4">
          <GhostButton size="md" onClick={onClose}>
            Done
          </GhostButton>
        </div>
      ) : null}
    </div>
  )

  if (chrome === 'door') {
    // The door owns the bar (its name rides the app strip) and the rail column;
    // this contributes the categories and the body, and nothing else. No Close
    // control of its own: leaving is the bar's back chevron, Escape, or opening
    // any other door — the one way out every door already has.
    return (
      <GlobalSurfaceShell
        ariaLabel="Settings"
        bar={{ title: 'Settings' }}
        rail={sidebarNode}
        onBack={doorBack.onBack}
        canGoBack={doorBack.canGoBack}
      >
        <div className="h-full min-h-0 overflow-y-auto px-5 py-4">{bodyContent}</div>
      </GlobalSurfaceShell>
    )
  }

  if (chrome === 'overlay') {
    // The modal-host layout (doors→modals, 2026-09-01): the SAME shell anatomy
    // the door branch above renders — one 36px title bar, the categories in
    // the shell's raised-ground rail, the body beside it — so Settings inside
    // the Modal reads identically to Plugins/Automations/Design. The host's
    // ModalSurfaceChromeContext puts the closing X in the bar; the shell
    // suppresses the chevron there, so no onBack is passed.
    return (
      <GlobalSurfaceShell ariaLabel="Settings" bar={{ title: 'Settings' }} rail={sidebarNode}>
        <div className="h-full min-h-0 overflow-y-auto px-5 py-4">{bodyContent}</div>
      </GlobalSurfaceShell>
    )
  }

  return (
    <WorkspacePanel
      title="Settings"
      subtitle="Configure local CLIs, workspace paths, updates, and telemetry."
      titleId="settings-panel-title"
      onClose={onClose}
      closeLabel="Close settings"
      sidebar={sidebarNode}
    >
      {bodyContent}
    </WorkspacePanel>
  )
}

// Human plan label for the Profile meta grid ("Pro plan" / "Free plan" / a
// non-active entitlement status). Presentation only: it reads the plan's name
// to print it, and nothing may branch on what it returns.
function profilePlanLabel(authState: MulticodeAuthState): string {
  const plan = authState.entitlements?.plan ?? null
  if (!plan) return 'Free plan'
  if (plan.status === 'active') {
    const code = plan.code ? plan.code[0].toUpperCase() + plan.code.slice(1) : 'Pro'
    return `${code} plan`
  }
  return plan.status ? plan.status[0].toUpperCase() + plan.status.slice(1) : 'Unknown'
}

// Profile tab body: a fuller account-management surface over the shared auth
// projection. Drives the same auth IPC as the sidebar account popover; the two
// coexist (quick glance vs. full management).
function ProfileSection({
  authState,
  message,
  pending,
  onSignIn,
  onSignOut,
  onRefresh,
  onUpgrade,
}: {
  authState: MulticodeAuthState
  message: string | null
  pending: boolean
  onSignIn: () => void
  onSignOut: () => void
  onRefresh: () => void
  onUpgrade: () => void
}) {
  if (!authState.authenticated) {
    return (
      <div className="space-y-4">
        <SettingsSectionTitle>Account</SettingsSectionTitle>
        <p className="text-body leading-5 text-[color:var(--text-muted)]">
          Sign in to sync entitlements and unlock Pro features.
        </p>
        <PrimaryButton size="md" onClick={onSignIn} disabled={pending || authState.status === 'checking'}>
          Sign in
        </PrimaryButton>
        {message ? <p className="text-body leading-5 text-[color:var(--text-muted)]">{message}</p> : null}
      </div>
    )
  }

  // Two questions, deliberately not one: the Plan cell's tone is presentation
  // (it colours the plan's own name), and the upgrade button is an access
  // decision, which is asked of feature keys rather than the plan's name.
  const planTone = planDisplayTier(authState) === 'pro' ? 'positive' : undefined
  const offerUpgrade = !hasPaidEntitlement(authState)
  const name = authState.user?.displayName ?? authState.user?.email ?? 'Your account'
  const email = authState.user?.displayName ? authState.user?.email : null
  const orgName = authState.selectedOrganization?.name ?? null
  const accessStale = Boolean(message) || authState.entitlementStatus !== 'fresh'

  return (
    <div className="space-y-5">
      <SettingsSectionTitle>Account</SettingsSectionTitle>
      <div className="flex items-center gap-3">
        <AccountAvatar
          user={authState.user}
          className="h-11 w-11 border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-title text-[color:var(--text-strong)]"
          glyphClassName="icon-lg"
        />
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-[color:var(--text-strong)]">{name}</div>
          {email ? <div className="truncate text-body text-[color:var(--text-muted)]">{email}</div> : null}
        </div>
      </div>

      <div className="grid gap-x-6 gap-y-3 border-t border-[color:var(--border-subtle)] pt-4 text-body sm:grid-cols-2">
        <MetaCell label="Plan" value={profilePlanLabel(authState)} tone={planTone} />
        {orgName ? <MetaCell label="Organization" value={orgName} /> : null}
      </div>

      {message ? <p className="text-body leading-5 text-[color:var(--text-muted)]">{message}</p> : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-[color:var(--border-subtle)] pt-4">
        {offerUpgrade ? (
          <PrimaryButton size="md" onClick={onUpgrade} disabled={pending}>
            Upgrade to Pro
          </PrimaryButton>
        ) : null}
        <OutlineButton
          size="md"
          onClick={onRefresh}
          disabled={pending}
        >
          {accessStale ? 'Check access again' : 'Refresh access'}
        </OutlineButton>
        <GhostButton size="md" onClick={onSignOut} disabled={pending} className="ml-auto">
          Sign out
        </GhostButton>
      </div>
    </div>
  )
}

// Single-line rail item — a leading glyph + label, no subtitle. The rail
// orients; tab bodies carry their own section headings. Built-in tabs pass an
// `icon`; module sections fall back to their contributed `moduleSection.icon`.
const SettingsTabButton = React.forwardRef<HTMLButtonElement, {
  tab: SettingsTabDescriptor
  active: boolean
  onClick: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}>(function SettingsTabButton({ tab, active, onClick, onKeyDown }, ref) {
  const Icon = tab.icon ?? tab.moduleSection?.icon
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={`settings-tab-${tab.id}`}
      aria-selected={active}
      aria-controls={`settings-panel-${tab.id}`}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`interactive flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body leading-5 focus-visible:focus-ring ${
        active
          ? 'bg-[color:var(--bg-selected)] font-medium text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
      }`}
    >
      {Icon ? (
        <Icon
          className={`icon-md shrink-0 ${active ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-subtle)]'}`}
        />
      ) : null}
      <span className="min-w-0 truncate">{tab.label}</span>
    </button>
  )
})

function formatUpdateChannel(channel: AppUpdateState['channel'] | undefined): string {
  switch (channel) {
    case 'stable':
      return 'Stable'
    case 'preview':
      return 'Preview'
    case 'dev':
      return 'Development'
    default:
      return 'Unknown'
  }
}

function formatGitHubTokenStatus(status: GitHubTokenUiStatus | null): string {
  if (!status) return 'Checking'
  if (status.source === 'settings') return 'Saved'
  if (status.source === 'environment') return 'Environment'
  return 'Not set'
}

function formatUpdateStatus(state: AppUpdateState | null): string {
  if (!state) return 'Loading update status.'
  if (!state.packaged) return 'Update checks are available after installing a packaged build.'
  switch (state.status) {
    case 'checking':
      return 'Checking for updates.'
    case 'available':
      return state.updateVersion ? `Version ${state.updateVersion} is available.` : 'An update is available.'
    case 'downloading':
      return state.progress ? `Downloading update (${Math.round(state.progress.percent)}%).` : 'Downloading update.'
    case 'downloaded':
      return 'Update downloaded. Restart to install it.'
    case 'not_available':
      return 'You’re up to date.'
    case 'error':
      return state.errorMessage ?? 'Update check failed.'
    default:
      return 'No update check is running.'
  }
}
