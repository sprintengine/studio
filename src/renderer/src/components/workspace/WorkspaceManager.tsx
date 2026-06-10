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
import type { SoloChatSeed } from '../../store/slices/workspacesSlice'
import { normalizeSelectedCli } from '../../store/slices/settingsSlice'
import { resolveAvailableAgentCli, resolveCliModel, resolveTemplateAgentCli, selectAgentCliCatalog } from './newWorkspace/cliRuntimeOptions'
import { subscribePluginCatalogRefreshOnFocus } from '../../store/slices/pluginsSlice'
import { getRendererHost, selectModuleEnabled } from '../../modules'
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
  orderSpecialistActions,
  buildSpecialistSoulStartupPrompt,
  loadMultiloopPrompt,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
  AgentCliModelSelection,
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
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { applySprintEngineAutomationStopReason } from '../../utils/sprintengineSupervisorNotifications'
import { addAgentTabTiled, addTerminalTab, focusOrAddAgentTab, focusOrAddTerminalTab, getModel, jsonModelHasComponent, revealNavRailComponent, togglePanelRailComponent } from '../../utils/modelRegistry'
import { MULTICODE_DISABLE_SPRINTENGINE_SYNC } from '../../utils/runtimeFlags'
import { agentCliSupportsConversationResume } from '../../utils/agentCliResume'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { type NewWorkspacePanelInitialState } from './NewWorkspacePanel'
import MultiloopStateSynchronizer from './MultiloopStateSynchronizer'
import SprintEngineProjectionSupervisor from './SprintEngineProjectionSupervisor'
import WorkspaceLayout from './WorkspaceLayout'
import WorkspaceSidebar from './WorkspaceSidebar'
import { beginSidebarTransition } from '../../utils/sidebarTransition'
import { WORKSPACE_LAYER_REVEAL_EVENT } from '../../utils/terminalFitScheduler'
import { AppTitleBar } from './AppTitleBar'
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
import {
  EMPTY_WORKSPACE_NAVIGATION_HISTORY,
  recordWorkspaceVisit,
  stepWorkspaceHistory,
  type WorkspaceNavigationHistory,
} from '../../utils/workspaceNavigationHistory'
import {
  buildConversationSpawnOptions,
  conversationAgentRuntimePatch,
  resolveDefaultConversationOption,
  type ConversationSpawnOption,
} from './conversationSpawnOptions'
import { computeRetainedWorkspaceLayoutIds, type WorkspaceLayoutRetentionReason } from './workspaceLayoutRetention'
import type { ConversationProviderListResult } from '../../../../shared/electron-api'
import { restoreDetachedWorkspaceWindowsOnStartup } from './workspaceWindowRestore'
import { LAYOUT_TEMPLATES } from '../../layouts/templates'
import { collectWorkspaceTypeSupervisors } from '../../modules/workspace-type-supervisors'
import { RendererCommandDispatcher } from '../../commands/commandDispatcher'
import { getCommandDefinition, type CommandId } from '../../commands/commandRegistry'
import { getElectronAccelerator } from '../../commands/effectiveKeybindings'
import type { CommandAvailabilityContext } from '../../commands/availability'
import type { CommandScope } from '../../commands/types'
import { buildSprintEngineAgentRosterForState, computeSprintEngineFocusAgentAvailability } from '../../utils/sprintengine'
import { isGlobalShortcutSuppressedTarget } from '../../utils/keyboard'

// Lazy so the (large) new-workspace wizard — and everything it pulls in
// (GuidedBriefFlow, the markdown renderer) — is code-split out of the eager boot
// chunk and only fetched when the user opens "new workspace". Rendered only when
// showNewWorkspacePanel is true.
const NewWorkspacePanel = React.lazy(() => import('./NewWorkspacePanel'))

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const
const EMPTY_SPECIALIST_CLI_DEFAULTS: Partial<Record<SpecialistActionId, AgentCli>> = {}
const EMPTY_MULTILOOP_ROLE_CLI_DEFAULTS: Partial<Record<MultiloopRole, AgentCli>> = {}
const EMPTY_CLI_MODEL_DEFAULTS: Partial<Record<AgentCli, string>> = {}
const EMPTY_SPECIALIST_MODEL_DEFAULTS: Partial<Record<SpecialistActionId, AgentCliModelSelection>> = {}
const EMPTY_MULTILOOP_ROLE_MODEL_DEFAULTS: Partial<Record<MultiloopRole, AgentCliModelSelection>> = {}
const EMPTY_SPECIALIST_ORDER: SpecialistActionId[] = []
const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}

