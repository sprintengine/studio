import React, { useEffect, useRef, useState } from 'react'
import { Actions, DockLocation, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import { SpecialistActionIcon, StatusDot, SwarmRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import CommandPalette from '../CommandPalette'
import SettingsModal from '../settings/SettingsModal'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  MULTILOOP_AGENT_SOULS,
  SPECIALIST_ACTIONS,
  getMultiloopAgentSoul,
  getSpecialistAction,
  loadMultiloopAgentSoul,
  loadSpecialistPrompt,
  type MultiloopAgentSoul,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
  AppNotification,
  FuturePlanWorkspaceSource,
  LayoutTemplate,
  MultiloopAgentSoulRole,
  SpecialistActionId,
  SwarmCliPermissionPreset,
  Workspace,
} from '../../types/workspace'
import { pickRandomAgentName } from '../../utils/agentNames'
import { normalizeAgentIdentifier, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { focusOrAddAgentTab, focusOrAddComponentTab, focusOrAddTerminalTab, getModel } from '../../utils/modelRegistry'
import { MULTICODE_DISABLE_SPRINTENGINE_SYNC } from '../../utils/runtimeFlags'
import { buildCurrentContextSwarmHandoffPrompt } from '../../utils/sprintengineHandoff'
import { buildMultiloopLaunchContextLines, getActiveMultiloopMilestone, getMultiloopTasksForMilestone } from '../../utils/multiloop'
import { slugifySwarmName } from '../../utils/sprintengineStateFile'
import TemplateSelector, { type TemplateSelectorInitialState } from './TemplateSelector'
import SprintEngineAutoRunSupervisor from './SprintEngineAutoRunSupervisor'
import MultiloopAutoRunSupervisor from './MultiloopAutoRunSupervisor'
import MultiloopStateSynchronizer from './MultiloopStateSynchronizer'
import SprintEngineStateSynchronizer from './SprintEngineStateSynchronizer'
import WorkspaceGitStatusButton from './WorkspaceGitStatusButton'
import WorkspaceLayout from './WorkspaceLayout'

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const
const TERMINAL_SESSION_RECOVERY_POLL_MS = 30_000
const WORKSPACE_LAYOUT_IDLE_UNLOAD_MS = 5 * 60_000
const AGENT_SPAWN_CLI_OPTIONS: Array<{ value: AgentCli; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
]
const AGENT_SPAWN_PERMISSION_OPTIONS: Array<{
  value: SwarmCliPermissionPreset
  label: string
  title: string
}> = [
  {
    value: 'default',
    label: 'Default permissions',
    title: 'Use the CLI default permission behavior.',
  },
  {
    value: 'auto_workspace',
    label: 'Auto in workspace',
    title: 'Reduce prompts while keeping workspace-scoped guardrails where the CLI supports them.',
  },
  {
    value: 'bypass_all',
    label: 'Bypass permissions',
    title: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
  },
]
const SPECIALIST_KEYBOARD_SHORTCUTS: Record<string, SpecialistActionId> = {
  f: 'frontend-design-review',
  m: 'performance',
  p: 'architect',
}
type WorkspacePanelComponent = 'explorer' | 'editor' | 'git' | 'memory-graph'
type WorkspaceActivity = 'needs-input' | 'running' | 'idle'
type SessionStatus = 'needs-input' | 'running'
type SessionItem = {
  workspace: Workspace
  kind: TerminalKind
  agentId: string | null
  terminalId: string | null
  label: string
  cli: AgentCli
  status: SessionStatus
  role: NonNullable<Workspace['swarmState']>['swarmAgents'][string]['role'] | null
  taskId: string | null
  sessionId: string
}

function workspaceNeedsInput(workspace: Workspace): boolean {
  return Object.values(workspace.swarmState?.swarmAgents ?? {}).some(
    (agent) => agent.status === 'needs_input'
  )
}

function workspaceHasRunningAgent(
  workspace: Workspace,
  terminalSessions: TerminalSessionSnapshot[]
): boolean {
  return terminalSessions.some((session) =>
    session.kind === 'agent' && session.workspaceId === workspace.id && session.running
  )
}

function getWorkspaceActivity(
  workspace: Workspace,
  terminalSessions: TerminalSessionSnapshot[]
): WorkspaceActivity {
  if (workspaceNeedsInput(workspace)) return 'needs-input'
  if (workspaceHasRunningAgent(workspace, terminalSessions)) return 'running'
  return 'idle'
}

function workspaceActivityTone(activity: WorkspaceActivity): 'running' | 'needs-input' | null {
  switch (activity) {
    case 'needs-input':
      return 'needs-input'
    case 'running':
      return 'running'
    default:
      return null
  }
}

function workspaceActivityLabel(activity: WorkspaceActivity): string {
  switch (activity) {
    case 'needs-input':
      return 'Workspace needs input'
    case 'running':
      return 'Workspace has running agents'
    default:
      return 'Workspace idle'
  }
}

function hasActiveProPlan(authState: MulticodeAuthState): boolean {
  return authState.entitlements?.plan.status === 'active' && authState.entitlements.plan.code.toLowerCase() === 'pro'
}

function uniqueAgentName(baseName: string, agents: Workspace['agents']): string {
  const existingNames = new Set(Object.values(agents).map((agent) => agent.name))
  if (!existingNames.has(baseName)) return baseName

  let suffix = 2
  while (existingNames.has(`${baseName} ${suffix}`)) suffix += 1
  return `${baseName} ${suffix}`
}

function getSessionItems(
  workspaces: Workspace[],
  terminalSessions: TerminalSessionSnapshot[]
): SessionItem[] {
  return terminalSessions
    .filter((session) => (
      session.running
      && typeof session.workspaceId === 'string'
    ))
    .flatMap((session): SessionItem[] => {
      const workspace = workspaces.find((candidate) => candidate.id === session.workspaceId)
      if (!workspace) return []

      if (session.kind === 'agent') {
        if (!session.agentId) return []
        const agent = workspace.agents[session.agentId]
        const runtime = workspace.swarmState?.swarmAgents[session.agentId]
        const status: SessionStatus = runtime?.status === 'needs_input' ? 'needs-input' : 'running'

        return [{
          workspace,
          kind: session.kind,
          agentId: session.agentId,
          terminalId: null,
          label: agent?.name || session.agentId,
          cli: session.cli ?? agent?.cli ?? 'codex',
          status,
          role: runtime?.role ?? null,
          taskId: runtime?.currentTaskId ?? null,
          sessionId: session.sessionId,
        }]
      }

      const terminalId = session.terminalId ?? session.sessionId.replace(/^terminal-/, '')
      return [{
        workspace,
        kind: session.kind,
        agentId: null,
        terminalId,
        label: 'Terminal',
        cli: 'codex' as AgentCli,
        status: 'running' as const,
        role: null,
        taskId: null,
        sessionId: session.sessionId,
      }]
    })
}

function getTerminalSessionsSignature(sessions: TerminalSessionSnapshot[]): string {
  return [...sessions]
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .map((session) => [
      session.sessionId,
      session.running ? '1' : '0',
      session.kind,
      session.workspaceId ?? '',
      session.agentId ?? '',
      session.terminalId ?? '',
      session.cli ?? '',
      session.cwd ?? '',
      session.swarmStatePath ?? '',
      session.executionMode ?? '',
      session.worktreeId ?? '',
      session.worktreePath ?? '',
    ].join('\u001f'))
    .join('\u001e')
}

function toProjectRelativeStatePath(path: string | null | undefined, workspaceRoot: string | null | undefined): string {
  if (!path) return 'multiloop/<loop>/state.json'

  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = workspaceRoot?.replace(/\\/g, '/').replace(/\/+$/u, '')
  if (normalizedRoot && (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`))) {
    return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/u, '') || '.'
  }

  const multiloopIndex = normalizedPath.lastIndexOf('/multiloop/')
  return multiloopIndex >= 0
    ? normalizedPath.slice(multiloopIndex + 1)
    : 'multiloop/<loop>/state.json'
}

function buildMultiloopSpawnPrompt({
  soul,
  soulPrompt,
  workspace,
  agentId,
}: {
  soul: MultiloopAgentSoul
  soulPrompt: string
  workspace: Workspace
  agentId: string
}): string {
  const state = workspace.multiloopState
  const currentMilestone = state ? getActiveMultiloopMilestone(state) : null
  const readyTaskIdsForRole = state && currentMilestone
    ? getMultiloopTasksForMilestone(state, currentMilestone.id)
      .filter((task) => task.role === soul.role && task.status === 'ready')
      .map((task) => task.id)
    : []
  const context = buildMultiloopLaunchContextLines({
    roleLabel: soul.label,
    role: soul.role,
    agentId,
    readyTaskIdsForRole,
    loopName: state?.loop.displayName ?? workspace.multiloopContext?.loopName ?? workspace.name,
    finalGoal: state?.loop.finalGoal ?? null,
    currentMilestone,
    statePath: toProjectRelativeStatePath(workspace.multiloopContext?.statePath, workspace.folderPath),
  })

  return [soulPrompt.trim(), ...context].join('\n')
}

export default function WorkspaceManager() {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace)
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const setSwarmAutoEnabled = useWorkspaceStore((s) => s.setSwarmAutoEnabled)
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const lastSelectedCli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli ?? 'claude')
  const setLastSelectedCli = useWorkspaceStore((s) => s.setLastSelectedCli)
  const lastSelectedSpecialist = useWorkspaceStore(
    (s) => s.appSettings.lastSelectedSpecialist ?? SPECIALIST_ACTIONS[0].id
  )
  const setLastSelectedSpecialist = useWorkspaceStore((s) => s.setLastSelectedSpecialist)
  const lastSelectedMultiloopRole = useWorkspaceStore(
    (s) => s.appSettings.lastSelectedMultiloopRole ?? MULTILOOP_AGENT_SOULS[0].role
  )
  const setLastSelectedMultiloopRole = useWorkspaceStore((s) => s.setLastSelectedMultiloopRole)
  const lastAgentSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.appSettings.lastAgentSpawnPermissionPreset ?? 'default'
  )
  const setLastAgentSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.setLastAgentSpawnPermissionPreset
  )
  const notifications = useNotificationStore((s) => s.notifications)
  const markNotificationRead = useNotificationStore((s) => s.markRead)
  const markAllNotificationsRead = useNotificationStore((s) => s.markAllRead)
  const clearNotifications = useNotificationStore((s) => s.clearAll)

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
  const selectedCliOption = AGENT_SPAWN_CLI_OPTIONS.find((option) => option.value === lastSelectedCli) ?? AGENT_SPAWN_CLI_OPTIONS[0]
  const selectedSpecialistAction = getSpecialistAction(lastSelectedSpecialist)
  const selectedMultiloopSoul = getMultiloopAgentSoul(lastSelectedMultiloopRole)
  const multiloopLaunchMenu = activeWorkspace?.mode === 'multiloop'
  const proAccount = hasActiveProPlan(authState)

  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  const [templateSelectorInitialState, setTemplateSelectorInitialState] = useState<TemplateSelectorInitialState | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [specialistMenuOpen, setSpecialistMenuOpen] = useState(false)
  const [agentCliDropdownOpen, setAgentCliDropdownOpen] = useState(false)
  const [agentSpawnPermissionPreset, setAgentSpawnPermissionPresetState] = useState<SwarmCliPermissionPreset>(
    lastAgentSpawnPermissionPreset
  )
  const selectedAgentPermissionOption = AGENT_SPAWN_PERMISSION_OPTIONS.find(
    (option) => option.value === agentSpawnPermissionPreset
  ) ?? AGENT_SPAWN_PERMISSION_OPTIONS[0]
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handoffTeamName, setHandoffTeamName] = useState('')
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionSnapshot[]>([])
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([])
  const [windowState, setWindowState] = useState<WindowState>({
    isMaximized: false,
    isFullScreen: false,
  })
  const renameInputRef = useRef<HTMLInputElement>(null)
  const specialistMenuRef = useRef<HTMLDivElement>(null)
  const sessionsRef = useRef<HTMLDivElement>(null)
  const notificationsRef = useRef<HTMLDivElement>(null)
  const accountRef = useRef<HTMLDivElement>(null)
  const handoffDialogRef = useRef<HTMLDivElement>(null)
  const terminalSessionsSignatureRef = useRef('')
  const workspaceLayoutUnloadTimersRef = useRef<Record<string, number>>({})
  const workspaceActionsEnabled = activeWorkspace && !showTemplateSelector
  const sessions = getSessionItems(workspaces, terminalSessions)
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length
  const renderedWorkspaceIds = workspaces
    .map((workspace) => workspace.id)
    .filter((workspaceId) => workspaceId === activeWorkspaceId || mountedWorkspaceIds.includes(workspaceId))

  const openTemplateSelector = () => {
    setTemplateSelectorInitialState(null)
    setShowTemplateSelector(true)
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    setHandoffOpen(false)
  }

  const openFuturePlanWorkspace = (source: FuturePlanWorkspaceSource) => {
    setTemplateSelectorInitialState({
      mode: 'sprintengine',
      folderPath: source.folderPath,
      futurePlanSource: source,
    })
    setShowTemplateSelector(true)
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    setHandoffOpen(false)
  }

  const setAgentSpawnPermissionPreset = (preset: SwarmCliPermissionPreset) => {
    setAgentSpawnPermissionPresetState(preset)
    setLastAgentSpawnPermissionPreset(preset)
  }

  const clearWorkspaceLayoutUnloadTimer = (workspaceId: string) => {
    const timer = workspaceLayoutUnloadTimersRef.current[workspaceId]
    if (timer === undefined) return

    window.clearTimeout(timer)
    delete workspaceLayoutUnloadTimersRef.current[workspaceId]
  }

  useEffect(() => {
    if (!specialistMenuOpen) setAgentCliDropdownOpen(false)
  }, [specialistMenuOpen])

  useEffect(() => {
    setAgentSpawnPermissionPresetState(lastAgentSpawnPermissionPreset)
  }, [lastAgentSpawnPermissionPreset])

  useEffect(() => {
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))

    setMountedWorkspaceIds((current) => {
      const next = current.filter((workspaceId) => workspaceIds.has(workspaceId))
      if (activeWorkspaceId && workspaceIds.has(activeWorkspaceId) && !next.includes(activeWorkspaceId)) {
        next.push(activeWorkspaceId)
      }
      return next.length === current.length && next.every((workspaceId, index) => workspaceId === current[index])
        ? current
        : next
    })

    Object.keys(workspaceLayoutUnloadTimersRef.current).forEach((workspaceId) => {
      if (!workspaceIds.has(workspaceId) || workspaceId === activeWorkspaceId) {
        clearWorkspaceLayoutUnloadTimer(workspaceId)
      }
    })
  }, [activeWorkspaceId, workspaces])

  useEffect(() => {
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))

    mountedWorkspaceIds.forEach((workspaceId) => {
      if (workspaceId === activeWorkspaceId || !workspaceIds.has(workspaceId)) {
        clearWorkspaceLayoutUnloadTimer(workspaceId)
        return
      }
      if (workspaceLayoutUnloadTimersRef.current[workspaceId] !== undefined) return

      workspaceLayoutUnloadTimersRef.current[workspaceId] = window.setTimeout(() => {
        delete workspaceLayoutUnloadTimersRef.current[workspaceId]
        setMountedWorkspaceIds((current) => {
          if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) return current
          return current.filter((id) => id !== workspaceId)
        })
      }, WORKSPACE_LAYOUT_IDLE_UNLOAD_MS)
    })
  }, [activeWorkspaceId, mountedWorkspaceIds, workspaces])

  useEffect(() => () => {
    Object.values(workspaceLayoutUnloadTimersRef.current).forEach((timer) => window.clearTimeout(timer))
    workspaceLayoutUnloadTimersRef.current = {}
  }, [])

  useEffect(() => {
    if (workspaces.length === 0) setShowTemplateSelector(true)
  }, [workspaces.length])

  useEffect(() => {
    let disposed = false

    void window.api.authGetState()
      .then((state) => {
        if (!disposed) setAuthState(state)
      })
      .catch((error) => {
        if (!disposed) setAuthMessage(error instanceof Error ? error.message : String(error))
      })

    const removeStateListener = window.api.onAuthStateChanged((state) => {
      setAuthState(state)
      setAuthMessage(state.message)
    })
    const removeErrorListener = window.api.onAuthCallbackError((message) => {
      setAuthMessage(message)
      publishDiagnosticSync({
        level: 'error',
        source: 'auth',
        title: 'Sign-in failed',
        message,
      })
    })

    return () => {
      disposed = true
      removeStateListener()
      removeErrorListener()
    }
  }, [setAuthState])

  useEffect(() => {
    let disposed = false

    const applyTerminalSessions = (sessions: TerminalSessionSnapshot[]) => {
      if (disposed) return
      const signature = getTerminalSessionsSignature(sessions)
      if (signature === terminalSessionsSignatureRef.current) return
      terminalSessionsSignatureRef.current = signature
      setTerminalSessions(sessions)
    }

    const refreshTerminalSessions = async () => {
      applyTerminalSessions(await window.api.terminalList())
    }

    void refreshTerminalSessions().catch(() => {})
    const unsubscribe = window.api.onTerminalSessionsChanged(applyTerminalSessions)
    const interval = window.setInterval(() => {
      void refreshTerminalSessions().catch(() => {})
    }, TERMINAL_SESSION_RECOVERY_POLL_MS)

    return () => {
      disposed = true
      unsubscribe()
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (window.api.platform === 'darwin') return

    let mounted = true
    void window.api.getWindowState().then((state) => {
      if (mounted && state) setWindowState(state)
    })

    const unsubscribe = window.api.onWindowStateChanged(setWindowState)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!renamingId) return
    renameInputRef.current?.focus()
  }, [renamingId])

  useEffect(() => {
    if (!specialistMenuOpen) return

    const onPointerDown = (event: PointerEvent) => {
      if (!specialistMenuRef.current?.contains(event.target as Node)) {
        setSpecialistMenuOpen(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSpecialistMenuOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [specialistMenuOpen])

  useEffect(() => {
    if (!handoffOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHandoffOpen(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.setTimeout(() => {
      const input = handoffDialogRef.current?.querySelector('input')
      if (input instanceof HTMLInputElement) input.select()
    }, 0)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handoffOpen])

  useEffect(() => {
    if (!sessionsOpen) return

    const onPointerDown = (event: PointerEvent) => {
      if (!sessionsRef.current?.contains(event.target as Node)) {
        setSessionsOpen(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSessionsOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [sessionsOpen])

  useEffect(() => {
    if (!notificationsOpen) return

    const onPointerDown = (event: PointerEvent) => {
      if (!notificationsRef.current?.contains(event.target as Node)) {
        setNotificationsOpen(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNotificationsOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [notificationsOpen])

  useEffect(() => {
    setSpecialistMenuOpen(false)
    setSessionsOpen(false)
    setNotificationsOpen(false)
    setHandoffOpen(false)
  }, [activeWorkspaceId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || renamingId) return

      const ctrl = event.ctrlKey || event.metaKey
      if (!ctrl) return

      if (event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        if (activeWorkspaceId) cycleActiveLayoutTab(activeWorkspaceId, event.shiftKey ? -1 : 1)
        return
      }

      if (event.code === 'Backquote') {
        event.preventDefault()
        event.stopPropagation()
        const nextWorkspaceId = getNextWorkspaceId(
          workspaces,
          activeWorkspaceId,
          event.shiftKey ? -1 : 1
        )
        if (nextWorkspaceId) {
          setShowTemplateSelector(false)
          setActiveWorkspace(nextWorkspaceId)
        }
        return
      }

      if (event.code === 'Quote' && event.shiftKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        addNewTerminal()
        return
      }

      const key = event.key.toLowerCase()

      if (event.altKey) {
        const specialistId = SPECIALIST_KEYBOARD_SHORTCUTS[key]
        if (specialistId) {
          event.preventDefault()
          event.stopPropagation()
          setLastSelectedSpecialist(specialistId)
          setSpecialistMenuOpen(false)
          void addNewSpecialist(specialistId)
          return
        }
      }

      if (key === 't') {
        event.preventDefault()
        openTemplateSelector()
      }
      if (key === 'w' && showTemplateSelector) {
        event.preventDefault()
        if (workspaces.length > 0) setShowTemplateSelector(false)
      } else if (key === 'w' && activeWorkspaceId) {
        event.preventDefault()
        closeActiveLayoutTab(activeWorkspaceId)
      }

      const n = parseInt(event.key)
      if (n >= 1 && n <= 9 && workspaces[n - 1]) {
        event.preventDefault()
        setShowTemplateSelector(false)
        setActiveWorkspace(workspaces[n - 1].id)
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    workspaces,
    activeWorkspaceId,
    showTemplateSelector,
    renamingId,
    lastSelectedCli,
    removeWorkspace,
    setActiveWorkspace,
    setLastSelectedSpecialist,
  ])

  useEffect(() => {
    return window.api.onAppMenuCommand((command) => {
      if (command === 'show-settings') {
        setShowSettings(true)
        return
      }
      if (command === 'show-about') {
        setShowSettings(true)
        return
      }
      if (!activeWorkspaceId) return
      if (command === 'toggle-explorer') {
        toggleWorkspacePanel(activeWorkspaceId, 'explorer')
      } else if (command === 'toggle-editor') {
        toggleWorkspacePanel(activeWorkspaceId, 'editor')
      } else if (command === 'toggle-git') {
        toggleWorkspacePanel(activeWorkspaceId, 'git')
      } else if (command === 'open-sprintengine-kanban') {
        const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId)
        if (workspace?.mode === 'sprintengine' || workspace?.swarmContext) {
          focusOrAddComponentTab(activeWorkspaceId, 'sprintengine-kanban', 'Kanban')
        }
      }
    })
  }, [activeWorkspaceId, workspaces])

  const handleCreate = ({
    template,
    name,
    folderPath,
    swarmState,
    swarmContext,
    swarmRoleCliDefaults,
    swarmAutoState,
  }: {
    template: LayoutTemplate
    name: string
    folderPath: string | null
    swarmState?: Workspace['swarmState']
    swarmContext?: Workspace['swarmContext']
    swarmRoleCliDefaults?: Workspace['swarmRoleCliDefaults'] | null
    swarmAutoState?: Partial<Workspace['swarmAutoState']> | null
  }) => {
    addWorkspace(template, { name, folderPath, swarmState, swarmContext, swarmRoleCliDefaults, swarmAutoState })
    setShowTemplateSelector(false)
    setTemplateSelectorInitialState(null)
  }

  const handleCloseTab = (event: React.MouseEvent, id: string) => {
    event.preventDefault()
    event.stopPropagation()
    const workspace = workspaces.find((candidate) => candidate.id === id)
    if (workspace) terminateWorkspaceTerminals(workspace)
    removeWorkspace(id)
  }

  const startRename = (event: React.MouseEvent, workspace: Workspace) => {
    event.stopPropagation()
    setRenamingId(workspace.id)
    setRenameValue(workspace.name)
  }

  const commitRename = () => {
    if (renamingId) renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
  }

  const addNewSpecialist = async (
    specialistId: SpecialistActionId = lastSelectedSpecialist,
    requestedName = ''
  ) => {
    if (showTemplateSelector || !activeWorkspaceId) return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    const specialist = getSpecialistAction(specialistId)
    const agentName = normalizeAgentIdentifier(requestedName)
    const tabName = agentName || pickRandomAgentName(
      Object.values(activeWorkspace?.agents ?? {}).map((agent) => agent.name)
    )
    const newId = `specialist-${specialist.id}-${nanoid(6)}`
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    if (!targetTabset) return
    const prompt = await loadSpecialistPrompt(specialist.id)

    updateAgent(activeWorkspaceId, newId, {
      name: tabName,
      cli: lastSelectedCli,
      cliPermissionPreset: agentSpawnPermissionPreset,
      kind: 'specialist',
      specialistId: specialist.id,
      cliStartupPrompt: prependAgentIdentifier(prompt, tabName, specialist.shortLabel),
      cliOnboardingPromptSent: false,
      cliHasLaunched: false,
      cliResumeAvailable: false,
    })
    model.doAction(
      Actions.addNode(
        {
          type: 'tab',
          name: tabName,
          component: 'agent',
          config: { agentId: newId },
        },
        targetTabset.getId(),
        DockLocation.CENTER,
        -1,
        true
      )
    )
  }

  const addNewMultiloopAgent = async (
    role: MultiloopAgentSoulRole = lastSelectedMultiloopRole,
    requestedName = ''
  ) => {
    if (showTemplateSelector || !activeWorkspaceId) return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    if (!activeWorkspace || activeWorkspace.mode !== 'multiloop') return

    const soul = getMultiloopAgentSoul(role)
    const agentName = normalizeAgentIdentifier(requestedName)
    const tabName = agentName || uniqueAgentName(soul.label, activeWorkspace.agents)
    const newId = `multiloop-${role}-${nanoid(6)}`
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    if (!targetTabset) return

    if (activeWorkspace.folderPath && activeWorkspace.multiloopState) {
      const repaired = await window.api.initializeMultiloopState({
        workspaceRoot: activeWorkspace.folderPath,
        loopName: activeWorkspace.multiloopState.loop.displayName,
        finalGoal: activeWorkspace.multiloopState.loop.finalGoal,
      })
      if (!repaired.ok) {
        publishDiagnosticSync({
          level: 'error',
          source: 'workspace',
          title: 'Multiloop CLI unavailable',
          message: repaired.message || 'Could not prepare the Multiloop CLI wrapper for this workspace.',
          workspaceId: activeWorkspaceId,
          workspaceName: activeWorkspace.name,
        })
        return
      }
    }

    const prompt = await loadMultiloopAgentSoul(soul.role)
    const startupPrompt = buildMultiloopSpawnPrompt({
      soul,
      soulPrompt: prompt,
      workspace: activeWorkspace,
      agentId: newId,
    })

    updateAgent(activeWorkspaceId, newId, {
      name: tabName,
      cli: lastSelectedCli,
      cliPermissionPreset: agentSpawnPermissionPreset,
      kind: 'multiloop',
      specialistId: undefined,
      multiloopRole: soul.role,
      cliStartupPrompt: prependAgentIdentifier(startupPrompt, tabName, `Multiloop ${soul.shortLabel}`),
      cliStartRequested: true,
      cliOnboardingPromptSent: false,
      cliHasLaunched: false,
      cliResumeAvailable: false,
      cliSessionId: crypto.randomUUID(),
    })
    model.doAction(
      Actions.addNode(
        {
          type: 'tab',
          name: tabName,
          component: 'agent',
          config: { agentId: newId },
        },
        targetTabset.getId(),
        DockLocation.CENTER,
        -1,
        true
      )
    )
  }

  const addNewCliAgent = (cli: AgentCli, label: string) => {
    if (showTemplateSelector || !activeWorkspaceId) return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    const tabName = uniqueAgentName(label, activeWorkspace?.agents ?? {})
    const newId = `agent-${cli}-${nanoid(6)}`
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    if (!targetTabset) return

    updateAgent(activeWorkspaceId, newId, {
      name: tabName,
      cli,
      cliPermissionPreset: agentSpawnPermissionPreset,
      kind: 'general',
      specialistId: undefined,
      cliStartupPrompt: undefined,
      cliOnboardingPromptSent: false,
      cliHasLaunched: false,
      cliResumeAvailable: false,
    })
    model.doAction(
      Actions.addNode(
        {
          type: 'tab',
          name: tabName,
          component: 'agent',
          config: { agentId: newId },
        },
        targetTabset.getId(),
        DockLocation.CENTER,
        -1,
        true
      )
    )
    setSpecialistMenuOpen(false)
  }

  const addNewTerminal = () => {
    if (showTemplateSelector || !activeWorkspaceId) return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const newId = `terminal-${nanoid(6)}`
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    if (!targetTabset) return

    model.doAction(
      Actions.addNode(
        { type: 'tab', name: 'Terminal', component: 'terminal', config: { terminalId: newId } },
        targetTabset.getId(),
        DockLocation.CENTER,
        -1,
        true
      )
    )
  }

  const openMemoryGraph = () => {
    if (!activeWorkspaceId) return
    focusOrAddComponentTab(activeWorkspaceId, 'memory-graph', 'Memory Graph')
    setSessionsOpen(false)
    setNotificationsOpen(false)
    setSpecialistMenuOpen(false)
    setAccountOpen(false)
  }

  const openHandoffDialog = () => {
    if (!activeWorkspace) return
    setHandoffTeamName(slugifySwarmName(activeWorkspace.name))
    setHandoffError(null)
    setSessionsOpen(false)
    setSpecialistMenuOpen(false)
    setHandoffOpen(true)
  }

  const confirmHandoff = async () => {
    if (!activeWorkspaceId || !activeWorkspace) return
    const teamSlug = slugifySwarmName(handoffTeamName)
    const target = getActiveCliSession(activeWorkspace, terminalSessions)
    if (!target) {
      setHandoffError('Open or focus a running CLI session before handing off.')
      return
    }

    const prompt = buildCurrentContextSwarmHandoffPrompt(teamSlug)
    await window.api.terminalWrite(
      target.sessionId,
      `\x1b[200~${prompt.replace(/\r?\n/g, '\n')}\x1b[201~\r`
    )
    setHandoffOpen(false)
  }

  const handleSelectSpecialist = (specialistId: SpecialistActionId) => {
    setLastSelectedSpecialist(specialistId)
    setSpecialistMenuOpen(false)
    void addNewSpecialist(specialistId)
  }

  const handleSelectMultiloopRole = (role: MultiloopAgentSoulRole) => {
    setLastSelectedMultiloopRole(role)
    setSpecialistMenuOpen(false)
    void addNewMultiloopAgent(role)
  }

  const handleSelectSpawnCli = (cli: AgentCli) => {
    setLastSelectedCli(cli)
    setAgentCliDropdownOpen(false)
  }

  const startLogin = async () => {
    setSessionsOpen(false)
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    setAccountOpen(false)
    await window.api.authLogin(authState.selectedOrganization?.id ?? null)
  }

  const refreshAuthState = async () => {
    setAuthMessage('Checking access.')
    setAuthState(await window.api.authRefreshEntitlements())
  }

  const logout = async () => {
    await window.api.authLogout()
    setAccountOpen(false)
  }

  const switchOrganization = async () => {
    const organizationId = window.prompt('Organization ID')
    if (!organizationId?.trim()) return
    await window.api.authSelectOrganization(organizationId.trim())
    setAuthState(await window.api.authRefreshEntitlements())
  }

  const openSession = async (item: SessionItem) => {
    const status = await window.api.terminalStatus(item.sessionId)
    if (!status.running) {
      setTerminalSessions((sessions) => sessions.filter((session) => session.sessionId !== item.sessionId))
      if (item.agentId) {
        updateAgent(item.workspace.id, item.agentId, {
          cliStartRequested: false,
          cliHasLaunched: false,
          cliOnboardingPromptSent: false,
        })
      }
      return
    }

    if (item.agentId) {
      updateAgent(item.workspace.id, item.agentId, {
        name: item.label,
        cli: item.cli,
        cliSessionId: item.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable: item.cli === 'codex' ? true : undefined,
      })
    }

    setShowTemplateSelector(false)
    setActiveWorkspace(item.workspace.id)
    setSessionsOpen(false)

    requestAnimationFrame(() => {
      const opened = item.agentId
        ? focusOrAddAgentTab(item.workspace.id, item.agentId, item.label)
        : item.terminalId
          ? focusOrAddTerminalTab(item.workspace.id, item.terminalId)
          : false
      if (opened) return
      window.setTimeout(() => {
        if (item.agentId) {
          focusOrAddAgentTab(item.workspace.id, item.agentId, item.label)
        } else if (item.terminalId) {
          focusOrAddTerminalTab(item.workspace.id, item.terminalId)
        }
      }, 0)
    })
  }

  const stopSession = (item: SessionItem) => {
    void window.api.terminalKill(item.sessionId).catch(() => {})
    setTerminalSessions((sessions) => sessions.filter((session) => session.sessionId !== item.sessionId))
    if (item.workspace.mode === 'sprintengine') setSwarmAutoEnabled(item.workspace.id, false)
    if (item.agentId) {
      updateAgent(item.workspace.id, item.agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
      })
    }
  }

  const handleShowMenubarMenu = async (
    event: React.MouseEvent<HTMLButtonElement>,
    label: (typeof MENU_BAR_ITEMS)[number]
  ) => {
    const rect = event.currentTarget.getBoundingClientRect()
    await window.api.showMenubarMenu(label, {
      x: rect.left,
      y: rect.bottom + 4,
    })
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#08090b] text-[#ececee]">
      <SprintEngineAutoRunSupervisor />
      <MultiloopAutoRunSupervisor />
      {workspaces.map((workspace) => (
        workspace.id === activeWorkspaceId && (workspace.mode === 'multiloop' || workspace.multiloopContext)
          ? <MultiloopStateSynchronizer key={workspace.id} workspaceId={workspace.id} />
          : null
      ))}
      {!MULTICODE_DISABLE_SPRINTENGINE_SYNC && workspaces.map((workspace) => (
        workspace.id === activeWorkspaceId && (workspace.mode === 'sprintengine' || workspace.swarmContext)
          ? <SprintEngineStateSynchronizer key={workspace.id} workspaceId={workspace.id} />
          : null
      ))}

      {window.api.platform !== 'darwin' && (
        <div
          className="app-drag flex h-[34px] shrink-0 items-stretch justify-between border-b border-[#1f2025] bg-[#0d0e11]"
        >
          <div className="flex min-w-0 items-center gap-1 px-2">
            {MENU_BAR_ITEMS.map((label) => (
              <button
                key={label}
                onClick={(event) => void handleShowMenubarMenu(event, label)}
                className="app-no-drag inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                {label}
              </button>
            ))}
          </div>

          <WindowControls isMaximized={windowState.isMaximized} />
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1f2025] bg-[#0b0c0f] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {workspaces.map((workspace) => {
            const active = !showTemplateSelector && workspace.id === activeWorkspaceId
            const sprintEngineWorkspace = workspace.mode === 'sprintengine'
            const activity = getWorkspaceActivity(workspace, terminalSessions)
            const activityLabel = workspaceActivityLabel(activity)
            const activityTone = workspaceActivityTone(activity)
            return (
              <div
                key={workspace.id}
                onMouseDown={(event) => {
                  if (event.button !== 1) return
                  handleCloseTab(event, workspace.id)
                }}
                onClick={() => {
                  if (!renamingId) {
                    setShowTemplateSelector(false)
                    setActiveWorkspace(workspace.id)
                  }
                }}
                className={`group inline-flex h-[30px] max-w-[260px] cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-md border px-2.5 text-[13px] transition-colors ${
                  active && sprintEngineWorkspace
                    ? 'border-[#3a3426] bg-[#17181d] text-[#ececee] shadow-[inset_0_-2px_0_rgba(255,191,47,0.42)]'
                    : active
                      ? 'border-[#2a2b31] bg-[#17181d] text-[#ececee]'
                      : sprintEngineWorkspace
                        ? 'border-transparent text-[#9a9aa2] hover:bg-[#ffbf2f]/8 hover:text-[#e6d4ad]'
                        : 'border-transparent text-[#8a8a92] hover:bg-[#15161a] hover:text-[#d7d7dc]'
                }`}
              >
                <WorkspaceTypeIcon
                  mode={workspace.mode}
                  className={`h-3.5 w-3.5 shrink-0 ${
                    sprintEngineWorkspace ? 'text-[#ffbf2f]' : 'text-[#9a9aa2]'
                  }`}
                />
                {renamingId === workspace.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename()
                      if (event.key === 'Escape') setRenamingId(null)
                      event.stopPropagation()
                    }}
                    onClick={(event) => event.stopPropagation()}
                    className="w-32 rounded border border-[#303139] bg-[#090a0c] px-1.5 py-0 text-[13px] text-[#ececee] focus:outline-none"
                  />
                ) : (
                  <span
                    onDoubleClick={(event) => startRename(event, workspace)}
                    className="min-w-0 flex-1 truncate"
                  >
                    {workspace.name}
                  </span>
                )}

                {activityTone ? (
                  <StatusDot tone={activityTone} label={activityLabel} className="ml-0.5" />
                ) : null}

                <button
                  onClick={(event) => handleCloseTab(event, workspace.id)}
                  className="text-xs leading-none text-[#5a5a63] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#d7d7dc]"
                  aria-label={`Close ${workspace.name}`}
                >
                  x
                </button>
              </div>
            )
          })}

          <button
            onClick={openTemplateSelector}
            className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-[#8a8a92] transition-colors hover:bg-[#15161a] hover:text-[#d7d7dc]"
            title="New workspace (Ctrl+T)"
          >
            + New Workspace
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {workspaces.length > 0 ? (
            <div ref={sessionsRef} className="relative inline-flex">
              <button
                type="button"
                  onClick={() => {
                    setSessionsOpen((open) => !open)
                    setSpecialistMenuOpen(false)
                  setNotificationsOpen(false)
                }}
                className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                  sessionsOpen
                    ? 'border-[#303139] bg-[#17181d] text-[#ececee]'
                    : 'border-[#24252b] bg-[#111216] text-[#9a9aa2] hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc]'
                }`}
                title="Sessions"
                aria-label="Sessions"
                aria-haspopup="menu"
                aria-expanded={sessionsOpen}
              >
                <SessionsIcon className="h-[18px] w-[18px]" />
                {sessions.length > 0 ? (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[#0b0c0f] bg-[#30d158] px-1 text-[10px] font-bold leading-none text-[#061210]">
                    {sessions.length > 99 ? '99+' : sessions.length}
                  </span>
                ) : null}
              </button>

              {sessionsOpen ? (
                <SessionsPopover
                  items={sessions}
                  onOpen={openSession}
                  onStop={stopSession}
                />
              ) : null}
            </div>
          ) : null}

          {activeWorkspace ? (
            <WorkspaceGitStatusButton
              workspaceId={activeWorkspace.id}
              folderPath={activeWorkspace.folderPath ?? null}
              onOpen={() => {
                setSessionsOpen(false)
                setNotificationsOpen(false)
                setSpecialistMenuOpen(false)
                setAccountOpen(false)
              }}
            />
          ) : null}

          {workspaceActionsEnabled ? (
            <button
              type="button"
              onClick={openMemoryGraph}
              disabled={!activeWorkspaceId}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#24252b] bg-[#111216] text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc] disabled:opacity-40 disabled:hover:bg-[#111216]"
              title="Memory Graph"
              aria-label="Memory Graph"
            >
              <MemoryGraphIcon className="h-[18px] w-[18px]" />
            </button>
          ) : null}

          <div ref={notificationsRef} className="relative inline-flex">
            <button
              type="button"
              onClick={() => {
                setNotificationsOpen((open) => !open)
                setSessionsOpen(false)
                setSpecialistMenuOpen(false)
                setAccountOpen(false)
              }}
              className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                notificationsOpen
                  ? 'border-[#303139] bg-[#17181d] text-[#ececee]'
                  : 'border-[#24252b] bg-[#111216] text-[#9a9aa2] hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc]'
              }`}
              title="Notifications"
              aria-label="Notifications"
              aria-haspopup="menu"
              aria-expanded={notificationsOpen}
            >
              <NotificationBellIcon className="h-[18px] w-[18px]" />
              {unreadNotificationCount > 0 ? (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[#0b0c0f] bg-[#ff787c] px-1 text-[10px] font-bold leading-none text-[#240708]">
                  {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
                </span>
              ) : null}
            </button>

            {notificationsOpen ? (
              <NotificationsPopover
                notifications={notifications}
                onMarkRead={markNotificationRead}
                onMarkAllRead={markAllNotificationsRead}
                onClear={clearNotifications}
                onOpenLogs={() => void window.api.openDiagnosticsLogsFolder()}
              />
            ) : null}
          </div>

          {workspaceActionsEnabled ? (
            <button
              type="button"
              onClick={openHandoffDialog}
              disabled={!activeWorkspaceId}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#24252b] bg-[#111216] text-[#ffbf2f] transition-colors hover:border-[#3a3426] hover:bg-[#ffbf2f]/8 hover:text-[#ffe0a3] disabled:opacity-40 disabled:hover:bg-[#111216]"
              title="Handoff current plan to sprintengine"
              aria-label="Handoff current plan to sprintengine"
            >
              <WorkspaceTypeIcon mode="sprintengine" className="h-[18px] w-[18px]" />
            </button>
          ) : null}

          {workspaceActionsEnabled ? (
            <button
              onClick={addNewTerminal}
              disabled={!activeWorkspaceId}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#24252b] bg-[#111216] text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc] disabled:opacity-40 disabled:hover:bg-[#111216]"
              title="Open terminal (Ctrl+Shift+')"
              aria-label="Open terminal"
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
                <path d="M7.25 10L10 12.5L7.25 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12.5 15H16.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}

          {workspaceActionsEnabled ? (
            <div ref={specialistMenuRef} className="relative inline-flex">
              <div className="inline-flex overflow-hidden rounded-md border border-[#4b4d55] bg-[#181a20] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.025)]">
                <button
                  onClick={() => {
                    if (multiloopLaunchMenu) {
                      void addNewMultiloopAgent()
                    } else {
                      void addNewSpecialist()
                    }
                  }}
                  disabled={!activeWorkspaceId}
                  className="inline-flex h-8 w-8 items-center justify-center text-[#d7d7dc] transition-colors hover:bg-[#22252c] hover:text-[#f3f3f5] disabled:opacity-40 disabled:hover:bg-[#181a20]"
                  title={
                    multiloopLaunchMenu
                      ? `Spawn Multiloop ${selectedMultiloopSoul.label} with ${selectedCliOption.label}, ${selectedAgentPermissionOption.label}`
                      : `Spawn ${selectedSpecialistAction.label} specialist with ${selectedCliOption.label}, ${selectedAgentPermissionOption.label}${selectedSpecialistAction.shortcut ? ` (${selectedSpecialistAction.shortcut})` : ''}`
                  }
                  aria-label={
                    multiloopLaunchMenu
                      ? `Spawn Multiloop ${selectedMultiloopSoul.label}`
                      : `Spawn ${selectedSpecialistAction.label} specialist`
                  }
                >
                  <SpecialistActionIcon
                    icon={multiloopLaunchMenu ? selectedMultiloopSoul.icon : selectedSpecialistAction.icon}
                    className="h-[18px] w-[18px]"
                  />
                </button>
                <button
                  onClick={() => {
                    setSpecialistMenuOpen((open) => !open)
                  }}
                  disabled={!activeWorkspaceId}
                  className="inline-flex h-8 w-6 items-center justify-center border-l border-[#4b4d55] text-[#c7c7ce] transition-colors hover:bg-[#22252c] hover:text-[#f3f3f5] disabled:opacity-40 disabled:hover:bg-[#181a20]"
                  title="Spawn agent"
                  aria-haspopup="menu"
                  aria-expanded={specialistMenuOpen}
                  aria-label="Spawn agent"
                >
                  <svg className={`h-3.5 w-3.5 transition-transform ${specialistMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>

              {specialistMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-9 z-40 w-72 overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
                >
                  <div className="px-2.5 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                    AI Model
                  </div>
                  <div className="px-1 pb-1">
                    <button
                      type="button"
                      aria-haspopup="listbox"
                      aria-expanded={agentCliDropdownOpen}
                      aria-controls="agent-spawn-cli-options"
                      onClick={() => setAgentCliDropdownOpen((open) => !open)}
                      className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-[#4b4d55] bg-[#181a20] px-2.5 text-left text-[13px] font-semibold text-[#ececee] transition-colors hover:border-[#5c5f68] hover:bg-[#22252c] focus:outline-none focus:ring-1 focus:ring-[#6b6e78]"
                    >
                      <CliIcon cli={selectedCliOption.value} className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{selectedCliOption.label}</span>
                      <svg
                        className={`h-3.5 w-3.5 shrink-0 text-[#9a9aa2] transition-transform ${
                          agentCliDropdownOpen ? 'rotate-180' : ''
                        }`}
                        viewBox="0 0 20 20"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    {agentCliDropdownOpen ? (
                      <div
                        id="agent-spawn-cli-options"
                        role="listbox"
                        aria-label="AI model for new agent"
                        className="mt-1 overflow-hidden rounded-md border border-[#303139] bg-[#111216] p-1"
                      >
                        {AGENT_SPAWN_CLI_OPTIONS.map((option) => {
                          const selected = option.value === selectedCliOption.value
                          return (
                            <button
                              key={option.value}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onClick={() => handleSelectSpawnCli(option.value)}
                              className={`flex w-full min-w-0 items-center gap-2 rounded border px-2 py-2 text-left text-[12px] font-semibold transition-colors ${
                                selected
                                  ? 'border-[#4b4d55] bg-[#24262d] text-[#f3f3f5]'
                                  : 'border-transparent text-[#b4b4bd] hover:border-[#3a3c44] hover:bg-[#1b1d23] hover:text-[#ececee]'
                              }`}
                            >
                              <CliIcon cli={option.value} className="h-4 w-4 shrink-0" />
                              <span className="truncate">{option.label}</span>
                            </button>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                  <div className="my-1 border-t border-[#24252b]" />
                  <div className="px-2.5 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                    Permissions
                  </div>
                  <div className="px-1 pb-1">
                    <label className="sr-only" htmlFor="agent-spawn-cli-permissions">
                      CLI permissions for new agent
                    </label>
                    <select
                      id="agent-spawn-cli-permissions"
                      value={agentSpawnPermissionPreset}
                      onChange={(event) =>
                        setAgentSpawnPermissionPreset(event.currentTarget.value as SwarmCliPermissionPreset)
                      }
                      title={
                        AGENT_SPAWN_PERMISSION_OPTIONS.find((option) => option.value === agentSpawnPermissionPreset)?.title
                        ?? 'CLI permissions for new agent'
                      }
                      className={`h-8 w-full rounded-md border bg-[#111216] px-2.5 text-sm font-semibold outline-none transition-colors focus:ring-1 ${
                        agentSpawnPermissionPreset === 'bypass_all'
                          ? 'border-[#ffbf2f]/50 text-[#ffe0a3] focus:ring-[#ffbf2f]/45'
                          : agentSpawnPermissionPreset === 'auto_workspace'
                            ? 'border-[#6ee7d8]/40 text-[#d8fffb] focus:ring-[#6ee7d8]/40'
                            : 'border-[#303139] text-[#8a8a92] focus:ring-[#303139]'
                      }`}
                    >
                      {AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="my-1 border-t border-[#24252b]" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => addNewCliAgent(selectedCliOption.value, 'General Agent')}
                    className="flex w-full items-start gap-3 rounded px-2.5 py-2 text-left text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                  >
                    <span
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border border-[#24252b] bg-[#111216] ${
                        selectedCliOption.value === 'codex' ? 'text-[#9a9aa2]' : 'text-[#d97757]'
                      }`}
                    >
                      <CliIcon cli={selectedCliOption.value} className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold">
                        General Agent
                      </span>
                      <span className="mt-0.5 block whitespace-normal break-words text-[11px] leading-4 text-[#8a8a92]">
                        {selectedCliOption.label}, {selectedAgentPermissionOption.label.toLowerCase()}, no Soul prompt
                      </span>
                    </span>
                  </button>
                  <div className="my-1 border-t border-[#24252b]" />
                  {multiloopLaunchMenu ? (
                    <>
                      <div className="px-2.5 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                        Multiloop Roles
                      </div>
                      {MULTILOOP_AGENT_SOULS.map((soul) => {
                        const selected = soul.role === selectedMultiloopSoul.role
                        return (
                          <button
                            key={soul.role}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            onClick={() => handleSelectMultiloopRole(soul.role)}
                            className={`flex w-full items-start gap-3 rounded px-2.5 py-2 text-left transition-colors ${
                              selected
                                ? 'bg-[#ffbf2f]/8 text-[#ececee]'
                                : 'text-[#d7d7dc] hover:bg-[#ffbf2f]/8 hover:text-[#e6d4ad]'
                            }`}
                          >
                            <span
                              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border ${
                                selected
                                  ? 'border-[#ffbf2f]/40 bg-[#ffbf2f]/8 text-[#ffbf2f]'
                                  : 'border-[#24252b] bg-[#111216] text-[#5a5a63]'
                              }`}
                            >
                              <SpecialistActionIcon icon={soul.icon} className="h-[18px] w-[18px]" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-semibold">
                                {soul.label}
                              </span>
                              <span className="mt-0.5 block text-[11px] leading-4 text-[#8a8a92]">
                                multiloop-agent-souls/{soul.promptFile}
                              </span>
                            </span>
                            {selected ? (
                              <span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-[#ffbf2f]" />
                            ) : null}
                          </button>
                        )
                      })}
                    </>
                  ) : (
                    <>
                      <div className="px-2.5 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                        Specialist Agents
                      </div>
                      {SPECIALIST_ACTIONS.map((action) => {
                        const selected = action.id === selectedSpecialistAction.id
                        return (
                          <button
                            key={action.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            onClick={() => handleSelectSpecialist(action.id)}
                            className={`flex w-full items-start gap-3 rounded px-2.5 py-2 text-left transition-colors ${
                              selected
                                ? 'bg-[#ffbf2f]/8 text-[#ececee]'
                                : 'text-[#d7d7dc] hover:bg-[#ffbf2f]/8 hover:text-[#e6d4ad]'
                            }`}
                          >
                            <span
                              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border ${
                                selected
                                  ? 'border-[#ffbf2f]/40 bg-[#ffbf2f]/8 text-[#ffbf2f]'
                                  : 'border-[#24252b] bg-[#111216] text-[#5a5a63]'
                              }`}
                            >
                              <SpecialistActionIcon icon={action.icon} className="h-[18px] w-[18px]" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-semibold">
                                {action.label}
                              </span>
                              <span className="mt-0.5 block text-[11px] leading-4 text-[#8a8a92]">
                                {action.description}
                              </span>
                            </span>
                            {selected ? (
                              <span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-[#ffbf2f]" />
                            ) : action.shortcut ? (
                              <kbd className="mt-2.5 shrink-0 rounded bg-[#111216] px-1.5 py-0.5 text-[10px] text-[#5a5a63]">
                                {action.shortcut}
                              </kbd>
                            ) : null}
                          </button>
                        )
                      })}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          <div ref={accountRef} className="relative inline-flex">
            {authState.authenticated ? (
              <button
                type="button"
                onClick={() => {
                  setAccountOpen((open) => !open)
                  setSessionsOpen(false)
                  setSpecialistMenuOpen(false)
                  setNotificationsOpen(false)
                }}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                  proAccount
                    ? accountOpen
                      ? 'border-[#3a3426] bg-[#ffbf2f]/8 text-[#ffe0a3]'
                      : 'border-transparent text-[#ffbf2f] hover:bg-[#ffbf2f]/8 hover:text-[#e6d4ad]'
                    : accountOpen
                      ? 'border-[#303139] bg-[#17181d] text-[#30d158]'
                      : 'border-[#25392c] bg-[#102016] text-[#30d158] hover:border-[#30d158]/50 hover:bg-[#142819]'
                }`}
                title={proAccount ? 'Multicode Pro account' : 'Multicode account'}
                aria-label={proAccount ? 'Multicode Pro account' : 'Multicode account'}
                aria-haspopup="menu"
                aria-expanded={accountOpen}
              >
                <AccountIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void startLogin()}
                disabled={authState.status === 'checking'}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#24252b] bg-[#111216] text-[#8a8a92] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[#24252b] disabled:hover:bg-[#111216] disabled:hover:text-[#8a8a92]"
                title={authState.status === 'checking' ? 'Checking sign-in status' : 'Sign in'}
                aria-label={authState.status === 'checking' ? 'Checking sign-in status' : 'Sign in'}
              >
                <AccountIcon className="h-4 w-4" />
              </button>
            )}

            {authState.authenticated && accountOpen ? (
              <AccountPopover
                authState={authState}
                message={authMessage}
                onRefresh={() => void refreshAuthState()}
                onLogout={() => void logout()}
                onSwitchOrganization={() => void switchOrganization()}
                onUpgrade={() => void window.api.authOpenUpgrade('swarm_mode')}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {showTemplateSelector ? (
          <TemplateSelector
            onCreate={handleCreate}
            onClose={() => {
              setShowTemplateSelector(false)
              setTemplateSelectorInitialState(null)
            }}
            allowClose={workspaces.length > 0}
            initialState={templateSelectorInitialState}
          />
        ) : (
          <>
            {workspaces.length === 0 && <EmptyState onNew={openTemplateSelector} />}
            {renderedWorkspaceIds.map((workspaceId) => {
              const active = workspaceId === activeWorkspaceId
              return (
                <div
                  key={workspaceId}
                  className={`absolute inset-0 ${active ? 'z-10 visible' : 'z-0 invisible'}`}
                  style={{ pointerEvents: active ? 'auto' : 'none' }}
                  aria-hidden={!active}
                >
                  <WorkspaceLayout workspaceId={workspaceId} onStartFuturePlan={openFuturePlanWorkspace} />
                </div>
              )
            })}
          </>
        )}
      </div>

      {handoffOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
          <div
            ref={handoffDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="handoff-title"
            className="w-full max-w-sm rounded-md border border-[#303139] bg-[#0d0e11] shadow-[0_18px_60px_rgba(0,0,0,0.5)]"
          >
            <div className="border-b border-[#1f2025] px-4 py-3">
              <div id="handoff-title" className="text-sm font-semibold text-[#ececee]">
                Handoff To SprintEngine
              </div>
            </div>
            <div className="space-y-3 px-4 py-4">
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                  Team Name
                </span>
                <input
                  value={handoffTeamName}
                  onChange={(event) => {
                    setHandoffTeamName(event.target.value)
                    setHandoffError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void confirmHandoff()
                  }}
                  className="h-9 w-full rounded bg-[#111216] px-2.5 text-[13px] text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] hover:bg-[#17181d] focus:ring-1 focus:ring-[#ffbf2f]/45"
                  placeholder="sprintengine-improvements"
                />
              </label>
              {handoffError ? (
                <div className="border-l border-[#ff787c] pl-3 text-[12px] leading-5 text-[#ffb3b5]">
                  {handoffError}
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[#1f2025] px-4 py-3">
              <button
                type="button"
                onClick={() => setHandoffOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#8a8a92] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmHandoff()}
                disabled={!handoffTeamName.trim()}
                className="inline-flex items-center gap-2 rounded-md bg-[#ffbf2f]/12 px-3 py-1.5 text-sm font-semibold text-[#ffe0a3] transition-colors hover:bg-[#ffbf2f]/18 disabled:opacity-45 disabled:hover:bg-[#ffbf2f]/12"
              >
                <WorkspaceTypeIcon mode="sprintengine" className="h-4 w-4" />
                Handoff
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNewWorkspace={openTemplateSelector}
          onSpawnSpecialist={handleSelectSpecialist}
        />
      )}
    </div>
  )
}

function NotificationsPopover({
  notifications,
  onMarkRead,
  onMarkAllRead,
  onClear,
  onOpenLogs,
}: {
  notifications: AppNotification[]
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onClear: () => void
  onOpenLogs: () => void
}) {
  const copyNotification = (notification: AppNotification) => {
    const details = [
      `[${notification.level.toUpperCase()}] ${notification.title}`,
      notification.message,
      notification.details,
      notification.workspaceName ? `Workspace: ${notification.workspaceName}` : null,
      notification.agentId ? `Agent: ${notification.agentId}` : null,
      notification.sessionId ? `Session: ${notification.sessionId}` : null,
      notification.logPath ? `Log: ${notification.logPath}` : null,
    ].filter(Boolean).join('\n')

    void navigator.clipboard.writeText(details).catch(() => {})
    onMarkRead(notification.id)
  }

  return (
    <div
      role="menu"
      className="absolute right-0 top-9 z-50 w-[440px] overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
    >
      <div className="flex h-10 items-center justify-between border-b border-[#1f2025] px-3">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#8a8a92]">
          Notifications
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenLogs}
            className="rounded px-2 py-1 text-[11px] font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
          >
            Logs
          </button>
          {notifications.length > 0 ? (
            <>
              <button
                type="button"
                onClick={onMarkAllRead}
                className="rounded px-2 py-1 text-[11px] font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Mark read
              </button>
              <button
                type="button"
                onClick={onClear}
                className="rounded px-2 py-1 text-[11px] font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
              >
                Clear
              </button>
            </>
          ) : null}
        </div>
      </div>

      {notifications.length === 0 ? (
        <div className="px-3 py-4 text-[13px] text-[#5a5a63]">No notifications</div>
      ) : (
        <div className="max-h-[440px] overflow-y-auto p-1">
          {notifications.map((notification) => (
            <div
              key={notification.id}
              role="menuitem"
              className={`rounded px-2.5 py-2.5 ${
                notification.read ? 'text-[#9a9aa2]' : 'bg-[#15161a] text-[#d7d7dc]'
              }`}
              onMouseEnter={() => {
                if (!notification.read) onMarkRead(notification.id)
              }}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                    notification.level === 'error'
                      ? 'bg-[#ff787c]'
                      : notification.level === 'warning'
                        ? 'bg-[#ffbf2f]'
                        : 'bg-[#6ee7d8]'
                  }`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className="truncate text-[13px] font-semibold text-[#ececee]">
                      {notification.title}
                    </div>
                    <div className="shrink-0 text-[11px] text-[#5a5a63]">
                      {formatNotificationTime(notification.timestamp)}
                    </div>
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-[#9a9aa2]">
                    {notification.message}
                  </div>
                  {(notification.workspaceName || notification.agentId || notification.sessionId) ? (
                    <div className="mt-1 truncate font-mono text-[10px] text-[#5a5a63]">
                      {[notification.workspaceName, notification.agentId, notification.sessionId]
                        .filter(Boolean)
                        .join(' / ')}
                    </div>
                  ) : null}
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => copyNotification(notification)}
                      className="rounded border border-[#24252b] bg-[#111216] px-2 py-1 text-[11px] font-semibold text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee]"
                    >
                      Copy
                    </button>
                    {notification.logPath ? (
                      <button
                        type="button"
                        onClick={onOpenLogs}
                        className="rounded border border-[#24252b] bg-[#111216] px-2 py-1 text-[11px] font-semibold text-[#9a9aa2] transition-colors hover:border-[#303139] hover:bg-[#17181d] hover:text-[#ececee]"
                      >
                        Open logs
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SessionsPopover({
  items,
  onOpen,
  onStop,
}: {
  items: SessionItem[]
  onOpen: (item: SessionItem) => void | Promise<void>
  onStop: (item: SessionItem) => void
}) {
  const groups = items.reduce<Array<{ workspace: Workspace; items: SessionItem[] }>>((acc, item) => {
    const group = acc.find((candidate) => candidate.workspace.id === item.workspace.id)
    if (group) {
      group.items.push(item)
    } else {
      acc.push({ workspace: item.workspace, items: [item] })
    }
    return acc
  }, [])

  return (
    <div
      role="menu"
      className="absolute right-0 top-9 z-50 w-[420px] overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
    >
      <div className="flex h-9 items-center justify-between border-b border-[#1f2025] px-2.5">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#8a8a92]">
          Sessions
        </span>
        {items.length > 0 ? (
          <span className="rounded bg-[#17181d] px-1.5 py-0.5 text-[11px] font-semibold text-[#9a9aa2]">
            {items.length}
          </span>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="px-2.5 py-3 text-[13px] text-[#5a5a63]">No sessions</div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto py-1">
          {groups.map((group) => (
            <div key={group.workspace.id} className="py-1">
              <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#5a5a63]">
                <WorkspaceTypeIcon mode={group.workspace.mode} className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">{group.workspace.name}</span>
              </div>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <div
                    key={`${item.workspace.id}:${item.agentId}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded px-2.5 py-2 text-[13px] text-[#d7d7dc] hover:bg-[#15161a]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[#24252b] bg-[#111216] text-[#8a8a92]">
                        {item.role ? (
                          <SwarmRoleIcon role={item.role} className="h-[17px] w-[17px]" />
                        ) : item.kind === 'terminal' ? (
                          <TerminalSessionIcon className="h-[17px] w-[17px]" />
                        ) : (
                          <CliIcon cli={item.cli} className="h-[17px] w-[17px]" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium text-[#ececee]">{item.label}</span>
                          <StatusDot
                            tone={item.status}
                            label={item.status === 'needs-input' ? 'Needs input' : 'Running'}
                          />
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-[#7a7a83]">
                          {item.kind === 'terminal' ? 'terminal' : item.taskId ?? item.cli}
                        </span>
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => void onOpen(item)}
                      className="h-7 rounded border border-[#24252b] bg-[#111216] px-2.5 text-[12px] font-semibold text-[#d7d7dc] transition-colors hover:border-[#303139] hover:bg-[#1b1c21] hover:text-[#ececee]"
                    >
                      Open
                    </button>

                    <button
                      type="button"
                      onClick={() => onStop(item)}
                      className="flex h-7 w-7 items-center justify-center rounded border border-[#24252b] bg-[#111216] text-[#8a8a92] transition-colors hover:border-[#4a2426] hover:bg-[#2a1214] hover:text-[#ff787c]"
                      title="Stop"
                      aria-label={`Stop ${item.label}`}
                    >
                      <StopIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SessionsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5" width="16" height="12.5" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M7.5 9.25L10.25 12L7.5 14.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 14.75H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 20H15.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function NotificationBellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M18.25 10.75V9.5a6.25 6.25 0 0 0-12.5 0v1.25c0 2.3-.8 3.6-1.55 4.38a1.24 1.24 0 0 0 .88 2.12h13.84a1.24 1.24 0 0 0 .88-2.12c-.75-.78-1.55-2.08-1.55-4.38Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.75 19.25a2.35 2.35 0 0 0 4.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function MemoryGraphIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="8" r="2.35" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="16.75" cy="6.25" r="2.15" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17.5" cy="16.75" r="2.75" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="7.25" cy="17.25" r="1.75" fill="currentColor" />
      <path d="M8.8 7.6L14.65 6.6M8.15 9.9L15.7 15.1M9 17.15H14.75" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  )
}

function TerminalSessionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M7.25 10L10 12.5L7.25 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function WindowControls({ isMaximized }: { isMaximized: boolean }) {
  const minimizeWindow = () => {
    void window.api.windowMinimize()
  }

  const toggleWindowSize = () => {
    void window.api.windowToggleMaximize()
  }

  const closeWindow = () => {
    void window.api.windowClose()
  }

  return (
    <div className="app-no-drag flex shrink-0 items-stretch" aria-label="Window controls">
      <button
        type="button"
        onClick={minimizeWindow}
        className="inline-flex w-10 items-center justify-center text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:bg-[#17181d] focus:text-[#ececee] focus:outline-none"
        aria-label="Minimize window"
        title="Minimize"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 8H12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      <button
        type="button"
        onClick={toggleWindowSize}
        className="inline-flex w-10 items-center justify-center text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:bg-[#17181d] focus:text-[#ececee] focus:outline-none"
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        title={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? (
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5.5 6.5H11.5V12.5H5.5V6.5Z" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4.5 9.5H3.5V3.5H9.5V4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4H12V12H4V4Z" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>

      <button
        type="button"
        onClick={closeWindow}
        className="inline-flex w-10 items-center justify-center text-[#9a9aa2] transition-colors hover:bg-[#c42b1c] hover:text-white focus:bg-[#c42b1c] focus:text-white focus:outline-none"
        aria-label="Close window"
        title="Close"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

function getNextWorkspaceId(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  step: 1 | -1
): string | null {
  if (workspaces.length < 2) return null

  const activeIndex = workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId)
  if (activeIndex === -1) return workspaces[0].id

  const nextIndex = (activeIndex + step + workspaces.length) % workspaces.length
  return workspaces[nextIndex].id
}

function killTerminalForLayoutTab(workspaceId: string, node: TabNode): void {
  const state = useWorkspaceStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!workspace) return

  const config = node.getConfig() as { agentId?: string; terminalId?: string } | undefined
  if (node.getComponent() === 'agent') {
    const agentId = config?.agentId ?? node.getId()
    const agent = workspace.agents[agentId]
    if (agent?.cliSessionId) void window.api.terminalKill(agent.cliSessionId).catch(() => {})
    if (agent?.kind === 'sprintengine') state.setSwarmAutoEnabled(workspaceId, false)
    state.updateAgent(workspaceId, agentId, {
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
    })
    return
  }

  if (node.getComponent() === 'terminal') {
    const terminalId = config?.terminalId ?? node.getId()
    void window.api.terminalKill(`terminal-${terminalId}`).catch(() => {})
  }
}

function closeActiveLayoutTab(workspaceId: string): boolean {
  const model = getModel(workspaceId)
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  if (!model || !tabset) return false

  const selectedIndex = tabset.getSelected()
  const selectedNode = tabset.getChildren()[selectedIndex]
  if (!(selectedNode instanceof TabNode) || !selectedNode.isEnableClose()) return false

  killTerminalForLayoutTab(workspaceId, selectedNode)
  model.doAction(Actions.deleteTab(selectedNode.getId()))
  return true
}

function AccountPopover({
  authState,
  message,
  onRefresh,
  onLogout,
  onSwitchOrganization,
  onUpgrade,
}: {
  authState: MulticodeAuthState
  message: string | null
  onRefresh: () => void
  onLogout: () => void
  onSwitchOrganization: () => void
  onUpgrade: () => void
}) {
  const planLabel = authState.entitlements?.plan.status === 'active'
    ? authState.entitlements.plan.code
    : authState.entitlementStatus === 'offline_grace'
      ? 'offline grace'
      : authState.entitlements?.plan.status ?? null

  return (
    <div
      role="menu"
      className="absolute right-0 top-9 z-50 w-72 overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] p-3 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[#ececee]">
              {authState.user?.displayName ?? authState.user?.email ?? 'Multicode account'}
            </div>
            <div className="mt-1 truncate text-[12px] text-[#8a8a92]">
              {authState.selectedOrganization?.name ?? 'No organization selected'}
            </div>
          </div>
          {planLabel ? (
            <span className="shrink-0 rounded border border-[#303139] bg-[#111216] px-2 py-1 text-[11px] font-semibold text-[#d7d7dc]">
              {planLabel}
            </span>
          ) : null}
        </div>

        {message || authState.entitlementStatus === 'offline_grace' ? (
          <div className="rounded border border-[#3a3426] bg-[#17181d] px-2.5 py-2 text-[12px] leading-5 text-[#c9b98c]">
            {message ?? `Offline grace expires ${formatShortDate(authState.graceExpiresAt)}.`}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={onRefresh}
            className="h-8 rounded-md border border-[#303139] bg-[#17181d] px-3 text-[12px] font-semibold text-[#d7d7dc] hover:bg-[#1f2025]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onSwitchOrganization}
            className="h-8 rounded-md border border-[#303139] bg-[#111216] px-3 text-[12px] font-semibold text-[#d7d7dc] hover:bg-[#17181d]"
          >
            Switch org
          </button>
          <button
            type="button"
            onClick={onUpgrade}
            className="h-8 rounded-md border border-[#ececee] bg-[#ececee] px-3 text-[12px] font-semibold text-[#08090b] hover:bg-white"
          >
            Upgrade
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="h-8 rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-[12px] font-semibold text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#d7d7dc]"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}

function AccountIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 12.25a4.25 4.25 0 1 0 0-8.5a4.25 4.25 0 0 0 0 8.5Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.75 20.25c.72-3.1 3.38-5.25 7.25-5.25s6.53 2.15 7.25 5.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function formatShortDate(value: string | null): string {
  if (!value) return 'soon'
  return new Date(value).toLocaleString()
}

function formatNotificationTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function cycleActiveLayoutTab(workspaceId: string, step: 1 | -1): boolean {
  const model = getModel(workspaceId)
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  if (!model || !tabset) return false

  const tabs = tabset.getChildren().filter((node): node is TabNode => node instanceof TabNode)
  if (tabs.length < 2) return false

  const selectedNode = tabset.getSelectedNode()
  const selectedIndex = selectedNode instanceof TabNode
    ? tabs.findIndex((tab) => tab.getId() === selectedNode.getId())
    : -1
  const nextIndex = ((selectedIndex === -1 ? 0 : selectedIndex) + step + tabs.length) % tabs.length
  const nextTab = tabs[nextIndex]
  model.doAction(Actions.selectTab(nextTab.getId()))
  if (nextTab.getComponent() === 'editor') {
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('multicode:focus-editor', { detail: { workspaceId } }))
    })
  }
  return true
}

function firstTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabSetNode) found = node
  })
  return found
}

function getActiveTab(model: Model | undefined): TabNode | null {
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  if (!tabset) return null
  const selectedNode = tabset.getChildren()[tabset.getSelected()]
  return selectedNode instanceof TabNode ? selectedNode : null
}

function findRunningSession(
  terminalSessions: TerminalSessionSnapshot[],
  predicate: (session: TerminalSessionSnapshot) => boolean
): TerminalSessionSnapshot | null {
  return terminalSessions.find((session) => session.running && predicate(session)) ?? null
}

function getActiveCliSession(
  workspace: Workspace,
  terminalSessions: TerminalSessionSnapshot[]
): TerminalSessionSnapshot | null {
  const model = getModel(workspace.id)
  const activeTab = getActiveTab(model)

  if (activeTab?.getComponent() === 'agent') {
    const config = activeTab.getConfig() as { agentId?: string } | undefined
    const agentId = config?.agentId
    const session = agentId
      ? findRunningSession(terminalSessions, (candidate) =>
        candidate.kind === 'agent'
        && candidate.workspaceId === workspace.id
        && candidate.agentId === agentId
      )
      : null
    if (session) return session
  }

  if (activeTab?.getComponent() === 'terminal') {
    const config = activeTab.getConfig() as { terminalId?: string } | undefined
    const terminalId = config?.terminalId ?? activeTab.getId()
    const session = findRunningSession(terminalSessions, (candidate) =>
      candidate.kind === 'terminal'
      && candidate.workspaceId === workspace.id
      && (
        candidate.terminalId === terminalId
        || candidate.sessionId === terminalId
        || candidate.sessionId === `terminal-${terminalId}`
      )
    )
    if (session) return session
  }

  return findRunningSession(terminalSessions, (candidate) =>
    candidate.workspaceId === workspace.id && candidate.kind === 'agent'
  ) ?? findRunningSession(terminalSessions, (candidate) =>
    candidate.workspaceId === workspace.id && candidate.kind === 'terminal'
  )
}

function findPanelTab(model: Model, component: WorkspacePanelComponent): TabNode | null {
  let found: TabNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabNode && node.getComponent() === component) {
      found = node
    }
  })
  return found
}

function toggleWorkspacePanel(workspaceId: string, component: WorkspacePanelComponent): void {
  const model = getModel(workspaceId)
  if (!model) return

  const existingTab = findPanelTab(model, component)
  if (existingTab) {
    model.doAction(Actions.deleteTab(existingTab.getId()))
    return
  }

  const tabName = component === 'explorer'
    ? 'Files'
    : component === 'git'
      ? 'Git'
      : component === 'memory-graph'
        ? 'Memory Graph'
        : 'Editor'
  const target = getPreferredPanelTarget(model, component)

  model.doAction(
    Actions.addNode(
      { type: 'tab', name: tabName, component },
      target.id,
      target.location,
      -1,
      true
    )
  )
}

function getPreferredPanelTarget(
  model: Model,
  component: WorkspacePanelComponent
): { id: string; location: DockLocation } {
  if (component === 'memory-graph') {
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    return {
      id: targetTabset?.getId() ?? model.getRoot().getId(),
      location: DockLocation.CENTER,
    }
  }

  if (component === 'git') {
    const explorerTab = findPanelTab(model, 'explorer')
    const explorerParent = explorerTab?.getParent()
    if (explorerParent instanceof TabSetNode) {
      return {
        id: explorerParent.getId(),
        location: DockLocation.CENTER,
      }
    }
  }

  if (component === 'explorer') {
    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    return {
      id: targetTabset?.getId() ?? model.getRoot().getId(),
      location: DockLocation.LEFT,
    }
  }

  const explorerTab = findPanelTab(model, 'explorer')
  const explorerParent = explorerTab?.getParent()
  if (explorerParent instanceof TabSetNode) {
    return {
      id: explorerParent.getId(),
      location: DockLocation.RIGHT,
    }
  }

  const targetTabset = model.getActiveTabset() ?? firstTabset(model)
  return {
    id: targetTabset?.getId() ?? model.getRoot().getId(),
    location: DockLocation.LEFT,
  }
}

type LayoutSessionNode = {
  component?: string
  config?: {
    agentId?: string
    terminalId?: string
  }
  children?: LayoutSessionNode[]
}

function terminateWorkspaceTerminals(workspace: Workspace): void {
  const sessionIds = new Set<string>()

  Object.values(workspace.agents).forEach((agent) => {
    if (agent.cliSessionId) sessionIds.add(agent.cliSessionId)
  })

  const collectLayoutSessions = (node: LayoutSessionNode | undefined) => {
    if (!node) return

    if (node.component === 'agent') {
      const agentId = node.config?.agentId
      const sessionId = agentId ? workspace.agents[agentId]?.cliSessionId : undefined
      if (sessionId) sessionIds.add(sessionId)
    }

    if (node.component === 'terminal') {
      const terminalId = node.config?.terminalId
      if (terminalId) sessionIds.add(`terminal-${terminalId}`)
    }

    node.children?.forEach(collectLayoutSessions)
  }

  collectLayoutSessions(workspace.layoutModel.layout as LayoutSessionNode)
  workspace.layoutModel.borders?.forEach((border) => collectLayoutSessions(border as LayoutSessionNode))

  sessionIds.forEach((sessionId) => {
    void window.api.terminalKill(sessionId).catch(() => {})
  })
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="space-y-4 text-center">
        <p className="text-sm text-[#5a5a63]">No workspace open</p>
        <button
          onClick={onNew}
          className="rounded bg-[#111216] px-4 py-2 text-sm font-medium text-[#ececee] transition-colors hover:bg-[#17181d]"
        >
          New Workspace
        </button>
      </div>
    </div>
  )
}
