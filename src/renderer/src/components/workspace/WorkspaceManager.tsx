import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import { useShallow } from 'zustand/react/shallow'
import CommandPalette from '../CommandPalette'
import DiagnosticsOverlay from '../diagnostics/DiagnosticsOverlay'
import { TipStartupModal } from '../learn/TipStartupModal'
import OnboardingFlow from '../onboarding/OnboardingFlow'
import { planDeferredAdoption } from '../onboarding/agentConfigAdoption'
import SettingsOverlay from '../settings/SettingsOverlay'
import { SuspenseFallback } from '../ui/SuspenseFallback'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { shouldOpenStartupTipOnComplete } from '../../store/onboardingState'
import type { SoloChatSeed } from '../../store/slices/workspacesSlice'
import { normalizeSelectedCli } from '../../store/slices/settingsSlice'
import { resolveAvailableAgentCli, resolveSurfaceModel, resolveTemplateAgentCli, selectAgentCliCatalog } from './newWorkspace/cliRuntimeOptions'
import { resumeCapabilitiesForCli, subscribePluginCatalogRefreshOnFocus } from '../../store/slices/pluginsSlice'
import type { ConversationCliRuntimeOverrides } from '../../../../shared/conversation-runtime'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import { resolveNotificationActions as resolveNotificationActionsFor } from '../../utils/notificationActions'
import {
  deriveWorkspaceIdleSince,
  deriveWorkspaceLastInputAt,
  deriveWorkspaceTerminalActivity,
  getTerminalSessionsSignature,
  refreshTerminalSessions,
  subscribeLiveTerminalSessionSnapshots,
} from '../../hooks/useTerminalSessions'
import { useAppTheme } from '../../hooks/useAppTheme'
import { useAutomationRequests } from '../../hooks/useAutomationRequests'
import { useVoiceDictation } from '../../hooks/useVoiceDictation'
import { useConversationSessions } from '../../hooks/useConversationSessions'
import {
  MULTILOOP_ROLES,
  GENERAL_AGENT_ENGINE_KEY,
  SPECIALIST_ACTIONS,
  getMultiloopRole,
  getSpecialistAction,
  buildSpecialistSoulStartupPrompt,
  loadMultiloopPrompt,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
  AgentCliModelSelection,
  AppNotification,
  FuturePlanWorkspaceSource,
  LayoutTemplate,
  MultiloopRole,
  SpecialistActionId,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleId,
  SprintEngineRoleModelOverrides,
  Workspace,
  WorkspaceMode,
  WorkspaceWindowId,
  WorkspaceWorktree,
} from '../../types/workspace'
import {
  connectorStartupPrompt,
  connectorWorktreePaths,
} from '../../utils/workspaceWorktree'
import { resolveConnectorLaunch } from '../../utils/connectorLaunch'
import { resolveSkillInvocation } from '../../../../shared/skill-invocation'
import { pickRandomAgentName } from '../../utils/agentNames'
import { normalizeAgentIdentifier, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { applySprintEngineAutomationStopReason } from '../../utils/sprintengineSupervisorNotifications'
import { addAgentTabTiled, addTerminalTab, focusOrAddAgentTab, focusOrAddFileTab, focusOrAddTerminalTab, getModel, jsonModelHasComponent, revealNavRailComponent, togglePanelRailComponent } from '../../utils/modelRegistry'
import { MULTICODE_DISABLE_SPRINTENGINE_SYNC } from '../../utils/runtimeFlags'
import { agentCliSupportsConversationResume, agentCliUsesStableSessionIdForResume } from '../../utils/agentCliResume'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { type NewWorkspacePanelInitialState } from './NewWorkspacePanel'
import { type AgentComposerConfirm, type AgentComposerSelection } from './agentComposer/AgentComposer'
import AgentComposerPopover from './agentComposer/AgentComposerPopover'
import MultiloopStateSynchronizer from './MultiloopStateSynchronizer'
import SprintEngineProjectionSupervisor from './SprintEngineProjectionSupervisor'
import SprintEnginePullRequestPollSupervisor from './SprintEnginePullRequestPollSupervisor'
// Always-on observer of background automation run events (raises run
// notifications). Automations is no longer a workspace type, so the shell mounts
// its global supervisor directly, gated on the automations module + primary
// window — the same role the workspace-type `supervisors` list used to play.
import AutomationsRunSupervisor from '../automations/AutomationsRunSupervisor'
import WorkspaceLayout from './WorkspaceLayout'
import WorkspaceSidebar from './WorkspaceSidebar'
import SprintEnginesAside from './SprintEnginesAside'
import { beginSidebarTransition } from '../../utils/sidebarTransition'
import { isHiddenFromRail } from '../../utils/workspaceVisibility'
import { WORKSPACE_LAYER_REVEAL_EVENT } from '../../utils/terminalFitScheduler'
import { SidebarChrome } from './SidebarChrome'
import { WorkspaceHeader } from './WorkspaceHeader'
import { WindowControls } from './WindowControls'
import { WorkspaceIdentity } from './WorkspaceIdentity'
import { WorkspaceActions, type SessionItem } from './WorkspaceActions'
import { AGENT_SPAWN_PERMISSION_OPTIONS } from './agentComposer/agentSpawnShared'
import {
  buildMultiloopSpawnPrompt,
  buildSidebarWorkspaceOrder,
  getSessionItems,
  getWorkspaceActivity,
  uniqueAgentName,
  type WorkspaceActivity,
} from './workspaceManagerHelpers'
import { attentionQueueBadge, buildAttentionQueueItems } from '../../utils/attentionQueue'
import { residentAgentWorkspaceIds } from '../../utils/workspaceResidency'
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
import {
  computeRetainedWorkspaceLayoutIds,
  WORKSPACE_LAYOUT_BUSY_RETAINED_LIMIT,
  WORKSPACE_LAYOUT_IDLE_UNLOAD_MS,
  WORKSPACE_LAYOUT_RETAINED_INACTIVE_LIMIT,
  WORKSPACE_LAYOUT_WARM_HIDDEN_LIMIT,
  type WorkspaceLayoutRetentionReason,
} from './workspaceLayoutRetention'
import type { ConversationProviderListResult } from '../../../../shared/electron-api'
import { restoreDetachedWorkspaceWindowsOnStartup } from './workspaceWindowRestore'
import { EMPTY_CHAT_TEMPLATE, LAYOUT_TEMPLATES } from '../../layouts/templates'
import { collectWorkspaceTypeSupervisors } from '../../modules/workspace-type-supervisors'
import { RendererCommandDispatcher } from '../../commands/commandDispatcher'
import { getCommandDefinition } from '../../commands/commandRegistry'
import { getElectronAccelerator } from '../../commands/effectiveKeybindings'
import type { CommandAvailabilityContext } from '../../commands/availability'
import type { CommandScope } from '../../commands/types'
import { buildSprintEngineAgentRosterForState, buildSprintEngineRoleRegistry, computeSprintEngineFocusAgentAvailability } from '../../utils/sprintengine'
import { isGlobalShortcutSuppressedTarget } from '../../utils/keyboard'

// Lazy so the (large) new-workspace wizard — and everything it pulls in
// (GuidedBriefFlow, the markdown renderer) — is code-split out of the eager boot
// chunk and only fetched when the user opens "new workspace". Rendered only when
// showNewWorkspacePanel is true.
const NewWorkspacePanel = React.lazy(() => import('./NewWorkspacePanel'))
// The pre-creation New Chat panel — agent + engine chooser that creates nothing
// until the user starts the chat. Code-split like NewWorkspacePanel; rendered
// only when showNewChatPanel is true.
const NewChatPanel = React.lazy(() => import('./agentComposer/NewChatPanel'))

// The Connectors surface (browse / install / launch). Code-split and mounted only
// while its store overlay is open, so its catalog reads never run on boot. Opened
// via the store `openConnectorsSurface` action (the sidebar entry T5 targets).
const ConnectorsSurface = React.lazy(() => import('../panels/ConnectorsPanel'))

// Display name for a New Chat project scope: the folder's last path segment.
function newChatFolderLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

// Automations is a content-area destination (not a modal): it renders inside the
// workspace card in place of workspace content, like the new-workspace panel.
// Lazy so the control center + schema-driven editor stay out of the boot chunk.

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const
const EMPTY_SPECIALIST_CLI_DEFAULTS: Partial<Record<SpecialistActionId, AgentCli>> = {}
const EMPTY_MULTILOOP_ROLE_CLI_DEFAULTS: Partial<Record<MultiloopRole, AgentCli>> = {}
const EMPTY_SPECIALIST_MODEL_DEFAULTS: Partial<Record<SpecialistActionId, AgentCliModelSelection>> = {}
const EMPTY_MULTILOOP_ROLE_MODEL_DEFAULTS: Partial<Record<MultiloopRole, AgentCliModelSelection>> = {}
const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}

const TERMINAL_SESSION_RECOVERY_POLL_MS = 30_000
const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'
const SOLO_CHAT_TEMPLATE = LAYOUT_TEMPLATES.find((template) => template.id === 'solo') ?? null
const MENU_ACCELERATOR_COMMAND_IDS = [
  'app.settings.open',
  'panel.files.toggle',
  'panel.editor.toggle',
  'panel.git.toggle',
  'panel.knowledge-graph.toggle',
] as const

type WorkspaceManagerWorkspaceCacheEntry = {
  source: Workspace
  value: Workspace
}

const workspaceManagerWorkspaceCache = new Map<string, WorkspaceManagerWorkspaceCacheEntry>()

function workspaceManagerWorkspaceFieldsEqual(left: Workspace, right: Workspace): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.mode === right.mode
    && left.folderPath === right.folderPath
    && left.folderMissing === right.folderMissing
    && left.sprintEngineContext === right.sprintEngineContext
    && left.multiloopContext === right.multiloopContext
    && left.templateId === right.templateId
    && left.layoutModel === right.layoutModel
    && left.worktreeState === right.worktreeState
    && left.memory === right.memory
    && left.editorState === right.editorState
    && left.fileExplorerState === right.fileExplorerState
    && left.sprintEngineState === right.sprintEngineState
    && left.multiloopState === right.multiloopState
    && left.sprintEngineRoleCliDefaults === right.sprintEngineRoleCliDefaults
    && left.sprintEngineInitialSpawnAgentIds === right.sprintEngineInitialSpawnAgentIds
    && left.sprintEngineAutoState === right.sprintEngineAutoState
    && left.multiloopAutoState === right.multiloopAutoState
    && left.guidedBriefState === right.guidedBriefState
    && left.highlight === right.highlight
    && left.createdAt === right.createdAt
    && left.lastTerminalActivityAt === right.lastTerminalActivityAt
}

