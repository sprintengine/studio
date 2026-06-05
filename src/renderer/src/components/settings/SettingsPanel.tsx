import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { selectModuleEnabled } from '../../modules'
import type {
  McpCatalogServer,
  McpSettings,
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
  SprintEngineRoleRegistryWarning,
  SkillPackCatalogEntry,
  SkillPackEntry,
  SkillPackSettings,
  VoiceDictationModel,
} from '../../types/workspace'
import AppThemePicker from './AppThemePicker'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { basename } from '../../utils/paths'
import {
  buildSprintEngineRoleRegistry,
  getSprintEngineRoleLabel,
  sprintEngineRoleOrder,
} from '../../utils/sprintengine'
import { WorkspacePanel } from '../ui/WorkspacePanel'
import {
  CloseIconButton,
  Field,
  GhostButton,
  PrimaryButton,
  Select,
  type SelectItem,
  StatusDot,
  Switch,
  type Tone,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import LearnCenter from '../learn/LearnCenter'
import { KeyboardShortcutsTab } from './KeyboardShortcutsTab'
import MobileSettingsTab from './MobileSettingsTab'
import { ModulesSettingsTab } from './ModulesSettingsTab'
import { ProviderSettingsTab } from './ProviderSettingsTab'
import {
  McpBrandIcon,
  McpCatalogTile,
  McpInfoPanel,
  groupMcpCatalog,
  mcpIconSlug,
  mcpServerFromCatalog,
} from './McpCatalog'
import {
  SkillPackInfoPanel,
  SkillPackTile,
  groupSkillPackCatalog,
} from './SkillPacksCatalog'
import { MetaCell, formatNullableDate } from './SettingsAtoms'
import { ProjectKnowledgeList } from './ProjectKnowledgeList'
import CliIcon from '../CliIcon'
import { cliRuntimeForPlugin, orderInstalledPlugins } from '../workspace/newWorkspace/cliRuntimeOptions'
import MulticodeMark from '../brand/MulticodeMark'
import { getSettingDescriptor, type SettingDescriptor } from './settingsRegistry'

interface Props {
  onClose: () => void
  checkForUpdatesOnOpen?: boolean
  checkForUpdatesRequestId?: number
  initialTab?: string | null
  onOpenSettingsTab?: (tabId: string) => void
  /**
   * `'panel'` (default) wraps the content in `WorkspacePanel` chrome.
   * `'overlay'` renders the full-app Settings route layout (header + rail +
   * content + optional right column). The surrounding overlay handles focus,
   * Escape, and scroll-lock.
   */
  chrome?: 'panel' | 'overlay'
  /** When `chrome='overlay'`, the surrounding dialog supplies its aria title id. */
  titleId?: string
}

type UpdateAction = 'check' | 'download' | 'restart'

type GitHubTokenUiStatus = Awaited<ReturnType<typeof window.api.getGitHubTokenStatus>>

const EMPTY_SEARCH_EXCLUDES: string[] = []
const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}
const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }
const EMPTY_SKILL_PACK_SETTINGS: SkillPackSettings = { installed: {} }

const MCP_TRANSPORT_ITEMS: SelectItem<'stdio' | 'http'>[] = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'http' },
]

const VOICE_MODEL_ITEMS: SelectItem<VoiceDictationModel>[] = [
  { value: 'tiny', label: 'Whisper tiny — fastest, least accurate' },
  { value: 'base', label: 'Whisper base' },
  { value: 'small', label: 'Whisper small — recommended' },
  { value: 'medium', label: 'Whisper medium' },
  { value: 'large-v2', label: 'Whisper large-v2' },
  { value: 'large-v3', label: 'Whisper large-v3' },
  { value: 'large-v3-turbo', label: 'Whisper large-v3-turbo' },
]

const VOICE_LANGUAGE_ITEMS: SelectItem<string>[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
]

type SettingsTabId =
  | 'appearance'
  | 'shortcuts'
  | 'modules'
  | 'updates'
  | 'github'
  | 'agents'
  | 'providers'
  | 'roles'
  | 'mcps'
  | 'skill-packs'
  | 'file-search'
  | 'knowledge-graph'
  | 'learn'
  | 'mobile'
  | 'voice-dictation'
  | 'telemetry'

const settingsTabs: Array<{ id: SettingsTabId; label: string; description: string }> = [
  { id: 'appearance', label: 'Appearance', description: 'Theme and visual style' },
  { id: 'shortcuts', label: 'Shortcuts', description: 'Keyboard shortcuts' },
  { id: 'modules', label: 'Modules', description: 'Enable or disable features' },
  { id: 'updates', label: 'Updates', description: 'Version and release channel' },
  { id: 'github', label: 'GitHub', description: 'Issue import token' },
  { id: 'agents', label: 'Agents', description: 'CLI runtime commands' },
  { id: 'providers', label: 'Providers', description: 'Model and harness API keys' },
  { id: 'roles', label: 'Roles', description: 'Sprint Engine role registry' },
  { id: 'mcps', label: 'MCPs', description: 'Agent tool integrations' },
  { id: 'skill-packs', label: 'Skill packs', description: 'Bundled and ecosystem agent skills' },
  { id: 'file-search', label: 'File search', description: 'Index exclude patterns' },
  { id: 'knowledge-graph', label: 'Knowledge graph', description: 'Project knowledge' },
  { id: 'learn', label: 'Learn', description: 'Tips and lessons' },
  { id: 'mobile', label: 'Mobile', description: 'Phone pairing and relay' },
  { id: 'voice-dictation', label: 'Voice dictation', description: 'Transcription server and model' },
  { id: 'telemetry', label: 'Telemetry', description: 'Usage and diagnostics' },
]

function isSettingsTabId(value: unknown): value is SettingsTabId {
  return (
    value === 'appearance'
    || value === 'shortcuts'
    || value === 'modules'
    || value === 'updates'
    || value === 'github'
    || value === 'agents'
    || value === 'providers'
    || value === 'roles'
    || value === 'mcps'
    || value === 'skill-packs'
    || value === 'file-search'
    || value === 'knowledge-graph'
    || value === 'learn'
    || value === 'mobile'
    || value === 'voice-dictation'
    || value === 'telemetry'
  )
}

