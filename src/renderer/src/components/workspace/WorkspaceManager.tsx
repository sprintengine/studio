import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import CommandPalette from '../CommandPalette'
import { TipStartupModal } from '../learn/TipStartupModal'
import OnboardingFlow from '../onboarding/OnboardingFlow'
import SettingsOverlay from '../settings/SettingsOverlay'
import { SuspenseFallback } from '../ui/SuspenseFallback'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { normalizeSelectedCli } from '../../store/slices/settingsSlice'
import { selectModuleEnabled } from '../../modules'
import {
  deriveWorkspaceLastOutputAt,
  deriveWorkspaceTerminalActivity,
} from '../../hooks/useTerminalSessions'
import { useAppTheme } from '../../hooks/useAppTheme'
import { useVoiceDictation } from '../../hooks/useVoiceDictation'
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
  WorkspaceWindowId,
} from '../../types/workspace'
import { pickRandomAgentName } from '../../utils/agentNames'
import { normalizeAgentIdentifier, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { disableSprintEngineAutoRun } from '../../utils/sprintengineSupervisorNotifications'
import { addAgentTabTiled, addTerminalTab, focusOrAddAgentTab, focusOrAddTerminalTab, getModel, togglePanelRailComponent } from '../../utils/modelRegistry'
import { MULTICODE_DISABLE_SPRINTENGINE_SYNC } from '../../utils/runtimeFlags'
import { agentCliSupportsConversationResume } from '../../utils/agentCliResume'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { type NewWorkspacePanelInitialState } from './NewWorkspacePanel'
import SprintEngineAutoRunSupervisor from './SprintEngineAutoRunSupervisor'
import MultiloopAutoRunSupervisor from './MultiloopAutoRunSupervisor'
import MultiloopStateSynchronizer from './MultiloopStateSynchronizer'
import SprintEngineStateSynchronizer from './SprintEngineStateSynchronizer'
import WorkspaceLayout from './WorkspaceLayout'
import WorkspaceSidebar from './WorkspaceSidebar'
import { beginSidebarTransition } from '../../utils/sidebarTransition'
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

// Lazy so the (large) new-workspace wizard — and everything it pulls in
// (GuidedBriefFlow, the markdown renderer) — is code-split out of the eager boot
// chunk and only fetched when the user opens "new workspace". Rendered only when
// showNewWorkspacePanel is true.
const NewWorkspacePanel = React.lazy(() => import('./NewWorkspacePanel'))

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const
const EMPTY_SPECIALIST_CLI_DEFAULTS: Partial<Record<SpecialistActionId, AgentCli>> = {}
const EMPTY_MULTILOOP_ROLE_CLI_DEFAULTS: Partial<Record<MultiloopRole, AgentCli>> = {}
const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}

const TERMINAL_SESSION_RECOVERY_POLL_MS = 30_000
const WORKSPACE_LAYOUT_IDLE_UNLOAD_MS = 5 * 60_000
const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'
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


