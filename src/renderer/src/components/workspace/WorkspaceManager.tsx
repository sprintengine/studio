import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, DockLocation, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import { WorkspaceTypeIcon } from '../AppIcons'
import CommandPalette from '../CommandPalette'
import { TipStartupModal } from '../learn/TipStartupModal'
import SettingsOverlay from '../settings/SettingsOverlay'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  deriveWorkspaceLastOutputAt,
  deriveWorkspaceTerminalActivity,
  findLiveSession,
} from '../../hooks/useTerminalSessions'
import { useAppTheme } from '../../hooks/useAppTheme'
import {
  MULTILOOP_ROLES,
  SPECIALIST_ACTIONS,
  getMultiloopRole,
  getSpecialistAction,
  buildSpecialistSoulStartupPrompt,
  loadMultiloopPrompt,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
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
import { addAgentTabTiled, focusComponentTab, focusOrAddAgentTab, focusOrAddComponentTab, focusOrAddTerminalTab, getModel } from '../../utils/modelRegistry'
import { MULTICODE_DISABLE_SPRINTENGINE_SYNC } from '../../utils/runtimeFlags'
import { buildCurrentContextSprintEngineHandoffPrompt } from '../../utils/sprintengineHandoff'
import { slugifySprintEngineName } from '../../utils/sprintengineStateFile'
import { agentCliSupportsConversationResume } from '../../utils/agentCliResume'
import { Field, Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import NewWorkspacePanel, { type NewWorkspacePanelInitialState } from './NewWorkspacePanel'
import SprintEngineAutoRunSupervisor from './SprintEngineAutoRunSupervisor'
import MultiloopAutoRunSupervisor from './MultiloopAutoRunSupervisor'
import MultiloopStateSynchronizer from './MultiloopStateSynchronizer'
import SprintEngineStateSynchronizer from './SprintEngineStateSynchronizer'
import WorkspaceLayout from './WorkspaceLayout'
import WorkspaceSidebar from './WorkspaceSidebar'
import { WindowControls } from './WindowControls'
import WorkspaceTopBar, {
  AGENT_SPAWN_PERMISSION_OPTIONS,
  type ChipPopoverForRole,
  type SessionItem,
} from './WorkspaceTopBar'
import {
  buildMultiloopSpawnPrompt,
  buildSidebarWorkspaceOrder,
  getSessionItems,
  getTerminalSessionsSignature,
  getWorkspaceActivity,
  hasActiveProPlan,
  uniqueAgentName,
  type WorkspaceActivity,
} from './workspaceManagerHelpers'

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const
const EMPTY_SPECIALIST_CLI_DEFAULTS: Partial<Record<SpecialistActionId, AgentCli>> = {}
const EMPTY_MULTILOOP_ROLE_CLI_DEFAULTS: Partial<Record<MultiloopRole, AgentCli>> = {}
const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}

const TERMINAL_SESSION_RECOVERY_POLL_MS = 30_000
const WORKSPACE_LAYOUT_IDLE_UNLOAD_MS = 5 * 60_000
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

type WorkspacePanelComponent = 'explorer' | 'editor' | 'git' | 'memory-graph'


export default function WorkspaceManager() {
  useAppTheme()
  const dialog = useConfirmDialog()
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const sidebarCollapsed = useWorkspaceStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useWorkspaceStore((s) => s.setSidebarCollapsed)
  const settingsOverlayOpen = useWorkspaceStore((s) => s.settingsOverlay.open)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const closeSettingsOverlay = useWorkspaceStore((s) => s.closeSettingsOverlay)
  const forgetFolder = useWorkspaceStore((s) => s.forgetFolder)
  const recordWorkspaceTerminalActivity = useWorkspaceStore((s) => s.recordWorkspaceTerminalActivity)
  const reconcileWorkspaceAgentLaunchFlags = useWorkspaceStore((s) => s.reconcileWorkspaceAgentLaunchFlags)
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
  const [tipModalOpen, setTipModalOpen] = useState(false)
  const tipModalDecidedRef = useRef(false)
  const showTipsOnStartup = useWorkspaceStore((s) => s.appSettings.learning?.showTipsOnStartup ?? true)
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? EMPTY_PROJECT_KNOWLEDGE_ROOTS)
  const [showPalette, setShowPalette] = useState(false)
  const [specialistMenuOpen, setSpecialistMenuOpen] = useState(false)
  const [agentMenuQuery, setAgentMenuQuery] = useState('')
  const [agentMenuHighlight, setAgentMenuHighlight] = useState(0)
  const [chipPopoverForRole, setChipPopoverForRole] = useState<ChipPopoverForRole>(null)
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
  const reportedTerminalLastOutputRef = useRef<Map<string, number>>(new Map())
  const reconciledLaunchFlagsRef = useRef(false)
  const workspaceLayoutUnloadTimersRef = useRef<Record<string, number>>({})
  const workspaceActionsEnabled = activeWorkspace && !showNewWorkspacePanel
  const sessions = getSessionItems(workspaces, terminalSessions)
  const sidebarWorkspaceOrder = useMemo(
    () => buildSidebarWorkspaceOrder(workspaces),
    [workspaces]
  )
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length
  const settingsOpen = settingsOverlayOpen
  const renderedWorkspaceIds = workspaces
    .map((workspace) => workspace.id)
    .filter((workspaceId) => workspaceId === activeWorkspaceId || mountedWorkspaceIds.includes(workspaceId))

  const openNewWorkspacePanel = () => {
    setNewWorkspacePanelInitialState(null)
    setShowNewWorkspacePanel(true)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    setHandoffOpen(false)
  }

  const openNewWorkspacePanelForFolder = useCallback((folderPath: string) => {
    setNewWorkspacePanelInitialState({ folderPath })
    setShowNewWorkspacePanel(true)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    setHandoffOpen(false)
  }, [closeSettingsOverlay])

  const openSettings = useCallback((checkForUpdates = false, targetTab: string | null = null) => {
    openSettingsOverlay({ initialTab: targetTab, checkForUpdates })
    setShowNewWorkspacePanel(false)
    setSpecialistMenuOpen(false)
    setSessionsOpen(false)
    setViewMenuOpen(false)
    setNotificationsOpen(false)
    setAccountOpen(false)
    setHandoffOpen(false)
  }, [openSettingsOverlay])

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
    closeSettingsOverlay()
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

      const lastOutputByWorkspace = new Map<string, number>()
      for (const session of sessions) {
        if (typeof session.workspaceId !== 'string') continue
        if (typeof session.lastOutputAt !== 'number') continue
        const current = lastOutputByWorkspace.get(session.workspaceId)
        if (current === undefined || session.lastOutputAt > current) {
          lastOutputByWorkspace.set(session.workspaceId, session.lastOutputAt)
        }
      }
      for (const [workspaceId, lastOutputAt] of lastOutputByWorkspace) {
        const lastReported = reportedTerminalLastOutputRef.current.get(workspaceId)
        if (lastReported !== undefined && lastReported >= lastOutputAt) continue
        reportedTerminalLastOutputRef.current.set(workspaceId, lastOutputAt)
        recordWorkspaceTerminalActivity(workspaceId, lastOutputAt)
      }

      if (!reconciledLaunchFlagsRef.current) {
        reconciledLaunchFlagsRef.current = true
        reconcileWorkspaceAgentLaunchFlags(sessions)
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
  }, [recordWorkspaceTerminalActivity, reconcileWorkspaceAgentLaunchFlags])

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
        closeActiveLayoutTab(activeWorkspaceId, terminalSessions)
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
    terminalSessions,
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
      } else if (command === 'open-sprintengine-tasks') {
        const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId)
        if (workspace?.mode === 'sprintengine' || workspace?.sprintEngineContext) {
          focusComponentTab(activeWorkspaceId, 'sprintengine')
          window.dispatchEvent(
            new CustomEvent('multicode:panel-command', { detail: { id: 'sprintengine.goto.tasks' } })
          )
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
    const map: Record<string, WorkspaceActivity> = {}
    for (const workspace of workspaces) {
      map[workspace.id] = getWorkspaceActivity(workspace, terminalSessions)
    }
    return map
  }, [workspaces, terminalSessions])

  const terminalRecencyByWorkspaceId = useMemo(() => {
    const map: Record<string, { hasRunning: boolean; lastFinishedAt: number | null }> = {}
    for (const workspace of workspaces) {
      const persistedLastOutputAt = typeof workspace.lastTerminalActivityAt === 'number'
        ? workspace.lastTerminalActivityAt
        : null
      const activity = deriveWorkspaceTerminalActivity(workspace.id, terminalSessions, persistedLastOutputAt)
      const hasRunning = activity.kind === 'working' || activity.kind === 'failed'
      const lastFinishedAt = deriveWorkspaceLastOutputAt(workspace.id, terminalSessions, persistedLastOutputAt)
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
    if (!(model.getActiveTabset() ?? firstTabset(model))) return
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
    addAgentTabTiled(activeWorkspaceId, newId, tabName)
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
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

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
    addAgentTabTiled(activeWorkspaceId, newId, tabName)
  }

  const addNewCliAgent = (cli: AgentCli, label: string) => {
    if (showNewWorkspacePanel || !activeWorkspaceId) return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    const tabName = uniqueAgentName(label, activeWorkspace?.agents ?? {})
    const newId = `agent-${cli}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

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
    addAgentTabTiled(activeWorkspaceId, newId, tabName)
    setSpecialistMenuOpen(false)
  }

  const addNewTerminal = () => {
    if (showNewWorkspacePanel || !activeWorkspaceId) return
    const model = getModel(activeWorkspaceId)
    if (!model) return

    const newId = `terminal-${nanoid(6)}`
    const terminalTab = {
      type: 'tab',
      name: 'Terminal',
      component: 'terminal',
      config: { terminalId: newId },
    }

    if (activeWorkspace?.mode === 'sprintengine') {
      // The SE board's tabset has no visible tab strip, so terminals must
      // land in a sibling tabset. Prefer (1) an existing terminal tabset so
      // multiple terminals stack together, (2) the first non-SE tabset
      // (typically agents on the right), (3) a new tabset docked to the
      // right of the workspace root if no right pane exists yet.
      const existingTerminalTabset = firstTerminalTabset(model)
      const sprintEngineNeighborTabset =
        existingTerminalTabset ?? firstNonSprintEngineBoardTabset(model)

      if (sprintEngineNeighborTabset) {
        model.doAction(
          Actions.addNode(terminalTab, sprintEngineNeighborTabset.getId(), DockLocation.CENTER, -1, true)
        )
        return
      }

      model.doAction(
        Actions.addNode(terminalTab, model.getRoot().getId(), DockLocation.RIGHT, -1, true)
      )
      return
    }

    const targetTabset = model.getActiveTabset() ?? firstTabset(model)
    if (!targetTabset) return

    model.doAction(
      Actions.addNode(terminalTab, targetTabset.getId(), DockLocation.CENTER, -1, true)
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
    const organizationId = await dialog.prompt({
      title: 'Switch organization',
      inputLabel: 'Organization ID',
      placeholder: 'org_…',
      required: true,
      confirmLabel: 'Switch',
    })
    const trimmed = organizationId?.trim()
    if (!trimmed) return
    await window.api.authSelectOrganization(trimmed)
    setAuthState(await window.api.authRefreshEntitlements())
  }

  const openSession = async (item: SessionItem) => {
    const status = await window.api.terminalStatus(item.sessionId)
    if (!status.processAlive) {
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
        cliResumeAvailable: agentCliSupportsConversationResume(item.cli) ? true : undefined,
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
    <div className="flex h-screen flex-col overflow-hidden bg-[color:var(--bg-app)] text-[color:var(--text-strong)]">
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
          className="app-drag flex h-[34px] shrink-0 items-stretch justify-between border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
        >
          <div className="flex min-w-0 items-center gap-1 px-2">
            {MENU_BAR_ITEMS.map((label) => (
              <button
                key={label}
                onClick={(event) => void handleShowMenubarMenu(event, label)}
                className="app-no-drag inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
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
        onNewWorkspaceInFolder={openNewWorkspacePanelForFolder}
        onRevealFolder={handleRevealFolder}
        onSetSidebarCollapsed={setSidebarCollapsed}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[10px] rounded-bl-[10px] bg-[color:var(--bg-surface)] shadow-[inset_1px_0_0_rgba(255,255,255,0.04)]">
      <WorkspaceTopBar
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        activeWorkspaceId={activeWorkspaceId}
        workspaceActionsEnabled={workspaceActionsEnabled}
        sessionsRef={sessionsRef}
        viewMenuRef={viewMenuRef}
        notificationsRef={notificationsRef}
        specialistMenuRef={specialistMenuRef}
        accountRef={accountRef}
        agentMenuSearchRef={agentMenuSearchRef}
        sessions={sessions}
        sidebarWorkspaceOrder={sidebarWorkspaceOrder}
        sessionsOpen={sessionsOpen}
        setSessionsOpen={setSessionsOpen}
        openSession={openSession}
        stopSession={stopSession}
        viewMenuOpen={viewMenuOpen}
        setViewMenuOpen={setViewMenuOpen}
        viewMenuTick={viewMenuTick}
        setViewMenuTick={setViewMenuTick}
        notifications={notifications}
        unreadNotificationCount={unreadNotificationCount}
        notificationsOpen={notificationsOpen}
        setNotificationsOpen={setNotificationsOpen}
        markNotificationRead={markNotificationRead}
        markAllNotificationsRead={markAllNotificationsRead}
        clearNotifications={clearNotifications}
        specialistMenuOpen={specialistMenuOpen}
        setSpecialistMenuOpen={setSpecialistMenuOpen}
        agentMenuQuery={agentMenuQuery}
        setAgentMenuQuery={setAgentMenuQuery}
        agentMenuHighlight={agentMenuHighlight}
        setAgentMenuHighlight={setAgentMenuHighlight}
        chipPopoverForRole={chipPopoverForRole}
        setChipPopoverForRole={setChipPopoverForRole}
        multiloopLaunchMenu={multiloopLaunchMenu}
        selectedSpecialistAction={selectedSpecialistAction}
        selectedMultiloopRoleDescriptor={selectedMultiloopRoleDescriptor}
        selectedAgentPermissionOption={selectedAgentPermissionOption}
        lastSelectedCli={lastSelectedCli}
        specialistCliDefaults={specialistCliDefaults}
        multiloopRoleCliDefaults={multiloopRoleCliDefaults}
        setSpecialistCliDefault={setSpecialistCliDefault}
        setMultiloopRoleCliDefault={setMultiloopRoleCliDefault}
        agentSpawnPermissionPreset={agentSpawnPermissionPreset}
        setAgentSpawnPermissionPreset={setAgentSpawnPermissionPreset}
        handleSelectSpecialist={handleSelectSpecialist}
        handleSelectMultiloopRole={handleSelectMultiloopRole}
        addNewSpecialist={addNewSpecialist}
        addNewMultiloopAgent={addNewMultiloopAgent}
        addNewCliAgent={addNewCliAgent}
        addNewTerminal={addNewTerminal}
        openMemoryGraph={openMemoryGraph}
        openHandoffDialog={openHandoffDialog}
        openSettings={openSettings}
        settingsOpen={settingsOpen}
        accountOpen={accountOpen}
        setAccountOpen={setAccountOpen}
        authState={authState}
        authMessage={authMessage}
        proAccount={proAccount}
        startLogin={startLogin}
        refreshAuthState={refreshAuthState}
        logout={logout}
        switchOrganization={switchOrganization}
      />

      <div className="relative min-h-0 flex-1">
        <div
          className="absolute inset-0"
          aria-hidden={settingsOverlayOpen || undefined}
          {...(settingsOverlayOpen ? ({ inert: '' } as Record<string, string>) : {})}
        >
          {showNewWorkspacePanel ? (
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
        <SettingsOverlay />
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
              className="h-9 w-full rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-3 text-[13px] text-[color:var(--text-strong)] outline-none transition-colors placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--tone-warn)]/70"
              placeholder="sprintengine-improvements"
            />
          </Field>
          {handoffError ? (
            <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
              {handoffError}
            </div>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <ModalButton onClick={() => setHandoffOpen(false)}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => void confirmHandoff()}
            disabled={!handoffTeamName.trim()}
            className="inline-flex items-center gap-2"
          >
            <WorkspaceTypeIcon mode="sprintengine" className="icon-md" />
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

function killTerminalForLayoutTab(
  workspaceId: string,
  node: TabNode,
  terminalSessions: TerminalSessionSnapshot[],
): void {
  const state = useWorkspaceStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!workspace) return

  const config = node.getConfig() as { agentId?: string; sessionId?: string; terminalId?: string } | undefined
  if (node.getComponent() === 'agent') {
    const agentId = config?.agentId ?? node.getId()
    const agent = workspace.agents[agentId]
    const sessionIds = new Set<string>()
    if (config?.sessionId) sessionIds.add(config.sessionId)
    if (agent?.cliSessionId) sessionIds.add(agent.cliSessionId)
    terminalSessions
      .filter((session) =>
        session.kind === 'agent'
        && session.workspaceId === workspaceId
        && session.agentId === agentId
      )
      .forEach((session) => sessionIds.add(session.sessionId))
    sessionIds.forEach((sessionId) => {
      void window.api.terminalKill(sessionId).catch(() => {})
    })
    if (agent?.kind === 'sprintengine') state.setSprintEngineAutoEnabled(workspaceId, false)
    state.updateAgent(workspaceId, agentId, {
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
      cliSessionId: undefined,
    })
    return
  }

  if (node.getComponent() === 'terminal') {
    const terminalId = config?.terminalId ?? node.getId()
    const sessionIds = new Set<string>([`terminal-${terminalId}`])
    terminalSessions
      .filter((session) =>
        session.kind === 'terminal'
        && session.workspaceId === workspaceId
        && session.terminalId === terminalId
      )
      .forEach((session) => sessionIds.add(session.sessionId))
    sessionIds.forEach((sessionId) => {
      void window.api.terminalKill(sessionId).catch(() => {})
    })
  }
}

function closeActiveLayoutTab(
  workspaceId: string,
  terminalSessions: TerminalSessionSnapshot[],
): boolean {
  const model = getModel(workspaceId)
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  if (!model || !tabset) return false

  const selectedIndex = tabset.getSelected()
  const selectedNode = tabset.getChildren()[selectedIndex]
  if (!(selectedNode instanceof TabNode) || !selectedNode.isEnableClose()) return false

  killTerminalForLayoutTab(workspaceId, selectedNode, terminalSessions)
  model.doAction(Actions.deleteTab(selectedNode.getId()))
  return true
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

function firstTerminalTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (!(node instanceof TabNode) || node.getComponent() !== 'terminal') return
    const parent = node.getParent()
    if (parent instanceof TabSetNode) found = parent
  })
  return found
}

function firstNonSprintEngineBoardTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (!(node instanceof TabSetNode)) return
    const hostsSprintEngineBoard = node.getChildren().some((child) =>
      child instanceof TabNode && child.getComponent() === 'sprintengine'
    )
    if (!hostsSprintEngineBoard) found = node
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
  return findLiveSession(terminalSessions, predicate)
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
        <p className="text-sm text-[color:var(--text-disabled)]">No workspace open</p>
        <button
          onClick={onNew}
          className="rounded bg-[color:var(--bg-surface-raised)] px-4 py-2 text-sm font-medium text-[color:var(--text-strong)] transition-colors hover:bg-[color:var(--bg-hover)]"
        >
          New Workspace
        </button>
      </div>
    </div>
  )
}
