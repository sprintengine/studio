import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli, McpCatalogServer, McpServerConfig, McpSettings } from '../../types/workspace'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { WorkspacePanel } from '../ui/WorkspacePanel'
import LearnCenter from '../learn/LearnCenter'
import MobileSettingsTab from './MobileSettingsTab'
import { MetaCell, SettingToggle, formatNullableDate } from './SettingsAtoms'
import MulticodeMark from '../brand/MulticodeMark'

interface Props {
  onClose: () => void
  checkForUpdatesOnOpen?: boolean
  checkForUpdatesRequestId?: number
  initialTab?: string | null
  onOpenSettingsTab?: (tabId: string) => void
}

type UpdateAction = 'check' | 'download' | 'restart'

type GitHubTokenUiStatus = Awaited<ReturnType<typeof window.api.getGitHubTokenStatus>>

const EMPTY_SEARCH_EXCLUDES: string[] = []
const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}
const EMPTY_MCP_SETTINGS: McpSettings = { syncEnabled: false, servers: {} }

type SettingsTabId =
  | 'updates'
  | 'github'
  | 'agents'
  | 'mcps'
  | 'file-search'
  | 'knowledge-graph'
  | 'learn'
  | 'mobile'
  | 'telemetry'

const settingsTabs: Array<{ id: SettingsTabId; label: string; description: string }> = [
  { id: 'updates', label: 'Updates', description: 'Version and release channel' },
  { id: 'github', label: 'GitHub', description: 'Issue import token' },
  { id: 'agents', label: 'Agents', description: 'CLI runtime commands' },
  { id: 'mcps', label: 'MCPs', description: 'Agent tool integrations' },
  { id: 'file-search', label: 'File Search', description: 'Index exclude patterns' },
  { id: 'knowledge-graph', label: 'Knowledge Graph', description: 'Project knowledge' },
  { id: 'learn', label: 'Learn', description: 'Tips and lessons' },
  { id: 'mobile', label: 'Mobile', description: 'Phone pairing and relay' },
  { id: 'telemetry', label: 'Telemetry', description: 'Usage and diagnostics' },
]

function isSettingsTabId(value: unknown): value is SettingsTabId {
  return (
    value === 'updates'
    || value === 'github'
    || value === 'agents'
    || value === 'mcps'
    || value === 'file-search'
    || value === 'knowledge-graph'
    || value === 'learn'
    || value === 'mobile'
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

function mcpServerFromCatalog(server: McpCatalogServer): McpServerConfig {
  return {
    id: server.id,
    name: server.name,
    category: server.category,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    url: server.url,
    env: server.env,
    envVarNames: server.envVarNames ?? [],
    headers: server.headers,
    enabled: true,
    required: false,
    clients: server.defaultClients?.length ? server.defaultClients : server.clients,
    scope: server.recommendedScope ?? 'workspace',
    source: 'bundled',
    riskLevel: server.riskLevel,
    auth: server.auth,
    capabilities: server.capabilities,
    sourceUrl: server.sourceUrl,
  }
}

function groupMcpCatalog(servers: McpCatalogServer[]): Array<[string, McpCatalogServer[]]> {
  const groups = new Map<string, McpCatalogServer[]>()
  for (const server of servers) {
    const category = server.category?.trim() || 'Other'
    groups.set(category, [...(groups.get(category) ?? []), server])
  }
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right))
}

function mcpIconSlug(id: string): string | null {
  if (id === 'context7') return null
  if (id === 'openai-docs') return 'openai'
  if (id === 'brave-search') return 'brave'
  return id
}