function selectWorkspaceManagerWorkspaces(workspaces: Workspace[]): Workspace[] {
  const liveIds = new Set<string>()
  const selected = workspaces.map((workspace) => {
    liveIds.add(workspace.id)
    const cached = workspaceManagerWorkspaceCache.get(workspace.id)
    if (cached && workspaceManagerWorkspaceFieldsEqual(cached.source, workspace)) {
      return cached.value
    }
    workspaceManagerWorkspaceCache.set(workspace.id, { source: workspace, value: workspace })
    return workspace
  })

  for (const workspaceId of workspaceManagerWorkspaceCache.keys()) {
    if (!liveIds.has(workspaceId)) workspaceManagerWorkspaceCache.delete(workspaceId)
  }

  return selected
}

export default function WorkspaceManager() {
  useAppTheme()
  const dialog = useConfirmDialog()
  const workspaceWindowId = useMemo(() => getWorkspaceWindowIdFromLocation(), [])
  // App-automation MCP mutations delegate to the primary window so they run the
  // same store actions as the UI (see src/main/automation/).
  useAutomationRequests(workspaceWindowId)
  // Dock-back from the external editor window: the window owning that workspace's
  // FlexLayout model reopens the file as a tab and flips the sticky preference
  // back to tabs; windows that do not own the workspace no-op.
  useEffect(() => {
    if (typeof window.api.onDockFileToWorkspace !== 'function') return
    return window.api.onDockFileToWorkspace(({ workspaceId, path, name }) => {
      if (focusOrAddFileTab(workspaceId, path, name)) {
        useWorkspaceStore.getState().setOpenFilesInExternalWindow(false)
      }
    })
  }, [])
  // Startup tidiness sweep: archive workspaces idle for 5+ days (pinned states,
  // starred rows, and every window's active workspace never qualify). Once per
  // window mount — the sweep is idempotent, so a second window re-running it is
  // harmless.
  useEffect(() => {
    useWorkspaceStore.getState().archiveStaleWorkspaces()
  }, [])
  const workspaces = useWorkspaceStore(useShallow((s) => selectWorkspaceManagerWorkspaces(s.workspaces)))
  const workspaceWindows = useWorkspaceStore((s) => s.workspaceWindows)
  const primaryWorkspaceWindowId = useWorkspaceStore((s) => s.primaryWorkspaceWindowId)
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)
  const multiloopEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'multiloop'))
  const sprintEngineEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'sprint-engine'))
  const mobileRelayEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'mobile-relay'))
  const automationsEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'automations'))
  const voiceDictationEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'voice-dictation'))
  const voiceDictation = useVoiceDictation()
  const onboardingStep = useWorkspaceStore((s) => s.appSettings.onboardingStep)
  const setOnboardingStep = useWorkspaceStore((s) => s.setOnboardingStep)
  // Deferred first-run config adoption (T3): the essentials step records which
  // detected MCP servers / skills to adopt; the real adoptAgentConfig IPC runs
  // here, once, against the newly-created workspace root.
  const pendingAgentConfigAdoption = useWorkspaceStore((s) => s.appSettings.pendingAgentConfigAdoption)
  const setPendingAgentConfigAdoption = useWorkspaceStore((s) => s.setPendingAgentConfigAdoption)
  const setAgentConfigAdoptionResult = useWorkspaceStore((s) => s.setAgentConfigAdoptionResult)
  const setActiveWorkspaceForWindow = useWorkspaceStore((s) => s.setActiveWorkspaceForWindow)
  const registerWorkspaceWindow = useWorkspaceStore((s) => s.registerWorkspaceWindow)
  const updateWorkspaceWindowPlacement = useWorkspaceStore((s) => s.updateWorkspaceWindowPlacement)
  const closeWorkspaceWindow = useWorkspaceStore((s) => s.closeWorkspaceWindow)
  const moveWorkspaceToWindow = useWorkspaceStore((s) => s.moveWorkspaceToWindow)
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const sidebarCollapsed = useWorkspaceStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useWorkspaceStore((s) => s.setSidebarCollapsed)
  const sidebarWidth = useWorkspaceStore((s) => s.sidebarWidth)
  const setSidebarWidth = useWorkspaceStore((s) => s.setSidebarWidth)
  const sprintEnginesAsideOpen = useWorkspaceStore((s) => s.sprintEnginesAsideOpen)
  const setSprintEnginesAsideOpen = useWorkspaceStore((s) => s.setSprintEnginesAsideOpen)
  const setSprintEngineRoleRegistry = useWorkspaceStore((s) => s.setSprintEngineRoleRegistry)
  const settingsOverlayOpen = useWorkspaceStore((s) => s.settingsOverlay.open)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const closeSettingsOverlay = useWorkspaceStore((s) => s.closeSettingsOverlay)
  const connectorsSurfaceOpen = useWorkspaceStore((s) => s.connectorsSurface.open)
  const closeConnectorsSurface = useWorkspaceStore((s) => s.closeConnectorsSurface)
  const forgetFolder = useWorkspaceStore((s) => s.forgetFolder)
  const recordWorkspaceTerminalActivity = useWorkspaceStore((s) => s.recordWorkspaceTerminalActivity)
  const reconcileWorkspaceAgentLaunchFlags = useWorkspaceStore((s) => s.reconcileWorkspaceAgentLaunchFlags)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const lastSelectedCli = useWorkspaceStore((s) => normalizeSelectedCli(s.appSettings.lastSelectedCli))
  const setSpecialistCliDefault = useWorkspaceStore((s) => s.setSpecialistCliDefault)
  const rememberedConversationModel = useWorkspaceStore((s) => s.appSettings.lastSelectedConversationModel)
  const setLastSelectedConversationModel = useWorkspaceStore((s) => s.setLastSelectedConversationModel)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const lastSelectedSpecialist = useWorkspaceStore(
    (s) => s.appSettings.lastSelectedSpecialist ?? SPECIALIST_ACTIONS[0].id
  )
  const setLastSelectedSpecialist = useWorkspaceStore((s) => s.setLastSelectedSpecialist)
  const lastNewChatAgent = useWorkspaceStore((s) => s.appSettings.lastNewChatAgent)
  const setLastNewChatAgent = useWorkspaceStore((s) => s.setLastNewChatAgent)
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
  const specialistModelDefaults = useWorkspaceStore(
    (s) => s.appSettings.specialistModelDefaults ?? EMPTY_SPECIALIST_MODEL_DEFAULTS
  )
  const multiloopRoleModelDefaults = useWorkspaceStore(
    (s) => s.appSettings.multiloopRoleModelDefaults ?? EMPTY_MULTILOOP_ROLE_MODEL_DEFAULTS
  )
  const keybindingSettings = useWorkspaceStore((s) => s.appSettings.keybindings)
  const notifications = useNotificationStore((s) => s.notifications)
  const markNotificationRead = useNotificationStore((s) => s.markRead)
  const markAllNotificationsRead = useNotificationStore((s) => s.markAllRead)
  const clearNotifications = useNotificationStore((s) => s.clearAll)

  // Resolve a notification's Open action(s). Two layers (see
  // backlog/2026-06-14-notification-open-action-deep-link.md): the owning
  // module's registered provider can return a deep-focus action (e.g. open the
  // Sprint Engine task, or open the Automations screen at a run), and the shell
  // guarantees a generic workspace-reveal fallback for any notification that
  // names a workspace. Provider actions are offered whether or not the
  // notification names a workspace — a provider can deep-link to an app-level
  // screen that has no backing workspace (Automations). Only the generic
  // reveal fallback needs a workspaceId. Provider modules that are disabled drop
  // out, exactly like Backlog item actions.
  const resolveNotificationActions = useCallback(
    (notification: AppNotification) =>
      resolveNotificationActionsFor({
        notification,
        providers: getRendererHost().getNotificationActionProviders((moduleId) =>
          selectModuleEnabled(moduleEnablement, moduleId),
        ),
        revealWorkspace: (id) => setActiveWorkspaceForWindow(workspaceWindowId, id),
      }),
    [moduleEnablement, setActiveWorkspaceForWindow, workspaceWindowId]
  )

  const currentWorkspaceWindow = useMemo(
    () => workspaceWindows.find((windowState) => windowState.id === workspaceWindowId)
      ?? workspaceWindows.find((windowState) => windowState.id === primaryWorkspaceWindowId)
      ?? null,
    [primaryWorkspaceWindowId, workspaceWindowId, workspaceWindows]
  )
  const isPrimaryWorkspaceWindow = workspaceWindowId === (primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID)
  const showSprintEnginesAside = sprintEngineEnabled && sprintEnginesAsideOpen
  const visibleWorkspaceIdSet = useMemo(
    () => new Set(currentWorkspaceWindow?.workspaceIds ?? workspaces.map((workspace) => workspace.id)),
    [currentWorkspaceWindow, workspaces]
  )
  const visibleWorkspaces = useMemo(
    () => workspaces.filter((workspace) => visibleWorkspaceIdSet.has(workspace.id)),
    [visibleWorkspaceIdSet, workspaces]
  )
  // Rail-navigable subset of this window's workspaces: the background Automations
  // host stays assigned and mounted (it is in `visibleWorkspaces`) but is never a
  // rail row, a switch target, or counted toward "has a workspace". Navigation,
  // keyboard switching, and the empty-state derive from this list so a lone
  // hidden host never strands the user on a blank rail.
  const railWorkspaces = useMemo(
    () => visibleWorkspaces.filter((workspace) => !isHiddenFromRail(workspace)),
    [visibleWorkspaces]
  )
  const railWorkspaceIdSet = useMemo(
    () => new Set(railWorkspaces.map((workspace) => workspace.id)),
    [railWorkspaces]
  )
  const windowActiveWorkspaceId =
    currentWorkspaceWindow?.activeWorkspaceId && visibleWorkspaceIdSet.has(currentWorkspaceWindow.activeWorkspaceId)
      // An explicitly-activated workspace is honored even when it is a hidden
      // host (the T5 reveal path sets it). Only the implicit fallback refuses to
      // auto-activate a hidden host, so a lone host yields a null active id and
      // the "no workspaces" empty state instead of stranding the user on it.
      ? currentWorkspaceWindow.activeWorkspaceId
      : railWorkspaces[0]?.id ?? null
  const activeWorkspace = visibleWorkspaces.find((workspace) => workspace.id === windowActiveWorkspaceId) ?? null
  // Load the Sprint Engine role registry for the active workspace so the spawn
  // dropdown and Specialist packs settings tab can surface registry-discovered
  // specialist packs (workspace / user / plugin layers) alongside the bundled
  // pack. In-memory only; re-fetched when the active workspace folder changes.
  const activeWorkspaceFolderPath = activeWorkspace?.folderPath ?? null
  useEffect(() => {
    // The registry read requires an absolute, existing workspace root, so skip
    // the call (and clear any prior registry) when no folder-backed workspace is
    // active — the dropdown then falls back to the bundled pack.
    if (!activeWorkspaceFolderPath || typeof window.api.readSprintEngineRegistryRoles !== 'function') {
      setSprintEngineRoleRegistry(null)
      return
    }
    let cancelled = false
    void window.api
      .readSprintEngineRegistryRoles({ workspaceRoot: activeWorkspaceFolderPath, includeShadowed: false })
      .then((result) => {
        if (cancelled) return
        setSprintEngineRoleRegistry(result.ok ? buildSprintEngineRoleRegistry(result.data) : null)
      })
      .catch(() => {
        if (!cancelled) setSprintEngineRoleRegistry(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceFolderPath, setSprintEngineRoleRegistry])
  const mobileWorkspaceRootKey = workspaces
    .map((workspace) => workspace.folderPath)
    .filter((folderPath): folderPath is string => Boolean(folderPath?.trim()))
    .join('\n')
  const selectedSpecialistAction = getSpecialistAction(lastSelectedSpecialist)
  const selectedMultiloopRoleDescriptor = getMultiloopRole(lastSelectedMultiloopRole)
  const multiloopLaunchMenu = activeWorkspace?.mode === 'multiloop'

  const [showNewWorkspacePanel, setShowNewWorkspacePanel] = useState(false)
  const [newWorkspacePanelInitialState, setNewWorkspacePanelInitialState] = useState<NewWorkspacePanelInitialState | null>(null)
  // The pre-creation New Chat panel's scope. Present while the panel is open;
  // folderPath is the project the chat lands in (null → inherit active), and
  // folderLabel names it in the panel's scoping chip.
  const [newChatPanelState, setNewChatPanelState] = useState<{ folderPath: string | null; folderLabel: string | null } | null>(null)
  const newChatPanelOpen = newChatPanelState !== null
  const [tipModalOpen, setTipModalOpen] = useState(false)
  const tipModalDecidedRef = useRef(false)
  // True once onboarding has been observed active (any non-complete step) this
  // session. A user who just walked through first-run onboarding should not be
  // hit with the one-shot startup tip on top of the activation payoff — it both
  // piles a second modal on the moment of completion and (because the tip Modal
  // has no focus trap) lets Tab/Shift+Tab leak to the workspace terminal behind
  // it. The tip returns to normal on the next launch, where onboardingStep is
  // already 'complete' from the first render and this ref stays false.
  const onboardingWasActiveRef = useRef(false)
  const showTipsOnStartup = useWorkspaceStore((s) => s.appSettings.learning?.showTipsOnStartup ?? true)
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? EMPTY_PROJECT_KNOWLEDGE_ROOTS)
  const [showPalette, setShowPalette] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [specialistMenuOpen, setSpecialistMenuOpen] = useState(false)
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
  // Debug Mode is intentionally transient and never persisted (unlike the
  // permission preset): it defaults off and resets off after each spawn, so a
  // debug agent never silently leaves the next unrelated spawn in debug.
  const [agentSpawnDebugMode, setAgentSpawnDebugMode] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  // Title-bar Attention Queue open state — a transient popover, so renderer-local
  // (never persisted), shared with the panel.attention-queue.toggle command.
  const [attentionQueueOpen, setAttentionQueueOpen] = useState(false)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [viewMenuTick, setViewMenuTick] = useState(0)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionSnapshot[]>([])
  // Conversation (chat) agents live outside the terminal runtime; their
  // session summaries feed the session manager alongside PTY snapshots.
  const conversationSessions = useConversationSessions()
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
  const terminalSessionsSignatureRef = useRef('')
  const reportedTerminalLastInputRef = useRef<Map<string, number>>(new Map())
  const reconciledLaunchFlagsRef = useRef(false)
  const workspaceLayoutLastFocusedAtRef = useRef<Record<string, number>>({})
  const workspaceLayoutRetentionReasonsRef = useRef<Record<string, WorkspaceLayoutRetentionReason>>({})
  // Last terminal-visibility we pushed to main per session, so the painting
  // effect only fires an IPC call on an actual transition.
  const appliedTerminalVisibilityRef = useRef<Map<string, boolean>>(new Map())
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
    const commandWorkspace = windowActiveWorkspaceId
      ? useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId) ?? null
      : null
    const context: CommandAvailabilityContext = {}
    if (workspaceActionsEnabled) context.activeWorkspace = true
    // The performance diagnostics panel is an engineering tool, offered only in
    // dev or when MULTICODE_DIAGNOSTICS=1 (matching the View-menu gate).
    if (window.api.isDevelopment || window.api.isDiagnosticsEnabled) context.diagnosticsEnabled = true
    if (voiceDictationEnabled) context.voiceDictationEnabled = true
    // The Knowledge Graph toggle is the panel's only entry point (no rail
    // glyph), so its availability tracks the memory-graph module directly.
    if (selectModuleEnabled(moduleEnablement, 'memory-graph')) context.memoryGraphEnabled = true
    // The Sprint Engines aside is app-level chrome, so its toggle tracks the
    // sprint-engine module rather than any active workspace.
    if (selectModuleEnabled(moduleEnablement, 'sprint-engine')) context.sprintEngineEnabled = true
    // The global Automations screen needs the automations module (its store/IPC).
    if (selectModuleEnabled(moduleEnablement, 'automations')) context.automationsEnabled = true
    if (activeCommandScopes.includes('panel:sprintengine')) {
      context.sprintengineWorkspace = true
      const sprintEngineState = commandWorkspace?.sprintEngineState ?? null
      const roster = buildSprintEngineAgentRosterForState(sprintEngineState)
      if (roster.some((agent) => agent.role === 'architect')) context.sprintengineHasArchitect = true
      const focusAvailability = computeSprintEngineFocusAgentAvailability(sprintEngineState, commandWorkspace?.agents ?? {})
      if (focusAvailability.showFocusAgentAction) context.sprintengineFocusAgentVisible = true
    }
    if (activeCommandScopes.includes('panel:multiloop')) {
      context.multiloopWorkspace = true
      if (commandWorkspace?.multiloopState) context.multiloopStateLoaded = true
    }
    if (activeCommandScopes.includes('panel:switchboard')) context.switchboardWorkspace = true
    if (commandWorkspace?.layoutModel && jsonModelHasComponent(commandWorkspace.layoutModel, 'git')) {
      context.gitPanelActive = true
    }
    if (terminalSessions.some((session) =>
      session.kind === 'terminal' && session.workspaceId === commandWorkspace?.id && session.terminalId,
    )) {
      context.terminalActive = true
    }
    return context
  }, [
    workspaceActionsEnabled,
    voiceDictationEnabled,
    moduleEnablement,
    activeCommandScopes,
    windowActiveWorkspaceId,
    terminalSessions,
  ])
  const sessions = getSessionItems(
    useWorkspaceStore.getState().workspaces.filter((workspace) => visibleWorkspaceIdSet.has(workspace.id)),
    terminalSessions,
    conversationSessions,
  )
  const sidebarWorkspaceOrder = useMemo(
    () => buildSidebarWorkspaceOrder(railWorkspaces),
    [railWorkspaces]
  )
  // Cross-workspace "agents awaiting you" for the title-bar Attention Queue. Rides
  // the already-subscribed `workspaces` slice (sprintEngineState is dedup-stable
  // via selectWorkspaceManagerWorkspaces, so an unrelated projection tick leaves
  // this referentially equal) and the dedup-stable terminalSessions — no new
  // subscription. Derived over ALL workspaces, not just this window's, so agents
  // in another window still surface (rendered disabled by the popover).
  const attentionItems = useMemo(
    () => buildAttentionQueueItems(workspaces, terminalSessions),
    [workspaces, terminalSessions]
  )
  const attentionBadge = useMemo(() => attentionQueueBadge(attentionItems), [attentionItems])
  // The bell badge is an error counter: only unread errors increment it (and
  // drive the red just-changed pulse), so a flood of info/warning notifications
  // never inflates the count. Warnings/info still appear in the popover list and
  // are reachable through its severity filters.
  const unreadErrorCount = notifications.filter(
    (notification) => !notification.read && notification.level === 'error'
  ).length
  const settingsOpen = settingsOverlayOpen
  const ownsGlobalSupervisors = isPrimaryWorkspaceWindow
  const renderedWorkspaceIds = visibleWorkspaces
    .map((workspace) => workspace.id)
    .filter((workspaceId) => workspaceId === windowActiveWorkspaceId || mountedWorkspaceIds.includes(workspaceId))
  // "Warm" layers stay fully composited behind the active one so switching back
  // to a recently-used workspace is instant. Everything beyond the warm set is
  // kept mounted but rendered with `content-visibility: hidden` (see the render
  // map below), so the compositor skips its per-frame work — that is the
  // scroll-jank fix. Warm = the most-recently-focused inactive layers, ranked by
  // the same last-focused clock the retention policy uses.
  const warmHiddenWorkspaceIdSet = useMemo(() => {
    const lastFocusedAt = workspaceLayoutLastFocusedAtRef.current
    const warm = renderedWorkspaceIds
      .filter((workspaceId) => workspaceId !== windowActiveWorkspaceId)
      .sort((a, b) => (lastFocusedAt[b] ?? 0) - (lastFocusedAt[a] ?? 0))
      .slice(0, WORKSPACE_LAYOUT_WARM_HIDDEN_LIMIT)
    return new Set(warm)
  }, [renderedWorkspaceIds, windowActiveWorkspaceId])
  const workspaceTypeSupervisors = useMemo(() => {
    const moduleEnabled = (moduleId: string) => selectModuleEnabled(moduleEnablement, moduleId)
    return collectWorkspaceTypeSupervisors(
      getRendererHost().getWorkspaceTypes(moduleEnabled),
      ownsGlobalSupervisors,
    )
  }, [moduleEnablement, ownsGlobalSupervisors])
  // The merge point output for keyboard dispatch: shell registry + enabled
  // module commands. Recomputed when enablement changes, so toggling a module
  // adds/removes its keybindings without a reload.
  const commandContributions = useMemo(
    () => getRendererHost().getCommandContributions((moduleId) => selectModuleEnabled(moduleEnablement, moduleId)),
    [moduleEnablement],
  )

  const openNewWorkspacePanel = useCallback(() => {
    setNewWorkspacePanelInitialState(null)
    setShowNewWorkspacePanel(true)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
  }, [closeSettingsOverlay])

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
    () =>
      selectAgentCliCatalog(pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, {
        map: cliAvailability,
        status: cliAvailabilityStatus,
      }),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus],
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
      .conversationProvidersList({ cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides })
      .then((result) => {
        if (!cancelled) setConversationProviderResult(result)
      })
      .catch(() => {
        if (!cancelled) setConversationProviderResult(null)
      })
    return () => {
      cancelled = true
    }
  }, [specialistMenuOpen, conversationSpawnEnabled, cliRuntimes])
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
    // Marks the new solo chat as worktree-backed (connector chats). `folderPath`
    // must already point at the worktree so resolveWorkspaceWorktree resolves the
    // Git view/glyph to it.
    worktree?: WorkspaceWorktree
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
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
    })
    setShowNewWorkspacePanel(false)
    setNewWorkspacePanelInitialState(null)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
    // Creating the first workspace finishes onboarding outright — no payoff
    // overlay. Jump straight to 'complete' regardless of the current step.
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
    // A plain New chat is a General agent, so it rides General's own remembered
    // CLI (falling back to the global default), never the reverse. The result is
    // clamped to an installed catalog entry so a stale value cannot seed a chat
    // with an uninstalled plugin id; explicit picks come from the catalog already.
    // A plain New chat is a General agent, so it rides General's own keyed
    // engine default (falling back to the global default), exactly like a
    // specialist. Clamped to an installed catalog entry so a stale value cannot
    // seed a chat with an uninstalled plugin id.
    const templateAgentCli = resolveTemplateAgentCli(
      chosenCli ?? specialistCliDefaults[GENERAL_AGENT_ENGINE_KEY],
      lastSelectedCli,
      agentCliCatalog,
    )
    // Ride the remembered General model when it belongs to the spawning CLI —
    // the same mechanism as a specialist. Seeded via an agentPatch (no tabName,
    // so the layout is untouched). The patch always carries the composer's
    // permission preset and debug mode: a General chat honors the picked
    // Default/Auto/Bypass exactly like a specialist chat does.
    const cliModel = resolveSurfaceModel(templateAgentCli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY])
    createSoloChatWorkspace({
      folderPath,
      templateAgentCli,
      seedAgent: {
        agentPatch: {
          ...(cliModel ? { cliModel } : {}),
          cliPermissionPreset: agentSpawnPermissionPreset,
          debugMode: agentSpawnDebugMode,
        },
      },
    })
    // Remember an explicit pick as General's own default — never the shared
    // lastSelectedCli, so a new-chat CLI never bleeds into the specialists.
    if (chosenCli) setSpecialistCliDefault(GENERAL_AGENT_ENGINE_KEY, chosenCli)
    if (agentSpawnDebugMode) setAgentSpawnDebugMode(false)
  }, [agentCliCatalog, agentSpawnDebugMode, agentSpawnPermissionPreset, createSoloChatWorkspace, specialistCliDefaults, specialistModelDefaults, lastSelectedCli, setSpecialistCliDefault])

  // Launch an isolated connector chat for any catalog entry carrying a `skill`
  // link: a fresh worktree on `connector/<id>-<uid>`, opened as a worktree-backed
  // solo chat whose spawn carries ONLY that connector's MCP (never the global
  // appSettings.mcp) plus its driving skill. Exactly one worktree per connector
  // chat — a new id (and so a new worktree) is minted on every invocation. This is
  // the single connector runtime: Railway's Command Palette entry, the Connectors
  // surface, and connector automations all funnel through it. A catalog entry with
  // no `skill` is not a connector and is refused (no silent fallback).
  const launchConnectorChat = useCallback(async (serverId: string) => {
    const connectorError = (title: string, message: string) =>
      publishDiagnosticSync({ level: 'error', source: 'workspace', title, message })

    const baseFolderPath = activeWorkspace?.folderPath
    if (!baseFolderPath) {
      connectorError('Connector needs a project', 'Open a project folder before launching a connector chat.')
      return
    }
    const repoRoot = await window.api.getGitRepoRoot(baseFolderPath)
    if (!repoRoot) {
      connectorError(
        'Connector needs a git repository',
        'The current project is not a git repository, so a connector worktree cannot be created.',
      )
      return
    }
    const resolution = await resolveConnectorLaunch(serverId)
    if (!resolution.ok) {
      connectorError(resolution.title, resolution.message)
      return
    }
    const { server, skillId, mcpSettings } = resolution.resolved

    const uid = crypto.randomUUID().slice(0, 8)
    const { containerPath, destinationPath, branchName } = connectorWorktreePaths(repoRoot, serverId, uid)
    const worktreeResult = await window.api.createGitWorktree({
      repoRoot,
      containerPath,
      destinationPath,
      branchName,
      baseRef: 'HEAD',
      copyIncludedFiles: false,
    })
    if (!worktreeResult.ok) {
      connectorError('Connector worktree failed', worktreeResult.message)
      return
    }

    // Same CLI/model resolution as a plain New chat, so the connector rides the
    // General engine default. The skill invocation is CLI-native (e.g.
    // `/use-railway` vs `Use $use-railway.`); when the CLI declares no native
    // skill support connectorStartupPrompt falls back to the plain instruction.
    const cli = resolveTemplateAgentCli(
      specialistCliDefaults[GENERAL_AGENT_ENGINE_KEY],
      lastSelectedCli,
      agentCliCatalog,
    )
    const cliModel = resolveSurfaceModel(cli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY])
    const invocation = resolveSkillInvocation(
      pluginCatalogEntries.find((entry) => entry.id === cli)?.skillIntegration,
      skillId,
    )
    const startupPrompt = connectorStartupPrompt(
      invocation,
      `Show me my ${server.name} setup and flag anything that needs attention.`,
    )

    createSoloChatWorkspace({
      folderPath: worktreeResult.data.path,
      worktree: { branch: worktreeResult.data.branch ?? branchName, baseRef: 'HEAD' },
      name: `${server.name} · ${uid}`,
      templateAgentCli: cli,
      seedAgent: {
        agentPatch: {
          ...(cliModel ? { cliModel } : {}),
          connectorMcpSettings: mcpSettings,
          connectorSkillId: skillId,
          cliStartupPrompt: startupPrompt,
        },
      },
    })
  }, [
    activeWorkspace?.folderPath,
    agentCliCatalog,
    createSoloChatWorkspace,
    lastSelectedCli,
    pluginCatalogEntries,
    specialistCliDefaults,
    specialistModelDefaults,
  ])

  // "New chat" entry point: create a fresh workspace that opens empty so the
  // WorkspaceLauncher chooser shows (the user picks an agent / specialist / Sprint
  // Engine there). `folderPath === undefined` inherits the active workspace's
  // folder, matching the plain New chat default. No agent is seeded.
  const createLauncherChat = useCallback((folderPath?: string | null) => {
    const targetFolderPath = folderPath === undefined ? activeWorkspace?.folderPath ?? null : folderPath
    addWorkspace(EMPTY_CHAT_TEMPLATE, {
      name: pickNewChatName(targetFolderPath),
      folderPath: targetFolderPath,
      windowId: workspaceWindowId,
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

  const openNewWorkspacePanelForFolder = useCallback((folderPath: string) => {
    setNewWorkspacePanelInitialState({ folderPath })
    setShowNewWorkspacePanel(true)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
  }, [closeSettingsOverlay])

  // Open the creation hub preselected on a type — the sidebar "+" menu rows.
  const openNewWorkspacePanelWithMode = useCallback((mode: WorkspaceMode) => {
    setNewWorkspacePanelInitialState({ mode })
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

  const openFuturePlanWorkspace = useCallback((source: FuturePlanWorkspaceSource) => {
    setNewWorkspacePanelInitialState({
      mode: 'sprintengine',
      folderPath: source.folderPath,
      futurePlanSource: source,
    })
    setShowNewWorkspacePanel(true)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
  }, [closeSettingsOverlay])

  // The empty-workspace launcher's Sprint Engine path: open the New Workspace
  // panel pre-set to the team-setup flow (no source plan — "start a new team").
  const openSprintEngineSetup = useCallback(() => {
    setNewWorkspacePanelInitialState({ mode: 'sprintengine' })
    setShowNewWorkspacePanel(true)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
  }, [closeSettingsOverlay])

  const setAgentSpawnPermissionPreset = (preset: SprintEngineCliPermissionPreset) => {
    setAgentSpawnPermissionPresetState(preset)
    setLastAgentSpawnPermissionPreset(preset)
  }

  useEffect(() => {
    // Startup tips must never overlay first-run onboarding. While onboarding is
    // active (fresh launch or a mid-onboarding reload), keep the tip modal
    // actively closed — clearing it rather than just deferring guarantees no
    // lingering open state can sit behind the render gate.
    if (onboardingStep !== 'complete') {
      onboardingWasActiveRef.current = true
      setTipModalOpen(false)
      return
    }
    if (tipModalDecidedRef.current) return
    tipModalDecidedRef.current = true
    // A fresh onboarding that just reached 'complete' this session skips the
    // one-shot tip; existing installs (complete on the first render) still get
    // it. See shouldOpenStartupTipOnComplete for the rationale.
    if (
      !shouldOpenStartupTipOnComplete({
        onboardingActiveThisSession: onboardingWasActiveRef.current,
        showTipsOnStartup,
      })
    ) {
      return
    }
    setTipModalOpen(true)
  }, [showTipsOnStartup, onboardingStep])

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
        const store = useWorkspaceStore.getState()
        void store.refreshPluginCatalog({ background: true })
        // Re-detect installed agent CLIs in lockstep with the catalog so a CLI
        // installed/removed while away updates the deployment pickers too.
        void store.refreshCliAvailability({
          background: true,
          cliRuntimes: store.appSettings.cliRuntimes,
        })
      }),
    []
  )

  useEffect(() => {
    if (collapsedStaleDetachedWindowsRef.current) return
    collapsedStaleDetachedWindowsRef.current = true
    if (!isPrimaryWorkspaceWindow) return
    // Restore popped-out windows only on the genuine cold-start primary. macOS
    // keeps the app alive with zero windows and `activate` re-creates a primary
    // when the app regains focus; that window carries restoreDetached=0 so it
    // never respawns windows the user just closed (the "won't close / keeps
    // respawning" bug). The main process owns this one-shot per process.
    if (new URL(window.location.href).searchParams.get('restoreDetached') !== '1') return
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

  // Drive per-terminal paint visibility from the layer state. Active + warm
  // layers paint live (so flicking between the recently-used pool is instant);
  // cold layers (mounted but beyond the warm set — the workspaces you forgot
  // about) stop painting. The agent PTY keeps running and is supervised either
  // way: `visible` only gates whether main forwards output to the renderer's
  // xterm, so this trades nothing but wasted off-screen rendering. On reveal,
  // main re-sends the retained replay and the terminal resyncs. Only sessions
  // routed to THIS window are touched; a workspace lives in exactly one window,
  // so windows never fight over a session's visibility.
  useEffect(() => {
    const paintingWorkspaceIds = new Set<string>(warmHiddenWorkspaceIdSet)
    if (windowActiveWorkspaceId) paintingWorkspaceIds.add(windowActiveWorkspaceId)

    const applied = appliedTerminalVisibilityRef.current
    const liveSessionIds = new Set<string>()
    for (const session of terminalSessions) {
      const workspaceId = session.workspaceId
      if (typeof workspaceId !== 'string' || !visibleWorkspaceIdSet.has(workspaceId)) continue
      liveSessionIds.add(session.sessionId)
      const shouldPaint = paintingWorkspaceIds.has(workspaceId)
      if (applied.get(session.sessionId) === shouldPaint) continue
      applied.set(session.sessionId, shouldPaint)
      void window.api.terminalSetVisible(session.sessionId, shouldPaint).catch(() => {})
    }
    // Forget sessions that unmounted or moved to another window; their own
    // TerminalView teardown already set them hidden on the main side.
    for (const sessionId of [...applied.keys()]) {
      if (!liveSessionIds.has(sessionId)) applied.delete(sessionId)
    }
  }, [terminalSessions, warmHiddenWorkspaceIdSet, windowActiveWorkspaceId, visibleWorkspaceIdSet])

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
    if (!mobileRelayEnabled) return
    const roots = mobileWorkspaceRootKey.split('\n').filter(Boolean)
    void window.api.mobileBridgeUpdateWorkspaceRoots(roots).catch(() => {})
  }, [mobileRelayEnabled, mobileWorkspaceRootKey])

  useEffect(() => {
    // Auto-open the new-workspace panel when there are no workspaces — but during
    // onboarding hold off until the flow reaches its workspace step, so the panel
    // doesn't pop behind the welcome/modules overlay.
    if (railWorkspaces.length === 0 && (onboardingStep === 'workspace' || onboardingStep === 'complete')) {
      setShowNewWorkspacePanel(true)
    }
  }, [railWorkspaces.length, onboardingStep])

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

      // Persist "last typed" recency from lastInputAt, not lastOutputAt: opening a
      // workspace replays scrollback / triggers a TUI repaint, and counting that
      // output made every reopened workspace jump to "now". Only genuine input moves it.
      const lastInputByWorkspace = new Map<string, number>()
      for (const session of sessions) {
        if (typeof session.workspaceId !== 'string') continue
        if (typeof session.lastInputAt !== 'number') continue
        const current = lastInputByWorkspace.get(session.workspaceId)
        if (current === undefined || session.lastInputAt > current) {
          lastInputByWorkspace.set(session.workspaceId, session.lastInputAt)
        }
      }
      for (const [workspaceId, lastInputAt] of lastInputByWorkspace) {
        const lastReported = reportedTerminalLastInputRef.current.get(workspaceId)
        if (lastReported !== undefined && lastReported >= lastInputAt) continue
        reportedTerminalLastInputRef.current.set(workspaceId, lastInputAt)
        recordWorkspaceTerminalActivity(workspaceId, lastInputAt)
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

    const unsubscribe = subscribeLiveTerminalSessionSnapshots(applyTerminalSessions)
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
    setAttentionQueueOpen(false)
    setNotificationsOpen(false)
  }, [windowActiveWorkspaceId])

  const closeWorkspaceById = useCallback(
    (id: string) => {
      const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === id)
      if (workspace) terminateWorkspaceTerminals(workspace)
      removeWorkspace(id)
    },
    [removeWorkspace]
  )

  // Fire the deferred agent-config adoption against the just-created workspace
  // root. Runs at most once per onboarding: the selection is consumed up front so
  // a later create can't double-adopt, and the real adoptAgentConfig IPC's
  // success/failure is surfaced honestly on the first-run overlay.
  const runDeferredAgentConfigAdoption = useCallback(
    (workspaceRoot: string | null) => {
      const plan = planDeferredAdoption({
        onboardingStep,
        selection: pendingAgentConfigAdoption,
        workspaceRoot,
      })
      // skip covers onboarding-complete and the no-selection case — including a
      // user who hit "Skip for now" (their selection was cleared), so adoption
      // never runs for a skip.
      if (plan.kind === 'skip') return
      // Consume the selection up front so a later create can't double-adopt.
      setPendingAgentConfigAdoption(null)
      if (plan.kind === 'missing-root') {
        setAgentConfigAdoptionResult(plan.result)
        return
      }
      setAgentConfigAdoptionResult({ status: 'adopting' })
      void (async () => {
        try {
          const result = await window.api.adoptAgentConfig({
            workspaceRoot: plan.workspaceRoot,
            mcpServerKeys: plan.mcpServerKeys,
            skillKeys: plan.skillKeys,
          })
          if (result.ok) {
            setAgentConfigAdoptionResult({
              status: 'adopted',
              mcpServerCount: result.adoptedMcpServers.length,
              skillCount: result.adoptedSkills.length,
              warnings: result.warnings,
            })
          } else {
            setAgentConfigAdoptionResult({ status: 'failed', message: result.message })
          }
        } catch (error) {
          setAgentConfigAdoptionResult({
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    },
    [onboardingStep, pendingAgentConfigAdoption, setPendingAgentConfigAdoption, setAgentConfigAdoptionResult],
  )

  const handleCreate = ({
    template,
    name,
    folderPath,
    sprintEngineState,
    sprintEngineContext,
    sprintEngineRoleCliDefaults,
    sprintEngineAgentCliOverrides,
    sprintEngineRoleModelOverrides,
    sprintEngineInitialSpawnRoles,
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
    sprintEngineRoleModelOverrides?: SprintEngineRoleModelOverrides | null
    sprintEngineInitialSpawnRoles?: SprintEngineRoleId[] | null
    sprintEngineAutoState?: Partial<Workspace['sprintEngineAutoState']> | null
    guidedBriefState?: Workspace['guidedBriefState'] | null
    mode?: Workspace['mode']
  }) => {
    addWorkspace(template, { name, folderPath, sprintEngineState, sprintEngineContext, sprintEngineRoleCliDefaults, sprintEngineAgentCliOverrides, sprintEngineRoleModelOverrides, sprintEngineInitialSpawnRoles, sprintEngineAutoState, guidedBriefState, mode, windowId: workspaceWindowId })
    setShowNewWorkspacePanel(false)
    setNewWorkspacePanelInitialState(null)
    // Creating the first workspace finishes onboarding outright — no payoff
    // overlay. Jump straight to 'complete' regardless of the current step.
    if (onboardingStep !== 'complete') {
      setOnboardingStep('complete')
      // Now that a real workspace root exists, run any deferred config adoption
      // the user opted into on the essentials step.
      runDeferredAgentConfigAdoption(folderPath)
    }
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

  // Workspaces whose agents are resident (live PTY) right now, so the sidebar can
  // bold them as "hot" — instant to switch into, versus suspended/exited rows that
  // re-launch on open. Derived from the same live `terminalSessions` snapshot as
  // activity, and recomputes the moment the reaper suspends an agent (it disposes
  // the session and broadcasts terminal:sessions-changed).
  const residentWorkspaceIds = useMemo(
    () => residentAgentWorkspaceIds(terminalSessions),
    [terminalSessions],
  )

  const terminalRecencyByWorkspaceId = useMemo(() => {
    const map: Record<string, { hasRunning: boolean; idleSince: number | null; lastInputAt: number | null }> = {}
    for (const workspace of workspaces) {
      const persistedLastInputAt = typeof workspace.lastTerminalActivityAt === 'number'
        ? workspace.lastTerminalActivityAt
        : null
      const activity = deriveWorkspaceTerminalActivity(workspace.id, terminalSessions, persistedLastInputAt)
      const hasRunning = activity.kind === 'working' || activity.kind === 'failed'
      const idleSince = deriveWorkspaceIdleSince(workspace.id, terminalSessions, persistedLastInputAt)
      const lastInputAt = deriveWorkspaceLastInputAt(workspace.id, terminalSessions, persistedLastInputAt)
      map[workspace.id] = { hasRunning, idleSince, lastInputAt }
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

    const activeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
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
      cliModel: resolveSurfaceModel(cliForSpawn, specialistModelDefaults[specialist.id]),
      cliPermissionPreset: agentSpawnPermissionPreset,
      debugMode: agentSpawnDebugMode,
      kind: 'specialist',
      specialistId: specialist.id,
      cliStartupPrompt: prependAgentIdentifier(prompt, tabName, specialist.shortLabel),
      cliOnboardingPromptSent: false,
      cliHasLaunched: false,
      cliResumeAvailable: false,
    })
    addAgentTabTiled(windowActiveWorkspaceId, newId, tabName)
    if (agentSpawnDebugMode) setAgentSpawnDebugMode(false)
  }

  const addNewMultiloopAgent = async (
    role: MultiloopRole = lastSelectedMultiloopRole,
    requestedName = '',
    selectedCli?: AgentCli
  ) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
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
      cliModel: resolveSurfaceModel(cliForSpawn, multiloopRoleModelDefaults[soul.role]),
      cliPermissionPreset: agentSpawnPermissionPreset,
      debugMode: agentSpawnDebugMode,
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
    if (agentSpawnDebugMode) setAgentSpawnDebugMode(false)
  }

  const addNewCliAgent = (cli: AgentCli, label: string) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    const spawnCli = fallbackSpawnCli(cli)
    const tabName = uniqueAgentName(label, activeWorkspace?.agents ?? {})
    const newId = `agent-${spawnCli}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      cli: spawnCli,
      cliModel: resolveSurfaceModel(spawnCli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY]),
      cliPermissionPreset: agentSpawnPermissionPreset,
      debugMode: agentSpawnDebugMode,
      kind: 'general',
      specialistId: undefined,
      cliStartupPrompt: undefined,
      cliOnboardingPromptSent: false,
      cliHasLaunched: false,
      cliResumeAvailable: false,
    })
    addAgentTabTiled(windowActiveWorkspaceId, newId, tabName)
    if (agentSpawnDebugMode) setAgentSpawnDebugMode(false)
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

    const activeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
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
  // instead of the active workspace. `folderPath === undefined` inherits the
  // active workspace's folder (the top bar's Open-in-new-chat); the sidebar New
  // chat picker passes the right-clicked folder. Each mirrors its in-workspace
  // spawn counterpart, but seeds the agent at creation time via
  // createSoloChatWorkspace so it lands race-free before the new model mounts.
  const openGeneralInNewChat = (cli?: AgentCli, folderPath?: string | null) => createNewChat(folderPath, cli)

  const openSpecialistInNewChat = (
    specialistId: SpecialistActionId,
    selectedCli?: AgentCli,
    folderPath?: string | null,
  ) => {
    setLastSelectedSpecialist(specialistId)
    const specialist = getSpecialistAction(specialistId)
    const tabName = pickRandomAgentName([])
    const prompt = buildSpecialistSoulStartupPrompt(specialist)
    const cliForSpawn = fallbackSpawnCli(
      normalizeSelectedCli(selectedCli ?? specialistCliDefaults[specialist.id], lastSelectedCli)
    )
    createSoloChatWorkspace({
      folderPath,
      templateAgentCli: cliForSpawn,
      seedAgent: {
        tabName,
        agentPatch: {
          name: tabName,
          cli: cliForSpawn,
          cliModel: resolveSurfaceModel(cliForSpawn, specialistModelDefaults[specialist.id]),
          cliPermissionPreset: agentSpawnPermissionPreset,
          debugMode: agentSpawnDebugMode,
          kind: 'specialist',
          specialistId: specialist.id,
          cliStartupPrompt: prependAgentIdentifier(prompt, tabName, specialist.shortLabel),
          cliOnboardingPromptSent: false,
          cliHasLaunched: false,
          cliResumeAvailable: false,
        },
      },
    })
    if (agentSpawnDebugMode) setAgentSpawnDebugMode(false)
  }

  const openTerminalInNewChat = (folderPath?: string | null) => {
    createSoloChatWorkspace({
      folderPath,
      seedAgent: { terminal: { terminalId: `terminal-${nanoid(6)}` }, tabName: 'Terminal' },
    })
  }

  // New-chat picks: each spawns the chosen agent in a fresh chat AND remembers
  // the choice as the default for a plain "New chat in project" click, so the
  // sidebar can show what will spawn and repeat it without reopening the picker.
  // Shared by the sidebar new-chat picker and the top bar's Open-in-new-chat.
  const pickNewChatTerminal = (folderPath?: string | null) => {
    setLastNewChatAgent({ kind: 'terminal' })
    openTerminalInNewChat(folderPath)
  }
  const pickNewChatGeneral = (cli?: AgentCli, folderPath?: string | null) => {
    setLastNewChatAgent({ kind: 'general' })
    openGeneralInNewChat(cli, folderPath)
  }
  const pickNewChatSpecialist = (
    specialistId: SpecialistActionId,
    cli?: AgentCli,
    folderPath?: string | null,
  ) => {
    setLastNewChatAgent({ kind: 'specialist', specialistId })
    openSpecialistInNewChat(specialistId, cli, folderPath)
  }

  // Open the pre-creation New Chat panel. `folderPath === undefined` inherits the
  // active workspace's folder (the plain New chat button); an explicit value
  // scopes the chat to that project (folder/workspace-row menus). Nothing is
  // created here — the panel's confirm does that.
  const openNewChatPanel = useCallback((folderPath?: string | null) => {
    const resolved = folderPath === undefined ? activeWorkspace?.folderPath ?? null : folderPath
    setNewChatPanelState({ folderPath: resolved, folderLabel: resolved ? newChatFolderLabel(resolved) : null })
    // The New Chat panel renders only in the non-hub branch: leaving the
    // creation hub open would make this click a visible no-op and leave the
    // armed panel to pop up later (first-run keeps the hub pinned open).
    setShowNewWorkspacePanel(false)
    setNewWorkspacePanelInitialState(null)
    closeSettingsOverlay()
    setSpecialistMenuOpen(false)
    setNotificationsOpen(false)
  }, [activeWorkspace?.folderPath, closeSettingsOverlay])
  const closeNewChatPanel = () => {
    setNewChatPanelState(null)
  }
  // The panel's project chip: distinct folders across this window's open
  // workspaces, in rail order. Browse admits a folder Multicode doesn't know.
  const newChatProjectOptions = useMemo(() => {
    const seen = new Set<string>()
    const options: Array<{ path: string; label: string }> = []
    for (const workspace of workspaces) {
      const path = workspace.folderPath?.trim()
      if (!path) continue
      const key = path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      options.push({ path, label: newChatFolderLabel(path) })
    }
    return options
  }, [workspaces])
  const selectNewChatProject = (path: string) => {
    setNewChatPanelState((prev) => (prev ? { folderPath: path, folderLabel: newChatFolderLabel(path) } : prev))
  }
  const browseNewChatProject = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    setNewChatPanelState((prev) => (prev ? { folderPath: dir, folderLabel: newChatFolderLabel(dir) } : prev))
  }
  // Switching workspaces dismisses the pre-creation panel: the user has moved
  // on, and the panel would otherwise sit over the newly revealed workspace.
  useEffect(() => {
    setNewChatPanelState(null)
  }, [windowActiveWorkspaceId])
  // Map the composer's confirm to the existing new-chat spawn handlers (which
  // persist lastNewChatAgent and seed the solo workspace), then close the panel.
  // `folderPathOverride` lets the embedded composer in the unified New Agent panel
  // (the 'chat' pseudo-type) spawn in the wizard's chosen folder rather than the
  // standalone panel's; omitting it keeps the standalone New chat behavior.
  const confirmNewChat = (confirm: AgentComposerConfirm, folderPathOverride?: string | null) => {
    const folderPath =
      folderPathOverride !== undefined ? folderPathOverride : newChatPanelState?.folderPath ?? null
    switch (confirm.kind) {
      case 'terminal':
        pickNewChatTerminal(folderPath)
        break
      case 'specialist':
        pickNewChatSpecialist(confirm.specialistId, confirm.cli, folderPath)
        break
      case 'general':
        pickNewChatGeneral(confirm.cli, folderPath)
        break
      default:
        // The New Chat panel is specialist-mode with no conversation/multiloop
        // rows, so those confirm kinds are unreachable here.
        break
    }
    closeNewChatPanel()
  }

  // Optional workspaceId targets a single workspace's panel. The mode-scoped
  // panels ignore it, but the Git panel (which can be mounted in several
  // background workspaces at once) uses it so a destructive command like commit
  // only runs in the active workspace's repo, never a stale background one.
  const dispatchPanelCommand = useCallback((id: string, workspaceId?: string) => {
    window.dispatchEvent(new CustomEvent('multicode:panel-command', { detail: { id, workspaceId } }))
  }, [])

  const runCommand = useCallback((commandId: string): boolean => {
    if (commandId === 'app.settings.open') {
      openSettings(false)
      return true
    }
    if (commandId === 'app.updates.check') {
      // Updates folded into the General tab; land there and run the check.
      openSettings(true, 'general')
      return true
    }
    if (commandId === 'commandPalette.open') {
      setShowPalette(true)
      setShowNewWorkspacePanel(false)
      setSpecialistMenuOpen(false)
      setSessionsOpen(false)
      setAttentionQueueOpen(false)
      setViewMenuOpen(false)
      setNotificationsOpen(false)
      return true
    }
    if (commandId === 'diagnostics.open') {
      setDiagnosticsOpen(true)
      return true
    }
    if (commandId === 'workspace.new') {
      openNewWorkspacePanel()
      return true
    }
    if (commandId === 'chat.new') {
      openNewChatPanel()
      return true
    }
    if (commandId === 'workspace.sidebar.toggle') {
      beginSidebarTransition()
      setSidebarCollapsed(!sidebarCollapsed)
      return true
    }
    if (commandId === 'panel.sprint-engines.toggle') {
      // Mirrors the command's sprintEngineEnabled availability so a stale
      // shortcut can't open an aside the disabled module never renders.
      if (!sprintEngineEnabled) return false
      setSprintEnginesAsideOpen(!sprintEnginesAsideOpen)
      return true
    }
    if (commandId === 'panel.attention-queue.toggle') {
      // Core shell chrome (no module gate) — toggles the same transient popover
      // open state the title-bar trigger drives.
      setAttentionQueueOpen((open) => !open)
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
        (workspaceId) => workspaceId !== windowActiveWorkspaceId && railWorkspaceIdSet.has(workspaceId),
      )
      if (!step) return false
      workspaceNavigationHistoryRef.current = step.history
      setShowNewWorkspacePanel(false)
      setActiveWorkspaceForWindow(workspaceWindowId, step.workspaceId)
      return true
    }
    if (commandId === 'workspace.switch.next' || commandId === 'workspace.switch.previous') {
      const nextWorkspaceId = getNextWorkspaceId(
        railWorkspaces,
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
      const workspace = railWorkspaces[workspaceIndex]
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
        if (railWorkspaces.length > 0) setShowNewWorkspacePanel(false)
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
    if (commandId === 'panel.knowledge-graph.toggle' && windowActiveWorkspaceId) {
      // The Knowledge Graph has no rail glyph; this palette/menu command is its
      // entry point. The module guard mirrors the command's availability so the
      // static View-menu item can't mount a panel the disabled memory-graph
      // module never registered.
      if (!selectModuleEnabled(moduleEnablement, 'memory-graph')) return false
      togglePanelRailComponent(windowActiveWorkspaceId, 'memory-graph', 'Knowledge Graph')
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
    // Module-contributed commands carry their handler callback directly; an
    // exact registry hit wins over the panel-command prefix heuristic below.
    // Enablement is re-checked at dispatch so a stale binding cannot fire a
    // command whose module was just toggled off.
    const moduleCommand = getRendererHost().getModuleCommand(commandId)
    if (moduleCommand) {
      if (!selectModuleEnabled(moduleEnablement, moduleCommand.moduleId)) return false
      void moduleCommand.run()
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
    openNewChatPanel,
    sidebarCollapsed,
    setSidebarCollapsed,
    sprintEngineEnabled,
    sprintEnginesAsideOpen,
    setSprintEnginesAsideOpen,
    windowActiveWorkspaceId,
    closeWorkspaceById,
    railWorkspaces,
    railWorkspaceIdSet,
    setActiveWorkspaceForWindow,
    workspaceWindowId,
    showNewWorkspacePanel,
    terminalSessions,
    voiceDictationEnabled,
    voiceDictation,
    moduleEnablement,
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
        commands: commandContributions,
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
    commandContributions,
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
      // With the pre-creation New Chat panel open, back means "leave the
      // panel": dismiss it and stay on the workspace underneath, never
      // navigate history through the overlay.
      if (event.button === 3 && newChatPanelOpen) {
        event.preventDefault()
        event.stopPropagation()
        closeNewChatPanel()
        return
      }
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
  }, [runCommand, disabledCommandIds, newChatPanelOpen])

  useEffect(() => {
    return window.api.onAppMenuCommand((command) => {
      const definition = getCommandDefinition(command)
      if (definition) {
        runCommand(definition.id)
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

  // The agent a picker opens preselected — the remembered specialist (standard
  // workspaces) or multiloop role. The composer falls back to its first roster
  // row if this is absent.
  const composerInitialSelection: AgentComposerSelection = multiloopLaunchMenu
    ? { kind: 'multiloop', role: lastSelectedMultiloopRole }
    : { kind: 'specialist', specialistId: lastSelectedSpecialist }

  // Map a composer confirm to the real spawn into the active workspace.
  // Shared by every AgentComposerPopover host (top bar, launcher); fresh chats
  // are the New Chat panel's job.
  const runComposerSpawn = (confirm: AgentComposerConfirm) => {
    switch (confirm.kind) {
      case 'terminal':
        addNewTerminal()
        break
      case 'general':
        addNewCliAgent(confirm.cli, 'General Agent')
        break
      case 'conversation':
        spawnConversationAgent()
        break
      case 'specialist':
        handleSelectSpecialist(confirm.specialistId, confirm.cli)
        break
      case 'multiloop':
        handleSelectMultiloopRole(confirm.role, confirm.cli)
        break
    }
  }

  // The empty-workspace launcher's "Specialist agent" row renders the shared
  // AgentComposerPopover anchored to the row. It spawns into the launcher's own
  // (active) workspace — a single `here` destination, no new-chat toggle.
  const renderSpecialistPicker = (close: () => void) => (
    <AgentComposerPopover
      roster={multiloopLaunchMenu ? 'multiloop' : 'specialist'}
      conversationAvailable={conversationSpawnAvailable}
      initialSelection={composerInitialSelection}
      action={{
        kind: 'spawn',
        onSpawn: runComposerSpawn,
        permissionPreset: agentSpawnPermissionPreset,
        onChangePermissionPreset: setAgentSpawnPermissionPreset,
        debugMode: agentSpawnDebugMode,
        onChangeDebugMode: setAgentSpawnDebugMode,
      }}
      onClose={close}
    />
  )

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
      const itemResumeCaps = resumeCapabilitiesForCli(item.cli, pluginCatalogEntries)
      updateAgent(item.workspace.id, item.agentId, {
        name: item.label,
        cli: item.cli,
        cliSessionId: item.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable: agentCliSupportsConversationResume(itemResumeCaps) ? true : undefined,
        cliUsesStableSessionId: agentCliUsesStableSessionIdForResume(itemResumeCaps) ? true : undefined,
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

  // Pause = freeze-the-view suspend: kill the agent PTY to free memory but keep
  // the painted scrollback and the resume flags, so reopening relaunches the CLI
  // with --resume. Unlike stopSession we do NOT reset launch flags or prune the
  // session — the suspend broadcast (terminal:sessions-changed) flips it to
  // suspended (processAlive=false), which drops it out of the working-sessions
  // list on its own.
  const pauseSession = (item: SessionItem) => {
    void window.api.terminalSuspend(item.sessionId).catch(() => {})
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
      {sprintEngineEnabled && !MULTICODE_DISABLE_SPRINTENGINE_SYNC && ownsGlobalSupervisors ? (
        // Background GitHub merge-state polling (exponential backoff) so a run's
        // sidebar glyph flips to merged after the PR is merged, without the board
        // being open. Unlike the disk-cheap projection sync above, each tick spawns
        // a `gh` subprocess, so it runs as a single global-owner singleton (like
        // AutomationsRunSupervisor) — one poll per workspace, not one per window.
        <SprintEnginePullRequestPollSupervisor
          activeWorkspaceId={windowActiveWorkspaceId}
          workspaceIds={workspaces.map((workspace) => workspace.id)}
        />
      ) : null}
      {workspaceTypeSupervisors.map(({ key, Component }) => (
        <React.Suspense key={key} fallback={null}>
          <Component />
        </React.Suspense>
      ))}
      {automationsEnabled && ownsGlobalSupervisors ? <AutomationsRunSupervisor /> : null}
      {multiloopEnabled && visibleWorkspaces.map((workspace) => (
        workspace.id === windowActiveWorkspaceId && (workspace.mode === 'multiloop' || workspace.multiloopContext)
          ? <MultiloopStateSynchronizer key={workspace.id} workspaceId={workspace.id} />
          : null
      ))}

      <div className="relative flex min-h-0 flex-1 flex-row">
      <WorkspaceSidebar
        workspaces={visibleWorkspaces}
        activeWorkspaceId={windowActiveWorkspaceId}
        workspaceWindowId={workspaceWindowId}
        isDetachedWindow={!isPrimaryWorkspaceWindow}
        sidebarCollapsed={sidebarCollapsed}
        chromeSlot={
          <SidebarChrome
            isMac={window.api.platform === 'darwin'}
            isFullScreen={windowState.isFullScreen}
            onToggleSidebar={() => runCommand('workspace.sidebar.toggle')}
            onNavigateBack={() => runCommand('workspace.history.back')}
            onNavigateForward={() => runCommand('workspace.history.forward')}
            onOpenSearch={() => runCommand('commandPalette.open')}
            menuItems={window.api.platform === 'darwin' ? [] : MENU_BAR_ITEMS}
            onShowMenu={(event, label) => void handleShowMenubarMenu(event, label)}
          />
        }
        activityByWorkspaceId={activityByWorkspaceId}
        residentWorkspaceIds={residentWorkspaceIds}
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
        onNewChat={() => openNewChatPanel()}
        onNewWorkspaceMode={openNewWorkspacePanelWithMode}
        onNewChatInFolder={(folderPath) => openNewChatPanel(folderPath)}
        onRevealFolder={handleRevealFolder}
        onSetSidebarCollapsed={setSidebarCollapsed}
        sidebarWidth={sidebarWidth}
        onSetSidebarWidth={setSidebarWidth}
        authState={authState}
        authMessage={authMessage}
        accountOpen={accountOpen}
        setAccountOpen={setAccountOpen}
        startLogin={startLogin}
        refreshAuthState={refreshAuthState}
        logout={logout}
        openSettings={openSettings}
        settingsOpen={settingsOpen}
      />
      {/* Content column: the workspace header (identity + controls) sits above
          the active workspace's card, so the chrome reads as tied to the
          workspace rather than floating in a full-width bar. */}
      <div className="flex min-w-0 flex-1 flex-col">
      <WorkspaceHeader
        activeWorkspaceId={windowActiveWorkspaceId}
        isMac={window.api.platform === 'darwin'}
        isFullScreen={windowState.isFullScreen}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => runCommand('workspace.sidebar.toggle')}
        onOpenSearch={() => runCommand('commandPalette.open')}
        onNewAgent={openNewWorkspacePanel}
        menuItems={window.api.platform === 'darwin' ? [] : MENU_BAR_ITEMS}
        onShowMenu={(event, label) => void handleShowMenubarMenu(event, label)}
        identitySlot={
          <WorkspaceIdentity
            activeWorkspace={activeWorkspace}
            activeWorkspaceId={windowActiveWorkspaceId}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => runCommand('workspace.sidebar.toggle')}
          />
        }
        attentionQueue={{
          items: attentionItems,
          badge: attentionBadge,
          open: attentionQueueOpen,
          onOpenChange: setAttentionQueueOpen,
          windowWorkspaceIds: visibleWorkspaceIdSet,
          activeWorkspaceId: windowActiveWorkspaceId,
          onOpenItem: openSession,
        }}
        sprintEnginesToggle={
          sprintEngineEnabled
            ? {
                open: sprintEnginesAsideOpen,
                onToggle: () => setSprintEnginesAsideOpen(!sprintEnginesAsideOpen),
              }
            : null
        }
        onOpenDiagnostics={
          window.api.isDevelopment || window.api.isDiagnosticsEnabled
            ? () => setDiagnosticsOpen(true)
            : null
        }
        actionsSlot={
          <WorkspaceActions
            workspaces={visibleWorkspaces}
            activeWorkspace={activeWorkspace}
            activeWorkspaceId={windowActiveWorkspaceId}
            workspaceActionsEnabled={workspaceActionsEnabled}
            sessionsRef={sessionsRef}
            viewMenuRef={viewMenuRef}
            notificationsRef={notificationsRef}
            specialistMenuRef={specialistMenuRef}
            sessions={sessions}
            sidebarWorkspaceOrder={sidebarWorkspaceOrder}
            sessionsOpen={sessionsOpen}
            setSessionsOpen={setSessionsOpen}
            openSession={openSession}
            pauseSession={pauseSession}
            stopSession={stopSession}
            stopWorkspaceSessions={stopWorkspaceSessions}
            viewMenuOpen={viewMenuOpen}
            setViewMenuOpen={setViewMenuOpen}
            viewMenuTick={viewMenuTick}
            setViewMenuTick={setViewMenuTick}
            notifications={notifications}
            unreadErrorCount={unreadErrorCount}
            notificationsOpen={notificationsOpen}
            setNotificationsOpen={setNotificationsOpen}
            markNotificationRead={markNotificationRead}
            markAllNotificationsRead={markAllNotificationsRead}
            clearNotifications={clearNotifications}
            resolveNotificationActions={resolveNotificationActions}
            voiceDictationEnabled={voiceDictationEnabled}
            voiceRecording={voiceDictation.recording}
            voiceTranscribing={voiceDictation.transcribing}
            toggleVoiceDictation={voiceDictation.toggle}
            specialistMenuOpen={specialistMenuOpen}
            setSpecialistMenuOpen={setSpecialistMenuOpen}
            agentCliOptions={agentCliCatalog}
            multiloopLaunchMenu={multiloopLaunchMenu}
            selectedSpecialistAction={selectedSpecialistAction}
            selectedMultiloopRoleDescriptor={selectedMultiloopRoleDescriptor}
            selectedAgentPermissionOption={selectedAgentPermissionOption}
            lastSelectedCli={lastSelectedCli}
            specialistCliDefaults={specialistCliDefaults}
            multiloopRoleCliDefaults={multiloopRoleCliDefaults}
            agentSpawnPermissionPreset={agentSpawnPermissionPreset}
            setAgentSpawnPermissionPreset={setAgentSpawnPermissionPreset}
            agentSpawnDebugMode={agentSpawnDebugMode}
            setAgentSpawnDebugMode={setAgentSpawnDebugMode}
            addNewSpecialist={(cli) => addNewSpecialist(lastSelectedSpecialist, '', cli)}
            addNewMultiloopAgent={(cli) => addNewMultiloopAgent(lastSelectedMultiloopRole, '', cli)}
            conversationSpawnAvailable={conversationSpawnAvailable}
            composerInitialSelection={composerInitialSelection}
            runComposerSpawn={runComposerSpawn}
          />
        }
      />
      {/* Card row: the workspace card and (when open) the Sprint Engines aside
          share the strip under the full-width WorkspaceHeader, so the header's
          right-edge controls keep the window's true right edge regardless of
          whether the aside is open. */}
      <div className="flex min-h-0 flex-1 flex-row">
      {/* The workspace card: everything inside the rounded surface belongs to
          the active workspace. With the Sprint Engines aside open the card
          also rounds its right edge, reading as a card floating between two
          pieces of app-level chrome (sidebar left, aside right). */}
      <div
        className={`flex min-w-0 flex-1 flex-col overflow-hidden rounded-bl-[10px] bg-[color:var(--bg-surface)] ${
          showSprintEnginesAside
            ? 'rounded-br-[10px] shadow-[inset_-1px_0_0_rgba(255,255,255,0.04)]'
            : ''
        }`}
      >
      {/* The workspace identity + control groups live in the WorkspaceHeader
          above this card (WorkspaceIdentity / WorkspaceActions slots), so the
          card opens directly with content. */}
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
                allowClose={railWorkspaces.length > 0}
                initialState={newWorkspacePanelInitialState}
                chatComposer={{
                  projectOptions: newChatProjectOptions,
                  initialSelection: lastNewChatAgent ?? { kind: 'general' },
                  permissionPreset: agentSpawnPermissionPreset,
                  onChangePermissionPreset: setAgentSpawnPermissionPreset,
                  debugMode: agentSpawnDebugMode,
                  onChangeDebugMode: setAgentSpawnDebugMode,
                  onConfirm: confirmNewChat,
                }}
              />
            </React.Suspense>
          ) : (
            <>
              {railWorkspaces.length === 0 && !activeWorkspace && <EmptyState onNew={openNewWorkspacePanel} />}
              {renderedWorkspaceIds.map((workspaceId) => {
                const active = workspaceId === windowActiveWorkspaceId
                // Cold = retained but neither active nor warm. Cold layers keep
                // their DOM / JS / xterm buffers but render with
                // content-visibility: hidden, so the compositor skips their
                // per-frame layout/paint/composite work (the scroll-jank fix).
                // On reveal they render once and the WORKSPACE_LAYER_REVEAL_EVENT
                // re-fits their terminals. Active + warm layers stay fully
                // composited so switching to them is instant.
                const cold = !active && !warmHiddenWorkspaceIdSet.has(workspaceId)
                return (
                  <div
                    key={workspaceId}
                    className={`absolute inset-0 ${active ? 'z-10 visible' : 'z-0 invisible'}`}
                    style={{
                      pointerEvents: active ? 'auto' : 'none',
                      contentVisibility: cold ? 'hidden' : undefined,
                    }}
                    aria-hidden={!active}
                  >
                    <WorkspaceLayout
                      workspaceId={workspaceId}
                      onStartFuturePlan={openFuturePlanWorkspace}
                      agentClis={agentCliCatalog}
                      onSpawnAgent={addNewCliAgent}
                      renderSpecialistPicker={renderSpecialistPicker}
                      onStartSprintEngine={openSprintEngineSetup}
                      onNewWorkspace={openNewWorkspacePanel}
                      onCloseWorkspace={closeWorkspaceById}
                    />
                  </div>
                )
              })}
              {/* Pre-creation New Chat panel — overlays the workspace canvas as a
                  full-region chooser. Creates nothing until confirmed; Escape or
                  close discards. Sits above the layers so it works whether or not
                  a workspace is active. */}
              {newChatPanelState ? (
                <React.Suspense fallback={<SuspenseFallback label="Loading new chat" />}>
                  <NewChatPanel
                    initialState={newChatPanelState}
                    projectOptions={newChatProjectOptions}
                    onSelectProject={selectNewChatProject}
                    onBrowseProject={() => void browseNewChatProject()}
                    initialSelection={lastNewChatAgent ?? { kind: 'general' }}
                    permissionPreset={agentSpawnPermissionPreset}
                    onChangePermissionPreset={setAgentSpawnPermissionPreset}
                    debugMode={agentSpawnDebugMode}
                    onChangeDebugMode={setAgentSpawnDebugMode}
                    onConfirm={confirmNewChat}
                    onClose={closeNewChatPanel}
                  />
                </React.Suspense>
              ) : null}
            </>
          )}
        </div>
        <SettingsOverlay />
        {connectorsSurfaceOpen ? (
          <React.Suspense fallback={null}>
            <ConnectorsSurface
              onLaunchConnector={(serverId) => { void launchConnectorChat(serverId) }}
              onUseInAutomation={() => {
                // The route to author a connector automation; the connector
                // pre-selection lands in T8. Close the surface and open the
                // workspace-creation flow where Automations mode is chosen.
                closeConnectorsSurface()
                openNewWorkspacePanel()
              }}
              activeWorkspaceRoot={activeWorkspaceFolderPath}
            />
          </React.Suspense>
        ) : null}
        {/* T6 first-run payoff: supply the real app actions it needs. A CLI is
            "configured" when at least one catalog entry is confirmed installed;
            the run reuses createNewChat against the just-created workspace
            folder, and the no-CLI fallback opens the real command palette. */}
        <OnboardingFlow
          hasConfiguredCli={agentCliCatalog.some((option) => option.installed === true)}
          onLaunchFirstAgent={() => createNewChat(activeWorkspace?.folderPath ?? undefined)}
          onOpenCommandPalette={() => {
            // The no-CLI payoff sends the user into the command palette as the
            // learn-by-doing beat, then finishes onboarding. The startup-tip
            // effect already skips its one-shot for any onboarding completed this
            // session (onboardingWasActiveRef), so the palette is never covered.
            runCommand('commandPalette.open')
          }}
        />
      </div>
      </div>
      {showSprintEnginesAside ? (
        <SprintEnginesAside
          activeWorkspaceId={windowActiveWorkspaceId}
          windowWorkspaceIds={visibleWorkspaceIdSet}
          onSelectWorkspace={(id) => {
            setShowNewWorkspacePanel(false)
            setActiveWorkspaceForWindow(workspaceWindowId, id)
          }}
          onClose={() => setSprintEnginesAsideOpen(false)}
        />
      ) : null}
      </div>
      </div>
      {/* Win/linux caption buttons pin to the window's absolute top-right corner
          (above whatever column owns that edge — content or the Sprint Engines
          aside), since the split chrome has no full-width bar to host them. */}
      {window.api.platform !== 'darwin' ? (
        <div className="app-no-drag absolute right-0 top-0 z-30 flex h-[36px] items-center">
          <WindowControls isMaximized={windowState.isMaximized} />
        </div>
      ) : null}
      </div>

      {diagnosticsOpen && <DiagnosticsOverlay onClose={() => setDiagnosticsOpen(false)} />}

      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNewWorkspace={openNewWorkspacePanel}
          onNewChat={() => createLauncherChat()}
          onConnectRailway={() => { void launchConnectorChat('railway') }}
          onSpawnSpecialist={handleSelectSpecialist}
          workspaceWindowId={workspaceWindowId}
          workspaces={visibleWorkspaces}
          activeWorkspaceId={windowActiveWorkspaceId}
          activeScopes={activeCommandScopes}
          commandAvailability={commandAvailability}
        />
      )}

      <TipStartupModal
        open={tipModalOpen && onboardingStep === 'complete'}
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