export default function WorkspaceManager() {
  useAppTheme()
  const dialog = useConfirmDialog()
  const workspaceWindowId = useMemo(() => getWorkspaceWindowIdFromLocation(), [])
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const workspaceWindows = useWorkspaceStore((s) => s.workspaceWindows)
  const primaryWorkspaceWindowId = useWorkspaceStore((s) => s.primaryWorkspaceWindowId)
  const multiloopEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'multiloop'))
  const sprintEngineEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'sprint-engine'))
  const voiceDictationEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'voice-dictation'))
  const voiceDictation = useVoiceDictation()
  const onboardingStep = useWorkspaceStore((s) => s.appSettings.onboardingStep)
  const setOnboardingStep = useWorkspaceStore((s) => s.setOnboardingStep)
  const setActiveWorkspaceForWindow = useWorkspaceStore((s) => s.setActiveWorkspaceForWindow)
  const registerWorkspaceWindow = useWorkspaceStore((s) => s.registerWorkspaceWindow)
  const updateWorkspaceWindowPlacement = useWorkspaceStore((s) => s.updateWorkspaceWindowPlacement)
  const closeWorkspaceWindow = useWorkspaceStore((s) => s.closeWorkspaceWindow)
  const moveWorkspaceToWindow = useWorkspaceStore((s) => s.moveWorkspaceToWindow)
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
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const lastSelectedCli = useWorkspaceStore((s) => normalizeSelectedCli(s.appSettings.lastSelectedCli))
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

  const currentWorkspaceWindow = useMemo(
    () => workspaceWindows.find((windowState) => windowState.id === workspaceWindowId)
      ?? workspaceWindows.find((windowState) => windowState.id === primaryWorkspaceWindowId)
      ?? null,
    [primaryWorkspaceWindowId, workspaceWindowId, workspaceWindows]
  )
  const isPrimaryWorkspaceWindow = workspaceWindowId === (primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID)
  const visibleWorkspaceIdSet = useMemo(
    () => new Set(currentWorkspaceWindow?.workspaceIds ?? workspaces.map((workspace) => workspace.id)),
    [currentWorkspaceWindow, workspaces]
  )
  const visibleWorkspaces = useMemo(
    () => workspaces.filter((workspace) => visibleWorkspaceIdSet.has(workspace.id)),
    [visibleWorkspaceIdSet, workspaces]
  )
  const windowActiveWorkspaceId =
    currentWorkspaceWindow?.activeWorkspaceId && visibleWorkspaceIdSet.has(currentWorkspaceWindow.activeWorkspaceId)
      ? currentWorkspaceWindow.activeWorkspaceId
      : visibleWorkspaces[0]?.id ?? null
  const activeWorkspace = visibleWorkspaces.find((workspace) => workspace.id === windowActiveWorkspaceId) ?? null
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
  const terminalSessionsSignatureRef = useRef('')
  const reportedTerminalLastOutputRef = useRef<Map<string, number>>(new Map())
  const reconciledLaunchFlagsRef = useRef(false)
  const workspaceLayoutUnloadTimersRef = useRef<Record<string, number>>({})
  const collapsedStaleDetachedWindowsRef = useRef(false)
  const workspaceActionsEnabled = activeWorkspace && !showNewWorkspacePanel
  const sessions = getSessionItems(visibleWorkspaces, terminalSessions)
  const sidebarWorkspaceOrder = useMemo(
    () => buildSidebarWorkspaceOrder(visibleWorkspaces),
    [visibleWorkspaces]
  )
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length
  const settingsOpen = settingsOverlayOpen
  const ownsGlobalSupervisors = isPrimaryWorkspaceWindow
  const renderedWorkspaceIds = visibleWorkspaces
    .map((workspace) => workspace.id)
    .filter((workspaceId) => workspaceId === windowActiveWorkspaceId || mountedWorkspaceIds.includes(workspaceId))

  const openNewWorkspacePanel = () => {
    setNewWorkspacePanelInitialState(null)
    setShowNewWorkspacePanel(true)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
  }

  const openNewWorkspacePanelForFolder = useCallback((folderPath: string) => {
    setNewWorkspacePanelInitialState({ folderPath })
    setShowNewWorkspacePanel(true)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
  }, [closeSettingsOverlay])

  const openSettings = useCallback((checkForUpdates = false, targetTab: string | null = null) => {
    openSettingsOverlay({ initialTab: targetTab, checkForUpdates })
    setShowNewWorkspacePanel(false)
    setSpecialistMenuOpen(false)
    setSessionsOpen(false)
    setViewMenuOpen(false)
    setNotificationsOpen(false)
    setAccountOpen(false)
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

  useEffect(() => {
    registerWorkspaceWindow(
      workspaceWindowId,
      isPrimaryWorkspaceWindow ? 'primary' : 'detached'
    )
  }, [isPrimaryWorkspaceWindow, registerWorkspaceWindow, workspaceWindowId])

  useEffect(() => {
    if (collapsedStaleDetachedWindowsRef.current) return
    collapsedStaleDetachedWindowsRef.current = true
    if (!isPrimaryWorkspaceWindow) return
    const restoreDetachedWindows = async () => {
      const persistedDetachedWindows = useWorkspaceStore
      .getState()
      .workspaceWindows
      .filter((windowState) => windowState.id !== (primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID))
      for (const windowState of persistedDetachedWindows) {
        let restored = false
        try {
          const result = await window.api.createWorkspaceWindow({
            windowId: windowState.id,
            workspaceId: windowState.activeWorkspaceId,
            bounds: windowState.bounds,
            isMaximized: windowState.isMaximized,
          })
          restored = result.ok
        } catch {
          restored = false
        }
        if (!restored) {
          closeWorkspaceWindow(windowState.id, primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID)
        }
      }
    }
    void restoreDetachedWindows()
  }, [closeWorkspaceWindow, isPrimaryWorkspaceWindow, primaryWorkspaceWindowId])

  useEffect(() => {
    void window.api.getWindowPlacement().then((placement) => {
      if (!placement) return
      updateWorkspaceWindowPlacement(workspaceWindowId, placement)
    }).catch(() => {})

    return window.api.onWindowPlacementChanged((placement) => {
      updateWorkspaceWindowPlacement(workspaceWindowId, placement)
    })
  }, [updateWorkspaceWindowPlacement, workspaceWindowId])

  useEffect(() => {
    if (isPrimaryWorkspaceWindow) return
    const onBeforeUnload = () => {
      closeWorkspaceWindow(workspaceWindowId, primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [closeWorkspaceWindow, isPrimaryWorkspaceWindow, primaryWorkspaceWindowId, workspaceWindowId])

  useEffect(() => {
    const windowName = activeWorkspace?.name?.trim()
    const projectName = activeWorkspace?.folderPath ? folderName(activeWorkspace.folderPath) : null
    document.title = [windowName, projectName, 'Multicode'].filter(Boolean).join(' - ')
  }, [activeWorkspace?.folderPath, activeWorkspace?.name])

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
    const workspaceIds = new Set(visibleWorkspaces.map((workspace) => workspace.id))

    setMountedWorkspaceIds((current) => {
      const next = current.filter((workspaceId) => workspaceIds.has(workspaceId))
      if (windowActiveWorkspaceId && workspaceIds.has(windowActiveWorkspaceId) && !next.includes(windowActiveWorkspaceId)) {
        next.push(windowActiveWorkspaceId)
      }
      return next.length === current.length && next.every((workspaceId, index) => workspaceId === current[index])
        ? current
        : next
    })

    Object.keys(workspaceLayoutUnloadTimersRef.current).forEach((workspaceId) => {
      if (!workspaceIds.has(workspaceId) || workspaceId === windowActiveWorkspaceId) {
        clearWorkspaceLayoutUnloadTimer(workspaceId)
      }
    })
  }, [visibleWorkspaces, windowActiveWorkspaceId])

  useEffect(() => {
    const workspaceIds = new Set(visibleWorkspaces.map((workspace) => workspace.id))

    mountedWorkspaceIds.forEach((workspaceId) => {
      if (workspaceId === windowActiveWorkspaceId || !workspaceIds.has(workspaceId)) {
        clearWorkspaceLayoutUnloadTimer(workspaceId)
        return
      }
      if (workspaceLayoutUnloadTimersRef.current[workspaceId] !== undefined) return

      workspaceLayoutUnloadTimersRef.current[workspaceId] = window.setTimeout(() => {
        delete workspaceLayoutUnloadTimersRef.current[workspaceId]
        setMountedWorkspaceIds((current) => {
          const state = useWorkspaceStore.getState()
          const currentWindow = state.workspaceWindows.find((windowState) => windowState.id === workspaceWindowId)
          if (currentWindow?.activeWorkspaceId === workspaceId) return current
          return current.filter((id) => id !== workspaceId)
        })
      }, WORKSPACE_LAYOUT_IDLE_UNLOAD_MS)
    })
  }, [mountedWorkspaceIds, visibleWorkspaces, windowActiveWorkspaceId, workspaceWindowId])

  useEffect(() => () => {
    Object.values(workspaceLayoutUnloadTimersRef.current).forEach((timer) => window.clearTimeout(timer))
    workspaceLayoutUnloadTimersRef.current = {}
  }, [])

  useEffect(() => {
    const roots = mobileWorkspaceRootKey.split('\n').filter(Boolean)
    void window.api.mobileBridgeUpdateWorkspaceRoots(roots).catch(() => {})
  }, [mobileWorkspaceRootKey])

  useEffect(() => {
    // Auto-open the new-workspace panel when there are no workspaces — but during
    // onboarding hold off until the flow reaches its workspace step, so the panel
    // doesn't pop behind the welcome/modules overlay.
    if (visibleWorkspaces.length === 0 && (onboardingStep === 'workspace' || onboardingStep === 'complete')) {
      setShowNewWorkspacePanel(true)
    }
  }, [visibleWorkspaces.length, onboardingStep])

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
  }, [windowActiveWorkspaceId])

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

      // Cmd/Ctrl+Shift+1 toggles voice transcription. Handled before the
      // text-field guard below so it still works while typing in the agent
      // prompt (the whole point of dictation). Keyed off event.code so it's
      // layout-independent (Shift turns event.key into '!'), which also keeps it
      // clear of the Cmd/Ctrl+1-9 workspace switches further down.
      if (
        voiceDictationEnabled
        && (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && event.code === 'Digit1'
      ) {
        event.preventDefault()
        event.stopPropagation()
        voiceDictation.toggle()
        return
      }

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
        if (windowActiveWorkspaceId) cycleActiveLayoutTab(windowActiveWorkspaceId, direction)
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
          visibleWorkspaces,
          windowActiveWorkspaceId,
          event.shiftKey || event.code === 'ArrowLeft' ? -1 : 1
        )
        if (nextWorkspaceId) {
          setShowNewWorkspacePanel(false)
          setActiveWorkspaceForWindow(workspaceWindowId, nextWorkspaceId)
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
        beginSidebarTransition()
        setSidebarCollapsed(!sidebarCollapsed)
        return
      }
      if (key === 'w' && event.shiftKey && windowActiveWorkspaceId) {
        event.preventDefault()
        closeWorkspaceById(windowActiveWorkspaceId)
        return
      }
      if (key === 'w' && showNewWorkspacePanel) {
        event.preventDefault()
        if (visibleWorkspaces.length > 0) setShowNewWorkspacePanel(false)
      } else if (key === 'w' && windowActiveWorkspaceId) {
        event.preventDefault()
        closeActiveLayoutTab(windowActiveWorkspaceId, terminalSessions)
      }

      const n = parseInt(event.key)
      if (n >= 1 && n <= 9 && visibleWorkspaces[n - 1]) {
        event.preventDefault()
        setShowNewWorkspacePanel(false)
        setActiveWorkspaceForWindow(workspaceWindowId, visibleWorkspaces[n - 1].id)
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    visibleWorkspaces,
    windowActiveWorkspaceId,
    workspaceWindowId,
    showNewWorkspacePanel,
    lastSelectedCli,
    removeWorkspace,
    setActiveWorkspaceForWindow,
    setLastSelectedSpecialist,
    sidebarCollapsed,
    setSidebarCollapsed,
    closeWorkspaceById,
    terminalSessions,
    voiceDictationEnabled,
    voiceDictation,
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
      if (!windowActiveWorkspaceId) return
      if (command === 'toggle-explorer') {
        togglePanelRailComponent(windowActiveWorkspaceId, 'explorer', 'Files')
      } else if (command === 'toggle-editor') {
        togglePanelRailComponent(windowActiveWorkspaceId, 'editor', 'Editor')
      } else if (command === 'toggle-git') {
        togglePanelRailComponent(windowActiveWorkspaceId, 'git', 'Git')
      }
    })
  }, [openSettings, windowActiveWorkspaceId])

  const handleCreate = ({
    template,
    name,
    folderPath,
    sprintEngineState,
    sprintEngineContext,
    sprintEngineRoleCliDefaults,
    sprintEngineAgentCliOverrides,
    sprintEngineAutoState,
    guidedBriefState,
    mode,
  }: {
    template: LayoutTemplate
    name: string
    folderPath: string | null
    sprintEngineState?: Workspace['sprintEngineState']
    sprintEngineContext?: Workspace['sprintEngineContext']
    sprintEngineRoleCliDefaults?: Workspace['sprintEngineRoleCliDefaults'] | null
    sprintEngineAgentCliOverrides?: Record<string, AgentCli> | null
    sprintEngineAutoState?: Partial<Workspace['sprintEngineAutoState']> | null
    guidedBriefState?: Workspace['guidedBriefState'] | null
    mode?: Workspace['mode']
  }) => {
    addWorkspace(template, { name, folderPath, sprintEngineState, sprintEngineContext, sprintEngineRoleCliDefaults, sprintEngineAgentCliOverrides, sprintEngineAutoState, guidedBriefState, mode, windowId: workspaceWindowId })
    setShowNewWorkspacePanel(false)
    setNewWorkspacePanelInitialState(null)
    // Creating the first workspace ends onboarding — jump straight to 'complete'
    // (not a single advance) so it's correct regardless of the current step.
    if (onboardingStep !== 'complete') setOnboardingStep('complete')
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

  const moveWorkspaceToNewWindow = useCallback(
    async (workspaceId: string, placement?: { screenX: number; screenY: number }) => {
      const targetWindowId = `workspace-${workspaceId}-${nanoid(6)}`
      registerWorkspaceWindow(targetWindowId, 'detached')
      moveWorkspaceToWindow(workspaceId, targetWindowId, workspaceWindowId)
      let result: Awaited<ReturnType<typeof window.api.createWorkspaceWindow>>
      try {
        result = await window.api.createWorkspaceWindow({
          windowId: targetWindowId,
          workspaceId,
          bounds: placement ? workspaceWindowBoundsForDrop(placement, currentWorkspaceWindow?.bounds) : undefined,
        })
      } catch (error) {
        result = {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }
      }
      if (!result.ok) {
        moveWorkspaceToWindow(workspaceId, workspaceWindowId, targetWindowId)
        publishDiagnosticSync({
          level: 'error',
          source: 'workspace',
          title: 'Move to new window failed',
          message: result.message,
          workspaceId,
        })
        setNotificationsOpen(true)
      }
    },
    [currentWorkspaceWindow?.bounds, moveWorkspaceToWindow, registerWorkspaceWindow, workspaceWindowId]
  )

  const moveWorkspaceToPrimaryWindow = useCallback(
    (workspaceId: string) => {
      const primaryWindowId = primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID
      moveWorkspaceToWindow(workspaceId, primaryWindowId, workspaceWindowId)
      if (!isPrimaryWorkspaceWindow && visibleWorkspaces.length <= 1) {
        void window.api.windowClose()
      }
    },
    [isPrimaryWorkspaceWindow, moveWorkspaceToWindow, primaryWorkspaceWindowId, visibleWorkspaces.length, workspaceWindowId]
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
    requestedName = '',
    selectedCli?: AgentCli
  ) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    const specialist = getSpecialistAction(specialistId)
    const agentName = normalizeAgentIdentifier(requestedName)
    const tabName = agentName || pickRandomAgentName(
      Object.values(activeWorkspace?.agents ?? {}).map((agent) => agent.name)
    )
    const newId = `specialist-${specialist.id}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return
    const prompt = buildSpecialistSoulStartupPrompt(specialist)
    const cliForSpawn = normalizeSelectedCli(selectedCli ?? specialistCliDefaults[specialist.id], lastSelectedCli)

    updateAgent(windowActiveWorkspaceId, newId, {
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
    addAgentTabTiled(windowActiveWorkspaceId, newId, tabName)
  }

  const addNewMultiloopAgent = async (
    role: MultiloopRole = lastSelectedMultiloopRole,
    requestedName = '',
    selectedCli?: AgentCli
  ) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    if (!multiloopEnabled || !activeWorkspace || activeWorkspace.mode !== 'multiloop') return

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
          workspaceId: windowActiveWorkspaceId,
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
    const cliForSpawn = normalizeSelectedCli(selectedCli ?? multiloopRoleCliDefaults[soul.role], lastSelectedCli)

    updateAgent(windowActiveWorkspaceId, newId, {
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
    addAgentTabTiled(windowActiveWorkspaceId, newId, tabName)
  }

  const addNewCliAgent = (cli: AgentCli, label: string) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    const tabName = uniqueAgentName(label, activeWorkspace?.agents ?? {})
    const newId = `agent-${cli}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

    updateAgent(windowActiveWorkspaceId, newId, {
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
    addAgentTabTiled(windowActiveWorkspaceId, newId, tabName)
    setSpecialistMenuOpen(false)
  }

  const addNewTerminal = () => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const newId = `terminal-${nanoid(6)}`
    addTerminalTab(windowActiveWorkspaceId, newId, 'Terminal')
  }

  const handleSelectSpecialist = (specialistId: SpecialistActionId, selectedCli?: AgentCli) => {
    setLastSelectedSpecialist(specialistId)
    setSpecialistMenuOpen(false)
    void addNewSpecialist(specialistId, '', selectedCli)
  }

  const handleSelectMultiloopRole = (role: MultiloopRole, selectedCli?: AgentCli) => {
    setLastSelectedMultiloopRole(role)
    setSpecialistMenuOpen(false)
    void addNewMultiloopAgent(role, '', selectedCli)
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
    setActiveWorkspaceForWindow(workspaceWindowId, item.workspace.id)
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
    if (item.workspace.mode === 'sprintengine') {
      disableSprintEngineAutoRun(item.workspace.id, 'agent_terminal_closed', {
        ...(item.agentId ? { agentId: item.agentId } : {}),
      })
    }
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
      {sprintEngineEnabled && ownsGlobalSupervisors ? <SprintEngineAutoRunSupervisor /> : null}
      {multiloopEnabled && ownsGlobalSupervisors ? <MultiloopAutoRunSupervisor /> : null}
      {multiloopEnabled && visibleWorkspaces.map((workspace) => (
        workspace.id === windowActiveWorkspaceId && (workspace.mode === 'multiloop' || workspace.multiloopContext)
          ? <MultiloopStateSynchronizer key={workspace.id} workspaceId={workspace.id} />
          : null
      ))}
      {sprintEngineEnabled && !MULTICODE_DISABLE_SPRINTENGINE_SYNC && visibleWorkspaces.map((workspace) => (
        workspace.id === windowActiveWorkspaceId && (workspace.mode === 'sprintengine' || workspace.sprintEngineContext)
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
        workspaces={visibleWorkspaces}
        activeWorkspaceId={windowActiveWorkspaceId}
        workspaceWindowId={workspaceWindowId}
        isDetachedWindow={!isPrimaryWorkspaceWindow}
        sidebarCollapsed={sidebarCollapsed}
        activityByWorkspaceId={activityByWorkspaceId}
        terminalRecencyByWorkspaceId={terminalRecencyByWorkspaceId}
        onSelectWorkspace={(id) => {
          setShowNewWorkspacePanel(false)
          setActiveWorkspaceForWindow(workspaceWindowId, id)
        }}
        onMoveWorkspaceToNewWindow={(id, placement) => void moveWorkspaceToNewWindow(id, placement)}
        onMoveWorkspaceToMainWindow={moveWorkspaceToPrimaryWindow}
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
        workspaces={visibleWorkspaces}
        activeWorkspace={activeWorkspace}
        activeWorkspaceId={windowActiveWorkspaceId}
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
        voiceDictationEnabled={voiceDictationEnabled}
        voiceRecording={voiceDictation.recording}
        voiceTranscribing={voiceDictation.transcribing}
        toggleVoiceDictation={voiceDictation.toggle}
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
        addNewSpecialist={(cli) => addNewSpecialist(lastSelectedSpecialist, '', cli)}
        addNewMultiloopAgent={(cli) => addNewMultiloopAgent(lastSelectedMultiloopRole, '', cli)}
        addNewCliAgent={addNewCliAgent}
        addNewTerminal={addNewTerminal}
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
            <React.Suspense fallback={<SuspenseFallback label="Loading workspace setup" />}>
              <NewWorkspacePanel
                onCreate={handleCreate}
                onClose={() => {
                  setShowNewWorkspacePanel(false)
                  setNewWorkspacePanelInitialState(null)
                }}
                workspaceWindowId={workspaceWindowId}
                allowClose={visibleWorkspaces.length > 0}
                initialState={newWorkspacePanelInitialState}
              />
            </React.Suspense>
          ) : (
            <>
              {visibleWorkspaces.length === 0 && <EmptyState onNew={openNewWorkspacePanel} />}
              {renderedWorkspaceIds.map((workspaceId) => {
                const active = workspaceId === windowActiveWorkspaceId
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
        <OnboardingFlow />
      </div>
      </div>
      </div>

      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNewWorkspace={openNewWorkspacePanel}
          onSpawnSpecialist={handleSelectSpecialist}
          workspaceWindowId={workspaceWindowId}
          workspaces={visibleWorkspaces}
          activeWorkspaceId={windowActiveWorkspaceId}
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

function getWorkspaceWindowIdFromLocation(): WorkspaceWindowId {
  try {
    const value = new URL(window.location.href).searchParams.get('windowId')?.trim()
    return value || PRIMARY_WORKSPACE_WINDOW_ID
  } catch {
    return PRIMARY_WORKSPACE_WINDOW_ID
  }
}

function folderName(folderPath: string): string {
  const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/u, '')
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(slash + 1) || normalized : normalized
}

function workspaceWindowBoundsForDrop(
  placement: { screenX: number; screenY: number },
  currentBounds: { width: number; height: number } | null | undefined
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(800, Math.round(currentBounds?.width ?? 1400))
  const height = Math.max(600, Math.round(currentBounds?.height ?? 900))
  return {
    x: Math.round(placement.screenX - width / 2),
    y: Math.round(placement.screenY - 24),
    width,
    height,
  }
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
    if (agent?.kind === 'sprintengine') {
      disableSprintEngineAutoRun(workspaceId, 'agent_terminal_closed', { agentId })
    }
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