const TERMINAL_SESSION_RECOVERY_POLL_MS = 30_000
const WORKSPACE_LAYOUT_IDLE_UNLOAD_MS = 30 * 60_000
const WORKSPACE_LAYOUT_RETAINED_INACTIVE_LIMIT = 4
const WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT = 8
const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'
const SOLO_CHAT_TEMPLATE = LAYOUT_TEMPLATES.find((template) => template.id === 'solo') ?? null
const MENU_ACCELERATOR_COMMAND_IDS = [
  'app.settings.open',
  'panel.files.toggle',
  'panel.editor.toggle',
  'panel.git.toggle',
] as const
export default function WorkspaceManager() {
  useAppTheme()
  const dialog = useConfirmDialog()
  const workspaceWindowId = useMemo(() => getWorkspaceWindowIdFromLocation(), [])
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const workspaceWindows = useWorkspaceStore((s) => s.workspaceWindows)
  const primaryWorkspaceWindowId = useWorkspaceStore((s) => s.primaryWorkspaceWindowId)
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)
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
  const setLastSelectedCli = useWorkspaceStore((s) => s.setLastSelectedCli)
  const rememberedConversationModel = useWorkspaceStore((s) => s.appSettings.lastSelectedConversationModel)
  const setLastSelectedConversationModel = useWorkspaceStore((s) => s.setLastSelectedConversationModel)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const pluginCatalogError = useWorkspaceStore((s) => s.pluginCatalogError)
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
  const cliModelDefaults = useWorkspaceStore(
    (s) => s.appSettings.cliModelDefaults ?? EMPTY_CLI_MODEL_DEFAULTS
  )
  const specialistModelDefaults = useWorkspaceStore(
    (s) => s.appSettings.specialistModelDefaults ?? EMPTY_SPECIALIST_MODEL_DEFAULTS
  )
  const multiloopRoleModelDefaults = useWorkspaceStore(
    (s) => s.appSettings.multiloopRoleModelDefaults ?? EMPTY_MULTILOOP_ROLE_MODEL_DEFAULTS
  )
  const setCliModelDefault = useWorkspaceStore((s) => s.setCliModelDefault)
  const setSpecialistModelDefault = useWorkspaceStore((s) => s.setSpecialistModelDefault)
  const setMultiloopRoleModelDefault = useWorkspaceStore((s) => s.setMultiloopRoleModelDefault)
  const specialistOrder = useWorkspaceStore(
    (s) => s.appSettings.specialistOrder ?? EMPTY_SPECIALIST_ORDER
  )
  const keybindingSettings = useWorkspaceStore((s) => s.appSettings.keybindings)
  const setSpecialistOrder = useWorkspaceStore((s) => s.setSpecialistOrder)
  const orderedSpecialistActions = useMemo(
    () => orderSpecialistActions(specialistOrder),
    [specialistOrder]
  )
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
  // Installed conversation providers, loaded lazily when the spawn menu opens.
  // Kept separate from `agentCliCatalog`: this is the provider/model catalog for
  // the conversation runtime, not the terminal CLI plugin catalog. `null` means
  // "not loaded yet"; an `ok: false` result drives the unavailable row.
  const [conversationProviderResult, setConversationProviderResult] = useState<ConversationProviderListResult | null>(null)
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
  const [workspaceLayoutRetentionTick, setWorkspaceLayoutRetentionTick] = useState(0)
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
  const workspaceLayoutLastFocusedAtRef = useRef<Record<string, number>>({})
  const workspaceLayoutRetentionReasonsRef = useRef<Record<string, WorkspaceLayoutRetentionReason>>({})
  const collapsedStaleDetachedWindowsRef = useRef(false)
  const workspaceActionsEnabled = activeWorkspace && !showNewWorkspacePanel
  const commandDispatcherRef = useRef(new RendererCommandDispatcher())
  // Per-window visit history backing mouse back/forward workspace navigation.
  // Transient shell state: a ref (not store state) because navigation must not
  // re-render anything on its own, and per-renderer because each BrowserWindow
  // tracks only its own activations.
  const workspaceNavigationHistoryRef = useRef<WorkspaceNavigationHistory>(EMPTY_WORKSPACE_NAVIGATION_HISTORY)
  const disabledCommandIds = useMemo(
    () => new Set(Object.entries(keybindingSettings?.disabled ?? {})
      .filter(([, disabled]) => disabled === true)
      .map(([commandId]) => commandId)),
    [keybindingSettings?.disabled]
  )
  const activeCommandScopes = useMemo((): CommandScope[] => {
    const scopes: CommandScope[] = ['global']
    if (!workspaceActionsEnabled) return scopes
    scopes.push('workspace', 'workspace-navigation')
    if (activeWorkspace.mode === 'sprintengine' || activeWorkspace.sprintEngineContext) {
      scopes.push('panel:sprintengine')
    }
    if (activeWorkspace.mode === 'multiloop' || activeWorkspace.multiloopContext) {
      scopes.push('panel:multiloop')
    }
    if (activeWorkspace.mode === 'switchboard') {
      scopes.push('panel:switchboard', 'panel:watchtower')
    }
    return scopes
  }, [activeWorkspace?.mode, activeWorkspace?.sprintEngineContext, activeWorkspace?.multiloopContext, workspaceActionsEnabled])
  // Runtime preconditions for registry commands, derived from the same active
  // scopes the dispatcher uses plus the panels' own availability predicates
  // (architect on roster, focusable agent, loaded multiloop state). The
  // dispatcher and the command palette both read this context so keyboard
  // dispatch and palette rows agree on which commands are actually runnable.
  // `activeFile` is intentionally omitted: no command declares it yet, and
  // inventing a value here would be a fake precondition.
  const commandAvailability = useMemo((): CommandAvailabilityContext => {
    const context: CommandAvailabilityContext = {}
    if (workspaceActionsEnabled) context.activeWorkspace = true
    if (voiceDictationEnabled) context.voiceDictationEnabled = true
    if (activeCommandScopes.includes('panel:sprintengine')) {
      context.sprintengineWorkspace = true
      const sprintEngineState = activeWorkspace?.sprintEngineState ?? null
      const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
      if (roster.some((agent) => agent.role === 'architect')) context.sprintengineHasArchitect = true
      const focusAvailability = computeSprintEngineFocusAgentAvailability(sprintEngineState, activeWorkspace?.agents ?? {})
      if (focusAvailability.showFocusAgentAction) context.sprintengineFocusAgentVisible = true
    }
    if (activeCommandScopes.includes('panel:multiloop')) {
      context.multiloopWorkspace = true
      if (activeWorkspace?.multiloopState) context.multiloopStateLoaded = true
    }
    if (activeCommandScopes.includes('panel:switchboard')) context.switchboardWorkspace = true
    if (activeWorkspace?.layoutModel && jsonModelHasComponent(activeWorkspace.layoutModel, 'git')) {
      context.gitPanelActive = true
    }
    if (terminalSessions.some((session) =>
      session.kind === 'terminal' && session.workspaceId === activeWorkspace?.id && session.terminalId,
    )) {
      context.terminalActive = true
    }
    return context
  }, [workspaceActionsEnabled, voiceDictationEnabled, activeCommandScopes, activeWorkspace, terminalSessions])
  const sessions = getSessionItems(visibleWorkspaces, terminalSessions)
  const sidebarWorkspaceOrder = useMemo(
    () =>
      buildSidebarWorkspaceOrder(
        visibleWorkspaces,
        (workspace) => getWorkspaceActivity(workspace, terminalSessions) !== 'idle'
      ),
    [visibleWorkspaces, terminalSessions]
  )
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length
  const settingsOpen = settingsOverlayOpen
  const ownsGlobalSupervisors = isPrimaryWorkspaceWindow
  const renderedWorkspaceIds = visibleWorkspaces
    .map((workspace) => workspace.id)
    .filter((workspaceId) => workspaceId === windowActiveWorkspaceId || mountedWorkspaceIds.includes(workspaceId))
  const workspaceTypeSupervisors = useMemo(() => {
    const moduleEnabled = (moduleId: string) => selectModuleEnabled(moduleEnablement, moduleId)
    return collectWorkspaceTypeSupervisors(
      getRendererHost().getWorkspaceTypes(moduleEnabled),
      ownsGlobalSupervisors,
    )
  }, [moduleEnablement, ownsGlobalSupervisors])

  const openNewWorkspacePanel = () => {
    setNewWorkspacePanelInitialState(null)
    setShowNewWorkspacePanel(true)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
  }

  const pickNewChatName = useCallback((folderPath: string | null): string => {
    const folderWorkspaces = workspaces.filter((workspace) => workspace.folderPath === folderPath)
    const existingNames = new Set(folderWorkspaces.map((workspace) => workspace.name.trim().toLowerCase()))
    if (!existingNames.has('chat')) return 'Chat'
    for (let index = 2; index < 1000; index += 1) {
      const name = `Chat ${index}`
      if (!existingNames.has(name.toLowerCase())) return name
    }
    return `Chat ${Date.now()}`
  }, [workspaces])

  // Agent CLIs offered across every renderer picker (sidebar New chat, top-bar
  // spawn menu, New workspace roster). Driven by the installed-plugin catalog
  // from T2 plus any configured cliRuntimes, so the lists scale with installed
  // agents instead of a hardcoded list. While the registry is loading or after a
  // registry error this falls back to the legacy bundled options.
  const agentCliCatalog = useMemo(
    () => selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes],
  )
  // First available catalog entry used to rescue new spawns whose remembered CLI
  // (lastSelectedCli / specialist / multiloop default) is no longer installed.
  const fallbackSpawnCli = (cli: AgentCli): AgentCli =>
    resolveAvailableAgentCli(cli, agentCliCatalog, agentCliCatalog[0]?.value ?? cli)

  // Conversation spawn is offered only in standard workspaces; Sprint Engine and
  // Multiloop agents stay terminal/MCP-owned (AgentPanel enforces this too).
  const conversationSpawnEnabled = activeWorkspace?.mode === 'standard'
  // Load the conversation provider catalog when the spawn menu opens in a
  // standard workspace. Defensive: if the IPC is absent the feature is simply
  // unavailable and no rows render. We refetch on each open so a provider just
  // configured in Settings shows up without a restart.
  React.useEffect(() => {
    if (!specialistMenuOpen || !conversationSpawnEnabled) return
    if (typeof window.api.conversationProvidersList !== 'function') {
      setConversationProviderResult(null)
      return
    }
    let cancelled = false
    void window.api
      .conversationProvidersList()
      .then((result) => {
        if (!cancelled) setConversationProviderResult(result)
      })
      .catch(() => {
        if (!cancelled) setConversationProviderResult(null)
      })
    return () => {
      cancelled = true
    }
  }, [specialistMenuOpen, conversationSpawnEnabled])
  const conversationSpawnOptions = useMemo<ConversationSpawnOption[]>(
    () => buildConversationSpawnOptions(conversationProviderResult),
    [conversationProviderResult],
  )
  // Providers with a live catalog accept any model id, so a remembered live-only
  // model is still a valid spawn default for them.
  const conversationDynamicProviderIds = useMemo(() => {
    const ids = new Set<string>()
    if (conversationProviderResult?.ok) {
      for (const provider of conversationProviderResult.providers) {
        if (provider.supportsDynamicModels) ids.add(provider.id)
      }
    }
    return ids
  }, [conversationProviderResult])
  // Single spawn entry: the model is picked in the chat composer, so the menu
  // only needs the default pair to open with (remembered → first available).
  const conversationDefaultOption = useMemo(
    () => resolveDefaultConversationOption(conversationSpawnOptions, rememberedConversationModel, conversationDynamicProviderIds),
    [conversationSpawnOptions, rememberedConversationModel, conversationDynamicProviderIds],
  )
  const conversationSpawnAvailable = conversationSpawnEnabled && conversationDefaultOption !== null

  // Create a fresh single-agent "solo chat" workspace. `folderPath === undefined`
  // inherits the active workspace's folder (the plain New chat default); an
  // explicit value (sidebar) targets that folder. `seedAgent` opens a specific
  // agent (terminal/specialist/conversation) in the new workspace, seeded at
  // creation so it is race-free before first render. Shared by createNewChat and
  // the Open-in-new-chat handlers.
  const createSoloChatWorkspace = useCallback((opts: {
    folderPath?: string | null
    templateAgentCli?: AgentCli | null
    seedAgent?: SoloChatSeed
    name?: string
  }) => {
    if (!SOLO_CHAT_TEMPLATE) {
      publishDiagnosticSync({
        level: 'error',
        source: 'workspace',
        title: 'New chat unavailable',
        message: 'The Solo layout template is missing, so Multicode cannot create a one-agent chat.',
      })
      return
    }
    const targetFolderPath = opts.folderPath === undefined ? activeWorkspace?.folderPath ?? null : opts.folderPath
    addWorkspace(SOLO_CHAT_TEMPLATE, {
      name: opts.name ?? pickNewChatName(targetFolderPath),
      folderPath: targetFolderPath,
      windowId: workspaceWindowId,
      templateAgentCli: opts.templateAgentCli,
      seedAgent: opts.seedAgent,
    })
    setShowNewWorkspacePanel(false)
    setNewWorkspacePanelInitialState(null)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    if (onboardingStep !== 'complete') setOnboardingStep('complete')
  }, [
    activeWorkspace?.folderPath,
    addWorkspace,
    closeSettingsOverlay,
    onboardingStep,
    pickNewChatName,
    setOnboardingStep,
    workspaceWindowId,
  ])

  const createNewChat = useCallback((folderPath?: string | null, cli?: AgentCli) => {
    const chosenCli = cli && cli.trim() ? cli.trim() : null
    // Plain New chat (no explicit pick) clamps the remembered lastSelectedCli to an
    // installed catalog entry so a stale value cannot seed a chat with an
    // uninstalled plugin id; explicit picks come from the catalog already.
    const templateAgentCli = resolveTemplateAgentCli(chosenCli, lastSelectedCli, agentCliCatalog)
    createSoloChatWorkspace({ folderPath, templateAgentCli })
    // Remember an explicit pick so the next plain New chat repeats it.
    if (chosenCli) setLastSelectedCli(chosenCli)
  }, [agentCliCatalog, createSoloChatWorkspace, lastSelectedCli, setLastSelectedCli])

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

  // The plugin catalog loads once at startup (workspaceStore) and on explicit
  // Settings retry. Re-sync it when this window regains focus / becomes visible
  // so plugins installed or removed while the user was away show up without an
  // app reload. Background mode avoids a loading flicker; refreshPluginCatalog
  // dedups concurrent calls during rapid focus changes.
  useEffect(
    () =>
      subscribePluginCatalogRefreshOnFocus(() => {
        void useWorkspaceStore.getState().refreshPluginCatalog({ background: true })
      }),
    []
  )

  useEffect(() => {
    if (collapsedStaleDetachedWindowsRef.current) return
    collapsedStaleDetachedWindowsRef.current = true
    if (!isPrimaryWorkspaceWindow) return
    void restoreDetachedWorkspaceWindowsOnStartup({
      primaryWorkspaceWindowId: primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID,
      workspaceWindows: useWorkspaceStore.getState().workspaceWindows,
      createWorkspaceWindow: window.api.createWorkspaceWindow,
      closeWorkspaceWindow,
    })
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
    return window.api.onWindowCloseRequested(() => {
      closeWorkspaceWindow(workspaceWindowId, primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID)
      void window.api.confirmWindowClose()
    })
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
    if (!windowActiveWorkspaceId) return
    workspaceLayoutLastFocusedAtRef.current[windowActiveWorkspaceId] = Date.now()
    // The newly active layer just flipped from visibility:hidden; terminals
    // parked behind it run their deferred fit now (terminalFitScheduler.ts).
    window.dispatchEvent(new Event(WORKSPACE_LAYER_REVEAL_EVENT))
  }, [windowActiveWorkspaceId])

  useEffect(() => {
    const now = Date.now()
    const visibleWorkspaceIds = visibleWorkspaces.map((workspace) => workspace.id)
    const visibleWorkspaceIdSet = new Set(visibleWorkspaceIds)
    if (windowActiveWorkspaceId && visibleWorkspaceIdSet.has(windowActiveWorkspaceId)) {
      workspaceLayoutLastFocusedAtRef.current[windowActiveWorkspaceId] = now
    }

    const busyWorkspaceIds = new Set<string>()
    for (const workspace of visibleWorkspaces) {
      if (getWorkspaceActivity(workspace, terminalSessions) !== 'idle') {
        busyWorkspaceIds.add(workspace.id)
      }
    }
    for (const session of terminalSessions) {
      if (session.processAlive && typeof session.workspaceId === 'string') {
        busyWorkspaceIds.add(session.workspaceId)
      }
    }

    const retention = computeRetainedWorkspaceLayoutIds({
      visibleWorkspaceIds,
      activeWorkspaceId: windowActiveWorkspaceId,
      mountedWorkspaceIds,
      busyWorkspaceIds,
      lastFocusedAtByWorkspaceId: workspaceLayoutLastFocusedAtRef.current,
      now,
      idleUnloadMs: WORKSPACE_LAYOUT_IDLE_UNLOAD_MS,
      inactiveLimit: WORKSPACE_LAYOUT_RETAINED_INACTIVE_LIMIT,
      busyLimit: WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT,
    })

    const nextReasons: Record<string, WorkspaceLayoutRetentionReason> = {}
    for (const retained of retention.retained) {
      nextReasons[retained.workspaceId] = retained.reason
      if (workspaceLayoutRetentionReasonsRef.current[retained.workspaceId] === retained.reason) continue
      logPerfEvent('WorkspaceManager', 'workspace-layout-retained', {
        workspaceId: retained.workspaceId,
        activeWorkspaceId: windowActiveWorkspaceId,
        reason: retained.reason,
        busy: retained.busy,
        mountedCount: retention.retainedWorkspaceIds.length,
        visibleWorkspaceCount: visibleWorkspaceIds.length,
        inactiveLimit: WORKSPACE_LAYOUT_RETAINED_INACTIVE_LIMIT,
        busyLimit: WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT,
        idleUnloadMs: WORKSPACE_LAYOUT_IDLE_UNLOAD_MS,
      })
    }
    for (const evicted of retention.evicted) {
      if (workspaceLayoutRetentionReasonsRef.current[evicted.workspaceId] === undefined) continue
      logPerfEvent('WorkspaceManager', 'workspace-layout-evicted', {
        workspaceId: evicted.workspaceId,
        activeWorkspaceId: windowActiveWorkspaceId,
        reason: evicted.reason,
        busy: evicted.busy,
        mountedCount: retention.retainedWorkspaceIds.length,
        visibleWorkspaceCount: visibleWorkspaceIds.length,
        inactiveLimit: WORKSPACE_LAYOUT_RETAINED_INACTIVE_LIMIT,
        busyLimit: WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT,
        idleUnloadMs: WORKSPACE_LAYOUT_IDLE_UNLOAD_MS,
      })
    }
    workspaceLayoutRetentionReasonsRef.current = nextReasons

    setMountedWorkspaceIds((current) => {
      const next = retention.retainedWorkspaceIds
      return next.length === current.length && next.every((workspaceId, index) => workspaceId === current[index])
        ? current
        : next
    })
  }, [mountedWorkspaceIds, terminalSessions, visibleWorkspaces, windowActiveWorkspaceId, workspaceLayoutRetentionTick])

  useEffect(() => {
    const now = Date.now()
    const visibleWorkspaceIds = new Set(visibleWorkspaces.map((workspace) => workspace.id))
    const busyWorkspaceIds = new Set<string>()
    for (const workspace of visibleWorkspaces) {
      if (getWorkspaceActivity(workspace, terminalSessions) !== 'idle') {
        busyWorkspaceIds.add(workspace.id)
      }
    }
    for (const session of terminalSessions) {
      if (session.processAlive && typeof session.workspaceId === 'string') {
        busyWorkspaceIds.add(session.workspaceId)
      }
    }

    let nextDeadline = Number.POSITIVE_INFINITY
    for (const workspaceId of mountedWorkspaceIds) {
      if (workspaceId === windowActiveWorkspaceId) continue
      if (!visibleWorkspaceIds.has(workspaceId)) continue
      if (busyWorkspaceIds.has(workspaceId)) continue
      const lastFocusedAt = workspaceLayoutLastFocusedAtRef.current[workspaceId] ?? 0
      nextDeadline = Math.min(nextDeadline, lastFocusedAt + WORKSPACE_LAYOUT_IDLE_UNLOAD_MS)
    }
    if (!Number.isFinite(nextDeadline)) return
    const timeout = window.setTimeout(() => {
      setWorkspaceLayoutRetentionTick(Date.now())
    }, Math.max(1_000, nextDeadline - now + 50))
    return () => window.clearTimeout(timeout)
  }, [mountedWorkspaceIds, terminalSessions, visibleWorkspaces, windowActiveWorkspaceId, workspaceLayoutRetentionTick])

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

  // Outside-click and Escape for the top-bar menus (spawn/specialist, sessions,
  // view, notifications, account) are owned by the Popover primitive: its surface
  // is portaled to <body>, so a manual `menuRef.contains(target)` guard here would
  // read every click inside the portaled surface as "outside" and close the menu
  // before the row's click lands — which silently broke specialist spawning. Each
  // Popover's onOpenChange already drives these open-states, so no handler is
  // needed (mirrors the account menu, which never had one).

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
    const cliForSpawn = fallbackSpawnCli(
      normalizeSelectedCli(selectedCli ?? specialistCliDefaults[specialist.id], lastSelectedCli)
    )

    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      cli: cliForSpawn,
      cliModel: resolveCliModel(cliForSpawn, specialistModelDefaults[specialist.id], cliModelDefaults),
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
    const cliForSpawn = fallbackSpawnCli(
      normalizeSelectedCli(selectedCli ?? multiloopRoleCliDefaults[soul.role], lastSelectedCli)
    )

    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      cli: cliForSpawn,
      cliModel: resolveCliModel(cliForSpawn, multiloopRoleModelDefaults[soul.role], cliModelDefaults),
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
    const spawnCli = fallbackSpawnCli(cli)
    const tabName = uniqueAgentName(label, activeWorkspace?.agents ?? {})
    const newId = `agent-${spawnCli}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      cli: spawnCli,
      cliModel: resolveCliModel(spawnCli, undefined, cliModelDefaults),
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

  // Spawn a conversation-backed general agent in the active standard workspace.
  // AgentPanel routes the new tab to AgentChatView based on `runtimeKind` +
  // `conversation`; no CLI session is created. The model is then switchable in
  // the chat composer until the first message, so spawning just needs a default
  // pair. Missing-key/unavailable states are handled downstream by AgentChatView.
  const addNewConversationAgent = (providerId: string, modelId: string, modelLabel: string) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    if (!activeWorkspace || activeWorkspace.mode !== 'standard') return

    const tabName = uniqueAgentName(modelLabel || 'Conversation Agent', activeWorkspace.agents)
    const newId = `conversation-${providerId}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      ...conversationAgentRuntimePatch(providerId, modelId),
    })
    addAgentTabTiled(windowActiveWorkspaceId, newId, tabName)
    setLastSelectedConversationModel({ providerId, modelId })
    setSpecialistMenuOpen(false)
  }

  // Single spawn-menu entry: open a conversation agent with the resolved default
  // model. No-op when no provider/model is available (entry stays hidden).
  const spawnConversationAgent = () => {
    if (!conversationDefaultOption) return
    addNewConversationAgent(
      conversationDefaultOption.providerId,
      conversationDefaultOption.modelId,
      conversationDefaultOption.modelLabel,
    )
  }

  const addNewTerminal = () => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const newId = `terminal-${nanoid(6)}`
    addTerminalTab(windowActiveWorkspaceId, newId, 'Terminal')
  }

  // Open-in-new-chat: spawn the chosen agent in a fresh solo-chat workspace
  // (inheriting the current folder) instead of the active workspace. Each mirrors
  // its in-workspace spawn counterpart, but seeds the agent at creation time via
  // createSoloChatWorkspace so it lands race-free before the new model mounts.
  const openGeneralInNewChat = (cli?: AgentCli) => createNewChat(undefined, cli)

  const openSpecialistInNewChat = (specialistId: SpecialistActionId, selectedCli?: AgentCli) => {
    setLastSelectedSpecialist(specialistId)
    const specialist = getSpecialistAction(specialistId)
    const tabName = pickRandomAgentName([])
    const prompt = buildSpecialistSoulStartupPrompt(specialist)
    const cliForSpawn = fallbackSpawnCli(
      normalizeSelectedCli(selectedCli ?? specialistCliDefaults[specialist.id], lastSelectedCli)
    )
    createSoloChatWorkspace({
      templateAgentCli: cliForSpawn,
      seedAgent: {
        tabName,
        agentPatch: {
          name: tabName,
          cli: cliForSpawn,
          cliModel: resolveCliModel(cliForSpawn, specialistModelDefaults[specialist.id], cliModelDefaults),
          cliPermissionPreset: agentSpawnPermissionPreset,
          kind: 'specialist',
          specialistId: specialist.id,
          cliStartupPrompt: prependAgentIdentifier(prompt, tabName, specialist.shortLabel),
          cliOnboardingPromptSent: false,
          cliHasLaunched: false,
          cliResumeAvailable: false,
        },
      },
    })
  }

  const openConversationInNewChat = () => {
    const option = conversationDefaultOption
    if (!option) return
    const tabName = option.modelLabel || 'Conversation Agent'
    createSoloChatWorkspace({
      seedAgent: {
        tabName,
        agentPatch: { name: tabName, ...conversationAgentRuntimePatch(option.providerId, option.modelId) },
      },
    })
    setLastSelectedConversationModel({ providerId: option.providerId, modelId: option.modelId })
  }

  const openTerminalInNewChat = () => {
    createSoloChatWorkspace({
      seedAgent: { terminal: { terminalId: `terminal-${nanoid(6)}` }, tabName: 'Terminal' },
    })
  }

  // Optional workspaceId targets a single workspace's panel. The mode-scoped
  // panels ignore it, but the Git panel (which can be mounted in several
  // background workspaces at once) uses it so a destructive command like commit
  // only runs in the active workspace's repo, never a stale background one.
  const dispatchPanelCommand = useCallback((id: string, workspaceId?: string) => {
    window.dispatchEvent(new CustomEvent('multicode:panel-command', { detail: { id, workspaceId } }))
  }, [])

  const runCommand = useCallback((commandId: CommandId): boolean => {
    if (commandId === 'app.settings.open') {
      openSettings(false)
      return true
    }
    if (commandId === 'app.updates.check') {
      openSettings(true)
      return true
    }
    if (commandId === 'commandPalette.open') {
      setShowPalette(true)
      setShowNewWorkspacePanel(false)
      setSpecialistMenuOpen(false)
      setSessionsOpen(false)
      setViewMenuOpen(false)
      setNotificationsOpen(false)
      return true
    }
    if (commandId === 'workspace.new') {
      openNewWorkspacePanel()
      return true
    }
    if (commandId === 'workspace.sidebar.toggle') {
      beginSidebarTransition()
      setSidebarCollapsed(!sidebarCollapsed)
      return true
    }
    if (commandId === 'workspace.close' && windowActiveWorkspaceId) {
      closeWorkspaceById(windowActiveWorkspaceId)
      return true
    }
    if (commandId === 'workspace.history.back' || commandId === 'workspace.history.forward') {
      // History semantics (the workspace I was just in), not sidebar order —
      // sidebar-order cycling stays on workspace.switch.next/previous. Entries
      // pointing at closed workspaces, workspaces routed to another window, or
      // the already-active workspace are skipped.
      const step = stepWorkspaceHistory(
        workspaceNavigationHistoryRef.current,
        commandId === 'workspace.history.back' ? -1 : 1,
        (workspaceId) => workspaceId !== windowActiveWorkspaceId && visibleWorkspaceIdSet.has(workspaceId),
      )
      if (!step) return false
      workspaceNavigationHistoryRef.current = step.history
      setShowNewWorkspacePanel(false)
      setActiveWorkspaceForWindow(workspaceWindowId, step.workspaceId)
      return true
    }
    if (commandId === 'workspace.switch.next' || commandId === 'workspace.switch.previous') {
      const nextWorkspaceId = getNextWorkspaceId(
        visibleWorkspaces,
        windowActiveWorkspaceId,
        commandId === 'workspace.switch.previous' ? -1 : 1,
      )
      if (!nextWorkspaceId) return false
      setShowNewWorkspacePanel(false)
      setActiveWorkspaceForWindow(workspaceWindowId, nextWorkspaceId)
      return true
    }
    if (commandId.startsWith('workspace.switch.')) {
      const workspaceIndex = Number(commandId.slice('workspace.switch.'.length)) - 1
      const workspace = visibleWorkspaces[workspaceIndex]
      if (!workspace) return false
      setShowNewWorkspacePanel(false)
      setActiveWorkspaceForWindow(workspaceWindowId, workspace.id)
      return true
    }
    if (commandId === 'layout.tab.next' || commandId === 'layout.tab.previous') {
      if (!windowActiveWorkspaceId) return false
      return cycleActiveLayoutTab(windowActiveWorkspaceId, commandId === 'layout.tab.previous' ? -1 : 1)
    }
    if (commandId === 'layout.tab.close') {
      if (showNewWorkspacePanel) {
        if (visibleWorkspaces.length > 0) setShowNewWorkspacePanel(false)
        return true
      }
      if (!windowActiveWorkspaceId) return false
      return closeActiveLayoutTab(windowActiveWorkspaceId, terminalSessions)
    }
    if (commandId === 'panel.files.toggle' && windowActiveWorkspaceId) {
      togglePanelRailComponent(windowActiveWorkspaceId, 'explorer', 'Files')
      return true
    }
    if (commandId === 'panel.editor.toggle' && windowActiveWorkspaceId) {
      togglePanelRailComponent(windowActiveWorkspaceId, 'editor', 'Editor')
      return true
    }
    if (commandId === 'panel.git.toggle' && windowActiveWorkspaceId) {
      togglePanelRailComponent(windowActiveWorkspaceId, 'git', 'Git')
      return true
    }
    if (commandId === 'git.worktrees.open' && windowActiveWorkspaceId) {
      // Worktrees live in the Git panel, so reveal the Git nav switch via the
      // same route the command palette uses. Sharing the route keeps a bound
      // shortcut and the palette row on the same surface instead of silently
      // no-opping (T8 code-review finding A10).
      revealNavRailComponent(windowActiveWorkspaceId, 'git', 'Git')
      return true
    }
    if (commandId === 'terminal.new') {
      addNewTerminal()
      return true
    }
    if (commandId === 'terminal.focus' && windowActiveWorkspaceId) {
      const session = terminalSessions.find((item) =>
        item.kind === 'terminal' && item.workspaceId === windowActiveWorkspaceId && item.terminalId,
      )
      if (!session?.terminalId) return false
      return focusOrAddTerminalTab(windowActiveWorkspaceId, session.terminalId, 'Terminal')
    }
    if (commandId === 'terminal.stop' && windowActiveWorkspaceId) {
      return stopActiveTerminal(windowActiveWorkspaceId, terminalSessions)
    }
    if (commandId === 'git.refresh' || commandId === 'git.fetch' || commandId === 'git.commit') {
      if (!windowActiveWorkspaceId) return false
      // Routed to the active workspace's mounted Git panel; availability
      // (gitPanelActive) keeps this reachable only while that panel is open, and
      // the workspace target prevents firing in a background repo.
      dispatchPanelCommand(commandId, windowActiveWorkspaceId)
      return true
    }
    if (commandId === 'voice.toggle') {
      if (!voiceDictationEnabled) return false
      voiceDictation.toggle()
      return true
    }
    if (commandId === 'specialist.spawn.architect') {
      setLastSelectedSpecialist('architect')
      setSpecialistMenuOpen(false)
      void addNewSpecialist('architect')
      return true
    }
    if (commandId === 'specialist.spawn.performance') {
      setLastSelectedSpecialist('performance')
      setSpecialistMenuOpen(false)
      void addNewSpecialist('performance')
      return true
    }
    if (commandId === 'specialist.spawn.frontend-design-review') {
      setLastSelectedSpecialist('frontend-design-review')
      setSpecialistMenuOpen(false)
      void addNewSpecialist('frontend-design-review')
      return true
    }
    if (commandId === 'specialist.spawn.nuclear-review') {
      setLastSelectedSpecialist('nuclear-review')
      setSpecialistMenuOpen(false)
      void addNewSpecialist('nuclear-review')
      return true
    }
    if (
      commandId.startsWith('sprintengine.')
      || commandId.startsWith('multiloop.')
      || commandId.startsWith('watchtower.')
      || commandId.startsWith('switchboard.')
    ) {
      dispatchPanelCommand(commandId)
      return true
    }
    return false
  }, [
    openSettings,
    openNewWorkspacePanel,
    sidebarCollapsed,
    setSidebarCollapsed,
    windowActiveWorkspaceId,
    closeWorkspaceById,
    visibleWorkspaces,
    visibleWorkspaceIdSet,
    setActiveWorkspaceForWindow,
    workspaceWindowId,
    showNewWorkspacePanel,
    terminalSessions,
    voiceDictationEnabled,
    voiceDictation,
    setLastSelectedSpecialist,
    addNewSpecialist,
    dispatchPanelCommand,
  ])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const platform = window.api.platform === 'darwin'
        ? 'darwin'
        : window.api.platform === 'win32'
          ? 'windows'
          : 'linux'
      const result = commandDispatcherRef.current.resolve(event, {
        activeScopes: activeCommandScopes,
        disabledCommandIds,
        keybindingOverrides: keybindingSettings?.overrides,
        availability: commandAvailability,
        isSuppressedTarget: isGlobalShortcutSuppressedTarget,
        platform,
      })
      if (result.kind === 'unmatched') return
      if (result.kind === 'pending') {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (runCommand(result.commandId)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    activeCommandScopes,
    disabledCommandIds,
    keybindingSettings?.overrides,
    commandAvailability,
    runCommand,
  ])

  // Record every activation of this window's active workspace, whatever caused
  // it (sidebar click, palette, switch commands, sync events). Back/forward
  // navigation moves the history cursor onto the visited id before activating,
  // so recordWorkspaceVisit sees it already at the cursor and does not push.
  useEffect(() => {
    if (!windowActiveWorkspaceId) return
    workspaceNavigationHistoryRef.current = recordWorkspaceVisit(
      workspaceNavigationHistoryRef.current,
      windowActiveWorkspaceId,
    )
  }, [windowActiveWorkspaceId])

  useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      // Chromium reports the mouse back button as 3 and forward as 4.
      if (event.button !== 3 && event.button !== 4) return
      const commandId = event.button === 3 ? 'workspace.history.back' : 'workspace.history.forward'
      // A command disabled through the Shortcuts tab opts the buttons out
      // entirely; the untouched event then reaches whatever surface wants it.
      if (disabledCommandIds.has(commandId)) return
      // Swallow the buttons app-wide (even when history cannot move) so they
      // never reach xterm mouse reporting or Chromium's own session-history
      // navigation — in this shell they mean workspace navigation, full stop.
      event.preventDefault()
      event.stopPropagation()
      runCommand(commandId)
    }
    window.addEventListener('mouseup', onMouseUp, true)
    return () => window.removeEventListener('mouseup', onMouseUp, true)
  }, [runCommand, disabledCommandIds])

  useEffect(() => {
    return window.api.onAppMenuCommand((command) => {
      const definition = getCommandDefinition(command)
      if (definition) {
        runCommand(definition.id as CommandId)
        return
      }
      if (command === 'show-settings') {
        runCommand('app.settings.open')
        return
      }
      if (command === 'show-about') {
        openSettings(false)
        return
      }
      if (command === 'check-for-updates') {
        runCommand('app.updates.check')
        return
      }
      if (command === 'toggle-explorer') {
        runCommand('panel.files.toggle')
      } else if (command === 'toggle-editor') {
        runCommand('panel.editor.toggle')
      } else if (command === 'toggle-git') {
        runCommand('panel.git.toggle')
      }
    })
  }, [openSettings, runCommand])

  useEffect(() => {
    const updates = MENU_ACCELERATOR_COMMAND_IDS.map((commandId) => ({
      commandId,
      accelerator: getElectronAccelerator(commandId, keybindingSettings),
    }))
    void window.api.updateAppMenuAccelerators(updates).catch(() => {})
  }, [keybindingSettings])

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

  // Kill one session's process and reset its derived agent/automation state, but
  // leave the terminalSessions list to the caller so a batch stop can prune in a
  // single update instead of one render per session.
  const killSessionItem = (item: SessionItem) => {
    void window.api.terminalKill(item.sessionId).catch(() => {})
    if (item.workspace.mode === 'sprintengine') {
      applySprintEngineAutomationStopReason(item.workspace.id, 'agent_terminal_closed', {
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

  const stopSession = (item: SessionItem) => {
    killSessionItem(item)
    setTerminalSessions((sessions) => sessions.filter((session) => session.sessionId !== item.sessionId))
  }

  const stopWorkspaceSessions = async (workspace: Workspace, items: SessionItem[]) => {
    if (items.length === 0) return
    const confirmed = await dialog.confirm({
      title:
        items.length === 1
          ? `Stop the session in ${workspace.name}?`
          : `Stop all ${items.length} sessions in ${workspace.name}?`,
      body: 'Running terminals and agent CLIs in this workspace will be stopped.',
      confirmLabel: 'Stop all',
      tone: 'danger',
    })
    if (!confirmed) return
    for (const item of items) killSessionItem(item)
    const stoppedIds = new Set(items.map((item) => item.sessionId))
    setTerminalSessions((sessions) => sessions.filter((session) => !stoppedIds.has(session.sessionId)))
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
      {sprintEngineEnabled && !MULTICODE_DISABLE_SPRINTENGINE_SYNC ? (
        // Projection sync consumes active-window/workspace identity from the shell,
        // so it remains the known propful exception to zero-prop supervisor contributions.
        <SprintEngineProjectionSupervisor
          activeWorkspaceId={windowActiveWorkspaceId}
          workspaceIds={workspaces.map((workspace) => workspace.id)}
        />
      ) : null}
      {workspaceTypeSupervisors.map(({ key, Component }) => (
        <React.Suspense key={key} fallback={null}>
          <Component />
        </React.Suspense>
      ))}
      {multiloopEnabled && visibleWorkspaces.map((workspace) => (
        workspace.id === windowActiveWorkspaceId && (workspace.mode === 'multiloop' || workspace.multiloopContext)
          ? <MultiloopStateSynchronizer key={workspace.id} workspaceId={workspace.id} />
          : null
      ))}

      <AppTitleBar
        isMac={window.api.platform === 'darwin'}
        isMaximized={windowState.isMaximized}
        menuItems={MENU_BAR_ITEMS}
        onShowMenu={(event, label) => void handleShowMenubarMenu(event, label)}
      />

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
        onNewChat={() => createNewChat()}
        onNewChatInFolder={(folderPath) => createNewChat(folderPath)}
        onNewChatWithAgent={(cli) => createNewChat(undefined, cli)}
        onNewChatInFolderWithAgent={(folderPath, cli) => createNewChat(folderPath, cli)}
        newChatAgentOptions={agentCliCatalog}
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
        stopWorkspaceSessions={stopWorkspaceSessions}
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
        agentCliOptions={agentCliCatalog}
        agentCliStatus={pluginCatalogStatus}
        agentCliError={pluginCatalogError}
        setChipPopoverForRole={setChipPopoverForRole}
        multiloopLaunchMenu={multiloopLaunchMenu}
        selectedSpecialistAction={selectedSpecialistAction}
        selectedMultiloopRoleDescriptor={selectedMultiloopRoleDescriptor}
        selectedAgentPermissionOption={selectedAgentPermissionOption}
        lastSelectedCli={lastSelectedCli}
        specialistCliDefaults={specialistCliDefaults}
        cliModelDefaults={cliModelDefaults}
        specialistModelDefaults={specialistModelDefaults}
        multiloopRoleModelDefaults={multiloopRoleModelDefaults}
        setCliModelDefault={setCliModelDefault}
        setSpecialistModelDefault={setSpecialistModelDefault}
        setMultiloopRoleModelDefault={setMultiloopRoleModelDefault}
        multiloopRoleCliDefaults={multiloopRoleCliDefaults}
        setSpecialistCliDefault={setSpecialistCliDefault}
        setMultiloopRoleCliDefault={setMultiloopRoleCliDefault}
        specialistActions={orderedSpecialistActions}
        setSpecialistOrder={setSpecialistOrder}
        agentSpawnPermissionPreset={agentSpawnPermissionPreset}
        setAgentSpawnPermissionPreset={setAgentSpawnPermissionPreset}
        handleSelectSpecialist={handleSelectSpecialist}
        handleSelectMultiloopRole={handleSelectMultiloopRole}
        addNewSpecialist={(cli) => addNewSpecialist(lastSelectedSpecialist, '', cli)}
        addNewMultiloopAgent={(cli) => addNewMultiloopAgent(lastSelectedMultiloopRole, '', cli)}
        addNewCliAgent={addNewCliAgent}
        addNewTerminal={addNewTerminal}
        setGeneralAgentCli={setLastSelectedCli}
        conversationSpawnAvailable={conversationSpawnAvailable}
        onSpawnConversationAgent={spawnConversationAgent}
        onOpenTerminalInNewChat={openTerminalInNewChat}
        onOpenGeneralInNewChat={openGeneralInNewChat}
        onOpenConversationInNewChat={openConversationInNewChat}
        onOpenSpecialistInNewChat={openSpecialistInNewChat}
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
                    <WorkspaceLayout
                      workspaceId={workspaceId}
                      onStartFuturePlan={openFuturePlanWorkspace}
                      onNewChat={() => createNewChat()}
                      onNewWorkspace={openNewWorkspacePanel}
                      onCloseWorkspace={closeWorkspaceById}
                    />
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
          onNewChat={() => createNewChat()}
          onSpawnSpecialist={handleSelectSpecialist}
          workspaceWindowId={workspaceWindowId}
          workspaces={visibleWorkspaces}
          activeWorkspaceId={windowActiveWorkspaceId}
          activeScopes={activeCommandScopes}
          commandAvailability={commandAvailability}
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
      applySprintEngineAutomationStopReason(workspaceId, 'agent_terminal_closed', { agentId })
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

// Stop the process behind a live terminal without closing its tab. The focused
// terminal tab wins; otherwise the workspace's first live terminal session is
// stopped. This succeeds whenever the workspace has a live terminal, so it
// matches the command's `terminalActive` availability exactly (no
// available-but-no-op gap). Returns false only when no live terminal exists.
function stopActiveTerminal(
  workspaceId: string,
  terminalSessions: TerminalSessionSnapshot[],
): boolean {
  const model = getModel(workspaceId)
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  const selectedNode = tabset?.getChildren()[tabset.getSelected()]
  if (selectedNode instanceof TabNode && selectedNode.getComponent() === 'terminal') {
    killTerminalForLayoutTab(workspaceId, selectedNode, terminalSessions)
    return true
  }
  const session = terminalSessions.find((item) =>
    item.kind === 'terminal' && item.workspaceId === workspaceId && item.terminalId,
  )
  if (!session?.terminalId) return false
  const sessionIds = new Set<string>([`terminal-${session.terminalId}`])
  terminalSessions
    .filter((item) =>
      item.kind === 'terminal' && item.workspaceId === workspaceId && item.terminalId === session.terminalId,
    )
    .forEach((item) => sessionIds.add(item.sessionId))
  sessionIds.forEach((sessionId) => {
    void window.api.terminalKill(sessionId).catch(() => {})
  })
  return true
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