function splitCommandArgs(value: string): string[] {
  return value
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseEnvNames(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter(Boolean)
}


function parseSearchExcludeText(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((pattern) => pattern.trim())
    .filter(Boolean)
}

const INPUT_CLASS =
  'h-9 w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 font-mono text-sm text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] disabled:opacity-45'

const TEXTAREA_CLASS =
  'min-h-[96px] w-full resize-y rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 font-mono text-sm text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)]'

type MessageTone = 'neutral' | 'accent' | 'warn' | 'error'
type RoleRegistryStatus = 'idle' | 'loading' | 'ready' | 'unavailable'
type RoleInstallMessage = { tone: MessageTone; text: string } | null
type SprintEngineRoleInstallTarget = {
  sourcePath: string
  destinationKind: 'roles' | 'skills'
}

const MESSAGE_BORDER: Record<MessageTone, string> = {
  neutral: 'border-[color:var(--border-strong)]',
  accent: 'border-[color:var(--accent-primary)]',
  warn: 'border-[color:var(--tone-warn)]',
  error: 'border-[color:var(--tone-error)]',
}

const MESSAGE_TEXT: Record<MessageTone, string> = {
  neutral: 'text-[color:var(--text-muted)]',
  accent: 'text-[color:var(--accent-primary)]',
  warn: 'text-[color:var(--tone-warn)]',
  error: 'text-[color:var(--tone-error)]',
}

function MessageBlock({
  tone,
  children,
}: {
  tone: MessageTone
  children: React.ReactNode
}) {
  return (
    <div
      className={`border-l-2 pl-3 text-[12px] leading-5 ${MESSAGE_BORDER[tone]} ${MESSAGE_TEXT[tone]}`}
    >
      {children}
    </div>
  )
}

function StatusTag({
  tone,
  label,
}: {
  tone: Tone
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
      <StatusDot tone={tone} label={label} />
      <span className="font-medium text-[color:var(--text-default)]">{label}</span>
    </span>
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
        <span id={labelId} className="block text-[13px] font-medium text-[color:var(--text-strong)]">
          {descriptor.label}
        </span>
        {descriptor.help ? (
          <p id={helpId} className="mt-0.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
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
        <span id={labelId} className="block text-[13px] font-medium text-[color:var(--text-strong)]">
          {label}
        </span>
        {description ? (
          <p id={helpId} className="mt-0.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
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

export default function SettingsPanel({
  onClose,
  checkForUpdatesOnOpen = false,
  checkForUpdatesRequestId,
  initialTab = null,
  onOpenSettingsTab,
  chrome = 'panel',
  titleId,
}: Props) {
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId) ?? null
  )
  const dialog = useConfirmDialog()
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)
  const refreshPluginCatalog = useWorkspaceStore((s) => s.refreshPluginCatalog)
  const installedPluginRows = useMemo(
    () => orderInstalledPlugins(pluginCatalogEntries),
    [pluginCatalogEntries],
  )
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const searchExcludes = useWorkspaceStore((s) => s.appSettings.searchExcludes ?? EMPTY_SEARCH_EXCLUDES)
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? EMPTY_PROJECT_KNOWLEDGE_ROOTS)
  const usageTelemetry = useWorkspaceStore((s) => s.appSettings.usageTelemetry)
  const sprintEngineRoleSettings = useWorkspaceStore((s) => s.appSettings.sprintEngineRoleSettings)
  // The Mobile tab gates on the mobile-relay module; hide it when disabled.
  const mobileRelayEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'mobile-relay'))
  // The Voice dictation tab gates on the voice-dictation module.
  const voiceDictationEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'voice-dictation'))
  const voiceDictation = useWorkspaceStore((s) => s.appSettings.voiceDictation)
  const setVoiceDictationSettings = useWorkspaceStore((s) => s.setVoiceDictationSettings)
  const visibleSettingsTabs = useMemo(
    () =>
      settingsTabs.filter(
        (tab) =>
          (tab.id !== 'mobile' || mobileRelayEnabled) &&
          (tab.id !== 'voice-dictation' || voiceDictationEnabled)
      ),
    [mobileRelayEnabled, voiceDictationEnabled]
  )
  const appearanceTheme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const setAppearanceTheme = useWorkspaceStore((s) => s.setAppearanceTheme)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const skillPackSettings = useWorkspaceStore(
    (s) => s.appSettings.skillPacks ?? EMPTY_SKILL_PACK_SETTINGS,
  )
  const setSkillPacksInstalled = useWorkspaceStore((s) => s.setSkillPacksInstalled)
  const upsertSkillPack = useWorkspaceStore((s) => s.upsertSkillPack)
  const removeSkillPackFromStore = useWorkspaceStore((s) => s.removeSkillPack)
  const setSearchExcludes = useWorkspaceStore((s) => s.setSearchExcludes)
  const setUsageTelemetrySettings = useWorkspaceStore((s) => s.setUsageTelemetrySettings)
  const setSprintEngineRoleEnabled = useWorkspaceStore((s) => s.setSprintEngineRoleEnabled)
  const activeKnowledgeConfig = resolveProjectKnowledgeConfig(
    activeWorkspace?.folderPath,
    projectKnowledgeRoots,
    activeWorkspace?.memory.relativeRoot
  )
  const activeProjectRoot = activeKnowledgeConfig?.projectRoot ?? activeWorkspace?.folderPath ?? null
  const activeSprintEngineRoot = activeWorkspace?.folderPath ?? null
  const isWindows = window.api.platform === 'win32'
  const [searchExcludesDraft, setSearchExcludesDraft] = useState(() => searchExcludes.join('\n'))
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null)
  const [updateActionPending, setUpdateActionPending] = useState(false)
  const [githubTokenStatus, setGithubTokenStatus] = useState<GitHubTokenUiStatus | null>(null)
  const [githubTokenDraft, setGithubTokenDraft] = useState('')
  const [githubTokenMessage, setGithubTokenMessage] = useState('')
  const [githubTokenPending, setGithubTokenPending] = useState(false)
  const [activityInstalled, setActivityInstalled] = useState(false)
  const [activityPending, setActivityPending] = useState(false)
  const [activityMessage, setActivityMessage] = useState<string | null>(null)
  const [builtinSkills, setBuiltinSkills] = useState<BuiltinSkill[]>([])
  const [builtinSkillStatuses, setBuiltinSkillStatuses] = useState<Record<string, BuiltinSkillStatus>>({})
  const [builtinSkillPendingId, setBuiltinSkillPendingId] = useState<string | null>(null)
  const [builtinSkillMessage, setBuiltinSkillMessage] = useState<string | null>(null)
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogServer[]>([])
  const [mcpMessage, setMcpMessage] = useState<string | null>(null)
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null)
  const [skillPackCatalog, setSkillPackCatalog] = useState<SkillPackCatalogEntry[]>([])
  const [skillPackMessage, setSkillPackMessage] = useState<string | null>(null)
  const [skillPackPendingId, setSkillPackPendingId] = useState<string | null>(null)
  const [selectedSkillPackId, setSelectedSkillPackId] = useState<string | null>(null)
  const [roleRegistry, setRoleRegistry] = useState<SprintEngineRoleRegistry | null>(null)
  const [roleRegistryStatus, setRoleRegistryStatus] = useState<RoleRegistryStatus>('idle')
  const [roleRegistryMessage, setRoleRegistryMessage] = useState<string | null>(null)
  const [roleInstallPending, setRoleInstallPending] = useState(false)
  const [roleInstallMessage, setRoleInstallMessage] = useState<RoleInstallMessage>(null)
  const [userRoles, setUserRoles] = useState<Array<{ id: string; label: string; summary?: string }>>([])
  const [globalInstallPending, setGlobalInstallPending] = useState(false)
  const [globalInstallMessage, setGlobalInstallMessage] = useState<RoleInstallMessage>(null)
  const [customMcpId, setCustomMcpId] = useState('')
  const [customMcpName, setCustomMcpName] = useState('')
  const [customMcpCommand, setCustomMcpCommand] = useState('')
  const [customMcpArgs, setCustomMcpArgs] = useState('')
  const [customMcpUrl, setCustomMcpUrl] = useState('')
  const [customMcpEnv, setCustomMcpEnv] = useState('')
  const [customMcpTransport, setCustomMcpTransport] = useState<'stdio' | 'http'>('stdio')
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTabId>(
    isSettingsTabId(initialTab) ? initialTab : 'updates'
  )

  useEffect(() => {
    if (isSettingsTabId(initialTab)) {
      setActiveSettingsTab(initialTab)
      window.requestAnimationFrame(() => tabRefs.current[initialTab]?.focus())
    }
  }, [initialTab])

  // If the active tab is no longer visible (e.g. the Mobile module was disabled
  // while its tab was active), fall back to the first visible tab so the panel
  // body never goes blank on a hidden tab.
  useEffect(() => {
    if (!visibleSettingsTabs.some((tab) => tab.id === activeSettingsTab)) {
      setActiveSettingsTab(visibleSettingsTabs[0]?.id ?? 'updates')
    }
  }, [visibleSettingsTabs, activeSettingsTab])
  const tabRefs = useRef<Record<SettingsTabId, HTMLButtonElement | null>>({
    appearance: null,
    shortcuts: null,
    modules: null,
    updates: null,
    github: null,
    agents: null,
    providers: null,
    roles: null,
    mcps: null,
    'skill-packs': null,
    'file-search': null,
    'knowledge-graph': null,
    learn: null,
    mobile: null,
    'voice-dictation': null,
    telemetry: null,
  })
  const autoCheckStartedRef = useRef(false)
  const lastUpdateRequestIdRef = useRef<number | null>(null)

  const closeSettings = useCallback(() => {
    setSearchExcludes(parseSearchExcludeText(searchExcludesDraft))
    onClose()
  }, [onClose, searchExcludesDraft, setSearchExcludes])

  useEffect(() => {
    setSearchExcludesDraft(searchExcludes.join('\n'))
  }, [searchExcludes])

  useEffect(() => {
    let cancelled = false
    setActivityMessage(null)
    setBuiltinSkillMessage(null)
    setBuiltinSkillStatuses({})
    if (!activeProjectRoot) {
      setActivityInstalled(false)
      void window.api.builtinSkillsList().then((skills) => {
        if (!cancelled) setBuiltinSkills(skills)
      })
      return
    }
    void window.api
      .memoryActivityIsInstalled({ workspaceRoot: activeProjectRoot })
      .then((installed) => {
        if (!cancelled) setActivityInstalled(installed)
      })
    void window.api.builtinSkillsList().then(async (skills) => {
      if (cancelled) return
      setBuiltinSkills(skills)
      const statuses = await Promise.all(skills.map(async (skill) => {
        const status = await window.api.builtinSkillStatus({
          workspaceRoot: activeProjectRoot,
          skillId: skill.id,
        })
        return [skill.id, status] as const
      }))
      if (!cancelled) {
        setBuiltinSkillStatuses(Object.fromEntries(statuses))
      }
    }).catch((error) => {
      if (!cancelled) {
        setBuiltinSkillMessage(error instanceof Error ? error.message : 'Failed to load built-in skills.')
      }
    })
    return () => {
      cancelled = true
    }
  }, [activeProjectRoot])

  const installBuiltinSkill = useCallback(async (skill: BuiltinSkill) => {
    if (!activeProjectRoot) return
    setBuiltinSkillPendingId(skill.id)
    setBuiltinSkillMessage(null)
    try {
      const result = await window.api.builtinSkillInstall({
        workspaceRoot: activeProjectRoot,
        skillId: skill.id,
      })
      if (result.ok) {
        setBuiltinSkillMessage(result.status === 'updated'
          ? `${skill.name} updated.`
          : `${skill.name} installed.`)
        const status = await window.api.builtinSkillStatus({
          workspaceRoot: activeProjectRoot,
          skillId: skill.id,
        })
        setBuiltinSkillStatuses((current) => ({
          ...current,
          [skill.id]: status,
        }))
      } else {
        setBuiltinSkillMessage(result.message)
      }
    } catch (error) {
      setBuiltinSkillMessage(error instanceof Error ? error.message : `Failed to install ${skill.name}.`)
    } finally {
      setBuiltinSkillPendingId(null)
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
              <div>Multicode will:</div>
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
    if (typeof window.api.mcpListCatalog !== 'function') {
      setMcpMessage('MCP settings need an app restart before this tab is available.')
      return () => {
        cancelled = true
      }
    }
    void window.api.mcpListCatalog().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setMcpCatalog(result.servers)
      } else {
        setMcpMessage(result.message)
      }
    }).catch((error) => {
      if (!cancelled) setMcpMessage(error instanceof Error ? error.message : 'Unable to load MCP catalog.')
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (typeof window.api.skillPackListCatalog !== 'function') {
      setSkillPackMessage('Skill packs need an app restart before this tab is available.')
      return () => {
        cancelled = true
      }
    }
    void window.api.skillPackListCatalog().then((result) => {
      if (cancelled) return
      if (result.ok) {
        setSkillPackCatalog(result.packs)
      } else {
        setSkillPackMessage(result.message)
      }
    }).catch((error) => {
      if (!cancelled) {
        setSkillPackMessage(
          error instanceof Error ? error.message : 'Unable to load skill-pack catalog.',
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeProjectRoot) {
      setSkillPacksInstalled([])
      return
    }
    if (typeof window.api.skillPackListInstalled !== 'function') return
    let cancelled = false
    void window.api
      .skillPackListInstalled({ workspaceRoot: activeProjectRoot })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setSkillPacksInstalled(result.installed)
        } else {
          setSkillPackMessage(result.message)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSkillPackMessage(
            error instanceof Error ? error.message : 'Unable to read installed skill packs.',
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeProjectRoot, setSkillPacksInstalled])

  const syncMcps = useCallback(async () => {
    if (!activeProjectRoot) return
    try {
      const result = await window.api.mcpSync({
        workspaceRoot: activeProjectRoot,
        settings: mcpSettings,
      })
      if (!result.ok) {
        setMcpMessage(result.message)
        return
      }
      const blockingIssue = result.issues.find((issue) => issue.level === 'error')
      if (blockingIssue) setMcpMessage(blockingIssue.message)
      // Success path leaves mcpMessage alone so setup-notes or default copy persists.
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : 'MCP sync failed.')
    }
  }, [activeProjectRoot, mcpSettings])

  const lastSyncedServersRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeProjectRoot) return
    const snapshot = JSON.stringify(mcpSettings.servers)
    if (lastSyncedServersRef.current === snapshot) return
    const isFirstRun = lastSyncedServersRef.current === null
    lastSyncedServersRef.current = snapshot
    if (isFirstRun) return
    void syncMcps()
  }, [activeProjectRoot, mcpSettings.servers, syncMcps])

  const addCustomMcp = useCallback(() => {
    const id = customMcpId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    const name = customMcpName.trim() || id
    if (!id || !name) {
      setMcpMessage('Custom MCP needs an id and name.')
      return
    }
    if (customMcpTransport === 'stdio' && !customMcpCommand.trim()) {
      setMcpMessage('Stdio MCP needs a command.')
      return
    }
    if (customMcpTransport === 'http' && !customMcpUrl.trim()) {
      setMcpMessage('HTTP MCP needs a URL.')
      return
    }
    upsertMcpServer({
      id,
      name,
      transport: customMcpTransport,
      command: customMcpTransport === 'stdio' ? customMcpCommand.trim() : undefined,
      args: splitCommandArgs(customMcpArgs),
      url: customMcpTransport === 'http' ? customMcpUrl.trim() : undefined,
      envVarNames: parseEnvNames(customMcpEnv),
      enabled: true,
      required: false,
      clients: ['codex', 'claude'],
      scope: 'workspace',
      source: 'custom',
      riskLevel: customMcpTransport === 'stdio' ? 'local-command' : 'network',
    })
    setCustomMcpId('')
    setCustomMcpName('')
    setCustomMcpCommand('')
    setCustomMcpArgs('')
    setCustomMcpUrl('')
    setCustomMcpEnv('')
    setMcpMessage(null)
  }, [
    customMcpArgs,
    customMcpCommand,
    customMcpEnv,
    customMcpId,
    customMcpName,
    customMcpTransport,
    customMcpUrl,
    upsertMcpServer,
  ])

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

  const activeTab = visibleSettingsTabs.find((tab) => tab.id === activeSettingsTab) ?? visibleSettingsTabs[0]
  const groupedMcpCatalog = groupMcpCatalog(mcpCatalog)
  const selectedCatalogServer = selectedCatalogId
    ? mcpCatalog.find((server) => server.id === selectedCatalogId) ?? null
    : null
  const activeMcpServers = Object.values(mcpSettings.servers).filter((server) => server.enabled)
  const registryRoles = orderedSprintEngineRoles(roleRegistry)
  const registryWarningCount =
    (roleRegistry?.warnings.length ?? 0)
    + registryRoles.reduce((total, role) => total + roleWarnings(role).length, 0)

  const groupedSkillPackCatalog = groupSkillPackCatalog(skillPackCatalog)
  const selectedSkillPack = selectedSkillPackId
    ? skillPackCatalog.find((pack) => pack.id === selectedSkillPackId) ?? null
    : null
  const installedSkillPacks = Object.values(skillPackSettings.installed)

  const searchExcludesDescriptor = getSettingDescriptor('search-excludes')
  const telemetrySendDescriptor = getSettingDescriptor('usage-telemetry-send-data')
  const telemetryLocalDescriptor = getSettingDescriptor('usage-telemetry-local-export')
  const telemetryDiagnosticsDescriptor = getSettingDescriptor('usage-telemetry-export-diagnostics')

  const toggleCatalogServer = useCallback((server: McpCatalogServer) => {
    const existing = mcpSettings.servers[server.id]
    if (existing?.enabled) {
      removeMcpServer(server.id)
      setMcpMessage(null)
    } else {
      upsertMcpServer(mcpServerFromCatalog(server))
      setMcpMessage(server.setupNotes ? server.setupNotes : null)
    }
  }, [mcpSettings.servers, removeMcpServer, upsertMcpServer])

  const toggleSkillPack = useCallback(
    async (pack: SkillPackCatalogEntry) => {
      if (!activeProjectRoot) {
        setSkillPackMessage('Open a workspace folder before installing skill packs.')
        return
      }
      const installed = skillPackSettings.installed[pack.id]
      setSkillPackPendingId(pack.id)
      setSkillPackMessage(null)
      try {
        if (installed) {
          const result = await window.api.skillPackRemove({
            workspaceRoot: activeProjectRoot,
            slug: pack.slug,
            installedDirName: pack.installedDirName,
          })
          if (result.ok) {
            removeSkillPackFromStore(pack.id)
            setSkillPackMessage(`${pack.name} removed.`)
          } else {
            setSkillPackMessage(result.message)
          }
        } else {
          const result = await window.api.skillPackInstall({
            workspaceRoot: activeProjectRoot,
            slug: pack.slug,
            harnesses: pack.harnesses,
            installedDirName: pack.installedDirName,
          })
          if (result.ok) {
            const entry: SkillPackEntry = {
              ...result.installed,
              id: pack.id,
              name: pack.name,
              category: pack.category,
              description: pack.description,
              version: pack.version,
              sourceUrl: pack.sourceUrl,
              installedDirName: pack.installedDirName ?? result.installed.installedDirName,
            }
            upsertSkillPack(entry)
            setSkillPackMessage(
              pack.setupNotes ? `${pack.name} installed. ${pack.setupNotes}` : `${pack.name} installed.`,
            )
          } else {
            setSkillPackMessage(result.message)
          }
        }
      } catch (error) {
        setSkillPackMessage(error instanceof Error ? error.message : 'Skill pack action failed.')
      } finally {
        setSkillPackPendingId(null)
      }
    },
    [
      activeProjectRoot,
      removeSkillPackFromStore,
      skillPackSettings.installed,
      upsertSkillPack,
    ],
  )

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
        tone: 'accent',
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
          tone: rejected > 0 ? 'warn' : 'accent',
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

  const selectSettingsTab = useCallback((tabId: SettingsTabId) => {
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

  const sidebarNode = (
    <div
      role="tablist"
      aria-label="Settings categories"
      aria-orientation="vertical"
      className="grid grid-cols-2 gap-1 md:grid-cols-1"
    >
      {visibleSettingsTabs.map((tab, index) => (
        <SettingsTabButton
          key={tab.id}
          ref={(node) => {
            tabRefs.current[tab.id] = node
          }}
          tab={tab}
          active={activeSettingsTab === tab.id}
          onClick={() => selectSettingsTab(tab.id)}
          onKeyDown={(event) => onSettingsTabKeyDown(event, index)}
        />
      ))}
    </div>
  )

  const bodyContent = (
    <>
      <header className="mb-4 border-b border-[color:var(--border-subtle)] pb-3">
        <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">
          {activeTab.label}
        </h3>
        <p className="mt-1 text-[12px] text-[color:var(--text-muted)]">
          {activeTab.description}
        </p>
      </header>

      {activeSettingsTab === 'appearance' ? (
        <div
          role="tabpanel"
          id="settings-panel-appearance"
          aria-labelledby="settings-tab-appearance"
          className="space-y-4"
        >
          <div className="space-y-2">
            <div className="text-[13px] font-semibold text-[color:var(--text-strong)]">Theme</div>
            <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
              Theme applies across every Multicode workspace and panel. Every theme is anti-temporal-dither baseline (channel values are multiples of 4) so surfaces don&apos;t flicker on 6-bit-FRC panels. &lsquo;Match system&rsquo; follows your operating system&apos;s light or dark preference.
            </p>
          </div>
          <AppThemePicker value={appearanceTheme} onChange={setAppearanceTheme} />
        </div>
      ) : null}

      {activeSettingsTab === 'updates' ? (
        <div
          role="tabpanel"
          id="settings-panel-updates"
          aria-labelledby="settings-tab-updates"
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-[color:var(--text-strong)]">
              <MulticodeMark className="h-4 w-4 shrink-0" />
              <span>multicode {updateState?.version ?? '...'}</span>
            </div>
            <StatusTag tone={updateChannelTone(updateState?.channel)} label={formatUpdateChannel(updateState?.channel)} />
          </div>

          <MessageBlock tone={updateMessageTone(updateState?.status)}>
            {formatUpdateStatus(updateState)}
            {updateState?.progress ? (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[color:var(--bg-active)]">
                <div
                  className="h-full rounded-full bg-[color:var(--accent-primary)]"
                  style={{ width: `${Math.max(0, Math.min(100, updateState.progress.percent))}%` }}
                />
              </div>
            ) : null}
          </MessageBlock>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => void window.api.updateOpenReleaseNotes()}
              className="text-sm font-semibold text-[color:var(--accent-primary)] hover:text-[color:var(--accent-primary-hover)] focus:outline-none focus-visible:underline"
            >
              Release notes
            </button>
            <UpdateActionButton
              label="Check"
              primary={nextUpdateAction === 'check'}
              onClick={() => void checkForUpdates()}
              disabled={updateActionPending || updateState?.status === 'checking' || updateState?.status === 'downloading'}
            />
            <UpdateActionButton
              label="Download"
              primary={nextUpdateAction === 'download'}
              onClick={() => void downloadUpdate()}
              disabled={updateActionPending || updateState?.status !== 'available'}
            />
            <UpdateActionButton
              label="Restart"
              primary={nextUpdateAction === 'restart'}
              onClick={() => void restartToInstall()}
              disabled={!updateState?.downloaded}
            />
          </div>

          <div className="grid gap-x-6 gap-y-3 border-t border-[color:var(--border-subtle)] pt-4 text-sm sm:grid-cols-2">
            <MetaCell label="Update version" value={updateState?.updateVersion ?? 'None'} />
            <MetaCell label="Last checked" value={formatNullableDate(updateState?.lastCheckedAt)} />
          </div>
        </div>
      ) : null}

      {activeSettingsTab === 'github' ? (
        <div
          role="tabpanel"
          id="settings-panel-github"
          aria-labelledby="settings-tab-github"
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-sm font-semibold text-[color:var(--text-strong)]">
              GitHub access token
            </div>
            <StatusTag tone={githubTokenTone(githubTokenStatus)} label={formatGitHubTokenStatus(githubTokenStatus)} />
          </div>

          <Field label="Token" htmlFor="github-token-input">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                value={githubTokenDraft}
                onChange={(event) => setGithubTokenDraft(event.target.value)}
                placeholder={githubTokenStatus?.configured ? 'Token saved' : 'Fine-grained GitHub token'}
                autoComplete="off"
                className={`${INPUT_CLASS} min-w-0 flex-1`}
              />
              <div className="flex gap-2">
                <PrimaryButton
                  size="md"
                  onClick={() => void saveGitHubToken()}
                  disabled={githubTokenPending || !githubTokenDraft.trim()}
                  className="h-9"
                >
                  Save
                </PrimaryButton>
                <GhostButton
                  size="md"
                  onClick={() => void clearGitHubToken()}
                  disabled={githubTokenPending || githubTokenStatus?.source !== 'settings'}
                  className="h-9 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                >
                  Clear
                </GhostButton>
              </div>
            </div>
          </Field>

          <MessageBlock tone={githubTokenMessage ? 'accent' : 'neutral'}>
            {githubTokenMessage || 'Switchboard uses this token to import private GitHub issues. The token is stored on this device and is not saved in workspace files.'}
            {githubTokenStatus && !githubTokenStatus.encryptionAvailable ? ' Secure storage is unavailable, so the token is kept for this app session only.' : ''}
          </MessageBlock>
        </div>
      ) : null}

      {activeSettingsTab === 'agents' ? (
        <div
          role="tabpanel"
          id="settings-panel-agents"
          aria-labelledby="settings-tab-agents"
          className="space-y-4"
        >
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            Installed plugins define which agent CLIs are available. These fields only override how each
            one is invoked — they don't install or create CLIs. Leave a command blank to use the plugin's
            bundled binary, or enter a full executable path if the CLI is not on PATH.
          </p>

          {pluginCatalogStatus === 'loading' && installedPluginRows.length === 0 ? (
            <MessageBlock tone="neutral">Loading installed agent plugins…</MessageBlock>
          ) : pluginCatalogStatus === 'error' ? (
            <div className="space-y-2">
              <MessageBlock tone="warn">
                {pluginCatalogError ?? 'The plugin registry could not be loaded.'}
              </MessageBlock>
              <GhostButton
                onClick={() => void refreshPluginCatalog()}
                className="h-9 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                Retry
              </GhostButton>
            </div>
          ) : installedPluginRows.length === 0 ? (
            <div className="space-y-2">
              <MessageBlock tone="neutral">No agent plugins are installed.</MessageBlock>
              <GhostButton
                onClick={() => void refreshPluginCatalog()}
                className="h-9 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                Refresh
              </GhostButton>
            </div>
          ) : (
            installedPluginRows.map((plugin) => {
              const override = cliRuntimeForPlugin(plugin.id, cliRuntimes)
              return (
                <div key={plugin.id} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <CliIcon cli={plugin.id} className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
                    <span className="text-[13px] font-medium text-[color:var(--text-strong)]">
                      {plugin.displayName}
                    </span>
                    <span className="text-[11px] text-[color:var(--text-muted)]">
                      {plugin.source === 'bundled' ? 'Built-in' : 'User plugin'}
                    </span>
                  </div>
                  <Field label="Command" htmlFor={`cli-command-${plugin.id}`}>
                    <input
                      id={`cli-command-${plugin.id}`}
                      // Per-plugin accessible name so screen readers don't announce an
                      // identical "Command" for every row; the visible label stays compact.
                      aria-label={`${plugin.displayName} command`}
                      value={override.command}
                      // Write the full effective pair so editing one field migrates the
                      // legacy-alias value (claude-code <- claude) onto the plugin-id key
                      // instead of dropping the other field to a blank default.
                      onChange={(event) => setCliRuntime(plugin.id, { command: event.target.value, useWsl: override.useWsl })}
                      placeholder={plugin.binary}
                      className={INPUT_CLASS}
                    />
                  </Field>

                  {isWindows && (
                    <CompoundSwitchRow
                      label={`Run ${plugin.displayName} through WSL`}
                      checked={override.useWsl}
                      onChange={(enabled) => setCliRuntime(plugin.id, { command: override.command, useWsl: enabled })}
                    />
                  )}
                  <p className="text-[11px] leading-5 text-[color:var(--text-muted)]">
                    Runs <span className="font-mono text-[color:var(--text-default)]">{plugin.binary}</span> when the command is blank.
                  </p>
                </div>
              )
            })
          )}
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[color:var(--text-strong)]">
                Sprint Engine roles
              </div>
              <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
                Registry manifests provide display metadata. Runtime enablement is stored in app settings.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <StatusTag
                tone={
                  roleRegistryStatus === 'ready'
                    ? registryWarningCount > 0 ? 'warn' : 'good'
                    : roleRegistryStatus === 'loading' ? 'neutral' : 'warn'
                }
                label={
                  roleRegistryStatus === 'ready'
                    ? `${registryRoles.length} role${registryRoles.length === 1 ? '' : 's'}`
                    : roleRegistryStatus === 'loading' ? 'Loading' : 'Unavailable'
                }
              />
              <PrimaryButton
                size="md"
                onClick={() => void installSprintEngineRoleFolder()}
                disabled={roleInstallPending || !activeSprintEngineRoot}
                className="h-9"
              >
                {roleInstallPending ? 'Installing' : 'Install folder'}
              </PrimaryButton>
            </div>
          </div>

          {roleRegistryStatus === 'loading' ? (
            <MessageBlock tone="neutral">
              Loading Sprint Engine roles from the workspace registry.
            </MessageBlock>
          ) : null}

          {roleRegistryStatus === 'unavailable' ? (
            <MessageBlock tone="warn">
              {roleRegistryMessage ?? 'Sprint Engine role registry is unavailable for this workspace.'}
            </MessageBlock>
          ) : null}

          {roleRegistryStatus === 'ready' && registryRoles.length === 0 ? (
            <MessageBlock tone="neutral">
              No Sprint Engine roles were found in the registry for this workspace.
            </MessageBlock>
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
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            id={switchLabelId}
                            className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]"
                          >
                            {label}
                          </span>
                          <StatusDot
                            tone={enabled ? 'good' : 'neutral'}
                            label={enabled ? 'Enabled' : 'Disabled'}
                          />
                        </div>
                        <div
                          id={switchHelpId}
                          className="mt-0.5 truncate font-mono text-[11px] leading-4 text-[color:var(--text-subtle)]"
                        >
                          {role.id} · {roleSourceLabel(role)}
                        </div>
                        {role.summary ? (
                          <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
                            {role.summary}
                          </p>
                        ) : null}
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
                    {manifestDisabled ? (
                      <div className="mt-2 border-l-2 border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-muted)]">
                        Disabled by this role manifest. The app setting cannot enable it until the manifest changes.
                      </div>
                    ) : isArchitect ? (
                      <div className="mt-2 border-l-2 border-[color:var(--border-strong)] pl-3 text-[12px] leading-5 text-[color:var(--text-muted)]">
                        Architect cannot be disabled. Sprint Engine planning requires it on every new roster.
                      </div>
                    ) : null}
                    {warnings.length > 0 ? (
                      <div className="mt-2 space-y-1 border-l-2 border-[color:var(--tone-warn)] pl-3">
                        {warnings.map((warning) => (
                          <p
                            key={`${role.id}:${warning.code}:${warning.message}`}
                            className="text-[12px] leading-5 text-[color:var(--tone-warn)]"
                          >
                            Warning: {warning.message}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}

          {roleRegistry?.warnings.length ? (
            <div className="space-y-1 border-l-2 border-[color:var(--tone-warn)] pl-3">
              {roleRegistry.warnings.map((warning) => (
                <p
                  key={`${warning.code}:${warning.message}`}
                  className="text-[12px] leading-5 text-[color:var(--tone-warn)]"
                >
                  Registry warning: {warning.message}
                </p>
              ))}
            </div>
          ) : null}

          {roleInstallMessage ? (
            <MessageBlock tone={roleInstallMessage.tone}>
              {roleInstallMessage.text}
            </MessageBlock>
          ) : (
            <MessageBlock tone="neutral">
              Install accepts a registry folder with roles and skills, a roles folder with JSON manifests, or a skills folder with SKILL.md directories.
            </MessageBlock>
          )}

          <div className="space-y-3 border-t border-[color:var(--border-subtle)] pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[color:var(--text-strong)]">Global roles</div>
                <p className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
                  Third-party roles installed for every workspace. Manifests are validated on install;
                  invalid ones are skipped. Reload to pick them up in open workspaces.
                </p>
              </div>
              <GhostButton
                size="md"
                onClick={() => void installGlobalRoleFolder()}
                disabled={globalInstallPending}
                className="h-9"
              >
                {globalInstallPending ? 'Installing' : 'Install from folder'}
              </GhostButton>
            </div>

            {globalInstallMessage ? (
              <MessageBlock tone={globalInstallMessage.tone}>{globalInstallMessage.text}</MessageBlock>
            ) : null}

            {userRoles.length === 0 ? (
              <MessageBlock tone="neutral">
                No global roles installed. Install a folder of role manifests to share roles across
                workspaces.
              </MessageBlock>
            ) : (
              <div className="divide-y divide-[color:var(--border-subtle)] border-y border-[color:var(--border-subtle)]">
                {userRoles.map((role) => (
                  <div key={role.id} className="flex items-baseline justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-[color:var(--text-default)]">{role.label}</div>
                      {role.summary ? (
                        <div className="mt-0.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
                          {role.summary}
                        </div>
                      ) : null}
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-[color:var(--text-subtle)]">{role.id}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {activeSettingsTab === 'mcps' ? (
        <div
          role="tabpanel"
          id="settings-panel-mcps"
          aria-labelledby="settings-tab-mcps"
          className="space-y-5"
        >
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-[12px] font-semibold text-[color:var(--text-strong)]">
                Active
              </h4>
              {activeMcpServers.length ? (
                <span className="tabular-nums text-[11px] font-medium text-[color:var(--text-subtle)]">
                  {activeMcpServers.length} active
                </span>
              ) : null}
            </div>
            {activeMcpServers.length === 0 ? (
              <MessageBlock tone="neutral">
                Nothing selected yet. Click a tile in the catalog below to add it.
              </MessageBlock>
            ) : (
              <ul className="divide-y divide-[color:var(--border-subtle)]">
                {activeMcpServers.map((server) => (
                  <li key={server.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <McpBrandIcon
                        slug={server.source === 'bundled' ? mcpIconSlug(server.id) : null}
                        name={server.name}
                        size={24}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">{server.name}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] leading-4 text-[color:var(--text-subtle)]">
                          {server.id} · {server.transport} · {server.clients.join(', ')}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        removeMcpServer(server.id)
                        setMcpMessage(null)
                      }}
                      className="text-[12px] font-semibold text-[color:var(--text-subtle)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:underline"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex gap-4 border-t border-[color:var(--border-subtle)] pt-4">
            <section className="min-w-0 flex-1 space-y-4">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-[12px] font-semibold text-[color:var(--text-strong)]">
                  Bundled catalog
                </h4>
                {mcpCatalog.length ? (
                  <span className="tabular-nums text-[11px] font-medium text-[color:var(--text-subtle)]">
                    {mcpCatalog.length} servers
                  </span>
                ) : null}
              </div>
              <div className="space-y-5">
                {groupedMcpCatalog.map(([category, servers]) => (
                  <div key={category} className="space-y-2">
                    <div className="flex items-center gap-3">
                      <span className="text-[12px] font-medium text-[color:var(--text-muted)]">{category}</span>
                      <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
                      <span className="tabular-nums font-mono text-[10px] text-[color:var(--text-subtle)]">{servers.length}</span>
                    </div>
                    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${selectedCatalogServer ? '' : 'lg:grid-cols-4'}`}>
                      {servers.map((server) => (
                        <McpCatalogTile
                          key={server.id}
                          server={server}
                          installed={Boolean(mcpSettings.servers[server.id]?.enabled)}
                          selected={selectedCatalogId === server.id}
                          onToggle={() => toggleCatalogServer(server)}
                          onInfo={() => setSelectedCatalogId((current) => current === server.id ? null : server.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
            {selectedCatalogServer ? (
              <McpInfoPanel
                server={selectedCatalogServer}
                installed={Boolean(mcpSettings.servers[selectedCatalogServer.id]?.enabled)}
                onToggle={() => toggleCatalogServer(selectedCatalogServer)}
                onClose={() => setSelectedCatalogId(null)}
              />
            ) : null}
          </div>

          <details className="group space-y-3 border-t border-[color:var(--border-subtle)] pt-4 [&[open]]:space-y-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[12px] font-semibold text-[color:var(--text-muted)] hover:text-[color:var(--text-default)] focus:outline-none focus-visible:underline">
              <span>Custom MCP</span>
              <span aria-hidden className="text-[10px] font-medium text-[color:var(--text-subtle)] transition-transform group-open:rotate-180">▾</span>
            </summary>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Server id" htmlFor="custom-mcp-id">
                <input
                  value={customMcpId}
                  onChange={(event) => setCustomMcpId(event.target.value)}
                  placeholder="server-id"
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Display name" htmlFor="custom-mcp-name">
                <input
                  value={customMcpName}
                  onChange={(event) => setCustomMcpName(event.target.value)}
                  placeholder="Display name"
                  className={`${INPUT_CLASS} font-sans`}
                />
              </Field>
              <Field label="Transport" htmlFor="custom-mcp-transport">
                <Select
                  ariaLabel="Transport"
                  items={MCP_TRANSPORT_ITEMS}
                  value={customMcpTransport}
                  onChange={setCustomMcpTransport}
                  className="h-9 w-full"
                />
              </Field>
              <Field
                label={customMcpTransport === 'stdio' ? 'Command' : 'URL'}
                htmlFor="custom-mcp-endpoint"
              >
                {customMcpTransport === 'stdio' ? (
                  <input
                    value={customMcpCommand}
                    onChange={(event) => setCustomMcpCommand(event.target.value)}
                    placeholder="e.g. npx"
                    className={INPUT_CLASS}
                  />
                ) : (
                  <input
                    value={customMcpUrl}
                    onChange={(event) => setCustomMcpUrl(event.target.value)}
                    placeholder="https://example.com/mcp"
                    className={INPUT_CLASS}
                  />
                )}
              </Field>
              <div className="sm:col-span-2">
                <Field label="Args (space separated)" htmlFor="custom-mcp-args">
                  <input
                    value={customMcpArgs}
                    onChange={(event) => setCustomMcpArgs(event.target.value)}
                    placeholder="e.g. -y @vendor/server"
                    className={INPUT_CLASS}
                  />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Required env vars (comma separated)" htmlFor="custom-mcp-env">
                  <input
                    value={customMcpEnv}
                    onChange={(event) => setCustomMcpEnv(event.target.value)}
                    placeholder="API_KEY, ANOTHER_VAR"
                    className={INPUT_CLASS}
                  />
                </Field>
              </div>
            </div>
            <div className="flex justify-end">
              <GhostButton
                size="md"
                onClick={addCustomMcp}
                className="h-9 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
              >
                Add custom MCP
              </GhostButton>
            </div>
          </details>

          <MessageBlock tone={mcpMessage ? 'accent' : 'neutral'}>
            {mcpMessage || (activeProjectRoot
              ? 'Changes apply automatically across Claude, Codex, and other terminal agents. Existing terminals keep their current config until relaunched.'
              : 'Open a workspace folder to sync MCPs to terminal agents.')}
          </MessageBlock>
        </div>
      ) : null}

      {activeSettingsTab === 'skill-packs' ? (
        <div
          role="tabpanel"
          id="settings-panel-skill-packs"
          aria-labelledby="settings-tab-skill-packs"
          className="space-y-5"
        >
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            Agent skills available to this workspace — Multicode&apos;s bundled workflow skills
            and curated packs from the open <code className="font-mono">skills</code> ecosystem.
          </p>

          <section className="space-y-2 border-t border-[color:var(--border-subtle)] pt-4">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-[12px] font-semibold text-[color:var(--text-strong)]">Bundled</h4>
              {builtinSkills.length ? (
                <span className="tabular-nums text-[11px] font-medium text-[color:var(--text-subtle)]">
                  {builtinSkills.length} skills
                </span>
              ) : null}
            </div>
            <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
              First-party workflow skills, installed into <code className="font-mono">.agents/skills</code>.
              Workspace Knowledge reads and updates the graph configured in the Knowledge graph tab.
            </p>
            <div className="grid gap-2">
              {builtinSkills.length ? builtinSkills.map((skill) => {
                const status = builtinSkillStatuses[skill.id] ?? null
                const installBlocked =
                  !activeProjectRoot
                  || !status
                  || !status.ok
                  || status.status === 'installed'
                  || status.status === 'modified'
                  || status.status === 'local'
                return (
                  <div
                    key={skill.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">{skill.name}</div>
                      <div className="mt-0.5 text-[12px] leading-5 text-[color:var(--text-muted)]">{skill.description}</div>
                      <div className="mt-1 text-[11px] leading-4 text-[color:var(--text-subtle)]">
                        {formatBuiltinSkillStatus(status, skill.id)}
                      </div>
                    </div>
                    <GhostButton
                      size="md"
                      onClick={() => void installBuiltinSkill(skill)}
                      disabled={builtinSkillPendingId !== null || installBlocked}
                      className="h-8 border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
                    >
                      {status?.ok && status.status === 'update-available' ? 'Update' : 'Install'}
                    </GhostButton>
                  </div>
                )
              }) : (
                <div className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-3 py-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
                  Built-in skills have not loaded yet.
                </div>
              )}
            </div>
            {builtinSkillMessage ? (
              <MessageBlock tone="warn">{builtinSkillMessage}</MessageBlock>
            ) : null}
          </section>

          <section className="space-y-2 border-t border-[color:var(--border-subtle)] pt-4">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-[12px] font-semibold text-[color:var(--text-strong)]">Installed</h4>
              {installedSkillPacks.length ? (
                <span className="tabular-nums text-[11px] font-medium text-[color:var(--text-subtle)]">
                  {installedSkillPacks.length} installed
                </span>
              ) : null}
            </div>
            {installedSkillPacks.length === 0 ? (
              <MessageBlock tone="neutral">
                Nothing installed yet. Pick a pack from the catalog below.
              </MessageBlock>
            ) : (
              <ul className="divide-y divide-[color:var(--border-subtle)]">
                {installedSkillPacks.map((pack) => (
                  <li
                    key={pack.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
                        {pack.name}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] leading-4 text-[color:var(--text-subtle)]">
                        {pack.slug}
                        {pack.harnesses.length ? ` · ${pack.harnesses.join(', ')}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const catalogEntry = skillPackCatalog.find((entry) => entry.id === pack.id)
                        if (catalogEntry) {
                          void toggleSkillPack(catalogEntry)
                          return
                        }
                        void toggleSkillPack({
                          id: pack.id,
                          slug: pack.slug,
                          name: pack.name,
                          installedDirName: pack.installedDirName,
                          harnesses: pack.harnesses,
                        })
                      }}
                      disabled={skillPackPendingId === pack.id}
                      className="text-[12px] font-semibold text-[color:var(--text-subtle)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:underline disabled:cursor-progress"
                    >
                      {skillPackPendingId === pack.id ? 'Removing' : 'Remove'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex gap-4 border-t border-[color:var(--border-subtle)] pt-4">
            <section className="min-w-0 flex-1 space-y-4">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-[12px] font-semibold text-[color:var(--text-strong)]">
                  Ecosystem catalog
                </h4>
                {skillPackCatalog.length ? (
                  <span className="tabular-nums text-[11px] font-medium text-[color:var(--text-subtle)]">
                    {skillPackCatalog.length} packs
                  </span>
                ) : null}
              </div>
              <div className="space-y-5">
                {groupedSkillPackCatalog.map(([category, packs]) => (
                  <div key={category} className="space-y-2">
                    <div className="flex items-center gap-3">
                      <span className="text-[12px] font-medium text-[color:var(--text-muted)]">
                        {category}
                      </span>
                      <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
                      <span className="tabular-nums font-mono text-[10px] text-[color:var(--text-subtle)]">
                        {packs.length}
                      </span>
                    </div>
                    <div
                      className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${selectedSkillPack ? '' : 'lg:grid-cols-4'}`}
                    >
                      {packs.map((pack) => (
                        <SkillPackTile
                          key={pack.id}
                          pack={pack}
                          installed={Boolean(skillPackSettings.installed[pack.id])}
                          pending={skillPackPendingId === pack.id}
                          selected={selectedSkillPackId === pack.id}
                          onToggle={() => void toggleSkillPack(pack)}
                          onInfo={() =>
                            setSelectedSkillPackId((current) =>
                              current === pack.id ? null : pack.id,
                            )
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
            {selectedSkillPack ? (
              <SkillPackInfoPanel
                pack={selectedSkillPack}
                installed={Boolean(skillPackSettings.installed[selectedSkillPack.id])}
                pending={skillPackPendingId === selectedSkillPack.id}
                onToggle={() => void toggleSkillPack(selectedSkillPack)}
                onClose={() => setSelectedSkillPackId(null)}
              />
            ) : null}
          </div>

          <MessageBlock tone={skillPackMessage ? 'accent' : 'neutral'}>
            {skillPackMessage
              || 'Install runs `npx skills add <slug>` inside the workspace root and writes files into the harness directories that already exist.'}
          </MessageBlock>
        </div>
      ) : null}

      {activeSettingsTab === 'file-search' ? (
        <div
          role="tabpanel"
          id="settings-panel-file-search"
          aria-labelledby="settings-tab-file-search"
          className="space-y-4"
        >
          {searchExcludesDescriptor && searchExcludesDescriptor.field.type === 'multiline' ? (
            <Field
              label={searchExcludesDescriptor.label}
              htmlFor="search-excludes-textarea"
              help={searchExcludesDescriptor.help}
            >
              <textarea
                value={searchExcludesDraft}
                onChange={(event) => setSearchExcludesDraft(event.target.value)}
                onBlur={(event) => setSearchExcludes(parseSearchExcludeText(event.target.value))}
                rows={searchExcludesDescriptor.field.rows ?? 4}
                placeholder={searchExcludesDescriptor.field.placeholder}
                className={TEXTAREA_CLASS}
              />
            </Field>
          ) : null}
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            Defaults still exclude heavy folders like <span className="font-mono text-[color:var(--text-default)]">.git</span>,{' '}
            <span className="font-mono text-[color:var(--text-default)]">node_modules</span>, and{' '}
            <span className="font-mono text-[color:var(--text-default)]">dist</span>. Add one pattern per line or separate entries with commas.
          </p>
        </div>
      ) : null}

      {activeSettingsTab === 'knowledge-graph' ? (
        <div
          role="tabpanel"
          id="settings-panel-knowledge-graph"
          aria-labelledby="settings-tab-knowledge-graph"
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-sm font-semibold text-[color:var(--text-strong)]">
              Markdown knowledge graph
            </div>
            {activeProjectRoot ? (
              <div
                className="max-w-[260px] truncate rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--accent-primary)]"
                title={activeProjectRoot}
              >
                {basename(activeProjectRoot)}
              </div>
            ) : null}
          </div>

          <p className="text-[12px] leading-5 text-[color:var(--text-subtle)]">
            Each project points at a knowledge folder, relative to its own root.
            Workspaces under a project (including Sprint Engine runs) inherit it.
            Select several to point them at one shared folder.
          </p>

          <ProjectKnowledgeList activeProjectRoot={activeProjectRoot} />

          <div className="border-t border-[color:var(--border-subtle)] pt-4">
            <CompoundSwitchRow
              label="Activity tracking (Claude Code)"
              description="Record which knowledge files Claude touches in this project and animate the graph as files are read. Adds a project-local hook to .claude/settings.local.json. Only files under the knowledge folder are recorded."
              checked={activityInstalled}
              disabled={activityPending || !activeProjectRoot || !activeKnowledgeConfig?.relativeRoot}
              onChange={(next) => void toggleActivityTracking(next)}
            />
            {activityMessage ? (
              <div className="mt-2">
                <MessageBlock tone="warn">{activityMessage}</MessageBlock>
              </div>
            ) : null}
          </div>
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

      {activeSettingsTab === 'voice-dictation' && voiceDictationEnabled ? (
        <div
          role="tabpanel"
          id="settings-panel-voice-dictation"
          aria-labelledby="settings-tab-voice-dictation"
          className="space-y-4"
        >
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            Press the microphone in the top bar (or {window.api.platform === 'darwin' ? 'Cmd+Shift+1' : 'Ctrl+Shift+1'}) to record, then again to stop.
            The audio is sent to a Multivoice transcription host and the text is copied to your clipboard.
            The server can run on this machine, on your network, or be hosted remotely — point the URL at wherever it lives.
          </p>

          <Field label="Server URL" htmlFor="voice-server-url" help="Base URL of the Multivoice transcription host.">
            <input
              id="voice-server-url"
              value={voiceDictation.serverUrl}
              onChange={(event) => setVoiceDictationSettings({ serverUrl: event.target.value })}
              placeholder="http://127.0.0.1:48173"
              className={INPUT_CLASS}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>

          <Field
            label="Auth token"
            htmlFor="voice-auth-token"
            help="Optional. Sent as an Authorization: Bearer header when set."
          >
            <input
              id="voice-auth-token"
              type="password"
              value={voiceDictation.authToken}
              onChange={(event) => setVoiceDictationSettings({ authToken: event.target.value })}
              placeholder="(none)"
              className={INPUT_CLASS}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Whisper model" htmlFor="voice-model" help="The host loads or downloads this model.">
              <Select
                ariaLabel="Whisper model"
                items={VOICE_MODEL_ITEMS}
                value={voiceDictation.model}
                onChange={(model: VoiceDictationModel) => setVoiceDictationSettings({ model })}
                className="h-9 w-full"
              />
            </Field>
            <Field label="Language" htmlFor="voice-language">
              <Select
                ariaLabel="Language"
                items={VOICE_LANGUAGE_ITEMS}
                value={voiceDictation.language}
                onChange={(language: string) => setVoiceDictationSettings({ language })}
                className="h-9 w-full"
              />
            </Field>
          </div>
        </div>
      ) : null}

      {activeSettingsTab === 'telemetry' ? (
        <div
          role="tabpanel"
          id="settings-panel-telemetry"
          aria-labelledby="settings-tab-telemetry"
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-sm font-semibold text-[color:var(--text-strong)]">
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

          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            Raw source, prompts, transcripts, artifact bodies, descriptions, notes, and file contents are not collected by default.
            Production upload is separate from local export and remains disabled until you turn on Send anonymous usage data.
          </p>

          <div className="grid gap-x-6 gap-y-3 border-t border-[color:var(--border-subtle)] pt-4 text-sm sm:grid-cols-2">
            <MetaCell label="Last local export" value={formatNullableDate(usageTelemetry.lastExportAt)} />
            <MetaCell
              label="Upload consent"
              value={usageTelemetry.sendUsageData ? 'Enabled' : 'Disabled'}
              tone={usageTelemetry.sendUsageData ? 'positive' : undefined}
            />
          </div>
        </div>
      ) : null}

      {chrome === 'panel' ? (
        <div className="mt-6 flex justify-end border-t border-[color:var(--border-subtle)] pt-4">
          <GhostButton size="md" onClick={closeSettings}>
            Done
          </GhostButton>
        </div>
      ) : null}
    </>
  )

  if (chrome === 'overlay') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] px-5 py-3.5">
          <h2
            id={titleId}
            className="truncate text-[15px] font-semibold tracking-tight text-[color:var(--text-strong)]"
          >
            Settings
          </h2>
          <div className="flex shrink-0 items-center gap-3">
            <kbd className="hidden font-mono text-[11px] text-[color:var(--text-subtle)] sm:inline">
              Esc
            </kbd>
            <CloseIconButton size="md" aria-label="Close settings" onClick={closeSettings} />
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="shrink-0 overflow-y-auto border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] p-2 md:w-56 md:border-b-0 md:border-r md:p-3">
            {sidebarNode}
          </aside>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {bodyContent}
          </div>
        </div>
      </div>
    )
  }

  return (
    <WorkspacePanel
      title="Settings"
      subtitle="Configure local CLIs, workspace paths, updates, and telemetry."
      titleId="settings-panel-title"
      onClose={closeSettings}
      closeLabel="Close settings"
      sidebar={sidebarNode}
    >
      {bodyContent}
    </WorkspacePanel>
  )
}

const SettingsTabButton = React.forwardRef<HTMLButtonElement, {
  tab: { id: SettingsTabId; label: string; description: string }
  active: boolean
  onClick: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}>(function SettingsTabButton({ tab, active, onClick, onKeyDown }, ref) {
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
      className={`interactive group min-h-12 rounded-md border-l-[3px] px-2.5 py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${
        active
          ? 'border-l-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
          : 'border-l-transparent text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
      }`}
    >
      <span className="block text-[13px] font-semibold leading-5">{tab.label}</span>
      <span className={`mt-0.5 block truncate text-[11px] leading-4 ${active ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-subtle)] group-hover:text-[color:var(--text-muted)]'}`}>
        {tab.description}
      </span>
    </button>
  )
})

function UpdateActionButton({
  label,
  primary,
  onClick,
  disabled,
}: {
  label: string
  primary: boolean
  onClick: () => void
  disabled?: boolean
}) {
  if (primary) {
    return (
      <PrimaryButton size="md" onClick={onClick} disabled={disabled}>
        {label}
      </PrimaryButton>
    )
  }
  return (
    <GhostButton
      size="md"
      onClick={onClick}
      disabled={disabled}
      className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
    >
      {label}
    </GhostButton>
  )
}

function formatBuiltinSkillStatus(status: BuiltinSkillStatus | null, skillId: string): string {
  if (!status) return 'Skill status has not been checked.'
  if (!status.ok) return status.message

  switch (status.status) {
    case 'missing':
      return 'Not installed in this workspace.'
    case 'installed':
      return `Installed in .agents/skills/${skillId}.`
    case 'update-available':
      return `Update available. Installed version: ${status.installedVersion}.`
    case 'modified':
      return 'Installed with local changes. Multicode will not overwrite it.'
    case 'local':
      return status.message
    default:
      return 'Skill status is unknown.'
  }
}

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

function updateChannelTone(channel: AppUpdateState['channel'] | undefined): Tone {
  switch (channel) {
    case 'stable':
      return 'accent'
    case 'preview':
      return 'warn'
    case 'dev':
      return 'accent'
    default:
      return 'neutral'
  }
}

function formatGitHubTokenStatus(status: GitHubTokenUiStatus | null): string {
  if (!status) return 'Checking'
  if (status.source === 'settings') return 'Saved'
  if (status.source === 'environment') return 'Environment'
  return 'Not set'
}

function githubTokenTone(status: GitHubTokenUiStatus | null): Tone {
  if (status?.configured) return 'accent'
  return 'neutral'
}

function updateMessageTone(status: AppUpdateState['status'] | undefined): MessageTone {
  switch (status) {
    case 'available':
    case 'downloaded':
      return 'accent'
    case 'checking':
    case 'downloading':
      return 'warn'
    case 'error':
      return 'error'
    default:
      return 'neutral'
  }
}

function formatUpdateStatus(state: AppUpdateState | null): string {
  if (!state) return 'Loading update status.'
  if (!state.packaged) return 'Update checks are available after installing a packaged build.'
  switch (state.status) {
    case 'checking':
      return 'Checking for updates.'
    case 'available':
      return state.updateVersion ? `Multicode ${state.updateVersion} is available.` : 'An update is available.'
    case 'downloading':
      return state.progress ? `Downloading update (${Math.round(state.progress.percent)}%).` : 'Downloading update.'
    case 'downloaded':
      return 'Update downloaded. Restart Multicode to install it.'
    case 'not_available':
      return 'Multicode is up to date.'
    case 'error':
      return state.errorMessage ?? 'Update check failed.'
    default:
      return 'No update check is running.'
  }
}
