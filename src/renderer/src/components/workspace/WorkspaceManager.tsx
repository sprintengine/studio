import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, DockLocation, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import { SpecialistActionIcon, StatusDot, SprintEngineRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import CommandPalette from '../CommandPalette'
import { TipStartupModal } from '../learn/TipStartupModal'
import SettingsPanel from '../settings/SettingsPanel'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  MULTILOOP_ROLES,
  SPECIALIST_ACTIONS,
  getMultiloopRole,
  getSpecialistAction,
  buildSpecialistSoulStartupPrompt,
  loadMultiloopPrompt,
  type MultiloopRoleDescriptor,
  type SpecialistAction,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
  AppNotification,
  FuturePlanWorkspaceSource,
  LayoutTemplate,
  MultiloopRole,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
  Workspace,
} from '../../types/workspace'
import { pickRandomAgentName } from '../../utils/agentNames'
import { normalizeAgentIdentifier, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { focusOrAddAgentTab, focusOrAddComponentTab, focusOrAddTerminalTab, getModel, hasComponentTab, toggleComponentTab } from '../../utils/modelRegistry'
import { MULTICODE_DISABLE_SPRINTENGINE_SYNC } from '../../utils/runtimeFlags'
import { buildCurrentContextSprintEngineHandoffPrompt } from '../../utils/sprintengineHandoff'
import { buildMultiloopLaunchContextLines, getActiveMultiloopMilestone, getMultiloopTasksForMilestone } from '../../utils/multiloop'
import { sprintEngineRoleAccent } from '../../utils/sprintengine'
import { getHighlightSwatch } from '../../utils/highlight'
import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import { Field, Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import NewWorkspacePanel, { type NewWorkspacePanelInitialState } from './NewWorkspacePanel'
import SprintEngineAutoRunSupervisor from './SprintEngineAutoRunSupervisor'
import MultiloopAutoRunSupervisor from './MultiloopAutoRunSupervisor'
import MultiloopStateSynchronizer from './MultiloopStateSynchronizer'
import SprintEngineStateSynchronizer from './SprintEngineStateSynchronizer'
import WorkspaceGitStatusButton from './WorkspaceGitStatusButton'
import WorkspaceLayout from './WorkspaceLayout'
import WorkspaceSidebar from './WorkspaceSidebar'

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const
const EMPTY_SPECIALIST_CLI_DEFAULTS: Partial<Record<SpecialistActionId, AgentCli>> = {}
const EMPTY_MULTILOOP_ROLE_CLI_DEFAULTS: Partial<Record<MultiloopRole, AgentCli>> = {}
const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}

type ViewItem = { component: string; name: string }
const VIEWS_FOR_MODE: Record<string, { label: string; views: ViewItem[] }> = {
  sprintengine: {
    label: 'Sprint Engine',
    views: [
      { component: 'sprintengine-project', name: 'Project' },
      { component: 'sprintengine-task-graph', name: 'Task Graph' },
      { component: 'sprintengine-kanban', name: 'Kanban' },
    ],
  },
  multiloop: {
    label: 'Multiloop',
    views: [
      { component: 'multiloop-board', name: 'Multiloop' },
    ],
  },
}
const TERMINAL_SESSION_RECOVERY_POLL_MS = 30_000
const WORKSPACE_LAYOUT_IDLE_UNLOAD_MS = 5 * 60_000
const AGENT_SPAWN_CLI_OPTIONS: Array<{ value: AgentCli; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
]
const AGENT_SPAWN_PERMISSION_OPTIONS: Array<{
  value: SprintEngineCliPermissionPreset
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
const SPECIALIST_KEYBOARD_CODE_SHORTCUTS: Record<string, SpecialistActionId> = {
  KeyF: 'frontend-design-review',
  KeyM: 'performance',
  KeyP: 'architect',
}
function shortcutLabel(shortcut: string): string {
  if (window.api.platform !== 'darwin') return shortcut
  return shortcut
    .replace(/\bCtrl\b/g, 'Cmd')
    .replace(/\bAlt\b/g, 'Option')
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
  role: NonNullable<Workspace['sprintEngineState']>['sprintEngineAgents'][string]['role'] | null
  taskId: string | null
  sessionId: string
}

function workspaceNeedsInput(workspace: Workspace): boolean {
  return Object.values(workspace.sprintEngineState?.sprintEngineAgents ?? {}).some(
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

function workspaceTabIconClass(mode: Workspace['mode']): string {
  if (mode === 'sprintengine') return 'text-[#ffbf2f]'
  if (mode === 'switchboard') return 'text-[#a78bfa]'
  return 'text-[#9a9aa2]'
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

function terminalSessionLabel(terminalId: string): string {
  if (terminalId.startsWith('git-')) return 'Git terminal'
  if (terminalId.startsWith('worktree-')) return 'Worktree terminal'
  return 'Terminal'
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
        const runtime = workspace.sprintEngineState?.sprintEngineAgents[session.agentId]
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
        label: terminalSessionLabel(terminalId),
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
      session.sprintEngineStatePath ?? '',
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
  multiloopPrompt,
  workspace,
  agentId,
}: {
  soul: MultiloopRoleDescriptor
  multiloopPrompt: string
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

  return [multiloopPrompt.trim(), ...context].join('\n')
}

export default function WorkspaceManager() {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const sidebarCollapsed = useWorkspaceStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useWorkspaceStore((s) => s.setSidebarCollapsed)
  const forgetFolder = useWorkspaceStore((s) => s.forgetFolder)
  const recordWorkspaceTerminalActivity = useWorkspaceStore((s) => s.recordWorkspaceTerminalActivity)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const setSprintEngineAutoEnabled = useWorkspaceStore((s) => s.setSprintEngineAutoEnabled)
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const lastSelectedCli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli ?? 'claude')
  const lastSelectedSpecialist = useWorkspaceStore(
    (s) => s.appSettings.lastSelectedSpecialist ?? SPECIALIST_ACTIONS[0].id
  )
  const setLastSelectedSpecialist = useWorkspaceStore((s) => s.setLastSelectedSpecialist)
  const lastSelectedMultiloopRole = useWorkspaceStore(
    (s) => s.appSettings.lastSelectedMultiloopRole ?? MULTILOOP_ROLES[0].role
  )
  const setLastSelectedMultiloopRole = useWorkspaceStore((s) => s.setLastSelectedMultiloopRole)
  const lastAgentSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.appSettings.lastAgentSpawnPermissionPreset ?? 'default'
  )
  const setLastAgentSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.setLastAgentSpawnPermissionPreset
  )
  const specialistCliDefaults = useWorkspaceStore(
    (s) => s.appSettings.specialistCliDefaults ?? EMPTY_SPECIALIST_CLI_DEFAULTS
  )
  const multiloopRoleCliDefaults = useWorkspaceStore(
    (s) => s.appSettings.multiloopRoleCliDefaults ?? EMPTY_MULTILOOP_ROLE_CLI_DEFAULTS
  )
  const setSpecialistCliDefault = useWorkspaceStore((s) => s.setSpecialistCliDefault)
  const setMultiloopRoleCliDefault = useWorkspaceStore((s) => s.setMultiloopRoleCliDefault)
  const notifications = useNotificationStore((s) => s.notifications)
  const markNotificationRead = useNotificationStore((s) => s.markRead)
  const markAllNotificationsRead = useNotificationStore((s) => s.markAllRead)
  const clearNotifications = useNotificationStore((s) => s.clearAll)

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
  const mobileWorkspaceRootKey = workspaces
    .map((workspace) => workspace.folderPath)
    .filter((folderPath): folderPath is string => Boolean(folderPath?.trim()))
    .join('\n')
  const selectedSpecialistAction = getSpecialistAction(lastSelectedSpecialist)
  const selectedMultiloopRoleDescriptor = getMultiloopRole(lastSelectedMultiloopRole)
  const multiloopLaunchMenu = activeWorkspace?.mode === 'multiloop'
  const proAccount = hasActiveProPlan(authState)

  const [showNewWorkspacePanel, setShowNewWorkspacePanel] = useState(false)
  const [newWorkspacePanelInitialState, setNewWorkspacePanelInitialState] = useState<NewWorkspacePanelInitialState | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [checkForUpdatesOnSettingsOpen, setCheckForUpdatesOnSettingsOpen] = useState(false)
  const [initialSettingsTab, setInitialSettingsTab] = useState<string | null>(null)
  const [tipModalOpen, setTipModalOpen] = useState(false)
  const tipModalDecidedRef = useRef(false)
  const showTipsOnStartup = useWorkspaceStore((s) => s.appSettings.learning?.showTipsOnStartup ?? true)
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? EMPTY_PROJECT_KNOWLEDGE_ROOTS)
  const [showPalette, setShowPalette] = useState(false)
  const [specialistMenuOpen, setSpecialistMenuOpen] = useState(false)
  const [agentMenuQuery, setAgentMenuQuery] = useState('')
  const [agentMenuHighlight, setAgentMenuHighlight] = useState(0)
  const [chipPopoverForRole, setChipPopoverForRole] = useState<
    { kind: 'specialist'; id: SpecialistActionId } | { kind: 'multiloop'; role: MultiloopRole } | null
  >(null)
  const agentMenuSearchRef = useRef<HTMLInputElement>(null)
  const [agentSpawnPermissionPreset, setAgentSpawnPermissionPresetState] = useState<SprintEngineCliPermissionPreset>(
    lastAgentSpawnPermissionPreset
  )
  const selectedAgentPermissionOption = AGENT_SPAWN_PERMISSION_OPTIONS.find(
    (option) => option.value === agentSpawnPermissionPreset
  ) ?? AGENT_SPAWN_PERMISSION_OPTIONS[0]
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [viewMenuTick, setViewMenuTick] = useState(0)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handoffTeamName, setHandoffTeamName] = useState('')
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionSnapshot[]>([])
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([])
  const [windowState, setWindowState] = useState<WindowState>({
    isMaximized: false,
    isFullScreen: false,
  })
  const specialistMenuRef = useRef<HTMLDivElement>(null)
  const sessionsRef = useRef<HTMLDivElement>(null)
  const viewMenuRef = useRef<HTMLDivElement>(null)
  const notificationsRef = useRef<HTMLDivElement>(null)
  const accountRef = useRef<HTMLDivElement>(null)
  const handoffInputRef = useRef<HTMLInputElement>(null)
  const terminalSessionsSignatureRef = useRef('')
  const reportedTerminalExitsRef = useRef<Map<string, number>>(new Map())
  const workspaceLayoutUnloadTimersRef = useRef<Record<string, number>>({})
  const workspaceActionsEnabled = activeWorkspace && !showNewWorkspacePanel
  const sessions = getSessionItems(workspaces, terminalSessions)
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length
  const settingsOpen = showSettings || Boolean(activeWorkspaceId && hasComponentTab(activeWorkspaceId, 'settings'))
  const renderedWorkspaceIds = workspaces
    .map((workspace) => workspace.id)
    .filter((workspaceId) => workspaceId === activeWorkspaceId || mountedWorkspaceIds.includes(workspaceId))

  const openNewWorkspacePanel = () => {
    setNewWorkspacePanelInitialState(null)
    setShowNewWorkspacePanel(true)
    setShowSettings(false)
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    setHandoffOpen(false)
  }

  const openSettings = useCallback((checkForUpdates = false, targetTab: string | null = null) => {
    if (activeWorkspaceId) {
      const model = getModel(activeWorkspaceId)
      if (model) {
        let settingsTabId: string | null = null
        model.visitNodes((node) => {
          if (settingsTabId || !(node instanceof TabNode) || node.getComponent() !== 'settings') return
          settingsTabId = node.getId()
        })

        if (settingsTabId) {
          const nextConfig: Record<string, unknown> = {}
          if (checkForUpdates) nextConfig.checkForUpdatesRequestId = Date.now()
          if (targetTab) nextConfig.initialTab = targetTab
          if (Object.keys(nextConfig).length > 0) {
            model.doAction(Actions.updateNodeAttributes(settingsTabId, { config: nextConfig }))
          }
          model.doAction(Actions.selectTab(settingsTabId))
        } else {
          const targetTabset = model.getActiveTabset() ?? firstTabset(model)
          if (targetTabset) {
            const config: Record<string, unknown> = {}
            if (checkForUpdates) config.checkForUpdatesRequestId = Date.now()
            if (targetTab) config.initialTab = targetTab
            model.doAction(
              Actions.addNode(
                {
                  type: 'tab',
                  name: 'Settings',
                  component: 'settings',
                  config,
                },
                targetTabset.getId(),
                DockLocation.CENTER,
                -1,
                true
              )
            )
          }
        }
      }
    }

    setCheckForUpdatesOnSettingsOpen(checkForUpdates)
    setInitialSettingsTab(targetTab)
    setShowSettings(!activeWorkspaceId)
    setShowNewWorkspacePanel(false)
    setSpecialistMenuOpen(false)
    setSessionsOpen(false)
    setViewMenuOpen(false)
    setNotificationsOpen(false)
    setAccountOpen(false)
    setHandoffOpen(false)
  }, [activeWorkspaceId])

  const openLearnCenter = useCallback(() => {
    openSettings(false, 'learn')
  }, [openSettings])

  const openFuturePlanWorkspace = (source: FuturePlanWorkspaceSource) => {
    setNewWorkspacePanelInitialState({
      mode: 'sprintengine',
      folderPath: source.folderPath,
      futurePlanSource: source,
    })
    setShowNewWorkspacePanel(true)
    setShowSettings(false)
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    setHandoffOpen(false)
  }

  const setAgentSpawnPermissionPreset = (preset: SprintEngineCliPermissionPreset) => {
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
    if (specialistMenuOpen) {
      setAgentMenuQuery('')
      setAgentMenuHighlight(0)
      setChipPopoverForRole(null)
      requestAnimationFrame(() => agentMenuSearchRef.current?.focus())
    } else {
      setChipPopoverForRole(null)
    }
  }, [specialistMenuOpen])

  useEffect(() => {
    if (tipModalDecidedRef.current) return
    tipModalDecidedRef.current = true
    if (!showTipsOnStartup) return
    setTipModalOpen(true)
  }, [showTipsOnStartup])

  const learningContext = useMemo(() => ({
    activeWorkspace,
    hasAnyTerminal: terminalSessions.length > 0,
    hasKnowledgeRoot:
      Boolean(
        activeWorkspace?.memory?.relativeRoot
        || (activeWorkspace?.folderPath && projectKnowledgeRoots[activeWorkspace.folderPath])
      ),
  }), [activeWorkspace, projectKnowledgeRoots, terminalSessions.length])

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
    const roots = mobileWorkspaceRootKey.split('\n').filter(Boolean)
    void window.api.mobileBridgeUpdateWorkspaceRoots(roots).catch(() => {})
  }, [mobileWorkspaceRootKey])

  useEffect(() => {
    if (workspaces.length === 0) setShowNewWorkspacePanel(true)
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
      const liveSessionIds = new Set<string>()
      for (const session of sessions) {
        liveSessionIds.add(session.sessionId)
        if (session.running) {
          // Re-arm reporting if a sessionId is reused after a prior exit.
          reportedTerminalExitsRef.current.delete(session.sessionId)
          continue
        }
        if (
          typeof session.exitedAt !== 'number'
          || typeof session.workspaceId !== 'string'
        ) continue
        const lastReported = reportedTerminalExitsRef.current.get(session.sessionId)
        if (lastReported !== undefined && lastReported >= session.exitedAt) continue
        reportedTerminalExitsRef.current.set(session.sessionId, session.exitedAt)
        recordWorkspaceTerminalActivity(session.workspaceId, session.exitedAt)
      }
      for (const trackedId of reportedTerminalExitsRef.current.keys()) {
        if (!liveSessionIds.has(trackedId)) reportedTerminalExitsRef.current.delete(trackedId)
      }
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
  }, [recordWorkspaceTerminalActivity])

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
    const handle = window.setTimeout(() => handoffInputRef.current?.select(), 0)
    return () => window.clearTimeout(handle)
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
    if (!viewMenuOpen) return

    const onPointerDown = (event: PointerEvent) => {
      if (!viewMenuRef.current?.contains(event.target as Node)) {
        setViewMenuOpen(false)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewMenuOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [viewMenuOpen])

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

  const closeWorkspaceById = useCallback(
    (id: string) => {
      const workspace = workspaces.find((candidate) => candidate.id === id)
      if (workspace) terminateWorkspaceTerminals(workspace)
      removeWorkspace(id)
    },
    [workspaces, removeWorkspace]
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }

      const ctrl = event.ctrlKey || event.metaKey
      if (!ctrl) return

      const mac = window.api.platform === 'darwin'
      const macCycleLayoutTab = mac
        && event.metaKey
        && event.shiftKey
        && (event.code === 'BracketRight' || event.code === 'BracketLeft')
      if (event.key === 'Tab' || macCycleLayoutTab) {
        event.preventDefault()
        event.stopPropagation()
        const direction = event.key === 'Tab'
          ? (event.shiftKey ? -1 : 1)
          : (event.code === 'BracketLeft' ? -1 : 1)
        if (activeWorkspaceId) cycleActiveLayoutTab(activeWorkspaceId, direction)
        return
      }

      const macCycleWorkspace = mac
        && event.metaKey
        && event.altKey
        && !event.shiftKey
        && (event.code === 'ArrowRight' || event.code === 'ArrowLeft')
      if (event.code === 'Backquote' || macCycleWorkspace) {
        event.preventDefault()
        event.stopPropagation()
        const nextWorkspaceId = getNextWorkspaceId(
          workspaces,
          activeWorkspaceId,
          event.shiftKey || event.code === 'ArrowLeft' ? -1 : 1
        )
        if (nextWorkspaceId) {
          setShowNewWorkspacePanel(false)
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
        const specialistId = SPECIALIST_KEYBOARD_CODE_SHORTCUTS[event.code] ?? SPECIALIST_KEYBOARD_SHORTCUTS[key]
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
        openNewWorkspacePanel()
      }
      if (key === 'b') {
        event.preventDefault()
        setSidebarCollapsed(!sidebarCollapsed)
        return
      }
      if (key === 'w' && event.shiftKey && activeWorkspaceId) {
        event.preventDefault()
        closeWorkspaceById(activeWorkspaceId)
        return
      }
      if (key === 'w' && showNewWorkspacePanel) {
        event.preventDefault()
        if (workspaces.length > 0) setShowNewWorkspacePanel(false)
      } else if (key === 'w' && activeWorkspaceId) {
        event.preventDefault()
        closeActiveLayoutTab(activeWorkspaceId)
      }

      const n = parseInt(event.key)
      if (n >= 1 && n <= 9 && workspaces[n - 1]) {
        event.preventDefault()
        setShowNewWorkspacePanel(false)
        setActiveWorkspace(workspaces[n - 1].id)
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    workspaces,
    activeWorkspaceId,
    showNewWorkspacePanel,
    lastSelectedCli,
    removeWorkspace,
    setActiveWorkspace,
    setLastSelectedSpecialist,
    sidebarCollapsed,
    setSidebarCollapsed,
    closeWorkspaceById,
  ])

  useEffect(() => {
    return window.api.onAppMenuCommand((command) => {
      if (command === 'show-settings') {
        openSettings(false)
        return
      }
      if (command === 'show-about') {
        openSettings(false)
        return
      }
      if (command === 'check-for-updates') {
        openSettings(true)
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
        if (workspace?.mode === 'sprintengine' || workspace?.sprintEngineContext) {
          focusOrAddComponentTab(activeWorkspaceId, 'sprintengine-kanban', 'Kanban')
        }
      }
    })
  }, [activeWorkspaceId, openSettings, workspaces])

  const handleCreate = ({
    template,
    name,
    folderPath,
    sprintEngineState,
    sprintEngineContext,
    sprintEngineRoleCliDefaults,
    sprintEngineAutoState,
    mode,
  }: {
    template: LayoutTemplate
    name: string
    folderPath: string | null
    sprintEngineState?: Workspace['sprintEngineState']
    sprintEngineContext?: Workspace['sprintEngineContext']
    sprintEngineRoleCliDefaults?: Workspace['sprintEngineRoleCliDefaults'] | null
    sprintEngineAutoState?: Partial<Workspace['sprintEngineAutoState']> | null
    mode?: Workspace['mode']
  }) => {
    addWorkspace(template, { name, folderPath, sprintEngineState, sprintEngineContext, sprintEngineRoleCliDefaults, sprintEngineAutoState, mode })
    setShowNewWorkspacePanel(false)
    setNewWorkspacePanelInitialState(null)
  }

  const deleteWorkspaceWithState = useCallback(
    async (id: string) => {
      const workspace = workspaces.find((candidate) => candidate.id === id)
      if (!workspace) return
      terminateWorkspaceTerminals(workspace)
      const dirPath =
        workspace.mode === 'sprintengine'
          ? workspace.sprintEngineContext?.teamDirectoryPath ?? null
          : workspace.mode === 'multiloop'
            ? workspace.multiloopContext?.loopDirectoryPath ?? null
            : null
      if (dirPath) {
        try {
          await window.api.deletePath(dirPath)
        } catch (error) {
          publishDiagnosticSync({
            level: 'error',
            source: 'workspace',
            title: 'Delete workspace state failed',
            message: `Could not remove ${dirPath}.`,
            details: error instanceof Error ? error.message : String(error),
            workspaceId: workspace.id,
            workspaceName: workspace.name,
          })
        }
      }
      removeWorkspace(id)
    },
    [workspaces, removeWorkspace]
  )

  const handleForgetFolder = useCallback(
    (folderPath: string) => {
      const normalize = (value: string) =>
        value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
      const targetKey = normalize(folderPath)
      workspaces.forEach((workspace) => {
        if (workspace.folderPath && normalize(workspace.folderPath) === targetKey) {
          terminateWorkspaceTerminals(workspace)
        }
      })
      forgetFolder(folderPath)
    },
    [workspaces, forgetFolder]
  )

  const handleRevealFolder = useCallback((folderPath: string) => {
    void window.api.showItemInFolder(folderPath)
  }, [])

  const activityByWorkspaceId = useMemo(() => {
    const map: Record<string, 'running' | 'needs-input' | 'idle'> = {}
    for (const workspace of workspaces) {
      map[workspace.id] = getWorkspaceActivity(workspace, terminalSessions)
    }
    return map
  }, [workspaces, terminalSessions])

  const terminalRecencyByWorkspaceId = useMemo(() => {
    const map: Record<string, { hasRunning: boolean; lastFinishedAt: number | null }> = {}
    for (const workspace of workspaces) {
      let hasRunning = false
      let lastFinishedAt: number | null =
        typeof workspace.lastTerminalActivityAt === 'number' ? workspace.lastTerminalActivityAt : null
      for (const session of terminalSessions) {
        if (session.workspaceId !== workspace.id) continue
        if (session.running) {
          hasRunning = true
        } else if (typeof session.exitedAt === 'number') {
          if (lastFinishedAt === null || session.exitedAt > lastFinishedAt) {
            lastFinishedAt = session.exitedAt
          }
        }
      }
      map[workspace.id] = { hasRunning, lastFinishedAt }
    }
    return map
  }, [workspaces, terminalSessions])

  const addNewSpecialist = async (
    specialistId: SpecialistActionId = lastSelectedSpecialist,
    requestedName = ''
  ) => {
    if (showNewWorkspacePanel || !activeWorkspaceId) return
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
    const prompt = buildSpecialistSoulStartupPrompt(specialist)
    const cliForSpawn = specialistCliDefaults[specialist.id] ?? lastSelectedCli

    updateAgent(activeWorkspaceId, newId, {
      name: tabName,
      cli: cliForSpawn,
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
    role: MultiloopRole = lastSelectedMultiloopRole,
    requestedName = ''
  ) => {
    if (showNewWorkspacePanel || !activeWorkspaceId) return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    if (!activeWorkspace || activeWorkspace.mode !== 'multiloop') return

    const soul = getMultiloopRole(role)
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

    const prompt = await loadMultiloopPrompt(soul.role)
    const startupPrompt = buildMultiloopSpawnPrompt({
      soul,
      multiloopPrompt: prompt,
      workspace: activeWorkspace,
      agentId: newId,
    })
    const cliForSpawn = multiloopRoleCliDefaults[soul.role] ?? lastSelectedCli

    updateAgent(activeWorkspaceId, newId, {
      name: tabName,
      cli: cliForSpawn,
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
    if (showNewWorkspacePanel || !activeWorkspaceId) return
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
    if (showNewWorkspacePanel || !activeWorkspaceId) return
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
    focusOrAddComponentTab(activeWorkspaceId, 'memory-graph', 'Knowledge Graph')
    setSessionsOpen(false)
    setNotificationsOpen(false)
    setSpecialistMenuOpen(false)
    setAccountOpen(false)
  }

  const openHandoffDialog = () => {
    if (!activeWorkspace) return
    setHandoffTeamName(slugifySprintEngineName(activeWorkspace.name))
    setHandoffError(null)
    setSessionsOpen(false)
    setSpecialistMenuOpen(false)
    setHandoffOpen(true)
  }

  const confirmHandoff = async () => {
    if (!activeWorkspaceId || !activeWorkspace) return
    const teamSlug = slugifySprintEngineName(handoffTeamName)
    const target = getActiveCliSession(activeWorkspace, terminalSessions)
    if (!target) {
      setHandoffError('Open or focus a running CLI session before handing off.')
      return
    }

    const prompt = buildCurrentContextSprintEngineHandoffPrompt(teamSlug)
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

  const handleSelectMultiloopRole = (role: MultiloopRole) => {
    setLastSelectedMultiloopRole(role)
    setSpecialistMenuOpen(false)
    void addNewMultiloopAgent(role)
  }

  const startLogin = async () => {
    setSessionsOpen(false)
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    setAccountOpen(false)
    setAuthMessage('Opening sign-in.')

    try {
      await window.api.authLogin(authState.selectedOrganization?.id ?? null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setAuthMessage(message)
      setAuthState(await window.api.authGetState().catch(() => ({
        ...authState,
        status: 'error' as const,
        message,
      })))
      publishDiagnosticSync({
        level: 'error',
        source: 'auth',
        title: 'Sign-in did not open',
        message,
        details: 'Check that the Multiauth server is running and reachable from this desktop process.',
      })
      setNotificationsOpen(true)
    }
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

    setShowNewWorkspacePanel(false)
    setActiveWorkspace(item.workspace.id)
    setSessionsOpen(false)

    requestAnimationFrame(() => {
      const opened = item.agentId
        ? focusOrAddAgentTab(item.workspace.id, item.agentId, item.label)
        : item.terminalId
        ? focusOrAddTerminalTab(item.workspace.id, item.terminalId, item.label)
          : false
      if (opened) return
      window.setTimeout(() => {
        if (item.agentId) {
          focusOrAddAgentTab(item.workspace.id, item.agentId, item.label)
        } else if (item.terminalId) {
        focusOrAddTerminalTab(item.workspace.id, item.terminalId, item.label)
        }
      }, 0)
    })
  }

  const stopSession = (item: SessionItem) => {
    void window.api.terminalKill(item.sessionId).catch(() => {})
    setTerminalSessions((sessions) => sessions.filter((session) => session.sessionId !== item.sessionId))
    if (item.workspace.mode === 'sprintengine') setSprintEngineAutoEnabled(item.workspace.id, false)
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
        workspace.id === activeWorkspaceId && (workspace.mode === 'sprintengine' || workspace.sprintEngineContext)
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

      <div className="flex min-h-0 flex-1 flex-row">
      <WorkspaceSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        sidebarCollapsed={sidebarCollapsed}
        activityByWorkspaceId={activityByWorkspaceId}
        terminalRecencyByWorkspaceId={terminalRecencyByWorkspaceId}
        onSelectWorkspace={(id) => {
          setShowNewWorkspacePanel(false)
          setActiveWorkspace(id)
        }}
        onCloseWorkspace={closeWorkspaceById}
        onDeleteWorkspaceWithState={deleteWorkspaceWithState}
        onForgetFolder={handleForgetFolder}
        onNewWorkspace={openNewWorkspacePanel}
        onRevealFolder={handleRevealFolder}
        onSetSidebarCollapsed={setSidebarCollapsed}
      />
      <div className="flex min-w-0 flex-1 flex-col">
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1f2025] bg-[#0b0c0f] px-3 py-2 transition-colors"
        style={
          activeWorkspace?.highlight?.color
            ? (() => {
                const tint = getHighlightSwatch(activeWorkspace.highlight.color).ringRgba(0.05)
                return {
                  // Layer the tint over the topbar's #0b0c0f base via a flat
                  // gradient so we don't replace the bg color.
                  backgroundImage: `linear-gradient(${tint}, ${tint})`,
                  borderBottomColor: getHighlightSwatch(activeWorkspace.highlight.color).ringRgba(0.18),
                }
              })()
            : undefined
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {activeWorkspace ? (
            <>
              <span
                className={`shrink-0 ${activeWorkspace.highlight?.color ? '' : workspaceTabIconClass(activeWorkspace.mode)}`}
                style={{
                  color: activeWorkspace.highlight?.color
                    ? getHighlightSwatch(activeWorkspace.highlight.color).hex
                    : undefined,
                }}
              >
                <WorkspaceTypeIcon
                  mode={activeWorkspace.mode}
                  className="h-3.5 w-3.5"
                />
              </span>
              {activeWorkspace.highlight?.starred ? (
                <svg
                  className="h-3 w-3 shrink-0 text-[#ffbf2f] drop-shadow-[0_0_4px_rgba(255,191,47,0.6)]"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-label="Starred workspace"
                >
                  <title>Starred workspace</title>
                  <path d="M8 1.5L9.95 5.7L14.5 6.3L11.2 9.55L12 14.1L8 11.95L4 14.1L4.8 9.55L1.5 6.3L6.05 5.7L8 1.5Z" />
                </svg>
              ) : null}
              <span className="min-w-0 truncate text-[13px] font-semibold text-[#ececee]">
                {activeWorkspace.name}
              </span>
              {activeWorkspace.folderPath ? (
                <span className="hidden min-w-0 truncate text-[12px] text-[#5a5a63] md:inline">
                  · {activeWorkspace.folderPath}
                </span>
              ) : null}
            </>
          ) : null}
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
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-[#0b0c0f] bg-[#30d158] px-1 text-[10px] font-bold leading-none text-[#08090b]">
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

          {workspaceActionsEnabled && activeWorkspace && (activeWorkspace.mode === 'sprintengine' || activeWorkspace.mode === 'multiloop') ? (
            <div ref={viewMenuRef} className="relative inline-flex">
              <button
                type="button"
                onClick={() => {
                  setViewMenuOpen((open) => !open)
                  setViewMenuTick((tick) => tick + 1)
                  setSessionsOpen(false)
                  setSpecialistMenuOpen(false)
                  setNotificationsOpen(false)
                  setAccountOpen(false)
                }}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 transition-colors ${
                  viewMenuOpen
                    ? 'border-[#303139] bg-[#17181d] text-[#ececee]'
                    : 'border-[#24252b] bg-[#111216] text-[#9a9aa2] hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc]'
                }`}
                title={`${VIEWS_FOR_MODE[activeWorkspace.mode]?.label ?? 'View'} panels`}
                aria-label="Toggle workspace panels"
                aria-haspopup="menu"
                aria-expanded={viewMenuOpen}
              >
                <svg className="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="2" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="9" y="2" width="5" height="6" rx="1" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="9" y="10" width="5" height="4" rx="1" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                <span className="text-[12px] font-semibold">{VIEWS_FOR_MODE[activeWorkspace.mode]?.label ?? 'View'}</span>
                <svg className={`h-3 w-3 transition-transform ${viewMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {viewMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-9 z-40 w-60 overflow-hidden rounded-md border border-[rgba(255,255,255,0.06)] bg-[#0d0e11] p-1"
                >
                  <div className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5a5a63]">
                    {VIEWS_FOR_MODE[activeWorkspace.mode]?.label ?? 'View'} Panels
                  </div>
                  {(VIEWS_FOR_MODE[activeWorkspace.mode]?.views ?? []).map((view) => {
                    void viewMenuTick
                    const checked = hasComponentTab(activeWorkspace.id, view.component)
                    return (
                      <button
                        key={view.component}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={checked}
                        onClick={() => {
                          toggleComponentTab(activeWorkspace.id, view.component, view.name)
                          setViewMenuTick((tick) => tick + 1)
                        }}
                        className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left text-[13px] text-[#d7d7dc] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            checked
                              ? 'border-[#5c7cff] bg-[#5c7cff] text-[#08090b]'
                              : 'border-[#3a3d49] bg-transparent text-transparent'
                          }`}
                          aria-hidden="true"
                        >
                          <svg className="h-3 w-3" viewBox="0 0 20 20" fill="none">
                            <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <span className="min-w-0 flex-1 truncate">{view.name}</span>
                      </button>
                    )
                  })}
                </div>
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
              title="Knowledge Graph"
              aria-label="Knowledge Graph"
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
              title={`Open terminal (${shortcutLabel("Ctrl+Shift+'")})`}
              aria-label="Open terminal"
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
                <path d="M7.25 10L10 12.5L7.25 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12.5 15H16.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}

          {workspaceActionsEnabled ? (() => {
            const triggerCli: AgentCli = multiloopLaunchMenu
              ? (multiloopRoleCliDefaults[selectedMultiloopRoleDescriptor.role] ?? lastSelectedCli)
              : (specialistCliDefaults[selectedSpecialistAction.id] ?? lastSelectedCli)
            const triggerCliOption =
              AGENT_SPAWN_CLI_OPTIONS.find((option) => option.value === triggerCli)
              ?? AGENT_SPAWN_CLI_OPTIONS[0]
            const menuQuery = agentMenuQuery.trim().toLowerCase()
            const filteredSpecialists = menuQuery
              ? SPECIALIST_ACTIONS.filter((action) =>
                  action.label.toLowerCase().includes(menuQuery)
                  || action.shortLabel.toLowerCase().includes(menuQuery)
                  || action.description.toLowerCase().includes(menuQuery)
                )
              : SPECIALIST_ACTIONS
            const filteredMultiloop = menuQuery
              ? MULTILOOP_ROLES.filter((soul) =>
                  soul.label.toLowerCase().includes(menuQuery)
                  || soul.shortLabel.toLowerCase().includes(menuQuery)
                )
              : MULTILOOP_ROLES
            const visibleItems = multiloopLaunchMenu ? filteredMultiloop : filteredSpecialists
            const safeHighlight = visibleItems.length === 0
              ? 0
              : Math.min(agentMenuHighlight, visibleItems.length - 1)
            const cycleCli = (current: AgentCli): AgentCli => {
              const index = AGENT_SPAWN_CLI_OPTIONS.findIndex((option) => option.value === current)
              const next = AGENT_SPAWN_CLI_OPTIONS[(index + 1) % AGENT_SPAWN_CLI_OPTIONS.length]
              return next?.value ?? current
            }
            const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setAgentMenuHighlight((index) =>
                  visibleItems.length === 0 ? 0 : Math.min(index + 1, visibleItems.length - 1)
                )
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setAgentMenuHighlight((index) => Math.max(index - 1, 0))
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const item = visibleItems[safeHighlight]
                if (!item) return
                if (multiloopLaunchMenu) {
                  handleSelectMultiloopRole((item as MultiloopRoleDescriptor).role)
                } else {
                  handleSelectSpecialist((item as SpecialistAction).id)
                }
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                if (chipPopoverForRole) {
                  setChipPopoverForRole(null)
                } else {
                  setSpecialistMenuOpen(false)
                }
                return
              }
              if ((event.altKey || event.metaKey) && (event.key === 'm' || event.key === 'M')) {
                event.preventDefault()
                const item = visibleItems[safeHighlight]
                if (!item) return
                if (multiloopLaunchMenu) {
                  const role = (item as MultiloopRoleDescriptor).role
                  const next = cycleCli(multiloopRoleCliDefaults[role] ?? lastSelectedCli)
                  setMultiloopRoleCliDefault(role, next)
                } else {
                  const id = (item as SpecialistAction).id
                  const next = cycleCli(specialistCliDefaults[id] ?? lastSelectedCli)
                  setSpecialistCliDefault(id, next)
                }
                return
              }
              if (event.shiftKey && event.key === 'Backspace') {
                event.preventDefault()
                const item = visibleItems[safeHighlight]
                if (!item) return
                if (multiloopLaunchMenu) {
                  setMultiloopRoleCliDefault((item as MultiloopRoleDescriptor).role, null)
                } else {
                  setSpecialistCliDefault((item as SpecialistAction).id, null)
                }
                return
              }
            }
            return (
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
                      ? `Spawn Multiloop ${selectedMultiloopRoleDescriptor.label} with ${triggerCliOption.label}, ${selectedAgentPermissionOption.label}`
                      : `Spawn ${selectedSpecialistAction.label} specialist with ${triggerCliOption.label}, ${selectedAgentPermissionOption.label}${selectedSpecialistAction.shortcut ? ` (${shortcutLabel(selectedSpecialistAction.shortcut)})` : ''}`
                  }
                  aria-label={
                    multiloopLaunchMenu
                      ? `Spawn Multiloop ${selectedMultiloopRoleDescriptor.label}`
                      : `Spawn ${selectedSpecialistAction.label} specialist`
                  }
                >
                  <SpecialistActionIcon
                    icon={multiloopLaunchMenu ? selectedMultiloopRoleDescriptor.icon : selectedSpecialistAction.icon}
                    className="h-[18px] w-[18px]"
                  />
                </button>
                <span
                  className="inline-flex h-8 items-center border-l border-[#4b4d55] px-1.5 text-[#b8ccff]"
                  aria-hidden="true"
                  title={`Default CLI: ${triggerCliOption.label}`}
                >
                  <CliIcon cli={triggerCli} className="h-3.5 w-3.5" />
                </span>
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
                  className="absolute right-0 top-9 z-40 w-[320px] overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
                >
                  <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-2">
                    <svg className="h-3.5 w-3.5 shrink-0 text-[#5a5a63]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.6" />
                      <path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    <input
                      ref={agentMenuSearchRef}
                      value={agentMenuQuery}
                      onChange={(event) => {
                        setAgentMenuQuery(event.currentTarget.value)
                        setAgentMenuHighlight(0)
                      }}
                      onKeyDown={onSearchKeyDown}
                      placeholder={multiloopLaunchMenu ? 'Spawn role…' : 'Spawn agent…'}
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-[#ececee] placeholder:text-[#5a5a63] focus:outline-none"
                      aria-label="Filter agents"
                    />
                  </div>

                  {visibleItems.length === 0 ? (
                    <div className="px-3 py-5 text-center text-[11px] text-[#5a5a63]">
                      No matches
                    </div>
                  ) : (
                    <div className="max-h-[340px] overflow-y-auto py-1">
                      {multiloopLaunchMenu
                        ? filteredMultiloop.map((soul, index) => {
                            const highlighted = index === safeHighlight
                            const boundCli = multiloopRoleCliDefaults[soul.role] ?? lastSelectedCli
                            const popoverOpen =
                              chipPopoverForRole?.kind === 'multiloop'
                              && chipPopoverForRole.role === soul.role
                            const hasOverride = multiloopRoleCliDefaults[soul.role] !== undefined
                            return (
                              <div key={soul.role} className="relative">
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={highlighted}
                                  onClick={() => handleSelectMultiloopRole(soul.role)}
                                  onMouseEnter={() => setAgentMenuHighlight(index)}
                                  className={`grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pr-2 text-left transition-colors ${
                                    highlighted
                                      ? 'bg-[#111b30] pl-[7px] shadow-[inset_3px_0_0_#5c7cff] text-[#ececee]'
                                      : 'pl-2.5 text-[#d7d7dc] hover:bg-[rgba(92,124,255,0.05)]'
                                  }`}
                                >
                                  <SpecialistActionIcon
                                    icon={soul.icon}
                                    className={`h-4 w-4 ${highlighted ? 'text-[#b8ccff]' : 'text-[#9a9aa2]'}`}
                                  />
                                  <span className="truncate text-[13px]">{soul.label}</span>
                                  <span
                                    role="button"
                                    tabIndex={-1}
                                    aria-label={`Default CLI: ${boundCli === 'codex' ? 'Codex' : 'Claude Code'}`}
                                    title={hasOverride
                                      ? `Pinned to ${boundCli === 'codex' ? 'Codex' : 'Claude Code'} · click to change · ⇧⌫ to unpin`
                                      : `Using last-used (${boundCli === 'codex' ? 'Codex' : 'Claude Code'}) · click to pin`}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setAgentMenuHighlight(index)
                                      setChipPopoverForRole((current) =>
                                        current?.kind === 'multiloop' && current.role === soul.role
                                          ? null
                                          : { kind: 'multiloop', role: soul.role }
                                      )
                                    }}
                                    className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors ${
                                      hasOverride
                                        ? highlighted
                                          ? 'bg-[#1a2540] text-[#b8ccff]'
                                          : 'bg-[#111b30]/60 text-[#b8ccff]'
                                        : highlighted
                                          ? 'text-[#7d8aa8] hover:text-[#b8ccff]'
                                          : 'text-[#5a5a63] hover:text-[#b8ccff]'
                                    }`}
                                  >
                                    <CliIcon cli={boundCli} className="h-3.5 w-3.5" />
                                  </span>
                                </button>
                                {popoverOpen ? (
                                  <div
                                    role="listbox"
                                    aria-label={`Default CLI for ${soul.label}`}
                                    className="absolute right-2 top-[32px] z-50 w-[180px] overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                                  >
                                    {AGENT_SPAWN_CLI_OPTIONS.map((option) => {
                                      const isCurrent = option.value === boundCli
                                      return (
                                        <button
                                          key={option.value}
                                          type="button"
                                          role="option"
                                          aria-selected={isCurrent}
                                          onClick={() => {
                                            setMultiloopRoleCliDefault(soul.role, option.value)
                                            setChipPopoverForRole(null)
                                          }}
                                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
                                            isCurrent
                                              ? 'bg-[#1a2540] text-[#b8ccff]'
                                              : 'text-[#c7c7ce] hover:bg-[rgba(92,124,255,0.06)] hover:text-[#ececee]'
                                          }`}
                                        >
                                          <CliIcon cli={option.value} className="h-3.5 w-3.5" />
                                          {option.label}
                                          {isCurrent ? <span className="ml-auto text-[#5c7cff]">✓</span> : null}
                                        </button>
                                      )
                                    })}
                                    {hasOverride ? (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setMultiloopRoleCliDefault(soul.role, null)
                                          setChipPopoverForRole(null)
                                        }}
                                        className="mt-0.5 flex w-full items-center gap-2 border-t border-white/[0.06] px-2 py-1.5 text-left text-[11px] text-[#8a8a92] transition-colors hover:text-[#ececee]"
                                      >
                                        Unpin
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })
                        : filteredSpecialists.map((action, index) => {
                            const highlighted = index === safeHighlight
                            const boundCli = specialistCliDefaults[action.id] ?? lastSelectedCli
                            const popoverOpen =
                              chipPopoverForRole?.kind === 'specialist'
                              && chipPopoverForRole.id === action.id
                            const hasOverride = specialistCliDefaults[action.id] !== undefined
                            return (
                              <div key={action.id} className="relative">
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={highlighted}
                                  onClick={() => handleSelectSpecialist(action.id)}
                                  onMouseEnter={() => setAgentMenuHighlight(index)}
                                  className={`grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 py-1.5 pr-2 text-left transition-colors ${
                                    highlighted
                                      ? 'bg-[#111b30] pl-[7px] shadow-[inset_3px_0_0_#5c7cff] text-[#ececee]'
                                      : 'pl-2.5 text-[#d7d7dc] hover:bg-[rgba(92,124,255,0.05)]'
                                  }`}
                                >
                                  <SpecialistActionIcon
                                    icon={action.icon}
                                    className={`h-4 w-4 ${highlighted ? 'text-[#b8ccff]' : 'text-[#9a9aa2]'}`}
                                  />
                                  <span className="truncate text-[13px]">{action.shortLabel}</span>
                                  <span
                                    role="button"
                                    tabIndex={-1}
                                    aria-label={`Default CLI: ${boundCli === 'codex' ? 'Codex' : 'Claude Code'}`}
                                    title={hasOverride
                                      ? `Pinned to ${boundCli === 'codex' ? 'Codex' : 'Claude Code'} · click to change · ⇧⌫ to unpin`
                                      : `Using last-used (${boundCli === 'codex' ? 'Codex' : 'Claude Code'}) · click to pin`}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setAgentMenuHighlight(index)
                                      setChipPopoverForRole((current) =>
                                        current?.kind === 'specialist' && current.id === action.id
                                          ? null
                                          : { kind: 'specialist', id: action.id }
                                      )
                                    }}
                                    className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors ${
                                      hasOverride
                                        ? highlighted
                                          ? 'bg-[#1a2540] text-[#b8ccff]'
                                          : 'bg-[#111b30]/60 text-[#b8ccff]'
                                        : highlighted
                                          ? 'text-[#7d8aa8] hover:text-[#b8ccff]'
                                          : 'text-[#5a5a63] hover:text-[#b8ccff]'
                                    }`}
                                  >
                                    <CliIcon cli={boundCli} className="h-3.5 w-3.5" />
                                  </span>
                                </button>
                                {popoverOpen ? (
                                  <div
                                    role="listbox"
                                    aria-label={`Default CLI for ${action.label}`}
                                    className="absolute right-2 top-[32px] z-50 w-[180px] overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
                                  >
                                    {AGENT_SPAWN_CLI_OPTIONS.map((option) => {
                                      const isCurrent = option.value === boundCli
                                      return (
                                        <button
                                          key={option.value}
                                          type="button"
                                          role="option"
                                          aria-selected={isCurrent}
                                          onClick={() => {
                                            setSpecialistCliDefault(action.id, option.value)
                                            setChipPopoverForRole(null)
                                          }}
                                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
                                            isCurrent
                                              ? 'bg-[#1a2540] text-[#b8ccff]'
                                              : 'text-[#c7c7ce] hover:bg-[rgba(92,124,255,0.06)] hover:text-[#ececee]'
                                          }`}
                                        >
                                          <CliIcon cli={option.value} className="h-3.5 w-3.5" />
                                          {option.label}
                                          {isCurrent ? <span className="ml-auto text-[#5c7cff]">✓</span> : null}
                                        </button>
                                      )
                                    })}
                                    {hasOverride ? (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSpecialistCliDefault(action.id, null)
                                          setChipPopoverForRole(null)
                                        }}
                                        className="mt-0.5 flex w-full items-center gap-2 border-t border-white/[0.06] px-2 py-1.5 text-left text-[11px] text-[#8a8a92] transition-colors hover:text-[#ececee]"
                                      >
                                        Unpin
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          addNewCliAgent(lastSelectedCli, 'General Agent')
                          setSpecialistMenuOpen(false)
                        }}
                        className="mt-1 grid w-full grid-cols-[20px_1fr_auto] items-center gap-2.5 border-t border-white/[0.06] py-1.5 pl-2.5 pr-2 text-left text-[#9a9aa2] transition-colors hover:bg-[rgba(92,124,255,0.05)] hover:text-[#ececee]"
                      >
                        <CliIcon cli={lastSelectedCli} className="h-4 w-4" />
                        <span className="truncate text-[13px]">General Agent</span>
                        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[#5a5a63]">
                          <CliIcon cli={lastSelectedCli} className="h-3.5 w-3.5" />
                        </span>
                      </button>
                    </div>
                  )}

                  <div className="flex items-center gap-1 border-t border-white/[0.06] px-2 py-1.5">
                    {AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => {
                      const active = option.value === agentSpawnPermissionPreset
                      const isBypass = option.value === 'bypass_all'
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setAgentSpawnPermissionPreset(option.value)}
                          title={option.title}
                          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                            active
                              ? isBypass
                                ? 'bg-[#ffbf2f]/12 text-[#ffe0a3]'
                                : 'bg-[#111b30] text-[#b8ccff]'
                              : 'text-[#5a5a63] hover:text-[#9a9aa2]'
                          }`}
                        >
                          {option.value === 'default' ? 'Default' : option.value === 'auto_workspace' ? 'Auto' : 'Bypass'}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </div>
            )
          })() : null}

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
                onUpgrade={() => void window.api.authOpenUpgrade('sprintengine')}
              />
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => openSettings(false)}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
              settingsOpen
                ? 'border-[#303139] bg-[#17181d] text-[#ececee]'
                : 'border-[#24252b] bg-[#111216] text-[#9a9aa2] hover:border-[#303139] hover:bg-[#17181d] hover:text-[#d7d7dc]'
            }`}
            title={`Settings (${shortcutLabel('Ctrl+,')})`}
            aria-label="Settings"
            aria-pressed={settingsOpen}
          >
            <GearIcon className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {showSettings ? (
          <SettingsPanel
            checkForUpdatesOnOpen={checkForUpdatesOnSettingsOpen}
            initialTab={initialSettingsTab}
            onOpenSettingsTab={(tabId) => openSettings(false, tabId)}
            onClose={() => {
              setShowSettings(false)
              setCheckForUpdatesOnSettingsOpen(false)
              setInitialSettingsTab(null)
              if (workspaces.length === 0) setShowNewWorkspacePanel(true)
            }}
          />
        ) : showNewWorkspacePanel ? (
          <NewWorkspacePanel
            onCreate={handleCreate}
            onClose={() => {
              setShowNewWorkspacePanel(false)
              setNewWorkspacePanelInitialState(null)
            }}
            allowClose={workspaces.length > 0}
            initialState={newWorkspacePanelInitialState}
          />
        ) : (
          <>
            {workspaces.length === 0 && <EmptyState onNew={openNewWorkspacePanel} />}
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
      </div>
      </div>

      <Modal
        open={handoffOpen}
        onClose={() => setHandoffOpen(false)}
        labelledBy="handoff-title"
        width={420}
      >
        <ModalHeader
          title="Handoff to SprintEngine"
          titleId="handoff-title"
          onClose={() => setHandoffOpen(false)}
        />
        <ModalBody className="space-y-3">
          <Field label="Team name">
            <input
              ref={handoffInputRef}
              value={handoffTeamName}
              onChange={(event) => {
                setHandoffTeamName(event.target.value)
                setHandoffError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void confirmHandoff()
              }}
              autoFocus
              className="h-9 w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-[13px] text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#ffbf2f]/70"
              placeholder="sprintengine-improvements"
            />
          </Field>
          {handoffError ? (
            <div className="border-l-2 border-[#ff787c] pl-3 text-[12px] leading-5 text-[#ffb3b5]">
              {handoffError}
            </div>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <ModalButton onClick={() => setHandoffOpen(false)}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            accent="gold"
            onClick={() => void confirmHandoff()}
            disabled={!handoffTeamName.trim()}
            className="inline-flex items-center gap-2"
          >
            <WorkspaceTypeIcon mode="sprintengine" className="h-4 w-4" />
            Handoff
          </ModalButton>
        </ModalFooter>
      </Modal>

      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNewWorkspace={openNewWorkspacePanel}
          onSpawnSpecialist={handleSelectSpecialist}
        />
      )}

      <TipStartupModal
        open={tipModalOpen}
        context={learningContext}
        onClose={() => setTipModalOpen(false)}
        onOpenLearnCenter={() => {
          setTipModalOpen(false)
          openLearnCenter()
        }}
        onSettingsTab={(tabId) => {
          setTipModalOpen(false)
          openSettings(false, tabId)
        }}
      />
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
      className="absolute right-0 top-9 z-40 w-[440px] overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
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
                        : 'bg-[#5c7cff]'
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
      className="absolute right-0 top-9 z-40 w-[420px] overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
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
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[#24252b] bg-[#111216] text-[#8a8a92]"
                        style={item.role ? {
                          borderColor: sprintEngineRoleAccent[item.role],
                          color: sprintEngineRoleAccent[item.role],
                          backgroundColor: `${sprintEngineRoleAccent[item.role]}14`,
                        } : undefined}
                      >
                        {item.role ? (
                          <SprintEngineRoleIcon role={item.role} className="h-[17px] w-[17px]" />
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
                        {item.kind === 'terminal' ? item.label.toLowerCase() : item.taskId ?? item.cli}
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
      <path
        d="M19.95 11.3c0-4.05-3.1-6.95-7.35-6.95-3.55 0-6.25 1.82-6.85 4.62-1.4.76-2.15 2.08-2.15 3.62 0 2.45 1.92 4.32 4.62 4.32h1.88c.92 0 1.66.74 1.66 1.66v1.1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19.95 11.3c0 1.42-.62 2.65-1.76 3.45-.72.5-1.08 1.08-1.08 1.82v.92"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.38 9.35c.5-1.28 1.72-2 3.02-1.78M10.4 7.57c.7-1.04 2.18-1.48 3.38-.85M13.78 6.72c1.32-.3 2.72.42 3.28 1.62"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.1 12.18c.7-1.1 2.18-1.42 3.28-.7M9.38 11.48c.66-.9 2.02-1.12 3-.48M12.38 11c.84-.92 2.38-.9 3.35.04"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.22 14.68c1.08-.48 2.48-.18 3.18.7M10.4 15.38c.84-.62 2.08-.52 2.82.26M13.22 15.64c.8-.62 1.98-.58 2.68.08"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
    if (agent?.kind === 'sprintengine') state.setSprintEngineAutoEnabled(workspaceId, false)
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
      className="absolute right-0 top-9 z-40 w-72 overflow-hidden rounded-md border border-[#303139] bg-[#0d0e11] p-3 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
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

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9.25 4.25L9.9 2.9h4.2l.65 1.35a1.8 1.8 0 0 0 2.2.92l1.43-.48 2.1 3.64-1.12 1a1.8 1.8 0 0 0 0 2.68l1.12 1-2.1 3.64-1.43-.48a1.8 1.8 0 0 0-2.2.92l-.65 1.35H9.9l-.65-1.35a1.8 1.8 0 0 0-2.2-.92l-1.43.48-2.1-3.64 1.12-1a1.8 1.8 0 0 0 0-2.68l-1.12-1 2.1-3.64 1.43.48a1.8 1.8 0 0 0 2.2-.92Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11.67" r="3" stroke="currentColor" strokeWidth="1.65" />
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
        ? 'Knowledge Graph'
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