function mcpMonogram(name: string): string {
  return name
    .split(/\s+/u)
    .map((piece) => piece[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function McpBrandIcon({
  slug,
  name,
  size = 36,
}: {
  slug: string | null
  name: string
  size?: number
}) {
  const [failed, setFailed] = useState(false)
  if (!slug || failed) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
        className="grid place-items-center rounded-md bg-[#1c1d25] font-mono font-semibold text-[#d7d7dc]"
      >
        {mcpMonogram(name)}
      </span>
    )
  }
  return (
    <img
      src={`https://cdn.simpleicons.org/${slug}/e5e7eb`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="pointer-events-none select-none"
    />
  )
}

function McpCatalogTile({
  server,
  installed,
  selected,
  onToggle,
  onInfo,
}: {
  server: McpCatalogServer
  installed: boolean
  selected: boolean
  onToggle: () => void
  onInfo: () => void
}) {
  const tileClass = installed
    ? 'border-[#5c7cff]/55 bg-[#100f1c] shadow-[0_0_0_1px_rgba(92,124,255,0.18),0_0_24px_-12px_rgba(92,124,255,0.55)]'
    : selected
      ? 'border-[#3a3b42] bg-[#11121a]'
      : 'border-[#24252b] bg-[#0d0e11] hover:border-[#3a3b42] hover:bg-[#11121a]'
  return (
    <div className="relative aspect-square">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={installed}
        aria-label={installed ? `Remove ${server.name}` : `Add ${server.name}`}
        className={`flex h-full w-full flex-col items-start justify-between rounded-lg border p-3 text-left transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60 ${tileClass}`}
      >
        <McpBrandIcon slug={mcpIconSlug(server.id)} name={server.name} size={36} />
        {installed ? (
          <span
            aria-hidden
            className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-[#5c7cff] text-[#08090b]"
          >
            <svg
              viewBox="0 0 10 10"
              className="h-2.5 w-2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="1.5,5 4,7.5 8.5,2.5" />
            </svg>
          </span>
        ) : null}
        <div className="w-full min-w-0 pr-6">
          <div className="truncate text-[13px] font-semibold leading-5 text-[#ececee]">{server.name}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] leading-3 text-[#6f7078]">{server.transport}</div>
        </div>
      </button>
      <button
        type="button"
        onClick={onInfo}
        aria-label={`Show details for ${server.name}`}
        aria-expanded={selected}
        className={`absolute bottom-2 right-2 z-10 grid h-5 w-5 place-items-center rounded-full transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60 ${
          selected
            ? 'bg-[#5c7cff]/20 text-[#b8ccff]'
            : 'text-[#5f6068] hover:bg-[#1c1d25] hover:text-[#d7d7dc]'
        }`}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5A5.5 5.5 0 118 2.5a5.5 5.5 0 010 11zM7.25 5.5a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM7.25 7.25a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4z" />
        </svg>
      </button>
    </div>
  )
}

function McpInfoPanel({
  server,
  installed,
  onToggle,
  onClose,
}: {
  server: McpCatalogServer
  installed: boolean
  onToggle: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const hasAuth = Boolean(server.auth && server.auth.trim().toLowerCase() !== 'none')

  return (
    <aside
      aria-label={`${server.name} details`}
      className="sticky top-2 w-72 shrink-0 self-start rounded-lg border border-[#24252b] bg-[#0d0e11] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <McpBrandIcon slug={mcpIconSlug(server.id)} name={server.name} size={32} />
          <div className="min-w-0">
            <h5 className="truncate text-[14px] font-semibold leading-5 text-[#ececee]">{server.name}</h5>
            <div className="mt-0.5 truncate font-mono text-[11px] text-[#7f8088]">{server.transport}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[#7f8088] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
      {server.description ? (
        <p className="mt-3 text-[12px] leading-5 text-[#9a9aa2]">{server.description}</p>
      ) : null}
      {hasAuth ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#5f6068]">Auth</div>
          <div className="mt-1 text-[12px] text-[#d5a868]">{server.auth}</div>
        </div>
      ) : null}
      {server.capabilities?.length ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#5f6068]">Capabilities</div>
          <ul className="mt-1 space-y-0.5 text-[12px] text-[#9a9aa2]">
            {server.capabilities.map((capability) => (
              <li key={capability} className="flex gap-1.5">
                <span aria-hidden className="text-[#5f6068]">·</span>
                <span>{capability}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {server.setupNotes ? (
        <p className="mt-3 border-l-2 border-[rgba(255,255,255,0.10)] pl-2 text-[11px] leading-4 text-[#7f8088]">
          {server.setupNotes}
        </p>
      ) : null}
      {server.sourceUrl ? (
        <a
          href={server.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex text-[12px] font-semibold text-[#9fb4ff] transition-colors hover:text-[#c5d0ff] focus:outline-none focus-visible:underline"
        >
          Source docs
        </a>
      ) : null}
      <button
        type="button"
        onClick={onToggle}
        className={`mt-4 h-9 w-full rounded-md text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60 ${
          installed
            ? 'border border-[#3a3b42] bg-[#0d0e11] text-[#d7d7dc] hover:bg-[#17181d]'
            : 'bg-[#5c7cff] text-[#08090b] hover:bg-[#6e8eff]'
        }`}
      >
        {installed ? 'Remove' : 'Add to active'}
      </button>
    </aside>
  )
}

function parseSearchExcludeText(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((pattern) => pattern.trim())
    .filter(Boolean)
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

function normalizePathParts(value: string): { drive: string | null; parts: string[] } {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '')
  const driveMatch = normalized.match(/^([A-Za-z]:)\/(.*)$/)
  if (driveMatch) {
    return {
      drive: driveMatch[1].toLowerCase(),
      parts: driveMatch[2].split('/').filter(Boolean),
    }
  }
  return {
    drive: null,
    parts: normalized.split('/').filter(Boolean),
  }
}

function relativePathBetween(fromPath: string, toPath: string): string | null {
  const from = normalizePathParts(fromPath)
  const to = normalizePathParts(toPath)
  if (from.drive !== to.drive) return null

  let common = 0
  while (
    common < from.parts.length
    && common < to.parts.length
    && from.parts[common].toLowerCase() === to.parts[common].toLowerCase()
  ) {
    common += 1
  }

  return [
    ...from.parts.slice(common).map(() => '..'),
    ...to.parts.slice(common),
  ].join('/') || '.'
}

export default function SettingsPanel({
  onClose,
  checkForUpdatesOnOpen = false,
  checkForUpdatesRequestId,
  initialTab = null,
  onOpenSettingsTab,
}: Props) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId) ?? null
  )
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const mcpSettings = useWorkspaceStore((s) => s.appSettings.mcp ?? EMPTY_MCP_SETTINGS)
  const searchExcludes = useWorkspaceStore((s) => s.appSettings.searchExcludes ?? EMPTY_SEARCH_EXCLUDES)
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? EMPTY_PROJECT_KNOWLEDGE_ROOTS)
  const usageTelemetry = useWorkspaceStore((s) => s.appSettings.usageTelemetry)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const setMcpSyncEnabled = useWorkspaceStore((s) => s.setMcpSyncEnabled)
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const removeMcpServer = useWorkspaceStore((s) => s.removeMcpServer)
  const setSearchExcludes = useWorkspaceStore((s) => s.setSearchExcludes)
  const setProjectKnowledgeRoot = useWorkspaceStore((s) => s.setProjectKnowledgeRoot)
  const setUsageTelemetrySettings = useWorkspaceStore((s) => s.setUsageTelemetrySettings)
  const activeKnowledgeConfig = resolveProjectKnowledgeConfig(
    activeWorkspace?.folderPath,
    projectKnowledgeRoots,
    activeWorkspace?.memory.relativeRoot
  )
  const activeProjectRoot = activeKnowledgeConfig?.projectRoot ?? activeWorkspace?.folderPath ?? null
  const isWindows = window.api.platform === 'win32'
  const [searchExcludesDraft, setSearchExcludesDraft] = useState(() => searchExcludes.join('\n'))
  const [memoryDraft, setMemoryDraft] = useState(() => activeKnowledgeConfig?.relativeRoot ?? '')
  const [memoryStatus, setMemoryStatus] = useState<MemoryRootStatus | null>(null)
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
  const [mcpPending, setMcpPending] = useState(false)
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null)
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
  const tabRefs = useRef<Record<SettingsTabId, HTMLButtonElement | null>>({
    updates: null,
    github: null,
    agents: null,
    mcps: null,
    'file-search': null,
    'knowledge-graph': null,
    learn: null,
    mobile: null,
    telemetry: null,
  })
  const autoCheckStartedRef = useRef(false)
  const lastUpdateRequestIdRef = useRef<number | null>(null)

  const commitMemoryDraft = useCallback((value: string) => {
    if (!activeProjectRoot) return
    const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
    setProjectKnowledgeRoot(activeProjectRoot, trimmed || null)
  }, [activeProjectRoot, setProjectKnowledgeRoot])

  const closeSettings = useCallback(() => {
    setSearchExcludes(parseSearchExcludeText(searchExcludesDraft))
    commitMemoryDraft(memoryDraft)
    onClose()
  }, [commitMemoryDraft, memoryDraft, onClose, searchExcludesDraft, setSearchExcludes])

  useEffect(() => {
    setSearchExcludesDraft(searchExcludes.join('\n'))
  }, [searchExcludes])

  useEffect(() => {
    setMemoryDraft(activeKnowledgeConfig?.relativeRoot ?? '')
  }, [activeKnowledgeConfig?.projectRoot, activeKnowledgeConfig?.relativeRoot, activeWorkspace?.id])

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
        const confirmed = window.confirm(
          'Enable knowledge activity tracking?\n\n'
          + 'Multicode will:\n'
          + ' • Add a hook to .claude/settings.local.json in the project folder\n'
          + ' • Copy a hook script to .multicode/hooks/\n'
          + ' • Record knowledge file touches to .multicode/knowledge-trace/\n\n'
          + 'Only files under your knowledge folder are recorded. Add .multicode/ to .gitignore.'
        )
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

  const syncMcps = useCallback(async () => {
    if (!activeProjectRoot) {
      setMcpMessage('Open a workspace folder before syncing MCPs.')
      return
    }
    setMcpPending(true)
    setMcpMessage(null)
    try {
      const result = await window.api.mcpSync({
        workspaceRoot: activeProjectRoot,
        settings: mcpSettings,
      })
      if (result.ok) {
        const targetCount = result.targets.length
        const issueText = result.issues.length ? ` ${result.issues.map((issue) => issue.message).join(' ')}` : ''
        setMcpMessage(targetCount
          ? `Synced ${targetCount} MCP target${targetCount === 1 ? '' : 's'}.${issueText}`
          : `No enabled MCP targets to sync.${issueText}`)
      } else {
        setMcpMessage(result.message)
      }
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : 'MCP sync failed.')
    } finally {
      setMcpPending(false)
    }
  }, [activeProjectRoot, mcpSettings])

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
    setMcpMessage('Custom MCP added. Sync applies to new agent terminals.')
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

  useEffect(() => {
    let cancelled = false
    const relativeRoot = memoryDraft.trim()
    if (!activeWorkspaceId || !relativeRoot) {
      setMemoryStatus(null)
      return
    }
    if (isAbsolutePath(relativeRoot)) {
      setMemoryStatus({
        ok: false,
        status: 'invalid-relative-path',
        relativeRoot: null,
        message: 'Knowledge path must be relative to the project folder.',
      })
      return
    }

    const timer = window.setTimeout(() => {
      void window.api.memoryResolveRoot({
        workspaceRoot: activeProjectRoot,
        relativeRoot,
      }).then((status) => {
        if (!cancelled) setMemoryStatus(status)
      }).catch((error) => {
        if (!cancelled) {
          setMemoryStatus({
            ok: false,
            status: 'inaccessible',
            relativeRoot,
            message: error instanceof Error ? error.message : 'Unable to check knowledge path.',
          })
        }
      })
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeProjectRoot, activeWorkspaceId, memoryDraft])

  const chooseMemoryFolder = async () => {
    if (!activeProjectRoot || !activeWorkspaceId) return
    const dir = await window.api.openDir()
    if (!dir) return
    const relativePath = relativePathBetween(activeProjectRoot, dir)
    if (!relativePath || relativePath === '.') {
      setMemoryStatus({
        ok: false,
        status: 'invalid-relative-path',
        relativeRoot: null,
        message: 'Choose a folder that can be expressed relative to the project folder.',
      })
      return
    }
    setMemoryDraft(relativePath)
    setProjectKnowledgeRoot(activeProjectRoot, relativePath)
  }

  const nextUpdateAction: UpdateAction = updateState?.downloaded
    ? 'restart'
    : updateState?.status === 'available'
      ? 'download'
      : 'check'

  const activeTab = settingsTabs.find((tab) => tab.id === activeSettingsTab) ?? settingsTabs[0]
  const groupedMcpCatalog = groupMcpCatalog(mcpCatalog)
  const selectedCatalogServer = selectedCatalogId
    ? mcpCatalog.find((server) => server.id === selectedCatalogId) ?? null
    : null
  const activeMcpServers = Object.values(mcpSettings.servers).filter((server) => server.enabled)

  const toggleCatalogServer = useCallback((server: McpCatalogServer) => {
    const existing = mcpSettings.servers[server.id]
    if (existing?.enabled) {
      removeMcpServer(server.id)
      setMcpMessage(`${server.name} removed.`)
    } else {
      upsertMcpServer(mcpServerFromCatalog(server))
      setMcpMessage(server.setupNotes
        ? `${server.name} added. ${server.setupNotes}`
        : `${server.name} added.`)
    }
  }, [mcpSettings.servers, removeMcpServer, upsertMcpServer])

  const selectSettingsTab = useCallback((tabId: SettingsTabId) => {
    setActiveSettingsTab(tabId)
  }, [])

  const onSettingsTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keyToIndex: Record<string, number> = {
      ArrowDown: (index + 1) % settingsTabs.length,
      ArrowRight: (index + 1) % settingsTabs.length,
      ArrowUp: (index - 1 + settingsTabs.length) % settingsTabs.length,
      ArrowLeft: (index - 1 + settingsTabs.length) % settingsTabs.length,
      Home: 0,
      End: settingsTabs.length - 1,
    }
    const nextIndex = keyToIndex[event.key]
    if (nextIndex === undefined) return
    event.preventDefault()
    const nextTab = settingsTabs[nextIndex]
    setActiveSettingsTab(nextTab.id)
    window.requestAnimationFrame(() => tabRefs.current[nextTab.id]?.focus())
  }, [])

  return (
    <WorkspacePanel
      title="Settings"
      subtitle="Configure local CLIs, workspace paths, updates, and telemetry."
      titleId="settings-panel-title"
      onClose={closeSettings}
      closeLabel="Close settings"
      sidebar={
        <div
          role="tablist"
          aria-label="Settings categories"
          aria-orientation="vertical"
          className="grid grid-cols-2 gap-1 md:grid-cols-1"
        >
          {settingsTabs.map((tab, index) => (
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
      }
    >
      <div className="mb-4 border-b border-[#24252b] pb-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
          {activeTab.label}
        </div>
        <h3 className="mt-1 text-[18px] font-semibold tracking-tight text-[#ececee]">
          {activeTab.description}
        </h3>
      </div>

        {activeSettingsTab === 'updates' ? (
        <div
          role="tabpanel"
          id="settings-panel-updates"
          aria-labelledby="settings-tab-updates"
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-[#ececee]">
              <MulticodeMark className="h-4 w-4 shrink-0" />
              <span>multicode {updateState?.version ?? '...'}</span>
            </div>
            <div className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${updateChannelClass(updateState?.channel)}`}>
              {formatUpdateChannel(updateState?.channel)}
            </div>
          </div>

          <div className={`border-l-2 pl-3 text-[12px] leading-5 ${updateStatusClass(updateState?.status)}`}>
            {formatUpdateStatus(updateState)}
            {updateState?.progress ? (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#24252b]">
                <div
                  className="h-full rounded-full bg-[#5c7cff]"
                  style={{ width: `${Math.max(0, Math.min(100, updateState.progress.percent))}%` }}
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => void window.api.updateOpenReleaseNotes()}
              className="text-sm font-semibold text-[#b8ccff] transition-colors hover:text-[#d4ddff] focus:outline-none focus-visible:underline"
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

          <div className="grid gap-x-6 gap-y-3 border-t border-[#24252b] pt-4 text-sm sm:grid-cols-2">
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
            <div className="min-w-0 text-sm font-semibold text-[#ececee]">
              GitHub access token
            </div>
            <div className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${githubTokenStatusClass(githubTokenStatus)}`}>
              {formatGitHubTokenStatus(githubTokenStatus)}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
              Token
            </span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                value={githubTokenDraft}
                onChange={(event) => setGithubTokenDraft(event.target.value)}
                placeholder={githubTokenStatus?.configured ? 'Token saved' : 'Fine-grained GitHub token'}
                autoComplete="off"
                className="h-9 min-w-0 flex-1 rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void saveGitHubToken()}
                  disabled={githubTokenPending || !githubTokenDraft.trim()}
                  className="h-9 rounded-md bg-[#5c7cff] px-3 text-sm font-semibold text-[#08090b] transition-colors hover:bg-[#6e8eff] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#5c7cff]"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => void clearGitHubToken()}
                  disabled={githubTokenPending || githubTokenStatus?.source !== 'settings'}
                  className="h-9 rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#0d0e11]"
                >
                  Clear
                </button>
              </div>
            </div>
          </label>

          <div className={`border-l-2 pl-3 text-[12px] leading-5 ${
            githubTokenMessage
              ? 'border-[#5c7cff]/70 text-[#b8ccff]'
              : 'border-[rgba(255,255,255,0.10)] text-[#9a9aa2]'
          }`}>
            {githubTokenMessage || 'Switchboard uses this token to import private GitHub issues. The token is stored on this device and is not saved in workspace files.'}
            {githubTokenStatus && !githubTokenStatus.encryptionAvailable ? ' Secure storage is unavailable, so the token is kept for this app session only.' : ''}
          </div>
        </div>
        ) : null}

        {activeSettingsTab === 'agents' ? (
        <div
          role="tabpanel"
          id="settings-panel-agents"
          aria-labelledby="settings-tab-agents"
          className="space-y-4"
        >
          {([
            ['codex', 'Codex command'],
            ['claude', 'Claude command'],
          ] as Array<[AgentCli, string]>).map(([cli, label]) => (
            <div key={cli} className="space-y-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                  {label}
                </span>
                <input
                  value={cliRuntimes[cli].command}
                  onChange={(event) => setCliRuntime(cli, { command: event.target.value })}
                  placeholder={cli}
                  className="w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-2 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
                />
              </label>

              {isWindows && (
                <SettingToggle
                  label={`Run ${cli === 'codex' ? 'Codex' : 'Claude'} through WSL`}
                  enabled={cliRuntimes[cli].useWsl}
                  onChange={(enabled) => setCliRuntime(cli, { useWsl: enabled })}
                />
              )}
            </div>
          ))}
          <p className="text-[12px] leading-5 text-[#5a5a63]">
            Defaults are <span className="font-mono text-[#d7d7dc]">codex</span> native and{' '}
            <span className="font-mono text-[#d7d7dc]">claude</span>{isWindows ? ' through WSL' : ''}.
            Use a full executable path if your CLI is not on PATH.
          </p>
        </div>
        ) : null}

        {activeSettingsTab === 'mcps' ? (
        <div
          role="tabpanel"
          id="settings-panel-mcps"
          aria-labelledby="settings-tab-mcps"
          className="space-y-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <SettingToggle
                label="Sync MCPs for new agent terminals"
                description="Multicode writes enabled MCPs to Codex and Claude workspace config before launching a new agent terminal."
                enabled={mcpSettings.syncEnabled}
                onChange={setMcpSyncEnabled}
              />
            </div>
            <button
              type="button"
              onClick={() => void syncMcps()}
              disabled={mcpPending || !activeProjectRoot}
              className="mt-3 h-9 shrink-0 rounded-md bg-[#5c7cff] px-3 text-sm font-semibold text-[#08090b] transition-colors hover:bg-[#6e8eff] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#5c7cff]"
            >
              {mcpPending ? 'Syncing' : 'Sync now'}
            </button>
          </div>

          <section className="space-y-2 border-t border-[#24252b] pt-4">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                Active
              </h4>
              {activeMcpServers.length ? (
                <span className="text-[11px] font-medium text-[#5f6068]">
                  {activeMcpServers.length} active
                </span>
              ) : null}
            </div>
            {activeMcpServers.length === 0 ? (
              <div className="border-l-2 border-[rgba(255,255,255,0.10)] pl-3 text-[12px] leading-5 text-[#9a9aa2]">
                Nothing selected yet. Click a tile in the catalog below to add it.
              </div>
            ) : (
              <ul className="divide-y divide-[#24252b]">
                {activeMcpServers.map((server) => (
                  <li key={server.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <McpBrandIcon
                        slug={server.source === 'bundled' ? mcpIconSlug(server.id) : null}
                        name={server.name}
                        size={24}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-[#ececee]">{server.name}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] leading-4 text-[#7f8088]">
                          {server.id} · {server.transport} · {server.clients.join(', ')}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        removeMcpServer(server.id)
                        setMcpMessage(`${server.name} removed.`)
                      }}
                      className="text-[12px] font-semibold text-[#7f8088] transition-colors hover:text-[#ececee] focus:outline-none focus-visible:underline"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex gap-4 border-t border-[#24252b] pt-4">
            <section className="min-w-0 flex-1 space-y-4">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                  Bundled catalog
                </h4>
                {mcpCatalog.length ? (
                  <span className="text-[11px] font-medium text-[#5f6068]">
                    {mcpCatalog.length} servers
                  </span>
                ) : null}
              </div>
              <div className="space-y-5">
                {groupedMcpCatalog.map(([category, servers]) => (
                  <div key={category} className="space-y-2">
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#8a8a92]">{category}</span>
                      <span className="h-px flex-1 bg-[#24252b]" />
                      <span className="font-mono text-[10px] text-[#5f6068]">{servers.length}</span>
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

          <details className="group space-y-3 border-t border-[#24252b] pt-4 [&[open]]:space-y-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2] transition-colors hover:text-[#d7d7dc] focus:outline-none focus-visible:underline">
              <span>Custom MCP</span>
              <span aria-hidden className="text-[10px] font-medium tracking-normal text-[#5f6068] transition-transform group-open:rotate-180">▾</span>
            </summary>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">Server id</span>
                <input
                  value={customMcpId}
                  onChange={(event) => setCustomMcpId(event.target.value)}
                  placeholder="server-id"
                  className="h-9 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">Display name</span>
                <input
                  value={customMcpName}
                  onChange={(event) => setCustomMcpName(event.target.value)}
                  placeholder="Display name"
                  className="h-9 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">Transport</span>
                <select
                  value={customMcpTransport}
                  onChange={(event) => setCustomMcpTransport(event.target.value === 'http' ? 'http' : 'stdio')}
                  className="h-9 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm text-[#ececee] outline-none transition-colors focus:border-[#5c7cff]/70"
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                  {customMcpTransport === 'stdio' ? 'Command' : 'URL'}
                </span>
                {customMcpTransport === 'stdio' ? (
                  <input
                    value={customMcpCommand}
                    onChange={(event) => setCustomMcpCommand(event.target.value)}
                    placeholder="e.g. npx"
                    className="h-9 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
                  />
                ) : (
                  <input
                    value={customMcpUrl}
                    onChange={(event) => setCustomMcpUrl(event.target.value)}
                    placeholder="https://example.com/mcp"
                    className="h-9 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
                  />
                )}
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">Args (space separated)</span>
                <input
                  value={customMcpArgs}
                  onChange={(event) => setCustomMcpArgs(event.target.value)}
                  placeholder="e.g. -y @vendor/server"
                  className="h-9 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">Required env vars (comma separated)</span>
                <input
                  value={customMcpEnv}
                  onChange={(event) => setCustomMcpEnv(event.target.value)}
                  placeholder="API_KEY, ANOTHER_VAR"
                  className="h-9 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
                />
              </label>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={addCustomMcp}
                className="h-9 rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d]"
              >
                Add custom MCP
              </button>
            </div>
          </details>

          <div className={`border-l-2 pl-3 text-[12px] leading-5 ${mcpMessage ? 'border-[#5c7cff]/70 text-[#b8ccff]' : 'border-[rgba(255,255,255,0.10)] text-[#9a9aa2]'}`}>
            {mcpMessage || 'Workspace-scoped sync writes Codex config to .codex/config.toml and Claude config to .mcp.json. Existing terminals are unchanged.'}
          </div>
        </div>
        ) : null}

        {activeSettingsTab === 'file-search' ? (
        <div
          role="tabpanel"
          id="settings-panel-file-search"
          aria-labelledby="settings-tab-file-search"
          className="space-y-4"
        >
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
              Additional exclude patterns
            </span>
            <textarea
              value={searchExcludesDraft}
              onChange={(event) => setSearchExcludesDraft(event.target.value)}
              onBlur={(event) => setSearchExcludes(parseSearchExcludeText(event.target.value))}
              rows={4}
              placeholder={'generated\n*.snap\nfixtures/large/**'}
              className="min-h-[96px] w-full resize-y rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-2 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
            />
          </label>
          <p className="text-[12px] leading-5 text-[#5a5a63]">
            Defaults still exclude heavy folders like <span className="font-mono text-[#d7d7dc]">.git</span>,{' '}
            <span className="font-mono text-[#d7d7dc]">node_modules</span>, and{' '}
            <span className="font-mono text-[#d7d7dc]">dist</span>. Add one pattern per line or separate entries with commas.
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
            <div className="min-w-0 text-sm font-semibold text-[#ececee]">
              Markdown knowledge graph
            </div>
            {activeWorkspace ? (
              <div className="max-w-[260px] truncate rounded-md border border-[#303139] bg-[#0d0e11] px-2.5 py-1 text-[11px] font-semibold text-[#b8ccff]">
                {activeWorkspace.name}
              </div>
            ) : null}
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
              Knowledge folder
            </span>
            <div className="flex gap-2">
              <input
                value={memoryDraft}
                onChange={(event) => setMemoryDraft(event.target.value)}
                onBlur={(event) => commitMemoryDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                  }
                }}
                placeholder="../ecosystem-knowledge"
                disabled={!activeWorkspace}
                className="h-9 min-w-0 flex-1 rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70 disabled:opacity-45"
              />
              <button
                type="button"
                onClick={() => void chooseMemoryFolder()}
                disabled={!activeProjectRoot}
                className="h-9 rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#0d0e11]"
              >
                Choose
              </button>
            </div>
          </label>

          <div className={`border-l-2 pl-3 text-[12px] leading-5 ${
            memoryStatus?.ok
              ? 'border-[#5c7cff]/70 text-[#b8ccff]'
              : memoryStatus
                ? 'border-[#ffbf2f]/75 text-[#ffd58a]'
                : 'border-[rgba(255,255,255,0.10)] text-[#9a9aa2]'
          }`}>
            {memoryStatus?.ok
              ? `Ready: ${memoryStatus.relativeRoot}`
              : memoryStatus
                ? `${memoryStatus.message} Do not guess another folder.`
                : activeProjectRoot
                  ? 'Set a relative path from the project folder. Workspaces under this project inherit the Knowledge Graph.'
                  : 'Open a workspace folder before configuring the Knowledge Graph.'}
          </div>

          <div className="border-t border-[#24252b] pt-4">
            <div className="mb-4 border-l-2 border-[#24252b] pl-3">
              <div className="mb-3 min-w-0">
                <div className="text-sm font-semibold text-[#ececee]">
                  Built-in agent skills
                </div>
                <div className="mt-1 text-[12px] leading-5 text-[#9a9aa2]">
                  {activeKnowledgeConfig?.relativeRoot
                    ? `Install workflow skills into .agents/skills. Knowledge-aware skills will use the configured graph: ${activeKnowledgeConfig.relativeRoot}.`
                    : ' Configure a knowledge folder so agents know which graph to read and update.'}
                </div>
              </div>
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
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#24252b] bg-[#0d0e11]/55 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-[#ececee]">{skill.name}</div>
                        <div className="mt-0.5 text-[12px] leading-5 text-[#9a9aa2]">{skill.description}</div>
                        <div className="mt-1 text-[11px] leading-4 text-[#6f7078]">
                          {formatBuiltinSkillStatus(status, skill.id)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void installBuiltinSkill(skill)}
                        disabled={builtinSkillPendingId !== null || installBlocked}
                        className="h-8 rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#0d0e11]"
                      >
                        {status?.ok && status.status === 'update-available' ? 'Update' : 'Install'}
                      </button>
                    </div>
                  )
                }) : (
                  <div className="rounded-md border border-[#24252b] bg-[#0d0e11]/55 px-3 py-2 text-[12px] leading-5 text-[#9a9aa2]">
                    Built-in skills have not loaded yet.
                  </div>
                )}
              </div>
              {builtinSkillMessage ? (
                <div className="basis-full border-l-2 border-[#ffbf2f]/75 pl-3 text-[12px] leading-5 text-[#ffd58a]">
                  {builtinSkillMessage}
                </div>
              ) : null}
            </div>

            <SettingToggle
              label="Activity tracking (Claude Code)"
              description="Record which knowledge files Claude touches in this project and animate the graph as files are read. Adds a project-local hook to .claude/settings.local.json. Only files under the knowledge folder are recorded."
              enabled={activityInstalled}
              disabled={activityPending || !activeProjectRoot || !activeKnowledgeConfig?.relativeRoot}
              onChange={(next) => void toggleActivityTracking(next)}
            />
            {activityMessage ? (
              <div className="mt-2 border-l-2 border-[#ffbf2f]/75 pl-3 text-[12px] leading-5 text-[#ffd58a]">
                {activityMessage}
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

        {activeSettingsTab === 'mobile' ? <MobileSettingsTab /> : null}

        {activeSettingsTab === 'telemetry' ? (
        <div
          role="tabpanel"
          id="settings-panel-telemetry"
          aria-labelledby="settings-tab-telemetry"
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-sm font-semibold text-[#ececee]">
              SprintEngine usage data and diagnostics
            </div>
            <div className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
              import.meta.env.DEV
                ? 'border-[#ffbf2f]/35 bg-[#ffbf2f]/10 text-[#ffe0a3]'
                : 'border-[#303139] bg-[#0d0e11] text-[#9a9aa2]'
            }`}>
              {import.meta.env.DEV ? 'Development build' : 'Production build'}
            </div>
          </div>

          <div className="divide-y divide-[#24252b]">
            <SettingToggle
              label="Send usage data"
              description="Upload sanitized SprintEngine usage records only after explicit consent. This stays off by default for production builds."
              enabled={usageTelemetry.sendUsageData}
              onChange={(enabled) => setUsageTelemetrySettings({ sendUsageData: enabled })}
            />
            <SettingToggle
              label="Local dev export"
              description="Write sanitized JSONL records to the sibling admin portal during local development. This can default on only in development builds."
              enabled={usageTelemetry.localDevExportEnabled}
              onChange={(enabled) => setUsageTelemetrySettings({ localDevExportEnabled: enabled })}
            />
            <SettingToggle
              label="Export diagnostics"
              description="Include privacy-safe exporter and upload diagnostics so missing, rejected, or duplicated records can be investigated."
              enabled={usageTelemetry.exportDiagnostics}
              onChange={(enabled) => setUsageTelemetrySettings({ exportDiagnostics: enabled })}
            />
          </div>

          <p className="text-[12px] leading-5 text-[#9a9aa2]">
            Raw source, prompts, transcripts, artifact bodies, descriptions, notes, and file contents are not collected by default.
            Production upload is separate from local export and remains disabled until you turn on Send usage data.
          </p>

          <div className="grid gap-x-6 gap-y-3 border-t border-[#24252b] pt-4 text-sm sm:grid-cols-2">
            <MetaCell label="Last local export" value={formatNullableDate(usageTelemetry.lastExportAt)} />
            <MetaCell
              label="Upload consent"
              value={usageTelemetry.sendUsageData ? 'Enabled' : 'Disabled'}
              tone={usageTelemetry.sendUsageData ? 'positive' : undefined}
            />
          </div>
        </div>
        ) : null}

        <div className="mt-6 flex justify-end border-t border-[#24252b] pt-4">
          <button
            type="button"
            onClick={closeSettings}
            className="rounded-md px-3.5 py-2 text-sm font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
          >
            Done
          </button>
        </div>
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
      className={`group min-h-12 rounded-md border-l-[3px] px-2.5 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60 ${
        active
          ? 'border-l-[#5c7cff] bg-[#100f1c] text-[#ececee]'
          : 'border-l-transparent text-[#8a8a92] hover:bg-[#111216] hover:text-[#d7d7dc]'
      }`}
    >
      <span className="block text-[13px] font-semibold leading-5">{tab.label}</span>
      <span className={`mt-0.5 block truncate text-[11px] leading-4 ${active ? 'text-[#b8ccff]' : 'text-[#5f6068] group-hover:text-[#8a8a92]'}`}>
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
  const base = 'rounded-md px-3 py-1.5 text-sm font-semibold transition-colors disabled:cursor-default disabled:opacity-45 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60'
  const tone = primary
    ? 'bg-[#5c7cff] text-[#08090b] hover:bg-[#6e8eff] disabled:hover:bg-[#5c7cff]'
    : 'border border-[#303139] bg-[#0d0e11] text-[#d7d7dc] hover:bg-[#17181d] disabled:hover:bg-[#0d0e11]'
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${tone}`}>
      {label}
    </button>
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

function updateChannelClass(channel: AppUpdateState['channel'] | undefined): string {
  switch (channel) {
    case 'stable':
      return 'border-[#5c7cff]/35 bg-[#5c7cff]/10 text-[#b8ccff]'
    case 'preview':
      return 'border-[#ffbf2f]/35 bg-[#ffbf2f]/10 text-[#ffe0a3]'
    case 'dev':
      return 'border-[#7785ff]/35 bg-[#7785ff]/10 text-[#d7dcff]'
    default:
      return 'border-[#303139] bg-[#0d0e11] text-[#9a9aa2]'
  }
}

function formatGitHubTokenStatus(status: GitHubTokenUiStatus | null): string {
  if (!status) return 'Checking'
  if (status.source === 'settings') return 'Saved'
  if (status.source === 'environment') return 'Environment'
  return 'Not set'
}

function githubTokenStatusClass(status: GitHubTokenUiStatus | null): string {
  if (status?.configured) return 'border-[#5c7cff]/35 bg-[#5c7cff]/10 text-[#b8ccff]'
  return 'border-[#303139] bg-[#0d0e11] text-[#9a9aa2]'
}

function updateStatusClass(status: AppUpdateState['status'] | undefined): string {
  switch (status) {
    case 'available':
    case 'downloaded':
      return 'border-[#5c7cff]/70 text-[#b8ccff]'
    case 'checking':
    case 'downloading':
      return 'border-[#ffbf2f]/75 text-[#ffd58a]'
    case 'error':
      return 'border-[#ff787c] text-[#ffb3b5]'
    default:
      return 'border-[#303139] text-[#9a9aa2]'
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
