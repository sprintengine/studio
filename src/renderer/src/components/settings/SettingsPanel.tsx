import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli } from '../../types/workspace'
import { resolveProjectKnowledgeConfig } from '../../utils/projectKnowledge'
import { WorkspacePanel } from '../ui/WorkspacePanel'

interface Props {
  onClose: () => void
  checkForUpdatesOnOpen?: boolean
  checkForUpdatesRequestId?: number
}

type MetaTone = 'positive' | 'muted'

type UpdateAction = 'check' | 'download' | 'restart'

type GitHubTokenUiStatus = Awaited<ReturnType<typeof window.api.getGitHubTokenStatus>>

type SettingsTabId = 'updates' | 'github' | 'agents' | 'file-search' | 'knowledge-graph' | 'telemetry'

const settingsTabs: Array<{ id: SettingsTabId; label: string; description: string }> = [
  { id: 'updates', label: 'Updates', description: 'Version and release checks' },
  { id: 'github', label: 'GitHub', description: 'Issue import token' },
  { id: 'agents', label: 'Agents', description: 'CLI runtime commands' },
  { id: 'file-search', label: 'File Search', description: 'Index exclude patterns' },
  { id: 'knowledge-graph', label: 'Knowledge Graph', description: 'Project knowledge' },
  { id: 'telemetry', label: 'Telemetry', description: 'Usage and diagnostics' },
]

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
}: Props) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId) ?? null
  )
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const searchExcludes = useWorkspaceStore((s) => s.appSettings.searchExcludes ?? [])
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? {})
  const usageTelemetry = useWorkspaceStore((s) => s.appSettings.usageTelemetry)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
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
  const [memorySkillStatus, setMemorySkillStatus] = useState<BuiltinSkillStatus | null>(null)
  const [memorySkillPending, setMemorySkillPending] = useState(false)
  const [memorySkillMessage, setMemorySkillMessage] = useState<string | null>(null)
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTabId>('updates')
  const tabRefs = useRef<Record<SettingsTabId, HTMLButtonElement | null>>({
    updates: null,
    github: null,
    agents: null,
    'file-search': null,
    'knowledge-graph': null,
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
    setMemorySkillMessage(null)
    if (!activeProjectRoot) {
      setActivityInstalled(false)
      setMemorySkillStatus(null)
      return
    }
    void window.api
      .memoryActivityIsInstalled({ workspaceRoot: activeProjectRoot })
      .then((installed) => {
        if (!cancelled) setActivityInstalled(installed)
      })
    void window.api
      .builtinSkillStatus({
        workspaceRoot: activeProjectRoot,
        skillId: 'workspace-knowledge',
      })
      .then((status) => {
        if (!cancelled) setMemorySkillStatus(status)
      })
    return () => {
      cancelled = true
    }
  }, [activeProjectRoot])

  const installWorkspaceMemorySkill = useCallback(async () => {
    if (!activeProjectRoot) return
    setMemorySkillPending(true)
    setMemorySkillMessage(null)
    try {
      const result = await window.api.builtinSkillInstall({
        workspaceRoot: activeProjectRoot,
        skillId: 'workspace-knowledge',
      })
      if (result.ok) {
        setMemorySkillMessage(result.status === 'updated'
          ? 'Workspace Knowledge skill updated.'
          : 'Workspace Knowledge skill installed.')
        setMemorySkillStatus(await window.api.builtinSkillStatus({
          workspaceRoot: activeProjectRoot,
          skillId: 'workspace-knowledge',
        }))
      } else {
        setMemorySkillMessage(result.message)
      }
    } catch (error) {
      setMemorySkillMessage(error instanceof Error ? error.message : 'Failed to install Workspace Knowledge skill.')
    } finally {
      setMemorySkillPending(false)
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                Application Updates
              </div>
              <div className="mt-1 text-sm font-semibold text-[#ececee]">
                Multicode {updateState?.version ?? '...'}
              </div>
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                GitHub Issues
              </div>
              <div className="mt-1 text-sm font-semibold text-[#ececee]">
                GitHub access token
              </div>
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
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
            Agent CLIs
          </div>
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

        {activeSettingsTab === 'file-search' ? (
        <div
          role="tabpanel"
          id="settings-panel-file-search"
          aria-labelledby="settings-tab-file-search"
          className="space-y-4"
        >
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
              File Search
            </div>
            <div className="mt-1 text-sm font-semibold text-[#ececee]">
              Additional exclude patterns
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
              Excludes
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                Workspace Knowledge
              </div>
              <div className="mt-1 text-sm font-semibold text-[#ececee]">
                Markdown knowledge graph
              </div>
            </div>
            {activeWorkspace ? (
              <div className="max-w-[260px] truncate text-[11px] text-[#9a9aa2]">
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
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-[#24252b] pl-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[#ececee]">
                  Workspace Knowledge skill
                </div>
                <div className="mt-1 text-[12px] leading-5 text-[#9a9aa2]">
                  {formatBuiltinSkillStatus(memorySkillStatus)}
                  {activeKnowledgeConfig?.relativeRoot
                    ? ` Agents will use the configured knowledge folder: ${activeKnowledgeConfig.relativeRoot}.`
                    : ' Configure a knowledge folder so agents know which graph to read and update.'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void installWorkspaceMemorySkill()}
                disabled={
                  memorySkillPending
                  || !activeProjectRoot
                  || memorySkillStatus?.status === 'installed'
                  || memorySkillStatus?.status === 'modified'
                  || memorySkillStatus?.status === 'local'
                }
                className="h-8 rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#0d0e11]"
              >
                {memorySkillStatus?.status === 'update-available' ? 'Update' : 'Install'}
              </button>
              {memorySkillMessage ? (
                <div className="basis-full border-l-2 border-[#ffbf2f]/75 pl-3 text-[12px] leading-5 text-[#ffd58a]">
                  {memorySkillMessage}
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

        {activeSettingsTab === 'telemetry' ? (
        <div
          role="tabpanel"
          id="settings-panel-telemetry"
          aria-labelledby="settings-tab-telemetry"
          className="space-y-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                Usage Telemetry
              </div>
              <div className="mt-1 text-sm font-semibold text-[#ececee]">
                SprintEngine usage data and diagnostics
              </div>
            </div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#5a5a63]">
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

function SettingToggle({
  label,
  description,
  enabled,
  onChange,
  disabled,
}: {
  label: string
  description?: string
  enabled: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-[#ececee]">{label}</div>
        {description ? (
          <div className="mt-1 text-[12px] leading-5 text-[#5a5a63]">{description}</div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60 disabled:opacity-45 ${
          enabled ? 'bg-[#5c7cff]' : 'bg-[#303139]'
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full transition-transform ${
            enabled ? 'translate-x-4 bg-[#08090b]' : 'translate-x-0 bg-[#d7d7dc]'
          }`}
        />
      </button>
    </div>
  )
}

function MetaCell({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: MetaTone
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#5a5a63]">{label}</div>
      <div className={`mt-1 truncate font-medium ${metaToneClass(tone)}`}>{value}</div>
    </div>
  )
}

function metaToneClass(tone?: MetaTone): string {
  switch (tone) {
    case 'positive':
      return 'text-[#b9f7c8]'
    case 'muted':
      return 'text-[#9a9aa2]'
    default:
      return 'text-[#ececee]'
  }
}

function formatBuiltinSkillStatus(status: BuiltinSkillStatus | null): string {
  if (!status) return 'Skill status has not been checked.'
  if (!status.ok) return status.message

  switch (status.status) {
    case 'missing':
      return 'Not installed in this workspace.'
    case 'installed':
      return 'Installed in .agents/skills/workspace-knowledge.'
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

function formatNullableDate(value: string | null | undefined): string {
  return value ? formatDate(value) : 'None'
}

function formatDate(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toLocaleString()
}
