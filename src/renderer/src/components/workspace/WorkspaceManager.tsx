import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { nanoid } from 'nanoid'
import { useShallow } from 'zustand/react/shallow'
import { shouldAutoOpenCreationHub, shouldShowFirstRunCliCard } from '../../store/onboardingState'
import { planAgentConfigAdoption } from '../onboarding/agentConfigAdoption'
import { EmptyState as KitEmptyState, PrimaryButton } from '../ui'
import { Modal } from '../ui/Modal'
import { SuspenseFallback } from '../ui/SuspenseFallback'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { SoloChatSeed } from '../../store/slices/workspacesSlice'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET, normalizeSelectedCli } from '../../store/slices/settingsSlice'
import { resolveCliReasoning, resolveLaunchableAgentCli, resolveSurfaceModel, resolveTemplateAgentCli, selectAgentCliCatalog } from './newWorkspace/cliRuntimeOptions'
import { AGENTS_SETTINGS_TAB } from './cliInstallRoute'
import { resumeCapabilitiesForCli, subscribePluginCatalogRefreshOnFocus } from '../../store/slices/pluginsSlice'
import type { ConversationCliRuntimeOverrides } from '../../../../shared/conversation-runtime'
import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import { resolveNotificationActions as resolveNotificationActionsFor } from '../../utils/notificationActions'
import {
  deriveWorkspaceIdleSince,
  deriveWorkspaceLastInputAt,
  deriveWorkspaceTerminalActivity,
  deriveWorkspaceWorkingSince,
  getTerminalSessionsSignature,
  refreshTerminalSessions,
  subscribeLiveTerminalSessionSnapshots,
} from '../../hooks/useTerminalSessions'
import { useAppTheme } from '../../hooks/useAppTheme'
import { useConversationSessions } from '../../hooks/useConversationSessions'
import {
  GENERAL_AGENT_ENGINE_KEY,
  getSpecialistAction,
  buildSpecialistSoulStartupPrompt,
} from '../../specialists/specialistActions'
import type {
  AgentCli,
  AgentCliModelSelection,
  AgentExecution,
  AppNotification,
  FuturePlanWorkspaceSource,
  LayoutTemplate,
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
  agentWorktreePaths,
  connectorStartupPrompt,
  connectorWorktreePaths,
  worktreeIdFromPath,
} from '../../utils/workspaceWorktree'
import { resolveConnectorLaunch } from '../../utils/connectorLaunch'
import { resolveSkillInvocation } from '../../../../shared/skill-invocation'
import { ensureSkillForAgent, renderChatSkillPrefill, skillSpawnAgentPatch } from '../../utils/skillInvocation'
import type { WorkspaceSkill } from '../../../../shared/electron-api'
import { pickRandomAgentName } from '../../utils/agentNames'
import { normalizeAgentIdentifier, prependAgentIdentifier } from '../../utils/agentPrompt'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { applySprintEngineAutomationStopReason } from '../../utils/sprintengineSupervisorNotifications'
import { initSprintEngineAutomationModeSync } from '../../utils/sprintengineAutomationModeSync'
import { initSprintEngineLaunchSettingsSync } from '../../utils/sprintengineLaunchSettingsSync'
import { initBackgroundModeSync } from '../../utils/backgroundModeSync'
import { initSprintEngineRuntimeBridge } from '../../utils/sprintengineRuntimeBridge'
import { addAgentTabTiled, addNewAgentTab, addTerminalTab, convertNewAgentTabToAgent, convertNewAgentTabToTerminal, focusOrAddAgentTab, focusOrAddFileTab, focusOrAddTerminalTab, getModel, removeAgentTab, removeNewAgentTab, toggleComponentTab, togglePanelRailComponent, visibleTerminalTabInLayout } from '../../utils/modelRegistry'
import { MULTICODE_DISABLE_SPRINTENGINE_AUTORUN, MULTICODE_DISABLE_SPRINTENGINE_SYNC } from '../../utils/runtimeFlags'
import { agentCliSupportsConversationResume, agentCliUsesStableSessionIdForResume } from '../../utils/agentCliResume'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { type NewWorkspacePanelInitialState } from './NewWorkspacePanel'
import {
  type AgentComposerConfirm,
  type AgentComposerConnector,
  type AgentComposerSelection,
} from './agentComposer/AgentComposer'
import SprintEngineProjectionSupervisor from './SprintEngineProjectionSupervisor'
import SprintEngineRunChangeSubscriber from './SprintEngineRunChangeSubscriber'
// Always-on observer of background automation run events (raises run
// notifications). Automations is no longer a workspace type, so the shell mounts
// its global supervisor directly, gated on the automations module + primary
// window — the same role the workspace-type `supervisors` list used to play.
import AutomationsRunSupervisor from '../automations/AutomationsRunSupervisor'
import WorkspaceLayout from './WorkspaceLayout'
import WorkspaceSidebar from './WorkspaceSidebar'
import { beginSidebarTransition } from '../../utils/sidebarTransition'
import { isHiddenFromRail } from '../../utils/workspaceVisibility'
import { revealAgentTerminalTab } from '../../utils/agentTabReveal'
import { markLaunchedAgentProjected, retiredLaunchedAgents } from '../../utils/launchedAgentProjection'
import { WORKSPACE_LAYER_REVEAL_EVENT } from '../../utils/terminalFitScheduler'
import {
  TERMINAL_FOCUS_RETRY_DELAYS_MS,
  focusRequestWouldInterrupt,
  requestTerminalFocus,
} from '../../utils/terminalFocusRequest'
import { SidebarChrome } from './SidebarChrome'
import { ToastHost } from './ToastHost'
import { fleetTerminalTabName } from '../panels/fleet/fleetModel'
import type { RemoteNewChatLaunch } from './agentComposer/NewAgentPanel'
import { showToast } from '../../store/toastStore'
import { WorkspaceHeader } from './WorkspaceHeader'
import { GlobalSurfaceBarSlotContext } from './globalSurface/surfaceBarSlot'
import { ModalSurfaceFrame } from './globalSurface/GlobalSurfaceShell'
import { GlobalSurfaceErrorBoundary } from './globalSurface/surfaceSubstrate'
import { resolveActiveDoorSurface, resolveActiveModalSurface } from './globalSurface/absentDoorSurface'
import {
  ContextRailColumn,
  ContextRailSlotContext,
  escapeLeavesSurface,
  useSurfaceTriggerFocus,
} from './globalSurface/contextRail'
import { SurfaceExitContext, type SurfaceExit } from './globalSurface/surfaceBackNav'
import {
  setExtensionsSurfaceHost,
  type ExtensionsSurfaceHostPorts,
} from './globalSurface/extensions/extensionsSurfaceHost'
import { WorkspacePaneColumn } from './pane/WorkspacePaneColumn'
import { isWorkspacePaneFocused } from './pane/paneFocus'
import { closePaneTabAndItsTerminal, paneTerminalSessionId } from './pane/paneTerminals'
import {
  claimSprintCreationForDoor,
  consumeSprintCreationDoorClaim,
  noteSprintDoorSelection,
  releaseSprintCreationDoorClaim,
  subscribeCloseSprintWorkspaceRequests,
  subscribeNewSprintRequests,
} from './globalSurface/sprints/sprintDoorRequests'
import { noteSprintRunDeleted } from './globalSurface/sprints/sprintRunTombstones'
import { WindowControls } from './WindowControls'
import { WorkspaceIdentity } from './WorkspaceIdentity'
import { WorkspaceActions, type SessionGroup, type SessionItem } from './WorkspaceActions'
import {
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
  recordNavigationVisit,
  stepNavigationHistory,
  type NavHistoryEntry,
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
import { WorkspaceTypeSupervisorHost } from '../../modules/WorkspaceTypeSupervisorHost'
import { RendererCommandDispatcher } from '../../commands/commandDispatcher'
import { getCommandDefinition } from '../../commands/commandRegistry'
import { getElectronAccelerator } from '../../commands/effectiveKeybindings'
import { LEGACY_COMMAND_ID_ALIASES } from '../../commands/keybindings'
import type { CommandAvailabilityContext } from '../../commands/availability'
import type { CommandScope, ModuleCommandContext } from '../../commands/types'
import { dispatchPanelCommandEvent } from '../../utils/panelCommands'
// From the pure search module, not the palette component: the palette is
// React.lazy and importing a type through it would be a needless edge into the
// deferred chunk.
import type { PaletteScope } from '../commandPaletteSearch'
import { buildSprintEngineAgentRosterForState, buildSprintEngineRoleRegistry, computeSprintEngineFocusAgentAvailability } from '../../utils/sprintengine'
import { isGlobalShortcutSuppressedTarget } from '../../utils/keyboard'

// Lazy so the (large) new-workspace wizard — and everything it pulls in
// (GuidedBriefFlow, the markdown renderer) — is code-split out of the eager boot
// chunk and only fetched when the user opens "new workspace". Rendered only when
// showNewWorkspacePanel is true.
const NewWorkspacePanel = React.lazy(() => import('./NewWorkspacePanel'))
// The pre-creation New Chat panel — agent + engine chooser that creates nothing
// until the user starts the chat. Code-split like NewWorkspacePanel; rendered
// only when the New chat door or the tab strip's "+" asks for it.
//
// One surface, two destinations (MC-2147): pressing "+" retypes a tab into the
// agent's terminal; New chat creates a solo workspace in the picked project.
// The panel that used to serve the second — NewChatPanel — is gone rather than
// left beside this one, because two launch surfaces drift.
const NewAgentPanel = React.lazy(() => import('./agentComposer/NewAgentPanel'))
// The New sprint dialog (MC-2062): one light dialog, shaped like New chat —
// sprint creation left the wizard, and every entry point converges here.
const NewSprintDialog = React.lazy(() => import('./newSprint/NewSprintDialog'))

// On-demand overlays kept off the eager boot chunk: each mounts only when the
// user reaches for it (Cmd-K palette, the diagnostics overlay, the startup-tip
// modal), so its subtree — and the diagnostics report formatter / learning
// catalog it pulls — is fetched at open time, not at boot.
const CommandPalette = React.lazy(() => import('../ui/CommandPalette'))
// Settings rides the modal shell but belongs to the app, not to a module —
// see the resolution below for why it can never be module-gated. Shaped like a
// registered modal surface so the mount path stays identical to every other
// modal (doors→modals, 2026-09-01).
const SettingsModalSurface = React.lazy(() => import('../settings/SettingsModalSurface'))
const CORE_SETTINGS_MODAL_SURFACE = {
  id: 'settings',
  moduleId: 'core',
  label: 'Settings',
  Component: SettingsModalSurface,
} as const
const DiagnosticsOverlay = React.lazy(() => import('../diagnostics/DiagnosticsOverlay'))
// First-run only: the CLI onboarding card (and the CliInstallControl subtree it
// shares with the lazy Settings panel) mounts on machines with no CLI installed,
// so it stays out of the eager boot chunk (bundle-budget ratchet).
const FirstRunCliCard = React.lazy(() => import('../onboarding/FirstRunCliCard'))
const TipStartupModal = React.lazy(() =>
  import('../learn/TipStartupModal').then((m) => ({ default: m.TipStartupModal })),
)

// Display name for a New Chat project scope: the folder's last path segment.
function newChatFolderLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

// Automations is a content-area destination (not a modal): it renders inside the
// workspace card in place of workspace content, like the new-workspace panel.
// Lazy so the control center + schema-driven editor stay out of the boot chunk.

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const
const EMPTY_SPECIALIST_CLI_DEFAULTS: Partial<Record<SpecialistActionId, AgentCli>> = {}
const EMPTY_SPECIALIST_MODEL_DEFAULTS: Partial<Record<SpecialistActionId, AgentCliModelSelection>> = {}
const EMPTY_PROJECT_KNOWLEDGE_ROOTS: Record<string, string | null> = {}

// Where a spawn should land, and what it should start with. Present only when
// the spawn came from the tab strip's "+" (MC-2147): `tabId` names that tab's
// node and `prompt` is what was typed on the launch surface inside it.
type AgentSpawnPlacement = {
  tabId?: string
  prompt?: string
  /**
   * The name the tab already wears. The new-agent tab is named when it opens,
   * like every other terminal in the strip, so the agent adopts that name
   * rather than drawing a second one and renaming the tab under the reader.
   */
  agentName?: string
}

/**
 * Put a freshly spawned agent in its tab. From a new-agent tab that means
 * retyping the SAME node — the launch surface becomes the terminal, in place,
 * with no pane moving under the person who just pressed Start. Everywhere else,
 * and whenever that tab is gone (closed while the composer was open), it falls
 * back to the ordinary tiled dock rather than losing the agent.
 */
function placeSpawnedAgentTab(
  workspaceId: string,
  agentId: string,
  tabName: string,
  placement?: AgentSpawnPlacement,
): void {
  if (placement?.tabId && convertNewAgentTabToAgent(workspaceId, placement.tabId, agentId, tabName)) {
    return
  }
  addAgentTabTiled(workspaceId, agentId, tabName)
}

const TERMINAL_SESSION_RECOVERY_POLL_MS = 30_000
const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'
const SOLO_CHAT_TEMPLATE = LAYOUT_TEMPLATES.find((template) => template.id === 'solo') ?? null
const MENU_ACCELERATOR_COMMAND_IDS = [
  'app.settings.open',
  'pane.toggle',
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
    && left.templateId === right.templateId
    && left.layoutModel === right.layoutModel
    && left.worktreeState === right.worktreeState
    && left.memory === right.memory
    && left.editorState === right.editorState
    && left.fileExplorerState === right.fileExplorerState
    && left.sprintEngineState === right.sprintEngineState
    && left.sprintEngineRoleCliDefaults === right.sprintEngineRoleCliDefaults
    && left.sprintEngineInitialSpawnAgentIds === right.sprintEngineInitialSpawnAgentIds
    && left.sprintEngineAutoState === right.sprintEngineAutoState
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
  // Main-owned automation mode intent (MC-1567): subscribe to authoritative
  // broadcasts and run the one-time per-run hydration sweep. Idempotent across
  // windows (main accepts the first hydration only).
  useEffect(() => initSprintEngineAutomationModeSync(), [])
  // Main-owned sprint scheduling (sprint-runtime-ownership Phase 2): mirror
  // the agent-launch settings to main, register sprint runs with the
  // scheduler, and apply its runtime-op broadcasts into this window's store.
  useEffect(() => initSprintEngineLaunchSettingsSync(), [])
  // Background mode is read by main at last-window-close, so it is mirrored the
  // same way the launch settings are (MC-2156).
  useEffect(() => initBackgroundModeSync(), [])
  // Safe-mode kill switch: not registering runs is what stops the main
  // scheduler from spawning (it only schedules registered runs) — the same
  // recovery lever the retired renderer supervisor honoured.
  useEffect(
    () => (MULTICODE_DISABLE_SPRINTENGINE_AUTORUN ? undefined : initSprintEngineRuntimeBridge()),
    [],
  )
  const workspaces = useWorkspaceStore(useShallow((s) => selectWorkspaceManagerWorkspaces(s.workspaces)))
  const workspaceWindows = useWorkspaceStore((s) => s.workspaceWindows)
  const primaryWorkspaceWindowId = useWorkspaceStore((s) => s.primaryWorkspaceWindowId)
  const moduleEnablement = useWorkspaceStore((s) => s.appSettings.modules)
  // One stable predicate for every registry read in this component. The store
  // hands out a new `appSettings.modules` reference only when enablement really
  // changes, so this is one identity per change rather than one per render.
  const moduleEnabled = useCallback(
    (moduleId: string) => selectModuleEnabled(moduleEnablement, moduleId),
    [moduleEnablement],
  )
  const sprintEngineEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'sprint-engine'))
  const automationsEnabled = useWorkspaceStore((s) => selectModuleEnabled(s.appSettings.modules, 'automations'))
  const firstRunCliCardDismissed = useWorkspaceStore((s) => s.appSettings.firstRunCliCardDismissed)
  const dismissFirstRunCliCard = useWorkspaceStore((s) => s.dismissFirstRunCliCard)
  const hasAdoptedAgentConfig = useWorkspaceStore((s) => s.appSettings.hasAdoptedAgentConfig)
  const markAgentConfigAdopted = useWorkspaceStore((s) => s.markAgentConfigAdopted)
  // Silent first-run config adoption: detection and the real adoptAgentConfig
  // IPC both run here, once per profile, against the newly-created workspace
  // root — the earliest moment a real folder exists to write into.
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
  const setSprintEngineRoleRegistry = useWorkspaceStore((s) => s.setSprintEngineRoleRegistry)
  const settingsOverlayOpen = useWorkspaceStore((s) => s.activeModalSurface === 'settings')
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const closeSettingsOverlay = useWorkspaceStore((s) => s.closeSettingsOverlay)
  // The modal surface floating over this window (doors→modals, 2026-09-01):
  // its registered id, or null. A float, not a mount kind — the card region
  // keeps whatever owns it underneath.
  const activeModalSurface = useWorkspaceStore((s) => s.activeModalSurface)
  const closeModalSurface = useWorkspaceStore((s) => s.closeModalSurface)
  // The door-routed full-page surface for this window (global-surfaces epic 1704):
  // its registered id, or null when a workspace owns the card region.
  const activeGlobalSurface = useWorkspaceStore((s) => s.activeGlobalSurface)
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  const closeGlobalSurface = useWorkspaceStore((s) => s.closeGlobalSurface)
  const openExtensionsSurface = useWorkspaceStore((s) => s.openExtensionsSurface)
  const forgetFolder = useWorkspaceStore((s) => s.forgetFolder)
  const recordWorkspaceTerminalActivity = useWorkspaceStore((s) => s.recordWorkspaceTerminalActivity)
  const autoTitleWorkspaceFromPrompt = useWorkspaceStore((s) => s.autoTitleWorkspaceFromPrompt)
  const reconcileWorkspaceAgentLaunchFlags = useWorkspaceStore((s) => s.reconcileWorkspaceAgentLaunchFlags)
  const projectLaunchedAgentSessions = useWorkspaceStore((s) => s.projectLaunchedAgentSessions)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const lastSelectedCli = useWorkspaceStore((s) => normalizeSelectedCli(s.appSettings.lastSelectedCli))
  const setSpecialistCliDefault = useWorkspaceStore((s) => s.setSpecialistCliDefault)
  const rememberedConversationModel = useWorkspaceStore((s) => s.appSettings.lastSelectedConversationModel)
  const setLastSelectedConversationModel = useWorkspaceStore((s) => s.setLastSelectedConversationModel)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cliModelCatalog = useWorkspaceStore((s) => s.appSettings.cliModelCatalog)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const pluginCatalogStatus = useWorkspaceStore((s) => s.pluginCatalogStatus)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const cliAvailabilityStatus = useWorkspaceStore((s) => s.cliAvailabilityStatus)
  const lastNewChatAgent = useWorkspaceStore((s) => s.appSettings.lastNewChatAgent)
  const setLastNewChatAgent = useWorkspaceStore((s) => s.setLastNewChatAgent)
  const lastAgentSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.appSettings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET
  )
  const setLastAgentSpawnPermissionPreset = useWorkspaceStore(
    (s) => s.setLastAgentSpawnPermissionPreset
  )
  const specialistCliDefaults = useWorkspaceStore(
    (s) => s.appSettings.specialistCliDefaults ?? EMPTY_SPECIALIST_CLI_DEFAULTS
  )
  const specialistModelDefaults = useWorkspaceStore(
    (s) => s.appSettings.specialistModelDefaults ?? EMPTY_SPECIALIST_MODEL_DEFAULTS
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
  const openPaneTab = useWorkspaceStore((s) => s.openPaneTab)
  const setPaneOpen = useWorkspaceStore((s) => s.setPaneOpen)
  const togglePaneKind = useWorkspaceStore((s) => s.togglePaneKind)
  const visibleWorkspaceIdSet = useMemo(
    () => new Set(currentWorkspaceWindow?.workspaceIds ?? workspaces.map((workspace) => workspace.id)),
    [currentWorkspaceWindow, workspaces]
  )
  const visibleWorkspaces = useMemo(
    () => workspaces.filter((workspace) => visibleWorkspaceIdSet.has(workspace.id)),
    [visibleWorkspaceIdSet, workspaces]
  )
  // Rail-navigable subset of this window's workspaces: rail-hidden workspaces —
  // the background Automations host, and every sprint-run workspace since item
  // 1767 — stay assigned and mounted (they are in `visibleWorkspaces`) but are
  // never a rail row, a keyboard switch target, or counted toward "has a
  // workspace". Sequential switching and the empty-state derive from this list so
  // a profile holding only hidden workspaces never strands the user on one.
  // Explicit activation (the Sprints door's "Open agents", the T5 reveal path)
  // still works and still renders the workspace whole — see
  // `windowActiveWorkspaceId` below.
  const railWorkspaces = useMemo(
    () => visibleWorkspaces.filter((workspace) => !isHiddenFromRail(workspace)),
    [visibleWorkspaces]
  )
  const windowActiveWorkspaceId =
    currentWorkspaceWindow?.activeWorkspaceId && visibleWorkspaceIdSet.has(currentWorkspaceWindow.activeWorkspaceId)
      // An explicitly-activated workspace is honored even when it is rail-hidden
      // (the T5 reveal path, and the Sprints door's "Open agents", both set it) —
      // so a sprint's terminals render with their whole layout, header, and tabs.
      // Only the implicit fallback refuses to auto-activate a hidden workspace, so
      // a profile holding only hidden ones yields a null active id and the "no
      // workspaces" empty state instead of stranding the user on one.
      ? currentWorkspaceWindow.activeWorkspaceId
      : railWorkspaces[0]?.id ?? null
  const activeWorkspace = visibleWorkspaces.find((workspace) => workspace.id === windowActiveWorkspaceId) ?? null
  // The workspace pane column (browser-pane epic) is open when the ACTIVE
  // workspace's pane record says so; the card rounds its right edge to match.
  // Render-time only — the command handler reads the store live instead.
  const activePaneOpen = activeWorkspace?.paneState?.open ?? false
  // Load the Sprint Engine role registry for the active workspace so the spawn
  // dropdown and Modules settings tab can surface registry-discovered
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
  const [showNewWorkspacePanel, setShowNewWorkspacePanel] = useState(false)
  const [newWorkspacePanelInitialState, setNewWorkspacePanelInitialState] = useState<NewWorkspacePanelInitialState | null>(null)
  // The one way the creation hub goes away. Every route out of it — cancelling,
  // Cmd-W, switching workspace, opening New chat, the palette, and creating a
  // workspace — runs through here, because each of them also ends the Sprints
  // door's claim on the next sprint creation (item 1811). A route that only hid
  // the panel left the claim armed, and the next sprint started from anywhere
  // bounced back to the door. Creation reads the claim first (handleCreate); this
  // releases it for everyone else.
  const dismissNewWorkspacePanel = useCallback(() => {
    setShowNewWorkspacePanel(false)
    setNewWorkspacePanelInitialState(null)
    releaseSprintCreationDoorClaim()
  }, [])
  // The pre-creation New Chat panel's scope. Present while the panel is open;
  // folderPath is the project the chat lands in (null → inherit active),
  // folderLabel names it in the panel's scoping chip, and connector is the
  // connector the panel opened with attached (null for a plain New chat).
  const [newChatPanelState, setNewChatPanelState] = useState<{
    folderPath: string | null
    folderLabel: string | null
    connector: AgentComposerConnector | null
  } | null>(null)
  const newChatPanelOpen = newChatPanelState !== null
  // The New sprint dialog's scope (MC-2062). Present while the dialog is open;
  // `initialSource` carries a preloaded plan (the `initialFuturePlan` seam) so
  // a backlog "Run a Sprint" arrives with the selection already made.
  const [newSprintDialogState, setNewSprintDialogState] = useState<{
    folderPath: string | null
    initialSource: FuturePlanWorkspaceSource | null
  } | null>(null)
  // Closing also releases the Sprints door's claim on the next sprint creation
  // (item 1811), exactly as dismissing the old wizard did.
  const closeNewSprintDialog = useCallback(() => {
    setNewSprintDialogState(null)
    releaseSprintCreationDoorClaim()
  }, [])
  const [tipModalOpen, setTipModalOpen] = useState(false)
  const tipModalDecidedRef = useRef(false)
  // Guards the async adoption against a second workspace creation landing before
  // the persisted `hasAdoptedAgentConfig` flag has been written.
  const adoptionInFlightRef = useRef(false)
  const showTipsOnStartup = useWorkspaceStore((s) => s.appSettings.learning?.showTipsOnStartup ?? true)
  const projectKnowledgeRoots = useWorkspaceStore((s) => s.appSettings.projectKnowledgeRoots ?? EMPTY_PROJECT_KNOWLEDGE_ROOTS)
  const [showPalette, setShowPalette] = useState(false)
  // Which groups the palette opens filtered to. ⌘K raises the full launcher;
  // ⌘⇧F raises the same overlay narrowed to files and their contents. Held here
  // rather than inside the palette because the shortcut that opens it is what
  // decides it, and the palette is unmounted when that shortcut fires.
  const [paletteScope, setPaletteScope] = useState<PaletteScope>('all')
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  // Installed conversation providers, loaded lazily when a spawn surface opens.
  // Kept separate from `agentCliCatalog`: this is the provider/model catalog for
  // the conversation runtime, not the terminal CLI plugin catalog. `null` means
  // "not loaded yet"; an `ok: false` result drives the unavailable row.
  const [conversationProviderResult, setConversationProviderResult] = useState<ConversationProviderListResult | null>(null)
  const [agentSpawnPermissionPreset, setAgentSpawnPermissionPresetState] = useState<SprintEngineCliPermissionPreset>(
    lastAgentSpawnPermissionPreset
  )
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
  const sessionsRef = useRef<HTMLDivElement>(null)
  const viewMenuRef = useRef<HTMLDivElement>(null)
  const notificationsRef = useRef<HTMLDivElement>(null)
  const terminalSessionsSignatureRef = useRef('')
  const reportedTerminalLastInputRef = useRef<Map<string, number>>(new Map())
  // Prompt timestamps already offered to the auto-titler, per session. The store
  // action is idempotent, but calling it on every broadcast would run an immer
  // `set` per snapshot and churn subscribers for nothing.
  const titledPromptAtRef = useRef<Map<string, number>>(new Map())
  const reconciledLaunchFlagsRef = useRef(false)
  const workspaceLayoutLastFocusedAtRef = useRef<Record<string, number>>({})
  const workspaceLayoutRetentionReasonsRef = useRef<Record<string, WorkspaceLayoutRetentionReason>>({})
  // Last terminal-visibility we pushed to main per session, so the painting
  // effect only fires an IPC call on an actual transition.
  const appliedTerminalVisibilityRef = useRef<Map<string, boolean>>(new Map())
  const collapsedStaleDetachedWindowsRef = useRef(false)
  // A full-canvas pre-creation surface owns the window: the workspace under it
  // is not what the chrome is describing any more. The New chat door counts for
  // the same reason the New workspace panel does — and the tab strip's "+" does
  // NOT, because that one lives inside a workspace whose header is still true.
  const workspaceActionsEnabled = activeWorkspace && !showNewWorkspacePanel && !newChatPanelOpen
  const commandDispatcherRef = useRef(new RendererCommandDispatcher())
  // Per-window visit history backing mouse back/forward workspace navigation.
  // Transient shell state: a ref (not store state) because navigation must not
  // re-render anything on its own, and per-renderer because each BrowserWindow
  // tracks only its own activations.
  const workspaceNavigationHistoryRef = useRef<WorkspaceNavigationHistory>(EMPTY_WORKSPACE_NAVIGATION_HISTORY)
  const disabledCommandIds = useMemo(() => {
    const disabled = new Set(Object.entries(keybindingSettings?.disabled ?? {})
      .filter(([, isDisabled]) => isDisabled === true)
      .map(([commandId]) => commandId))
    // Persisted disables keyed by a command's legacy id keep suppressing its
    // migrated id (Watchtower's module-path re-namespacing).
    for (const [currentId, legacyId] of Object.entries(LEGACY_COMMAND_ID_ALIASES)) {
      if (disabled.has(legacyId)) disabled.add(currentId)
    }
    return disabled
  }, [keybindingSettings?.disabled])
  // Third-party renderer modules normally finish loading before the React
  // root renders, but the boot has a timeout race — when a slow load lands
  // after first render, this generation bump recomputes the registry-derived
  // memos so late-registered types still activate scopes and commands.
  const [moduleRegistryGeneration, setModuleRegistryGeneration] = useState(0)
  useEffect(() => onThirdPartyRendererModulesLoaded(() => setModuleRegistryGeneration((n) => n + 1)), [])
  const activeCommandScopes = useMemo((): CommandScope[] => {
    const scopes: CommandScope[] = ['global']
    if (!workspaceActionsEnabled) return scopes
    scopes.push('workspace', 'workspace-navigation')
    if (activeWorkspace.mode === 'sprintengine' || activeWorkspace.sprintEngineContext) {
      scopes.push('panel:sprintengine')
    }
    // Generic module panel scope: the active mode's owning module (via the
    // workspace-type registry) gets `panel:<moduleId>` — this is how module
    // commands gate on "my workspace is active" without a shell enum arm per
    // module. Covers switchboard the mode-specific arm used to. Sprint Engine
    // is excluded: its commands ride the legacy 'panel:sprintengine' literal
    // pushed by the dedicated arm above, and its module id ('sprint-engine')
    // differs from the mode id — deriving here would activate a second,
    // phantom scope name for the same surface.
    const owningModule = getRendererHost().getWorkspaceTypeModule(activeWorkspace.mode)
    if (owningModule && owningModule !== 'sprint-engine') {
      scopes.push(`panel:${owningModule}`)
    }
    // Feature-specific extra the registry can't express: Watchtower is a
    // second surface of the switchboard module with its own shell-pushed scope.
    if (activeWorkspace.mode === 'switchboard') {
      scopes.push('panel:watchtower')
    }
    return scopes
    // moduleRegistryGeneration: a late third-party load re-derives the
    // registry-backed panel scope for the already-active workspace.
  }, [activeWorkspace?.mode, activeWorkspace?.sprintEngineContext, workspaceActionsEnabled, moduleRegistryGeneration])
  // The published context view module availability predicates evaluate
  // against — shared by the dispatcher and the palette so both agree.
  const moduleCommandContext = useMemo((): ModuleCommandContext => ({
    activeWorkspaceId: workspaceActionsEnabled ? windowActiveWorkspaceId ?? null : null,
    activeWorkspaceMode: workspaceActionsEnabled ? activeWorkspace?.mode ?? null : null,
  }), [workspaceActionsEnabled, windowActiveWorkspaceId, activeWorkspace?.mode])
  // Runtime preconditions for registry commands, derived from the same active
  // scopes the dispatcher uses plus the panels' own availability predicates
  // (architect on roster, focusable agent). The
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
    // The Git panel mounts only while its pane tab is the one showing (the
    // pane unmounts a hidden Git tab) and the git module is on — a disabled
    // module renders the unavailable surface, whose handlers cannot act.
    const pane = commandWorkspace?.paneState
    if (
      pane?.open
      && selectModuleEnabled(moduleEnablement, 'git')
      && pane.tabs.some((tab) => tab.id === pane.activeTabId && tab.kind === 'git')
    ) {
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
    moduleEnablement,
    activeCommandScopes,
    windowActiveWorkspaceId,
    terminalSessions,
  ])
  // Names the bucket a session with no workspace row is listed under. A module
  // that spawns agents outside a window's knowledge (the review guide runs as an
  // agent terminal in its project workspace) claims its own agent-id prefix and
  // supplies the label — core asks the registry rather than importing any
  // module's own id predicate.
  const resolveDetachedSessionLabel = useCallback(
    (workspaceId: string): string | null => {
      for (const summary of [...terminalSessions, ...conversationSessions]) {
        if (summary.workspaceId !== workspaceId) continue
        const owner = getRendererHost().getAgentIdNamespace(summary.agentId ?? '', moduleEnabled)
        if (owner) return owner.label
      }
      return null
    },
    [terminalSessions, conversationSessions, moduleEnabled],
  )
  // Resolution runs against EVERY workspace, not just this window's, so a session
  // hosted in another window resolves to its real workspace and is filtered out
  // below — only a session no workspace anywhere claims becomes detached. Detached
  // rows belong to no window, so every window lists them: they are stoppable from
  // wherever the user notices them.
  const sessions = getSessionItems(
    useWorkspaceStore.getState().workspaces,
    terminalSessions,
    conversationSessions,
    { resolveDetachedLabel: resolveDetachedSessionLabel },
  ).filter((item) => item.group.kind === 'detached' || visibleWorkspaceIdSet.has(item.group.id))
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
    () => buildAttentionQueueItems(workspaces, terminalSessions, {
      resolveDetachedLabel: resolveDetachedSessionLabel,
    }),
    [workspaces, terminalSessions, resolveDetachedSessionLabel]
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
  const workspaceTypeSupervisors = useMemo(
    () =>
      collectWorkspaceTypeSupervisors(
        getRendererHost().getWorkspaceTypes(moduleEnabled),
        ownsGlobalSupervisors,
      ),
    [moduleEnabled, ownsGlobalSupervisors, moduleRegistryGeneration],
  )
  // The merge point output for keyboard dispatch: shell registry + enabled
  // module commands. Recomputed when enablement changes, so toggling a module
  // adds/removes its keybindings without a reload.
  const commandContributions = useMemo(
    () => getRendererHost().getCommandContributions((moduleId) => selectModuleEnabled(moduleEnablement, moduleId)),
    [moduleEnablement, moduleRegistryGeneration],
  )
  // Resolve the active door-routed full-page surface (global-surfaces epic 1704)
  // to its registered component, gated on the owning module's live enablement.
  // A disabled or unregistered surface id resolves to the explicit not-installed
  // door (MC-1854) — the door says its module is absent and links into
  // Extensions, rather than silently dropping the region back to the workspace.
  // The persisted id is deliberately left intact: reinstalling or re-enabling
  // the module lands the user back on the door they were in.
  //
  const activeGlobalSurfaceEntry = useMemo(() => {
    if (!activeGlobalSurface) return null
    return resolveActiveDoorSurface(
      activeGlobalSurface,
      (id) => getRendererHost().getGlobalSurface(id),
      (moduleId) => selectModuleEnabled(moduleEnablement, moduleId),
      (view) => openExtensionsSurface({ view }),
    )
  }, [activeGlobalSurface, moduleEnablement, openExtensionsSurface])

  // Resolve the active MODAL surface (doors→modals, 2026-09-01) to its
  // registered entry, gated on the owning module's live enablement. An id
  // whose surface is unregistered or whose module is disabled resolves to the
  // explicit absence explainer inside the modal — a deep-link opener (a run
  // notification for a since-disabled module) must produce feedback, never a
  // silent no-op. The trigger glyphs are enablement-filtered and never hit it.
  //
  // Settings is the exception, and deliberately NOT a module's surface: module
  // enablement is edited inside Settings, so a Settings modal that could be
  // gated off by a module toggle is a dialog that can lock its own key inside.
  // It resolves from the app itself, ungated.
  const activeModalSurfaceEntry = useMemo(() => {
    if (!activeModalSurface) return null
    if (activeModalSurface === 'settings') return CORE_SETTINGS_MODAL_SURFACE
    return resolveActiveModalSurface(
      activeModalSurface,
      (id) => getRendererHost().getModalSurface(id),
      (moduleId) => selectModuleEnabled(moduleEnablement, moduleId),
      (view) => openExtensionsSurface({ view }),
    )
  }, [activeModalSurface, moduleEnablement, moduleRegistryGeneration, openExtensionsSurface])

  // The first-run "you have no agent CLI" card. Two halves:
  //   - shouldShowFirstRunCliCard is the honest answer to "does this machine
  //     have any agent CLI", and refuses to answer until the probe resolves;
  //   - the region check keeps it out of the way of whatever the user is
  //     already looking at.
  // Deliberately NOT gated on having a workspace: a user who dismisses the
  // creation hub on an empty profile still deserves the answer. The hub itself
  // no longer races it on a fresh profile — the auto-open below waits on the
  // same probe (MC-2094) — so `!showNewWorkspacePanel` stops being the thing
  // that made this card unreachable and goes back to being what it reads as.
  const showFirstRunCliCard =
    shouldShowFirstRunCliCard({ cliAvailabilityStatus, cliAvailability, firstRunCliCardDismissed })
    && !activeGlobalSurfaceEntry
    && !showNewWorkspacePanel
    && !newChatPanelOpen

  // The open door's human name, for the rail's accessible name and the error
  // boundary's title. Derived once so the two can never disagree.
  const surfaceLabel = activeGlobalSurfaceEntry
    ? activeGlobalSurfaceEntry.id.charAt(0).toUpperCase() + activeGlobalSurfaceEntry.id.slice(1)
    : ''

  // Destination element for the active door surface's lifted bar. The surface
  // portals its bar (title · status · context · actions) into the WorkspaceHeader
  // strip via GlobalSurfaceBarSlotContext, collapsing the door's own bar row into
  // the top strip. A fresh object identity only on element change keeps the
  // context stable across unrelated re-renders.
  const [surfaceBarEl, setSurfaceBarEl] = useState<HTMLDivElement | null>(null)
  const surfaceBarSlot = useMemo(() => ({ el: surfaceBarEl }), [surfaceBarEl])

  // Destination for the active surface's lifted RAIL (item 1993): the scrollport
  // inside the context-rail column, which renders in the app sidebar's own
  // column while a door is open. Same contract as the bar slot above — a fresh
  // object identity only on element change.
  const [surfaceRailEl, setSurfaceRailEl] = useState<HTMLDivElement | null>(null)
  // Whether the open surface actually HAS a rail. The column has to be mounted
  // before the surface can portal into it, so the answer arrives one commit
  // after the question; until then (and for a surface with no rail at all) the
  // workspaces rail stays exactly where it is. Every door on the substrate
  // DECLARES a rail in every load state (T19), so in the product this settles
  // true for the whole visit; the false branch is the one-commit settle and any
  // future canvas-only tenant, which nests no second navigation column and so
  // has nothing to replace.
  const [surfaceHasRail, setSurfaceHasRail] = useState(false)
  const surfaceRailSlot = useMemo(
    () => ({ el: surfaceRailEl, onRailPresence: setSurfaceHasRail }),
    [surfaceRailEl],
  )
  // Derived, never trusted on its own: `surfaceHasRail` is reported BY the
  // surface, so it is still true for a commit after the surface has gone. Reading
  // it through the live entry is what puts the workspaces rail back in the same
  // commit that clears the door — which is in turn what makes focus land on the
  // door's own row rather than on a row that is still `display:none`.
  const contextRailActive = activeGlobalSurfaceEntry !== null && surfaceHasRail
  // The door's canvas region, for deciding whether an Escape belongs to the door.
  const [surfaceRegionEl, setSurfaceRegionEl] = useState<HTMLDivElement | null>(null)
  const surfaceTrigger = useSurfaceTriggerFocus(activeGlobalSurface)

  // Leaving a door: restore the rail it replaced and hand the keyboard back to
  // the row that opened it. `closeGlobalSurface` is the whole of "back" for a
  // door (globalSurface/surfaceBackNav.ts) — never NavHistory, which would walk
  // to wherever the operator happened to be before instead of out of the door.
  const leaveGlobalSurface = useCallback(() => {
    surfaceTrigger.leave(closeGlobalSurface)
  }, [surfaceTrigger, closeGlobalSurface])

  // The same trigger-focus restore, offered to the door itself. The bar chevron
  // is rendered inside the surface's tree by `GlobalSurfaceShell`, so without this
  // it would reach only the store's bare `closeGlobalSurface` and leave the
  // keyboard on `<body>` — the rail row it replaces got the restore for free by
  // being the host's own. `leave` takes an optional close override for a surface
  // that owns extra state; absent one, this HOST closes the door (the modal host
  // below supplies its own default the same way).
  const surfaceExit = useMemo<SurfaceExit>(
    () => ({ leave: (close) => surfaceTrigger.leave(close ?? closeGlobalSurface) }),
    [surfaceTrigger, closeGlobalSurface],
  )

  // The modal host's exit: the same SurfaceExit contract the door host provides,
  // so one surface component (GlobalSurfaceShell's bar chevron included) leaves
  // correctly from either host. No trigger-focus bookkeeping here — Modal itself
  // restores focus to the element that opened it.
  const modalSurfaceExit = useMemo<SurfaceExit>(
    () => ({ leave: (close) => (close ?? closeModalSurface)() }),
    [closeModalSurface],
  )

  // A door has to hold the keyboard to have a keyboard exit at all.
  //
  // `ContextRailColumn` takes focus when it replaces the sidebar, so a door WITH
  // a rail is fine. A door without one left focus on the sidebar row that opened
  // it, which belongs to neither the door's canvas nor its rail, so Escape below
  // never claimed the keystroke and the door had no keyboard exit. Every door now
  // declares a rail in every state (T19), so this covers the one-commit settle
  // before the surface has answered, plus any future canvas-only tenant.
  // The page region takes the keyboard instead. It is also what makes a click on
  // the door's own empty canvas land INSIDE the door (a click on a non-focusable
  // node focuses its nearest focusable ancestor) rather than dropping focus to
  // `<body>`, which used to disarm Escape for the rest of the visit.
  //
  // Keyed on the surface and on whether the rail took over, exactly as the rail
  // column is, so it can never pull focus out of a control mid-surface.
  useEffect(() => {
    if (!surfaceRegionEl || contextRailActive) return
    if (surfaceRegionEl.contains(document.activeElement)) return
    // An overlay ON the door keeps the keyboard. A door's rail can appear or
    // vanish mid-surface (a door declares no rail until it has content), and that
    // is exactly when a confirm or prompt is likely to be open — deleting the last
    // horizon both empties the rail and holds a dialog. Taking focus to the region
    // behind it would leave that dialog un-dismissable from the keyboard.
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')) return
    surfaceRegionEl.focus()
  }, [surfaceRegionEl, contextRailActive, activeGlobalSurface])

  // Escape leaves the door: the keyboard twin of the bar's back chevron, and the
  // two affordances have to agree. Deliberately NOT a
  // dialog dismissal — nothing here traps focus, and a keystroke aimed at an
  // overlay ON the door (a context menu, a confirm, a listbox) stays that
  // overlay's, which is what `escapeLeavesSurface` decides.
  useEffect(() => {
    if (!activeGlobalSurfaceEntry) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (!escapeLeavesSurface(document.activeElement, surfaceRegionEl)) return
      event.preventDefault()
      leaveGlobalSurface()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeGlobalSurfaceEntry, surfaceRegionEl, leaveGlobalSurface])

  // The one way the creation hub opens, on whatever the caller preselected.
  //
  // Every opener closes the active door surface: the hub mounts inside the
  // workspace-card container, which is inert and painted over while a door is
  // active — without this the click is a visible no-op and the armed panel pops
  // up later (same contract as openNewChatPanel / the New-sprint door flow).
  //
  // Opening also releases the Sprints door's claim on the next sprint creation
  // (item 1811): the wizard now on screen is the one this caller opened. The door
  // re-claims immediately after asking for its own, so the claim always belongs to
  // the wizard the operator is actually looking at.
  const presentNewWorkspacePanel = useCallback((initialState: NewWorkspacePanelInitialState | null) => {
    setNewWorkspacePanelInitialState(initialState)
    setShowNewWorkspacePanel(true)
    releaseSprintCreationDoorClaim()
    closeGlobalSurface()
    // closeModalSurface also clears the settings request — it is the whole of
    // "no modal, clean settings" here.
    closeModalSurface()
    setNotificationsOpen(false)
  }, [closeGlobalSurface, closeModalSurface])

  const openNewWorkspacePanel = useCallback(() => {
    presentNewWorkspacePanel(null)
  }, [presentNewWorkspacePanel])

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
      }, cliModelCatalog),
    [
      pluginCatalogStatus,
      pluginCatalogEntries,
      cliRuntimes,
      cliAvailability,
      cliAvailabilityStatus,
      cliModelCatalog,
    ],
  )
  // The CLI a new spawn should launch: the remembered one when it is installed,
  // otherwise the first installed entry — and `null` when this machine has no
  // agent CLI at all (MC-2093). The old rescue answered with the remembered id
  // in that case, seeding an agent against a binary that is not here; a spawn
  // that gets `null` opens the install surface instead.
  const launchableSpawnCli = (cli: AgentCli): AgentCli | null =>
    resolveLaunchableAgentCli(cli, agentCliCatalog)
  const routeToCliInstall = (): void => {
    openSettingsOverlay({ initialTab: AGENTS_SETTINGS_TAB })
  }

  // Conversation spawn is offered only in standard workspaces; Sprint Engine
  // agents stay terminal/MCP-owned (AgentPanel enforces this too).
  const conversationSpawnEnabled = activeWorkspace?.mode === 'standard'
  // Every surface that can spawn a conversation agent asks for the catalog by
  // bumping this counter: the launch surface (MC-2147) and the launcher's
  // picker both offer the row. It used to be keyed on the top bar's spawn
  // menu alone, which no longer exists (MC-2222), and while it was, the row
  // could never appear elsewhere — the catalog stayed empty, so the option
  // silently did not exist.
  const [conversationCatalogRequests, setConversationCatalogRequests] = useState(0)
  const requestConversationCatalog = useCallback(() => {
    setConversationCatalogRequests((count) => count + 1)
  }, [])

  // Load the conversation provider catalog when a surface that offers one opens
  // in a standard workspace. Defensive: if the IPC is absent the feature is
  // simply unavailable and no rows render. We refetch on each open so a provider
  // just configured in Settings shows up without a restart.
  React.useEffect(() => {
    if (conversationCatalogRequests === 0 || !conversationSpawnEnabled) return
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
  }, [conversationCatalogRequests, conversationSpawnEnabled, cliRuntimes])
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
        message: 'The Solo layout template is missing, so a one-agent chat cannot be created.',
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
    dismissNewWorkspacePanel()
    closeSettingsOverlay()
    setNotificationsOpen(false)
  }, [
    activeWorkspace?.folderPath,
    addWorkspace,
    closeSettingsOverlay,
    dismissNewWorkspacePanel,
    pickNewChatName,
    workspaceWindowId,
  ])

  const createNewChat = useCallback((
    folderPath?: string | null,
    cli?: AgentCli,
    skill?: WorkspaceSkill,
    // What the launch surface typed. A new chat is a solo workspace whose agent
    // starts itself, so the prompt rides its seed patch rather than a tab.
    startupPrompt?: string,
  ) => {
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
    // A New chat seeds an agent that starts itself, so on a machine with no
    // agent CLI it would create a workspace around a binary that is not here
    // (MC-2093). The install is the honest answer to "start a chat" instead.
    if (!resolveLaunchableAgentCli(templateAgentCli, agentCliCatalog)) {
      openSettingsOverlay({ initialTab: AGENTS_SETTINGS_TAB })
      return
    }
    // Ride the remembered General model when it belongs to the spawning CLI —
    // the same mechanism as a specialist. Seeded via an agentPatch (no tabName,
    // so the layout is untouched). The patch always carries the composer's
    // permission preset and debug mode: a General chat honors the picked
    // Default/Auto/Bypass exactly like a specialist chat does.
    const cliModel = resolveSurfaceModel(templateAgentCli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY])
    const cliReasoning = resolveCliReasoning(templateAgentCli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY])
    createSoloChatWorkspace({
      folderPath,
      templateAgentCli,
      seedAgent: {
        agentPatch: {
          ...(cliModel ? { cliModel } : {}),
          ...(cliReasoning ? { cliReasoning } : {}),
          cliPermissionPreset: agentSpawnPermissionPreset,
          debugMode: agentSpawnDebugMode,
          ...(startupPrompt ? { cliStartupPrompt: startupPrompt } : {}),
          ...(skill
            ? skillSpawnAgentPatch(skill, pluginCatalogEntries.find((entry) => entry.id === templateAgentCli)?.skillIntegration)
            : {}),
        },
      },
    })
    // Remember an explicit pick as General's own default — never the shared
    // lastSelectedCli, so a new-chat CLI never bleeds into the specialists.
    if (chosenCli) setSpecialistCliDefault(GENERAL_AGENT_ENGINE_KEY, chosenCli)
    if (agentSpawnDebugMode) setAgentSpawnDebugMode(false)
  }, [agentCliCatalog, agentSpawnDebugMode, agentSpawnPermissionPreset, createSoloChatWorkspace, openSettingsOverlay, pluginCatalogEntries, specialistCliDefaults, specialistModelDefaults, lastSelectedCli, setSpecialistCliDefault])

  // Launch an isolated connector chat for any catalog entry or installed MCP
  // server: a fresh worktree on `connector/<id>-<uid>`, opened as a worktree-backed
  // solo chat whose spawn carries ONLY that connector's MCP (never the global
  // appSettings.mcp). A catalog entry with a driving skill (e.g. Railway) also
  // installs the skill and seeds its invocation; a plain MCP launches with a
  // kickoff prompt naming the attached server instead. Exactly one worktree per
  // connector chat — a new id (and so a new worktree) is minted on every
  // invocation. This is the single connector runtime, and it is reached only
  // through the composer's confirm: Railway's Command Palette entry and every
  // connector "New chat" now open the composer with the connector attached, so
  // no surface spawns a connector chat without the user choosing an agent.
  const launchConnectorChat = useCallback(async (
    serverId: string,
    // Composer overrides (the "+ Connector" attachment): the panel's chosen
    // project as the worktree base, the picked engine, an optional specialist
    // identity, and a "+ Skill" attachment. Absent (palette, Connectors
    // surface, automations) the launch is the plain General connector chat.
    composed?: {
      folderPath?: string | null
      cli?: AgentCli
      specialistId?: SpecialistActionId
      skill?: WorkspaceSkill
    },
  ) => {
    const connectorError = (title: string, message: string) =>
      publishDiagnosticSync({ level: 'error', source: 'workspace', title, message })

    const baseFolderPath = composed?.folderPath ?? activeWorkspace?.folderPath
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
    const resolution = await resolveConnectorLaunch(
      serverId,
      useWorkspaceStore.getState().appSettings.mcp?.servers,
    )
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
    // spawning agent's engine default (General, or the composed specialist's).
    // The skill invocation is CLI-native (e.g. `/use-railway` vs
    // `Use $use-railway.`); when the CLI declares no native skill support
    // connectorStartupPrompt falls back to the plain instruction.
    const specialist = composed?.specialistId ? getSpecialistAction(composed.specialistId) : null
    const engineKey = specialist ? specialist.id : GENERAL_AGENT_ENGINE_KEY
    const cli = resolveTemplateAgentCli(
      composed?.cli ?? specialistCliDefaults[engineKey],
      lastSelectedCli,
      agentCliCatalog,
    )
    const cliModel = resolveSurfaceModel(cli, specialistModelDefaults[engineKey])
    const cliReasoning = resolveCliReasoning(cli, specialistModelDefaults[engineKey])
    const invocation = skillId
      ? resolveSkillInvocation(
          pluginCatalogEntries.find((entry) => entry.id === cli)?.skillIntegration,
          skillId,
        )
      : undefined
    // With a driving skill the seeded turn runs its playbook; a plain MCP chat
    // has none, so the kickoff just states which server is attached. A composed
    // specialist keeps its role prompt as the seeded turn instead — the
    // connector still arrives via the isolated MCP config and skill install.
    const connectorPrompt = connectorStartupPrompt(
      invocation,
      skillId
        ? `Show me my ${server.name} setup and flag anything that needs attention.`
        : `The ${server.name} MCP server is attached to this chat. Confirm you can reach it, then show me what it can do.`,
    )
    const tabName = specialist ? pickRandomAgentName([]) : null
    const startupPrompt = specialist && tabName
      ? prependAgentIdentifier(buildSpecialistSoulStartupPrompt(specialist), tabName, specialist.shortLabel)
      : connectorPrompt

    createSoloChatWorkspace({
      folderPath: worktreeResult.data.path,
      worktree: { branch: worktreeResult.data.branch ?? branchName, baseRef: 'HEAD' },
      name: `${server.name} · ${uid}`,
      templateAgentCli: cli,
      seedAgent: {
        ...(tabName ? { tabName } : {}),
        agentPatch: {
          ...(specialist && tabName
            ? {
                name: tabName,
                cli,
                kind: 'specialist' as const,
                specialistId: specialist.id,
                cliOnboardingPromptSent: false,
                cliHasLaunched: false,
                cliResumeAvailable: false,
              }
            : {}),
          ...(cliModel ? { cliModel } : {}),
          ...(cliReasoning ? { cliReasoning } : {}),
          // The composer surfaces the permission preset + debug controls, so a
          // composed launch honors them like every other new-chat spawn; the
          // preset-less legacy entry points keep their behavior.
          ...(composed
            ? { cliPermissionPreset: agentSpawnPermissionPreset, debugMode: agentSpawnDebugMode }
            : {}),
          connectorMcpSettings: mcpSettings,
          ...(skillId ? { connectorSkillId: skillId } : {}),
          cliStartupPrompt: startupPrompt,
          ...(composed?.skill
            ? skillSpawnAgentPatch(
                composed.skill,
                pluginCatalogEntries.find((entry) => entry.id === cli)?.skillIntegration,
              )
            : {}),
        },
      },
    })
    if (composed && agentSpawnDebugMode) setAgentSpawnDebugMode(false)
  }, [
    activeWorkspace?.folderPath,
    agentCliCatalog,
    agentSpawnDebugMode,
    agentSpawnPermissionPreset,
    createSoloChatWorkspace,
    lastSelectedCli,
    pluginCatalogEntries,
    setAgentSpawnDebugMode,
    specialistCliDefaults,
    specialistModelDefaults,
  ])

  // "New chat" entry point: create a fresh workspace that opens empty, so
  // WorkspaceLayout's empty-workspace rule opens the New chat launch surface in
  // the tab its agent will run in. `folderPath === undefined` inherits the
  // active workspace's folder, matching the plain New chat default. No agent is
  // seeded.
  const createNewChatWorkspace = useCallback((folderPath?: string | null) => {
    const targetFolderPath = folderPath === undefined ? activeWorkspace?.folderPath ?? null : folderPath
    addWorkspace(EMPTY_CHAT_TEMPLATE, {
      name: pickNewChatName(targetFolderPath),
      folderPath: targetFolderPath,
      windowId: workspaceWindowId,
    })
    dismissNewWorkspacePanel()
    closeSettingsOverlay()
    setNotificationsOpen(false)
  }, [
    activeWorkspace?.folderPath,
    addWorkspace,
    closeSettingsOverlay,
    dismissNewWorkspacePanel,
    pickNewChatName,
    workspaceWindowId,
  ])

  const openNewWorkspacePanelForFolder = useCallback((folderPath: string) => {
    presentNewWorkspacePanel({ folderPath })
  }, [presentNewWorkspacePanel])

  // The one way the New sprint dialog opens (MC-2062) — the sidebar's New
  // sprint, the Sprints door's New sprint, and every plan-sourced entry
  // (`initialFuturePlan`) all land here. Mirrors presentNewWorkspacePanel: the
  // dialog overlays the workspace card region, so whatever owns that region
  // steps aside, and the Sprints-door claim resets to whoever opened this one.
  const openNewSprintDialog = useCallback(
    (initial?: { folderPath?: string | null; source?: FuturePlanWorkspaceSource | null }) => {
      setNewSprintDialogState({
        folderPath:
          initial?.source?.folderPath
          ?? initial?.folderPath
          ?? activeWorkspace?.folderPath
          ?? null,
        initialSource: initial?.source ?? null,
      })
      // One dismissal route for the creation hub (item 1811), so opening the
      // dialog releases whatever claim came before, exactly like the wizard.
      dismissNewWorkspacePanel()
      setNewChatPanelState(null)
      closeGlobalSurface()
      // The New sprint dialog is a Modal of its own: an open modal surface
      // closes first, or two focus-trapping dialogs stack and one Escape
      // dismisses both (closeModalSurface also clears the settings request).
      closeModalSurface()
      setNotificationsOpen(false)
    },
    [activeWorkspace?.folderPath, closeGlobalSurface, closeModalSurface, dismissNewWorkspacePanel],
  )

  // Open the creation hub preselected on a type — the sidebar "+" menu rows.
  // Sprint creation is no longer a wizard flow: its row opens the dialog.
  const openNewWorkspacePanelWithMode = useCallback((mode: WorkspaceMode) => {
    if (mode === 'sprintengine') {
      openNewSprintDialog()
      return
    }
    presentNewWorkspacePanel({ mode })
  }, [openNewSprintDialog, presentNewWorkspacePanel])

  // "New sprint" on the Sprints door (item 1763). A door-routed surface is
  // zero-prop by contract, so it signals instead of calling — and because the
  // door paints over the card region the wizard lives in, the door closes first,
  // otherwise the wizard would open behind it. Item 1765 gives that wizard its
  // primary-project picker, and the return leg below: a run started at the door
  // belongs to the door, so creating one comes back here rather than dropping
  // the operator into the workspace it resides in. The claim lives with the door
  // seam; it is taken after the wizard opens (opening releases whatever claim came
  // before) and released again by every route back out of it (item 1811).
  const openSettings = useCallback((checkForUpdates = false, targetTab: string | null = null) => {
    openSettingsOverlay({ initialTab: targetTab, checkForUpdates })
    dismissNewWorkspacePanel()
    // Primary+, is a global shortcut, so it fires through the New sprint
    // dialog's focus trap: that dialog closes (claim released, item 1811)
    // rather than stacking a second Modal under the Settings one — one Escape
    // would dismiss both.
    closeNewSprintDialog()
    setSessionsOpen(false)
    setViewMenuOpen(false)
    setNotificationsOpen(false)
    setAccountOpen(false)
  }, [closeNewSprintDialog, dismissNewWorkspacePanel, openSettingsOverlay])

  const openLearnCenter = useCallback(() => {
    openSettings(false, 'learn')
  }, [openSettings])

  const openFuturePlanWorkspace = useCallback((source: FuturePlanWorkspaceSource) => {
    openNewSprintDialog({ source })
  }, [openNewSprintDialog])

  useEffect(
    () =>
      subscribeNewSprintRequests((source) => {
        closeGlobalSurface()
        // A request carrying a plan (a "Run a Sprint" from a Backlog door row)
        // opens the New sprint dialog with that selection already made, exactly
        // as the per-project panel's own action does; the rail's bare "New
        // sprint" opens it with nothing chosen.
        if (source) openFuturePlanWorkspace(source)
        else openNewWorkspacePanelWithMode('sprintengine')
        claimSprintCreationForDoor()
      }),
    [closeGlobalSurface, openFuturePlanWorkspace, openNewWorkspacePanelWithMode],
  )

  const setAgentSpawnPermissionPreset = (preset: SprintEngineCliPermissionPreset) => {
    setAgentSpawnPermissionPresetState(preset)
    setLastAgentSpawnPermissionPreset(preset)
  }

  useEffect(() => {
    // The one-shot startup tip. It used to wait for the onboarding wizard to
    // finish, then suppress itself for the session that walked it — the wizard is
    // gone, but the reason for that suppression is not: a profile with no
    // workspaces yet is mid-setup, with the creation hub open over everything,
    // and the tip modal (which has no focus trap) would stack on top of it and
    // leak Tab to the surface behind. So a first-run session decides "no tip" and
    // stays decided; the tip returns on the next launch, once a workspace exists.
    if (tipModalDecidedRef.current) return
    if (railWorkspaces.length === 0) {
      tipModalDecidedRef.current = true
      return
    }
    // Hold the decision until the CLI probe has said something. It resolves
    // AFTER hydration, so deciding now would always decide "no card yet" and
    // then pop the tip on top of the card a second later.
    if (cliAvailabilityStatus === 'loading') return
    tipModalDecidedRef.current = true
    // The one question the app cannot answer for itself outranks a generic tip.
    if (showFirstRunCliCard) return
    if (!showTipsOnStartup) return
    setTipModalOpen(true)
  }, [showTipsOnStartup, railWorkspaces.length, cliAvailabilityStatus, showFirstRunCliCard])

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
    document.title = [windowName, projectName, 'Sprint Engine Studio'].filter(Boolean).join(' - ')
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

  // Opening a workspace puts the cursor in the terminal you are looking at, so
  // you can type into it without clicking first.
  //
  // Once per workspace per app session, not on every switch: coming back to a
  // workspace you were already using should leave the keyboard wherever you left
  // it (a file editor, the board), and layers are never unmounted on switch
  // (they go `invisible`, not away), so "opened before" is exactly this latch.
  //
  // A terminal cannot be asked to focus until it is mounted, and AgentPanel
  // lazy-loads TerminalView, so this re-asks on a short schedule until a pane
  // answers — and stops early if the user has already started typing somewhere
  // else, which is the only way this could be an interruption rather than a
  // convenience.
  const terminalFocusSeededWorkspaceIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const workspaceId = windowActiveWorkspaceId
    if (!workspaceId) return undefined
    if (terminalFocusSeededWorkspaceIdsRef.current.has(workspaceId)) return undefined
    terminalFocusSeededWorkspaceIdsRef.current.add(workspaceId)

    let settled = false
    const attempt = (): void => {
      if (settled) return
      if (focusRequestWouldInterrupt(document.activeElement)) {
        settled = true
        return
      }
      const target = visibleTerminalTabInLayout(getModel(workspaceId)?.toJson())
      // No terminal on screen (a Files-only or board-only layout, or a layout
      // that has not registered yet) — nothing to focus, and never a reason to
      // change which tab is selected.
      if (!target) return
      const handled = requestTerminalFocus(
        target.kind === 'agent'
          ? { workspaceId, agentId: target.agentId }
          : { workspaceId, terminalId: target.terminalId },
      )
      if (handled) settled = true
    }

    attempt()
    const timers = TERMINAL_FOCUS_RETRY_DELAYS_MS.map((delay) => window.setTimeout(attempt, delay))
    return () => {
      settled = true
      for (const timer of timers) window.clearTimeout(timer)
    }
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

  // Auto-open the new-workspace panel when there are no workspaces — unless the
  // first-run CLI question still owns that window (MC-2094). Precedence lives
  // HERE, at the opener, not on the card: the card's own "don't fight for the
  // region" gate below stays exactly as it is, and it is satisfied because the
  // hub simply has not opened yet. A scalar boolean, not the availability map, is
  // what the effect depends on — a background re-probe hands back a fresh map
  // object every time, and depending on that would re-open a hub the user closed.
  const autoOpenCreationHub = shouldAutoOpenCreationHub({
    workspaceCount: railWorkspaces.length,
    cliAvailabilityStatus,
    cliAvailability,
    firstRunCliCardDismissed,
  })

  useEffect(() => {
    if (autoOpenCreationHub) {
      setShowNewWorkspacePanel(true)
    }
  }, [autoOpenCreationHub])

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

      // Name a new chat after the first real prompt sent inside it, so a sidebar
      // of them says what each was for instead of "Chat 44". The store action
      // owns the rules — it no-ops once a workspace's name is locked, and skips a
      // prompt that yields no usable title (an app-injected skill drop, pure
      // filler), leaving the next prompt to try. So this only has to avoid
      // re-offering a prompt it already offered.
      for (const session of sessions) {
        const prompt = session.lastPrompt
        if (!prompt || typeof session.workspaceId !== 'string') continue
        const offered = titledPromptAtRef.current.get(session.sessionId)
        if (offered !== undefined && offered >= prompt.at) continue
        titledPromptAtRef.current.set(session.sessionId, prompt.at)
        autoTitleWorkspaceFromPrompt(session.workspaceId, prompt.text)
      }

      if (!reconciledLaunchFlagsRef.current) {
        reconciledLaunchFlagsRef.current = true
        reconcileWorkspaceAgentLaunchFlags(sessions)
      }

      // Agents the MAIN process launched (MC-2159) have no record here until
      // this projects one: main composed and spawned them, possibly with no
      // window open at all. Running on every session tick — not once — is what
      // makes a window opened long after a headless launch show the agent, and
      // what makes a launch into an already-open window appear as a tab. Both
      // arrive the same way, so there is one path to be right.
      //
      // The store is idempotent (an agent it already holds is untouched), so the
      // only per-tick work is revealing the tabs it just created.
      for (const projected of projectLaunchedAgentSessions(sessions)) {
        markLaunchedAgentProjected(projected.workspaceId, projected.agentId)
        const host = useWorkspaceStore
          .getState()
          .workspaces.find((candidate) => candidate.id === projected.workspaceId)
        revealAgentTerminalTab(
          {
            workspaceId: projected.workspaceId,
            agentId: projected.agentId,
            name: projected.agent.name,
          },
          // A launch into a standard workspace is something the operator asked
          // for and gets the view; a launch into a rail-hidden host (Automations,
          // a sprint run) gets its tab without moving anyone into it.
          { activateWorkspace: !host || !isHiddenFromRail(host) },
        )
      }

      // The renderer half of `agent.dispose`. Main kills a finished run's agent
      // session (so a one-shot agent never lingers pointing at a torn-down run
      // worktree); this is what drops the tab and the record that were standing
      // in for it. Only agents THIS projection created are ever candidates — a
      // user-created agent whose terminal exited keeps its tab, exactly as
      // before. Record last, so any tab-close handler still sees the agent.
      for (const retired of retiredLaunchedAgents(sessions)) {
        removeAgentTab(retired.workspaceId, retired.agentId)
        useWorkspaceStore.getState().removeAgent(retired.workspaceId, retired.agentId)
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
  }, [
    recordWorkspaceTerminalActivity,
    reconcileWorkspaceAgentLaunchFlags,
    projectLaunchedAgentSessions,
    autoTitleWorkspaceFromPrompt,
  ])

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
    setSessionsOpen(false)
    setAttentionQueueOpen(false)
    setNotificationsOpen(false)
  }, [windowActiveWorkspaceId])

  // Resolves when the close has actually run: every terminal kill acknowledged by
  // main and the workspace gone from the store. Callers that only want the
  // workspace closed can ignore it; a caller that then touches the run's files
  // must not (item 1812).
  const closeWorkspaceById = useCallback(
    (id: string): Promise<void> => {
      const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === id)
      const terminated = workspace ? terminateWorkspaceTerminals(workspace) : Promise.resolve()
      removeWorkspace(id)
      return terminated
    },
    [removeWorkspace]
  )

  // "Close workspace" for a sprint run, asked for by the Sprints door (item
  // 1767). The row that used to offer it is gone, but the operation is unchanged:
  // the same close path, so the run's agent terminals are terminated rather than
  // orphaned. The run itself stays on disk and keeps listing in the door. The
  // returned promise is what the door's "Delete sprint" waits on before it moves
  // the run's folder to the trash.
  useEffect(
    () => subscribeCloseSprintWorkspaceRequests((workspaceId) => closeWorkspaceById(workspaceId)),
    [closeWorkspaceById],
  )

  // Bring over an existing Claude Code / Codex setup, silently, at the first
  // workspace creation. This used to be a question on the wizard's essentials
  // step — "we found N, adopt them?" — whose answer was replayed here. There is
  // no card now, so it adopts everything it finds, once per profile.
  //
  // It cannot run any earlier: `agent-config-import.ts` requires a real
  // `workspaceRoot` that passes `isDirectory()`, and until this moment there is
  // no folder. The outcome is read out as one line in Settings → Agents — and a
  // failure says so, because silently dropping an adoption is worse than
  // admitting it failed.
  const runFirstRunAgentConfigAdoption = useCallback(
    (workspaceRoot: string | null) => {
      // Early-out before the detect IPC, not just before the write: a profile
      // that already adopted should not probe the user's home directory again on
      // every workspace it ever creates.
      if (hasAdoptedAgentConfig) return
      // The persisted flag is only set once the adopt IPC returns, so two creates
      // in quick succession would both pass the check above and adopt twice. The
      // ref closes that window synchronously.
      if (adoptionInFlightRef.current) return
      adoptionInFlightRef.current = true
      void (async () => {
        try {
          let detected: { mcpServerKeys: string[]; skillKeys: string[] } | null = null
          try {
            const detection = await window.api.detectExistingAgentConfig()
            if (!detection.ok) {
              // Detection itself failed. Report it and leave the profile
              // un-adopted so the next workspace creation tries again — claiming
              // "adopted" here would bury a real failure under a flag.
              setAgentConfigAdoptionResult({ status: 'failed', message: detection.message })
              return
            }
            detected = {
              mcpServerKeys: detection.mcpServers.map((server) => server.key),
              // Non-adoptable skills (custom ones) are visible in Settings but
              // never travel through this path.
              skillKeys: detection.skills.filter((skill) => skill.adoptable).map((skill) => skill.key),
            }
          } catch (error) {
            setAgentConfigAdoptionResult({
              status: 'failed',
              message: error instanceof Error ? error.message : String(error),
            })
            return
          }

          const plan = planAgentConfigAdoption({ hasAdoptedAgentConfig, workspaceRoot, detected })
          if (plan.kind === 'skip') return
          if (plan.kind === 'nothing-detected') {
            // A real answer, and a silent one: a user who never had Claude Code
            // or Codex has nothing to be told about. The profile is still marked
            // so the detect probe never runs again.
            markAgentConfigAdopted()
            return
          }
          if (plan.kind === 'missing-root') {
            setAgentConfigAdoptionResult(plan.result)
            return
          }

          setAgentConfigAdoptionResult({ status: 'adopting' })
          try {
            const result = await window.api.adoptAgentConfig({
              workspaceRoot: plan.workspaceRoot,
              mcpServerKeys: plan.mcpServerKeys,
              skillKeys: plan.skillKeys,
            })
            if (result.ok) {
              markAgentConfigAdopted()
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
        } finally {
          adoptionInFlightRef.current = false
        }
      })()
    },
    [hasAdoptedAgentConfig, markAgentConfigAdopted, setAgentConfigAdoptionResult],
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
    // Read the door's claim before dismissing the wizard — dismissal releases it.
    const cameFromSprintsDoor = consumeSprintCreationDoorClaim()
    dismissNewWorkspacePanel()
    // Started at the Sprints door: return there on the run that was just created
    // (item 1765). The workspace is still made and still resident — it holds the
    // terminals — but reading the run is the door's job, and "Open agents" on the
    // canvas is the deliberate way into the workspace.
    if (cameFromSprintsDoor && mode === 'sprintengine' && sprintEngineContext?.statePath) {
      noteSprintDoorSelection(sprintEngineContext.statePath)
      openGlobalSurface('sprints')
    }
    // A real workspace root now exists, which is the earliest point an existing
    // agent config can be adopted. Guarded once-per-profile inside.
    runFirstRunAgentConfigAdoption(folderPath)
  }

  // Checkpoint cleanup, quiet by design: a host without the git bridge (or an
  // older preload) simply has nothing to prune, and a failure here must never
  // block a delete the person asked for.
  const forgetWorkspaceCheckpoints = useCallback(async (workspaceId: string) => {
    try {
      await window.api.forgetWorkspaceCheckpoints?.(workspaceId)
    } catch {
      // The refs stay; the workspace still goes.
    }
  }, [])

  const deleteWorkspaceWithState = useCallback(
    async (id: string) => {
      const workspace = workspaces.find((candidate) => candidate.id === id)
      if (!workspace) return
      // Before the folder is trashed, not alongside it: a still-live agent writing
      // into the run directory recreates what was just deleted (item 1812).
      await terminateWorkspaceTerminals(workspace)
      const dirPath =
        workspace.mode === 'sprintengine'
          ? workspace.sprintEngineContext?.teamDirectoryPath ?? null
          : null
      if (dirPath) {
        try {
          await window.api.deletePath(dirPath)
          // Same run, same debris risk as the door's own delete: the Sprints door
          // lists from disk, so a folder a surviving writer puts back must not
          // read as a run there either (item 1812).
          const statePath = workspace.sprintEngineContext?.statePath
          if (statePath) noteSprintRunDeleted(statePath)
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
      // Epic decision 8: a deleted workspace's checkpoint refs go with it.
      // Nothing else prunes them, so without this up to 50 snapshot refs per
      // workspace accumulate in the user's repo forever.
      await forgetWorkspaceCheckpoints(id)
      removeWorkspace(id)
    },
    [workspaces, removeWorkspace, forgetWorkspaceCheckpoints]
  )

  const handleForgetFolder = useCallback(
    (folderPath: string) => {
      const normalize = (value: string) =>
        value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
      const targetKey = normalize(folderPath)
      workspaces.forEach((workspace) => {
        if (workspace.folderPath && normalize(workspace.folderPath) === targetKey) {
          // Nothing on disk is touched afterwards, so the kills run in the
          // background rather than holding the folder out of the sidebar.
          void terminateWorkspaceTerminals(workspace)
          // And the checkpoints go with the workspace (epic decision 8), for
          // the same reason as delete: nothing else ever prunes them.
          void forgetWorkspaceCheckpoints(workspace.id)
        }
      })
      forgetFolder(folderPath)
    },
    [workspaces, forgetFolder, forgetWorkspaceCheckpoints]
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
    const map: Record<
      string,
      { hasRunning: boolean; idleSince: number | null; lastInputAt: number | null; workingSince: number | null }
    > = {}
    for (const workspace of workspaces) {
      const persistedLastInputAt = typeof workspace.lastTerminalActivityAt === 'number'
        ? workspace.lastTerminalActivityAt
        : null
      const activity = deriveWorkspaceTerminalActivity(workspace.id, terminalSessions, persistedLastInputAt)
      const hasRunning = activity.kind === 'working' || activity.kind === 'failed'
      const idleSince = deriveWorkspaceIdleSince(workspace.id, terminalSessions, persistedLastInputAt)
      const lastInputAt = deriveWorkspaceLastInputAt(workspace.id, terminalSessions, persistedLastInputAt)
      // When the turn started, for the sidebar row's "how long has it been
      // working" counter. NOT `activity.kind === 'working' && activity.since`:
      // that is true of a session merely STARTING, so resuming a suspended
      // terminal started the clock with nothing asked of the agent (owner,
      // 2026-09-04). The dedicated derivation asks the hooks instead.
      const workingSince = deriveWorkspaceWorkingSince(workspace.id, terminalSessions)
      map[workspace.id] = { hasRunning, idleSince, lastInputAt, workingSince }
    }
    return map
  }, [workspaces, terminalSessions])


  // Create the git worktree an agent spawn requested ("+ Worktree" in the
  // agent composer): placed under the shared worktree container on branch
  // `agent/<slug>`, and registered in the workspace's worktree registry with
  // the new agent as owner. Returns the agent's execution, or null after
  // publishing a diagnostic — the caller aborts the spawn, because silently
  // spawning into the main checkout would drop the isolation the user asked for.
  const createAgentSpawnWorktree = async (
    workspace: Workspace,
    agentId: string,
    tabName: string,
    requestedName: string,
  ): Promise<AgentExecution | null> => {
    const spawnError = (title: string, message: string) =>
      publishDiagnosticSync({
        level: 'error',
        source: 'workspace',
        title,
        message,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      })

    if (!workspace.folderPath) {
      spawnError('Worktree needs a project', 'Open a project folder before spawning an agent on a worktree.')
      return null
    }
    const repoRoot = await window.api.getGitRepoRoot(workspace.folderPath)
    if (!repoRoot) {
      spawnError(
        'Worktree needs a git repository',
        'This project is not a git repository, so an agent worktree cannot be created.',
      )
      return null
    }
    // A typed name is used verbatim; an empty one derives from the agent's tab
    // name plus a short uid so repeat spawns never collide on the branch.
    const name = requestedName.trim() || `${tabName}-${nanoid(4).toLowerCase()}`
    const paths = agentWorktreePaths(repoRoot, name)
    if (!paths) {
      spawnError('Worktree name invalid', `"${name}" does not reduce to a usable worktree name.`)
      return null
    }
    const result = await window.api.createGitWorktree({
      repoRoot,
      containerPath: paths.containerPath,
      destinationPath: paths.destinationPath,
      branchName: paths.branchName,
      baseRef: 'HEAD',
      copyIncludedFiles: true,
    })
    if (!result.ok) {
      spawnError('Agent worktree failed', result.message)
      return null
    }

    const store = useWorkspaceStore.getState()
    store.setWorkspaceWorktreeState(workspace.id, { containerPath: paths.containerPath })
    const now = Date.now()
    const worktreeId = worktreeIdFromPath(result.data.path)
    store.upsertWorktreeEntry(workspace.id, {
      id: worktreeId,
      path: result.data.path,
      branch: result.data.branch ?? paths.branchName,
      ownerAgentId: agentId,
      status: 'assigned',
      createdAt: now,
      updatedAt: now,
    })
    return { mode: 'worktree', worktreeId, cwd: result.data.path }
  }

  const addNewSpecialist = async (
    specialistId: SpecialistActionId,
    requestedName = '',
    selectedCli?: AgentCli,
    skill?: WorkspaceSkill,
    worktree?: { name: string },
    // The model this spawn must launch, when the caller picked one in the same
    // event that persisted it (the spawn picker clicks a model row). Reading it
    // back off `specialistModelDefaults` here would read the value from before
    // that write; `undefined` keeps the remembered default.
    selectedModel?: string | null,
    // MC-2147: when the spawn came from a new-agent tab, that tab becomes the
    // terminal (same node, same place) and the user's prompt rides along.
    placement?: AgentSpawnPlacement,
  ) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    const specialist = getSpecialistAction(specialistId)
    const agentName = normalizeAgentIdentifier(requestedName)
    const tabName = agentName || placement?.agentName || pickRandomAgentName(
      Object.values(activeWorkspace?.agents ?? {}).map((agent) => agent.name)
    )
    const newId = `specialist-${specialist.id}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return
    const prompt = buildSpecialistSoulStartupPrompt(specialist)
    const cliForSpawn = launchableSpawnCli(
      normalizeSelectedCli(selectedCli ?? specialistCliDefaults[specialist.id], lastSelectedCli)
    )
    if (!cliForSpawn) {
      routeToCliInstall()
      return
    }

    let execution: AgentExecution | undefined
    if (worktree) {
      if (!activeWorkspace) return
      const created = await createAgentSpawnWorktree(activeWorkspace, newId, tabName, worktree.name)
      if (!created) return
      execution = created
    }

    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      cli: cliForSpawn,
      cliModel:
        selectedModel !== undefined
          ? selectedModel ?? undefined
          : resolveSurfaceModel(cliForSpawn, specialistModelDefaults[specialist.id]),
      cliReasoning: resolveCliReasoning(cliForSpawn, specialistModelDefaults[specialist.id]),
      ...(execution ? { execution } : {}),
      cliPermissionPreset: agentSpawnPermissionPreset,
      debugMode: agentSpawnDebugMode,
      kind: 'specialist',
      specialistId: specialist.id,
      cliStartupPrompt: prependAgentIdentifier(
        // The soul brief first, then what the user actually asked for — a
        // specialist that forgets its role because a task arrived is not the
        // specialist they picked.
        placement?.prompt ? `${prompt}\n\n${placement.prompt}` : prompt,
        tabName,
        specialist.shortLabel,
      ),
      cliOnboardingPromptSent: false,
      cliHasLaunched: false,
      cliResumeAvailable: false,
      ...(skill
        ? skillSpawnAgentPatch(skill, pluginCatalogEntries.find((entry) => entry.id === cliForSpawn)?.skillIntegration)
        : {}),
    })
    placeSpawnedAgentTab(windowActiveWorkspaceId, newId, tabName, placement)
    if (agentSpawnDebugMode) setAgentSpawnDebugMode(false)
  }

  const addNewCliAgent = async (
    cli: AgentCli,
    skill?: WorkspaceSkill,
    worktree?: { name: string },
    // See addNewSpecialist: the model the caller just picked, when it cannot be
    // read back from the defaults yet.
    selectedModel?: string | null,
    placement?: AgentSpawnPlacement,
  ) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    const spawnCli = launchableSpawnCli(cli)
    if (!spawnCli) {
      routeToCliInstall()
      return
    }
    // General agents get a real first+last name from the shared pool, exactly
    // like specialists — not a numbered "General Agent 2/3…" placeholder. A
    // launch from a new-agent tab keeps the name that tab is already wearing.
    const tabName = placement?.agentName || pickRandomAgentName(
      Object.values(activeWorkspace?.agents ?? {}).map((agent) => agent.name)
    )
    const newId = `agent-${spawnCli}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

    let execution: AgentExecution | undefined
    if (worktree) {
      if (!activeWorkspace) return
      const created = await createAgentSpawnWorktree(activeWorkspace, newId, tabName, worktree.name)
      if (!created) return
      execution = created
    }

    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      cli: spawnCli,
      cliModel:
        selectedModel !== undefined
          ? selectedModel ?? undefined
          : resolveSurfaceModel(spawnCli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY]),
      cliReasoning: resolveCliReasoning(spawnCli, specialistModelDefaults[GENERAL_AGENT_ENGINE_KEY]),
      ...(execution ? { execution } : {}),
      cliPermissionPreset: agentSpawnPermissionPreset,
      debugMode: agentSpawnDebugMode,
      kind: 'general',
      specialistId: undefined,
      cliStartupPrompt: placement?.prompt || undefined,
      cliOnboardingPromptSent: false,
      cliHasLaunched: false,
      cliResumeAvailable: false,
      ...(skill
        ? skillSpawnAgentPatch(skill, pluginCatalogEntries.find((entry) => entry.id === spawnCli)?.skillIntegration)
        : {}),
    })
    placeSpawnedAgentTab(windowActiveWorkspaceId, newId, tabName, placement)
    if (agentSpawnDebugMode) setAgentSpawnDebugMode(false)
  }

  // Spawn a conversation-backed general agent in the active standard workspace.
  // AgentPanel routes the new tab to AgentChatView based on `runtimeKind` +
  // `conversation`; no CLI session is created. The model is then switchable in
  // the chat composer until the first message, so spawning just needs a default
  // pair. Missing-key/unavailable states are handled downstream by AgentChatView.
  const addNewConversationAgent = (
    providerId: string,
    modelId: string,
    modelLabel: string,
    skill?: WorkspaceSkill,
    placement?: AgentSpawnPlacement,
  ) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    if (!activeWorkspace || activeWorkspace.mode !== 'standard') return

    const tabName = uniqueAgentName(modelLabel || 'Conversation Agent', activeWorkspace.agents)
    const newId = `conversation-${providerId}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

    // Skill-at-spawn on the conversation transport: make the skill present in
    // the workspace (best-effort) and seed the chat composer draft with the
    // invocation — prefilled, never auto-sent.
    if (skill && activeWorkspace.folderPath) {
      void ensureSkillForAgent({ workspaceRoot: activeWorkspace.folderPath, skill })
    }
    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      ...conversationAgentRuntimePatch(providerId, modelId),
      // The composer's permission picker applies to a conversation spawn like
      // every CLI spawn: the chat's session starts on the chosen preset instead
      // of always asking per tool. AgentChatView reads this record field and
      // lets the user change it mid-conversation.
      cliPermissionPreset: agentSpawnPermissionPreset,
      ...(skill ? { chatComposerPrefill: renderChatSkillPrefill(skill) } : {}),
      // A conversation has no CLI to hand a startup prompt to, so the launch
      // surface's prompt lands in its composer, typed and unsent — the same
      // place a skill invocation lands.
      ...(placement?.prompt ? { chatComposerPrefill: placement.prompt } : {}),
    })
    placeSpawnedAgentTab(windowActiveWorkspaceId, newId, tabName, placement)
    setLastSelectedConversationModel({ providerId, modelId })
  }

  // Single spawn-menu entry: open a conversation agent with the resolved default
  // model. No-op when no provider/model is available (entry stays hidden).
  const spawnConversationAgent = (
    skill?: WorkspaceSkill,
    provider?: { providerId: string; modelId: string; modelLabel: string },
    placement?: AgentSpawnPlacement,
  ) => {
    const target = provider ?? conversationDefaultOption
    if (!target) return
    addNewConversationAgent(target.providerId, target.modelId, target.modelLabel, skill, placement)
  }

  const addNewTerminal = (placement?: AgentSpawnPlacement) => {
    if (showNewWorkspacePanel || !windowActiveWorkspaceId) return
    const newId = `terminal-${nanoid(6)}`
    // From a new-agent tab, the shell opens in that tab rather than beside it.
    if (
      placement?.tabId
      && convertNewAgentTabToTerminal(windowActiveWorkspaceId, placement.tabId, newId, 'Terminal')
    ) {
      return
    }
    addTerminalTab(windowActiveWorkspaceId, newId, 'Terminal')
  }

  // Open-in-new-chat: spawn the chosen agent in a fresh solo-chat workspace
  // instead of the active workspace. `folderPath === undefined` inherits the
  // active workspace's folder (the top bar's Open-in-new-chat); the sidebar New
  // chat picker passes the right-clicked folder. Each mirrors its in-workspace
  // spawn counterpart, but seeds the agent at creation time via
  // createSoloChatWorkspace so it lands race-free before the new model mounts.
  const openGeneralInNewChat = (
    cli?: AgentCli,
    folderPath?: string | null,
    skill?: WorkspaceSkill,
    startupPrompt?: string,
  ) => createNewChat(folderPath, cli, skill, startupPrompt)

  const openSpecialistInNewChat = (
    specialistId: SpecialistActionId,
    selectedCli?: AgentCli,
    folderPath?: string | null,
    skill?: WorkspaceSkill,
    startupPrompt?: string,
  ) => {
    const specialist = getSpecialistAction(specialistId)
    const tabName = pickRandomAgentName([])
    const prompt = buildSpecialistSoulStartupPrompt(specialist)
    const cliForSpawn = launchableSpawnCli(
      normalizeSelectedCli(selectedCli ?? specialistCliDefaults[specialist.id], lastSelectedCli)
    )
    if (!cliForSpawn) {
      routeToCliInstall()
      return
    }
    createSoloChatWorkspace({
      folderPath,
      templateAgentCli: cliForSpawn,
      seedAgent: {
        tabName,
        agentPatch: {
          name: tabName,
          cli: cliForSpawn,
          cliModel: resolveSurfaceModel(cliForSpawn, specialistModelDefaults[specialist.id]),
          cliReasoning: resolveCliReasoning(cliForSpawn, specialistModelDefaults[specialist.id]),
          cliPermissionPreset: agentSpawnPermissionPreset,
          debugMode: agentSpawnDebugMode,
          kind: 'specialist',
          specialistId: specialist.id,
          cliStartupPrompt: prependAgentIdentifier(
            // The soul brief first, then the task, as the in-workspace spawn does.
            startupPrompt ? `${prompt}\n\n${startupPrompt}` : prompt,
            tabName,
            specialist.shortLabel,
          ),
          cliOnboardingPromptSent: false,
          cliHasLaunched: false,
          cliResumeAvailable: false,
          ...(skill
            ? skillSpawnAgentPatch(skill, pluginCatalogEntries.find((entry) => entry.id === cliForSpawn)?.skillIntegration)
            : {}),
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

  // A conversation agent in a fresh chat: same seed mechanism as the CLI paths,
  // with the conversation runtime patch instead of a CLI. The prompt lands in
  // the chat composer, typed and unsent — a conversation has no startup prompt
  // to hand a process, and auto-sending someone's first line is not the same
  // action as starting a chat.
  const openConversationInNewChat = (folderPath?: string | null, startupPrompt?: string) => {
    if (!conversationDefaultOption) return
    const { providerId, modelId, modelLabel } = conversationDefaultOption
    const tabName = uniqueAgentName(modelLabel || 'Conversation Agent', {})
    createSoloChatWorkspace({
      folderPath,
      seedAgent: {
        tabName,
        agentPatch: {
          name: tabName,
          ...conversationAgentRuntimePatch(providerId, modelId),
          cliPermissionPreset: agentSpawnPermissionPreset,
          ...(startupPrompt ? { chatComposerPrefill: startupPrompt } : {}),
        },
      },
    })
    setLastSelectedConversationModel({ providerId, modelId })
  }

  // New-chat picks: each spawns the chosen agent in a fresh chat AND remembers
  // the choice as the default for a plain "New chat in project" click, so the
  // sidebar can show what will spawn and repeat it without reopening the picker.
  // Shared by the sidebar new-chat picker and the top bar's Open-in-new-chat.
  const pickNewChatTerminal = (folderPath?: string | null) => {
    setLastNewChatAgent({ kind: 'terminal' })
    openTerminalInNewChat(folderPath)
  }
  const pickNewChatGeneral = (
    cli?: AgentCli,
    folderPath?: string | null,
    skill?: WorkspaceSkill,
    startupPrompt?: string,
  ) => {
    setLastNewChatAgent({ kind: 'general' })
    openGeneralInNewChat(cli, folderPath, skill, startupPrompt)
  }
  const pickNewChatSpecialist = (
    specialistId: SpecialistActionId,
    cli?: AgentCli,
    folderPath?: string | null,
    skill?: WorkspaceSkill,
    startupPrompt?: string,
  ) => {
    setLastNewChatAgent({ kind: 'specialist', specialistId })
    openSpecialistInNewChat(specialistId, cli, folderPath, skill, startupPrompt)
  }

  // Open the pre-creation New Chat panel. `folderPath === undefined` inherits the
  // active workspace's folder (the plain New chat button); an explicit value
  // scopes the chat to that project (folder/workspace-row menus). `connector`
  // opens the composer with that connector attached (the connector "New chat"
  // entry points). Nothing is created here — the panel's confirm does that.
  const openNewChatPanel = useCallback((
    folderPath?: string | null,
    connector?: AgentComposerConnector | null,
  ) => {
    const resolved = folderPath === undefined ? activeWorkspace?.folderPath ?? null : folderPath
    setNewChatPanelState({
      folderPath: resolved,
      folderLabel: resolved ? newChatFolderLabel(resolved) : null,
      connector: connector ?? null,
    })
    // The New Chat panel renders only in the non-hub branch: leaving the
    // creation hub open would make this click a visible no-op and leave the
    // armed panel to pop up later (first-run keeps the hub pinned open).
    dismissNewWorkspacePanel()
    // The panel mounts inside the workspace-card container, which is inert and
    // painted over while a door surface is active — the door closes first or
    // this click is a visible no-op (same contract as the New-sprint flow). An
    // open modal (a connector "New chat" comes from the Plugins modal) closes
    // for the same reason: the panel would open behind its scrim.
    // closeModalSurface also clears the settings request.
    closeGlobalSurface()
    closeModalSurface()
    setNotificationsOpen(false)
  }, [activeWorkspace?.folderPath, closeGlobalSurface, closeModalSurface, dismissNewWorkspacePanel])
  const closeNewChatPanel = () => {
    setNewChatPanelState(null)
  }

  // The Extensions door's host-action seam (MC-1847 B1): the door is a
  // zero-prop registered surface, so the shell's three connector routes are
  // registered into the extensionsSurfaceHost singleton instead of riding
  // props the way the retired modal's did. Registered once; the delegates read
  // the latest handlers through a render-refreshed ref so they never go stale.
  const extensionsHostRef = useRef<ExtensionsSurfaceHostPorts | null>(null)
  extensionsHostRef.current = {
    onLaunchConnector: (connector) => {
      // "New chat" on a connector opens the composer with it already attached,
      // rather than auto-spawning: the user still picks the agent, CLI, and
      // model. openNewChatPanel closes the door itself (the MC-1833 contract).
      openNewChatPanel(undefined, connector)
    },
    onUseSkillInNewAgent: (skill) => {
      // "Use in agent → New agent…" on an installed skill row: a general agent
      // on the General-engine default CLI, with the skill ensure-installed and
      // its invocation prefilled. addNewCliAgent targets the active
      // workspace's layout, so the hosting surface — the Plugins modal, or a
      // door in the no-host fallback — must close first or the new tab lands
      // behind it.
      closeGlobalSurface()
      closeModalSurface()
      void addNewCliAgent(
        resolveTemplateAgentCli(
          specialistCliDefaults[GENERAL_AGENT_ENGINE_KEY],
          lastSelectedCli,
          agentCliCatalog,
        ),
        skill,
      )
    },
    onUseInAutomation: () => {
      // The route to author a connector automation; the connector
      // pre-selection lands in T8. openNewWorkspacePanel closes the door.
      openNewWorkspacePanel()
    },
  }
  useEffect(() => {
    setExtensionsSurfaceHost({
      onLaunchConnector: (connector) => extensionsHostRef.current?.onLaunchConnector(connector),
      onUseInAutomation: (serverId) => extensionsHostRef.current?.onUseInAutomation(serverId),
      onUseSkillInNewAgent: (skill) => extensionsHostRef.current?.onUseSkillInNewAgent(skill),
    })
    return () => setExtensionsSurfaceHost(null)
  }, [])
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
    setNewChatPanelState((prev) => (prev ? { ...prev, folderPath: path, folderLabel: newChatFolderLabel(path) } : prev))
  }
  const browseNewChatProject = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    setNewChatPanelState((prev) => (prev ? { ...prev, folderPath: dir, folderLabel: newChatFolderLabel(dir) } : prev))
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
  const confirmNewChat = (
    confirm: AgentComposerConfirm,
    folderPathOverride?: string | null,
    startupPrompt?: string,
  ) => {
    const folderPath =
      folderPathOverride !== undefined ? folderPathOverride : newChatPanelState?.folderPath ?? null
    switch (confirm.kind) {
      case 'terminal':
        pickNewChatTerminal(folderPath)
        break
      case 'specialist':
        // A "+ Connector" attachment routes through the connector-chat runtime
        // (isolated worktree, single-server MCP) with the composed identity;
        // the agent memory still records the picked agent, not the connector.
        if (confirm.connector) {
          setLastNewChatAgent({ kind: 'specialist', specialistId: confirm.specialistId })
          void launchConnectorChat(confirm.connector.id, {
            folderPath,
            cli: confirm.cli,
            specialistId: confirm.specialistId,
            skill: confirm.skill,
          })
        } else {
          pickNewChatSpecialist(confirm.specialistId, confirm.cli, folderPath, confirm.skill, startupPrompt)
        }
        break
      case 'general':
        if (confirm.connector) {
          setLastNewChatAgent({ kind: 'general' })
          void launchConnectorChat(confirm.connector.id, {
            folderPath,
            cli: confirm.cli,
            skill: confirm.skill,
          })
        } else {
          pickNewChatGeneral(confirm.cli, folderPath, confirm.skill, startupPrompt)
        }
        break
      case 'conversation':
        setLastNewChatAgent({ kind: 'conversation' })
        openConversationInNewChat(folderPath, startupPrompt)
        break
    }
    closeNewChatPanel()
  }

  // A chat started on a paired machine (remote-sessions-ux /
  // new-chat-on-a-remote-machine): the agent is created THERE over the
  // audited fleet client — cli, prompt, model, and preset forwarded verbatim,
  // so the remote's own refusals (bypass, scopes) surface word for word — and
  // what appears here is a solo workspace whose lone pane is the fleet
  // attachment onto that session, provenance-badged by the two-line row. A
  // failure leaves the panel open with the remote's message as a toast; no
  // phantom row.
  const confirmRemoteNewChat = useCallback(async (launch: RemoteNewChatLaunch) => {
    const created = await window.api
      .fleetCreateTerminal({
        connectionId: launch.connectionId,
        workspaceId: launch.remoteWorkspaceId,
        cli: launch.cli,
        prompt: launch.prompt || undefined,
        cliModel: launch.cliModel ?? undefined,
        permissionPreset: launch.permissionPreset === 'none' ? undefined : launch.permissionPreset,
      })
      .catch((error: unknown): { ok: false; code: string; message: string } => ({
        ok: false,
        code: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }))
    if (!created.ok) {
      showToast({
        tone: 'error',
        title: `Could not start on ${launch.machineName}`,
        description: created.message,
      })
      return
    }
    if (!SOLO_CHAT_TEMPLATE) {
      // The remote agent is REAL now; say so rather than orphaning it silently.
      showToast({
        tone: 'error',
        title: `Started on ${launch.machineName}, but no pane could open`,
        description: `The Solo layout template is missing. Attach to "${created.title}" from the Fleet panel.`,
      })
      closeNewChatPanel()
      return
    }
    addWorkspace(SOLO_CHAT_TEMPLATE, {
      name: `${created.title} · ${launch.remoteWorkspaceName}`,
      // No local checkout: the code lives on the other machine, and a local
      // folder here would claim otherwise.
      folderPath: null,
      windowId: workspaceWindowId,
      seedAgent: {
        tabName: fleetTerminalTabName(launch.machineName, created.title),
        fleet: {
          connectionId: launch.connectionId,
          machineName: launch.machineName,
          remoteSessionId: created.sessionId,
        },
      },
    })
    closeNewChatPanel()
    showToast({
      tone: 'good',
      title: `Started on ${launch.machineName}`,
      description: `${created.title} in ${launch.remoteWorkspaceName}`,
    })
  }, [addWorkspace, closeNewChatPanel, workspaceWindowId])

  // Optional workspaceId targets a single workspace's panel. The mode-scoped
  // panels ignore it, but the Git panel (which can be mounted in several
  // background workspaces at once) uses it so a destructive command like commit
  // only runs in the active workspace's repo, never a stale background one.
  const dispatchPanelCommand = useCallback((id: string, workspaceId?: string) => {
    dispatchPanelCommandEvent(id, workspaceId)
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
    // ⌘K and ⌘⇧F raise the same overlay and dismiss the same competing surfaces;
    // they differ only in the scope it opens filtered to. Sharing the branch is
    // what keeps the two from drifting into two slightly different "open the
    // palette" behaviours.
    if (commandId === 'commandPalette.open' || commandId === 'search.files.open') {
      setPaletteScope(commandId === 'search.files.open' ? 'files' : 'all')
      setShowPalette(true)
      dismissNewWorkspacePanel()
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
      // History semantics (the location I was just in), not sidebar order —
      // sidebar-order cycling stays on workspace.switch.next/previous. Entries
      // pointing at closed workspaces, workspaces routed to another window, a
      // door whose module was disabled, or the already-active location are
      // skipped.
      const step = stepNavigationHistory(
        workspaceNavigationHistoryRef.current,
        commandId === 'workspace.history.back' ? -1 : 1,
        (entry) => {
          if (entry.kind === 'surface') {
            // Don't re-navigate to the door already showing; require its module
            // to still be enabled and the surface registered (mirrors the mount).
            if (activeGlobalSurface === entry.id) return false
            const surface = getRendererHost().getGlobalSurface(entry.id)
            return surface !== undefined && selectModuleEnabled(moduleEnablement, surface.moduleId)
          }
          // A workspace entry is the current location only when no door overlays
          // it; otherwise Back from a door to its own underlying workspace is valid.
          if (!activeGlobalSurface && entry.id === windowActiveWorkspaceId) return false
          // Assignment, not rail membership: history holds places the operator
          // actually visited, and a rail-hidden workspace is reached by explicit
          // activation (the Sprints door's "Open agents"). Gating on the rail
          // would let Back reach a run's terminals but never Forward.
          return visibleWorkspaceIdSet.has(entry.id)
        },
      )
      if (!step) return false
      workspaceNavigationHistoryRef.current = step.history
      dismissNewWorkspacePanel()
      // Opening the door sets the surface without touching the underlying
      // workspace; activating a workspace clears any open door as a side effect.
      if (step.entry.kind === 'surface') {
        openGlobalSurface(step.entry.id)
      } else {
        setActiveWorkspaceForWindow(workspaceWindowId, step.entry.id)
      }
      return true
    }
    if (commandId === 'workspace.switch.next' || commandId === 'workspace.switch.previous') {
      const nextWorkspaceId = getNextWorkspaceId(
        railWorkspaces,
        windowActiveWorkspaceId,
        commandId === 'workspace.switch.previous' ? -1 : 1,
      )
      if (!nextWorkspaceId) return false
      dismissNewWorkspacePanel()
      setActiveWorkspaceForWindow(workspaceWindowId, nextWorkspaceId)
      return true
    }
    if (commandId.startsWith('workspace.switch.')) {
      const workspaceIndex = Number(commandId.slice('workspace.switch.'.length)) - 1
      const workspace = railWorkspaces[workspaceIndex]
      if (!workspace) return false
      dismissNewWorkspacePanel()
      setActiveWorkspaceForWindow(workspaceWindowId, workspace.id)
      return true
    }
    if (commandId === 'layout.tab.next' || commandId === 'layout.tab.previous') {
      if (!windowActiveWorkspaceId) return false
      return cycleActiveLayoutTab(windowActiveWorkspaceId, commandId === 'layout.tab.previous' ? -1 : 1)
    }
    if (commandId === 'layout.tab.close') {
      if (showNewWorkspacePanel) {
        if (railWorkspaces.length > 0) dismissNewWorkspacePanel()
        return true
      }
      if (!windowActiveWorkspaceId) return false
      // Primary+W closes the pane's active tab while the pane owns focus; the
      // binding keeps its FlexLayout meaning everywhere else. Read live, not
      // from the render closure: this callback is retained across renders and
      // a stale `paneState` would close (and kill) the wrong tab.
      const pane = useWorkspaceStore.getState().workspaces.find((w) => w.id === windowActiveWorkspaceId)?.paneState
      if (pane?.open && pane.activeTabId && isWorkspacePaneFocused()) {
        const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId)
        if (tab) closePaneTabAndItsTerminal(windowActiveWorkspaceId, tab)
        return true
      }
      return closeActiveLayoutTab(windowActiveWorkspaceId, terminalSessions)
    }
    if (commandId === 'pane.toggle' && windowActiveWorkspaceId) {
      const open = useWorkspaceStore.getState().workspaces.find((w) => w.id === windowActiveWorkspaceId)?.paneState?.open ?? false
      setPaneOpen(windowActiveWorkspaceId, !open)
      return true
    }
    if (commandId === 'panel.files.toggle' && windowActiveWorkspaceId) {
      togglePaneKind(windowActiveWorkspaceId, 'files')
      return true
    }
    if (commandId === 'panel.editor.toggle' && windowActiveWorkspaceId) {
      togglePanelRailComponent(windowActiveWorkspaceId, 'editor', 'Editor')
      return true
    }
    if (commandId === 'panel.git.toggle' && windowActiveWorkspaceId) {
      togglePaneKind(windowActiveWorkspaceId, 'git')
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
      // Worktrees live in the Git panel, so reveal (never toggle) its pane tab
      // via the same route the command palette uses. Sharing the route keeps a
      // bound shortcut and the palette row on the same surface instead of
      // silently no-opping (T8 code-review finding A10).
      openPaneTab(windowActiveWorkspaceId, { kind: 'git' })
      return true
    }
    if (commandId === 'panel.fleet.toggle' && windowActiveWorkspaceId) {
      // Toggle, matching the other panel commands: a second invocation closes
      // the pane it opened rather than re-focusing it forever.
      return toggleComponentTab(windowActiveWorkspaceId, 'fleet', 'Fleet')
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
    if (commandId === 'workspace.folder.reveal') {
      if (!windowActiveWorkspaceId) return false
      // Routed to the identity cluster's open-in-editor control, which owns the
      // worktree resolution and the failure surface. Handling it here instead
      // would be a second path to the same IPC with its own idea of which
      // folder the workspace is checked out in.
      dispatchPanelCommand(commandId, windowActiveWorkspaceId)
      return true
    }
    if (commandId === 'git.refresh' || commandId === 'git.fetch' || commandId === 'git.commit') {
      if (!windowActiveWorkspaceId) return false
      // Routed to the active workspace's mounted Git panel; availability
      // (gitPanelActive) keeps this reachable only while that panel is open, and
      // the workspace target prevents firing in a background repo.
      dispatchPanelCommand(commandId, windowActiveWorkspaceId)
      return true
    }
    if (commandId === 'specialist.spawn.architect') {
      void addNewSpecialist('architect')
      return true
    }
    if (commandId === 'specialist.spawn.performance') {
      void addNewSpecialist('performance')
      return true
    }
    if (commandId === 'specialist.spawn.frontend-design-review') {
      void addNewSpecialist('frontend-design-review')
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
    // Registry-backed panel-event commands (Sprint Engine's remain in the
    // shell registry); switchboard/watchtower ids are module commands now and
    // were handled above.
    if (commandId.startsWith('sprintengine.')) {
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
    windowActiveWorkspaceId,
    activeGlobalSurface,
    openGlobalSurface,
    closeWorkspaceById,
    railWorkspaces,
    visibleWorkspaceIdSet,
    setActiveWorkspaceForWindow,
    workspaceWindowId,
    showNewWorkspacePanel,
    terminalSessions,
    moduleEnablement,
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
        moduleContext: moduleCommandContext,
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
    moduleCommandContext,
    runCommand,
  ])

  // The window's current navigation location: a door surface takes precedence
  // over the workspace it overlays (the door is what you're looking at), so
  // opening or leaving a door is itself a visit. Resolves to null only before
  // anything is active.
  const currentNavLocation = useMemo<NavHistoryEntry | null>(() => {
    if (activeGlobalSurfaceEntry && activeGlobalSurface) return { kind: 'surface', id: activeGlobalSurface }
    if (windowActiveWorkspaceId) return { kind: 'workspace', id: windowActiveWorkspaceId }
    return null
  }, [activeGlobalSurfaceEntry, activeGlobalSurface, windowActiveWorkspaceId])

  // Record every change of location, whatever caused it (sidebar click, palette,
  // switch commands, opening a door, sync events). Back/forward navigation moves
  // the history cursor onto the visited entry before activating, so
  // recordNavigationVisit sees it already at the cursor and does not push.
  useEffect(() => {
    if (!currentNavLocation) return
    workspaceNavigationHistoryRef.current = recordNavigationVisit(
      workspaceNavigationHistoryRef.current,
      currentNavLocation,
    )
  }, [currentNavLocation])

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

  const handleSelectSpecialist = (
    specialistId: SpecialistActionId,
    selectedCli?: AgentCli,
    skill?: WorkspaceSkill,
    worktree?: { name: string },
    selectedModel?: string | null,
    placement?: AgentSpawnPlacement,
  ) => {
    void addNewSpecialist(specialistId, '', selectedCli, skill, worktree, selectedModel, placement)
  }

  // New chat opens roleless. It used to preselect the remembered specialist —
  // whose factory default was 'architect' — so Enter on a plain message
  // launched an architect soul nobody picked. A specialist now launches only
  // when its row is explicitly chosen (see
  // backlog/2026-09-01-delete-the-specialist-agent-picker.md).
  const composerInitialSelection: AgentComposerSelection = { kind: 'general' }

  // Map a composer confirm to the real spawn into the active workspace.
  // Shared by every spawn-picker host (the launcher, the tab strip's "+");
  // fresh chats are the New Chat panel's job.
  const runComposerSpawn = (confirm: AgentComposerConfirm, placement?: AgentSpawnPlacement) => {
    switch (confirm.kind) {
      case 'terminal':
        addNewTerminal(placement)
        break
      case 'general':
        // A "+ Connector" attachment routes through the connector-chat runtime
        // (isolated worktree, single-server MCP) exactly as the New-chat path
        // does — the attachment is the whole point of the control, and a spawn
        // that dropped it would report success while ignoring what was asked.
        //
        // MC-2147: a connector chat does not take `placement`. It mints its own
        // isolated runtime rather than adopting the calling tab, so a spawn from
        // a new-agent tab opens the chat in a fresh tab and leaves the launch
        // surface where it was.
        if (confirm.connector) {
          void launchConnectorChat(confirm.connector.id, { cli: confirm.cli, skill: confirm.skill })
        } else {
          void addNewCliAgent(confirm.cli, confirm.skill, confirm.worktree, confirm.model, placement)
        }
        break
      case 'conversation':
        spawnConversationAgent(confirm.skill, confirm.provider, placement)
        break
      case 'specialist':
        if (confirm.connector) {
          void launchConnectorChat(confirm.connector.id, {
            cli: confirm.cli,
            specialistId: confirm.specialistId,
            skill: confirm.skill,
          })
        } else {
          handleSelectSpecialist(
            confirm.specialistId,
            confirm.cli,
            confirm.skill,
            confirm.worktree,
            confirm.model,
            placement,
          )
        }
        break
    }
  }

  // ── The tab strip's "+" (MC-2147) ──────────────────────────────────────────
  // Opens the tab the agent will run in. Standard workspaces only: a sprint
  // staffs its own agents, and a hand-spawned terminal in that strip would read
  // as a run member without being one.
  const canOpenNewAgentTab =
    !showNewWorkspacePanel
    && Boolean(windowActiveWorkspaceId)
    && activeWorkspace?.mode === 'standard'

  const openNewAgentTab = () => {
    if (!canOpenNewAgentTab || !windowActiveWorkspaceId) return
    // Named now, not at spawn: the tab is a terminal-in-waiting and carries the
    // name the agent will take.
    const taken = Object.values(activeWorkspace?.agents ?? {}).map((agent) => agent.name)
    addNewAgentTab(windowActiveWorkspaceId, pickRandomAgentName(taken))
  }

  // The launch surface, rendered inside that tab. It creates nothing: a confirm
  // plus the typed prompt comes back here, and the spawn retypes `tabId` in
  // place so the terminal lands exactly where the surface was.
  const renderNewAgentPanel = (tabId: string, agentName?: string) => (
    <React.Suspense fallback={null}>
      <NewAgentPanel
        workspaceId={windowActiveWorkspaceId ?? ''}
        conversationAvailable={conversationSpawnAvailable}
        onRequestConversationCatalog={requestConversationCatalog}
        initialSelection={composerInitialSelection}
        permissionPreset={agentSpawnPermissionPreset}
        onChangePermissionPreset={setAgentSpawnPermissionPreset}
        debugMode={agentSpawnDebugMode}
        onChangeDebugMode={setAgentSpawnDebugMode}
        onLaunch={({ prompt, ...confirm }) => runComposerSpawn(confirm, { tabId, prompt, agentName })}
        onClose={() => {
          if (windowActiveWorkspaceId) removeNewAgentTab(windowActiveWorkspaceId, tabId)
        }}
      />
    </React.Suspense>
  )

  const startLogin = async () => {
    setSessionsOpen(false)
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
        // Provider-agnostic on purpose (MC-2169): the message the adapter threw
        // already names the service and its URL, so repeating the provider here
        // only creates a renderer string the next auth migration has to chase.
        details: 'Check that the sign-in service is running and reachable from this desktop process.',
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
    // A detached row has no workspace to activate and no pane to focus. The
    // surfaces that list it already withhold their open affordance, so this is
    // the defensive floor, not a silent fallback path.
    if (item.group.kind !== 'workspace') return
    const workspace = item.group.workspace
    // Wizard specialist rows (guided-brief-*) carry an agentId that has no
    // workspace.agents record; updateAgent would fabricate one and
    // focusOrAddAgentTab would open a pane for it. For those rows activation
    // is plain workspace focus only.
    //
    // A review guide is the opposite case: it is an ordinary agent terminal
    // that main spawned without this window's knowledge, so it has no record
    // until something adopts it. Opening it from here IS that adoption — the
    // same one the Reviews door performs — and without it the reviewer lands in
    // the Reviews host with no tab (MC-1911).
    const agentId =
      item.agentId
      && (workspace.agents[item.agentId]
        || getRendererHost().getAgentIdNamespace(item.agentId, moduleEnabled))
        ? item.agentId
        : null
    const status = await window.api.terminalStatus(item.sessionId)
    if (!status.processAlive) {
      setTerminalSessions((sessions) => sessions.filter((session) => session.sessionId !== item.sessionId))
      if (agentId) {
        updateAgent(workspace.id, agentId, {
          cliStartRequested: false,
          cliHasLaunched: false,
          cliOnboardingPromptSent: false,
        })
      }
      return
    }

    if (agentId) {
      const itemResumeCaps = resumeCapabilitiesForCli(item.cli, pluginCatalogEntries)
      updateAgent(workspace.id, agentId, {
        name: item.label,
        cli: item.cli,
        cliSessionId: item.sessionId,
        cliStartRequested: true,
        cliHasLaunched: true,
        cliResumeAvailable: agentCliSupportsConversationResume(itemResumeCaps) ? true : undefined,
        cliUsesStableSessionId: agentCliUsesStableSessionIdForResume(itemResumeCaps) ? true : undefined,
      })
    }

    dismissNewWorkspacePanel()
    setActiveWorkspaceForWindow(workspaceWindowId, workspace.id)
    setSessionsOpen(false)

    if (!agentId && !item.terminalId) return
    requestAnimationFrame(() => {
      const opened = agentId
        ? focusOrAddAgentTab(workspace.id, agentId, item.label)
        : item.terminalId
        ? focusOrAddTerminalTab(workspace.id, item.terminalId, item.label)
          : false
      if (opened) return
      window.setTimeout(() => {
        if (agentId) {
          focusOrAddAgentTab(workspace.id, agentId, item.label)
        } else if (item.terminalId) {
        focusOrAddTerminalTab(workspace.id, item.terminalId, item.label)
        }
      }, 0)
    })
  }

  // Kill one session's process and reset its derived agent/automation state, but
  // leave the terminalSessions list to the caller so a batch stop can prune in a
  // single update instead of one render per session.
  const killSessionItem = (item: SessionItem) => {
    // A conversation agent has no PTY behind its sessionId: killing it through
    // the terminal runtime would report nothing and leave the agent running.
    if (item.transport === 'conversation') {
      void window.api.conversationSessionStop({ sessionId: item.sessionId }).catch(() => {})
    } else {
      void window.api.terminalKill(item.sessionId).catch(() => {})
    }
    // Killing the process always works; the derived state resets only exist for
    // a row that has a workspace behind it.
    const workspace = item.group.kind === 'workspace' ? item.group.workspace : null
    if (!workspace) return
    if (workspace.mode === 'sprintengine') {
      applySprintEngineAutomationStopReason(workspace.id, 'agent_terminal_closed', {
        ...(item.agentId ? { agentId: item.agentId } : {}),
      })
    }
    // Guarded like openSession: a wizard row's agentId has no
    // workspace.agents record, and updateAgent would fabricate one.
    if (item.agentId && workspace.agents[item.agentId]) {
      updateAgent(workspace.id, item.agentId, {
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

  const stopSessionGroup = async (group: SessionGroup, items: SessionItem[]) => {
    if (items.length === 0) return
    const confirmed = await dialog.confirm({
      title:
        items.length === 1
          ? `Stop the session in ${group.label}?`
          : `Stop all ${items.length} sessions in ${group.label}?`,
      body: 'The listed terminals and agents will be stopped.',
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
    <div className="flex h-screen flex-col overflow-hidden bg-[color:var(--bg-canvas)] text-[color:var(--text-strong)]">
      {sprintEngineEnabled && !MULTICODE_DISABLE_SPRINTENGINE_SYNC ? (
        // Projection sync consumes active-window/workspace identity from the shell,
        // so it remains the known propful exception to zero-prop supervisor contributions.
        <SprintEngineProjectionSupervisor
          activeWorkspaceId={windowActiveWorkspaceId}
          workspaceIds={workspaces.map((workspace) => workspace.id)}
        />
      ) : null}
      {sprintEngineEnabled && !MULTICODE_DISABLE_SPRINTENGINE_SYNC ? (
        // Merge-state polling itself is MAIN's (MC-2155): it spawns a `gh`
        // subprocess, must run with no window open, and having one owner in main
        // is what keeps a second window from doubling the probes. What is left
        // here is display — pulling a run main re-probed into THIS window's store
        // when the projection poll above has already quiesced on it. Per window,
        // not a global-owner singleton: every window's store needs the read.
        <SprintEngineRunChangeSubscriber workspaceIds={workspaces.map((workspace) => workspace.id)} />
      ) : null}
      {workspaceTypeSupervisors.map((supervisor) => (
        <WorkspaceTypeSupervisorHost key={supervisor.key} supervisor={supervisor} />
      ))}
      {automationsEnabled && ownsGlobalSupervisors ? <AutomationsRunSupervisor /> : null}
      {/* The one toast region (design-system/components/toast) + its app-level
          producers. Fixed-position; its place in this tree carries no layout. */}
      <ToastHost />

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
            // The brand row's wordmark is the New chat button, so it routes to the
            // same panel as the rail's New chat row below it — one action, two
            // affordances, never two behaviours.
            onNewChat={() => openNewChatPanel()}
            menuItems={window.api.platform === 'darwin' ? [] : MENU_BAR_ITEMS}
            onShowMenu={(event, label) => void handleShowMenubarMenu(event, label)}
          />
        }
        contextRail={
          // Drill-in replaces the rail (item 1993): while a door with a rail is
          // open, that rail renders in this column and the workspaces rail steps
          // aside. The column carries navigation only — the way OUT is the door's
          // bar chevron, beside the door's name.
          activeGlobalSurfaceEntry ? (
            <ContextRailColumn
              surfaceKey={activeGlobalSurfaceEntry.id}
              ariaLabel={`${surfaceLabel} rail`}
              active={contextRailActive}
              railRef={setSurfaceRailEl}
            />
          ) : undefined
        }
        // Only a surface that brought a rail takes the column over.
        contextRailActive={contextRailActive}
        activityByWorkspaceId={activityByWorkspaceId}
        residentWorkspaceIds={residentWorkspaceIds}
        terminalRecencyByWorkspaceId={terminalRecencyByWorkspaceId}
        onSelectWorkspace={(id) => {
          dismissNewWorkspacePanel()
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
      {/* The content column and the workspace pane column share this row so
          the pane can (a) stand beside the WorkspaceHeader at full height and
          (b) float over the content column when maximised without reflowing
          the terminals underneath. */}
      <div className="relative flex min-w-0 flex-1 flex-row">
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
        // The New chat door has no lifted bar of its own; passing it here drops
        // the workspace-scoped left cluster (panel switches + identity), which
        // was still naming the workspace open behind the surface.
        globalSurfaceActive={activeGlobalSurfaceEntry !== null || newChatPanelOpen}
        surfaceBarSlotRef={setSurfaceBarEl}
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
        onOpenDiagnostics={
          window.api.isDevelopment || window.api.isDiagnosticsEnabled
            ? () => setDiagnosticsOpen(true)
            : null
        }
        actionsSlot={
          <WorkspaceActions
            workspaces={visibleWorkspaces}
            activeWorkspace={activeWorkspace}
            workspaceActionsEnabled={workspaceActionsEnabled}
            sessionsRef={sessionsRef}
            viewMenuRef={viewMenuRef}
            notificationsRef={notificationsRef}
            sessions={sessions}
            sidebarWorkspaceOrder={sidebarWorkspaceOrder}
            sessionsOpen={sessionsOpen}
            setSessionsOpen={setSessionsOpen}
            openSession={openSession}
            pauseSession={pauseSession}
            stopSession={stopSession}
            stopSessionGroup={stopSessionGroup}
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
          />
        }
      />
      {/* Card row under the WorkspaceHeader. */}
      <div className="flex min-h-0 flex-1 flex-row">
      {/* The workspace card: everything inside the rounded surface belongs to
          the active workspace. With the pane column open the card also rounds
          its right edge, reading as a card floating between two pieces of
          app-level chrome (sidebar left, pane right); the column's own inner
          hairline does the separating, so the card draws no border of its own. */}
      <div
        className={`flex min-w-0 flex-1 flex-col overflow-hidden rounded-bl-lg bg-[color:var(--bg-surface)] ${
          activePaneOpen ? 'rounded-br-lg' : ''
        }`}
      >
      {/* The workspace identity + control groups live in the WorkspaceHeader
          above this card (WorkspaceIdentity / WorkspaceActions slots), so the
          card opens directly with content. */}
      <div className="relative min-h-0 flex-1">
        <div
          className="absolute inset-0"
          aria-hidden={activeGlobalSurfaceEntry !== null || undefined}
          {...(activeGlobalSurfaceEntry !== null
            ? ({ inert: '' } as Record<string, string>)
            : {})}
        >
          {showNewWorkspacePanel ? (
            <React.Suspense fallback={<SuspenseFallback label="Loading workspace setup" />}>
              <NewWorkspacePanel
                onCreate={handleCreate}
                onClose={dismissNewWorkspacePanel}
                workspaceWindowId={workspaceWindowId}
                allowClose={railWorkspaces.length > 0}
                initialState={newWorkspacePanelInitialState}
                onOpenNewSprintDialog={(folderPath) => openNewSprintDialog({ folderPath })}
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
                      // The "+" belongs to the layer the user is actually in:
                      // every spawn handler acts on the ACTIVE workspace, so
                      // offering it on a background layer would open a tab in a
                      // different workspace than the strip it was clicked on.
                      onNewAgentTab={active && canOpenNewAgentTab ? openNewAgentTab : undefined}
                      renderNewAgentPanel={active ? renderNewAgentPanel : undefined}
                    />
                  </div>
                )
              })}
              {/* Pre-creation New Chat panel — overlays the workspace canvas as a
                  full-region chooser. Creates nothing until confirmed; Escape or
                  close discards. Sits above the layers so it works whether or not
                  a workspace is active. */}
              {newChatPanelState ? (
                <div className="absolute inset-0 z-10 isolate overflow-auto bg-[color:var(--bg-app)]">
                  <React.Suspense fallback={<SuspenseFallback label="Loading new chat" />}>
                    {/* MC-2147: New chat opens the SAME launch surface the tab
                        strip's "+" opens. One shell, two destinations — here it
                        creates a solo workspace in the picked project rather
                        than retyping a tab. The composer seeds its connector
                        attachment on mount, so a connector "New chat" over an
                        open panel must remount; keyed on identity, so removing
                        the chip never does. */}
                    <NewAgentPanel
                      key={newChatPanelState.connector?.id ?? 'plain'}
                      workspaceId={windowActiveWorkspaceId ?? ''}
                      conversationAvailable={conversationSpawnAvailable}
                      onRequestConversationCatalog={requestConversationCatalog}
                      folderPath={newChatPanelState.folderPath}
                      projectOptions={newChatProjectOptions}
                      onSelectProject={selectNewChatProject}
                      onBrowseProject={() => void browseNewChatProject()}
                      initialSelection={lastNewChatAgent ?? { kind: 'general' }}
                      permissionPreset={agentSpawnPermissionPreset}
                      onChangePermissionPreset={setAgentSpawnPermissionPreset}
                      debugMode={agentSpawnDebugMode}
                      onChangeDebugMode={setAgentSpawnDebugMode}
                      onLaunch={({ prompt, ...confirm }) => {
                        confirmNewChat(confirm, newChatPanelState.folderPath, prompt)
                        closeNewChatPanel()
                      }}
                      onLaunchRemote={(launch) => void confirmRemoteNewChat(launch)}
                      onClose={closeNewChatPanel}
                      // The door has no tab to close, so the surface carries the
                      // control itself.
                      showCloseButton
                    />
                  </React.Suspense>
                </div>
              ) : null}
            </>
          )}
        </div>
        {/* Fourth mount kind (global-surfaces epic 1704): a door-routed full-page
            surface pre-empts the workspace card region. It paints OVER the retained
            workspace layers (they stay mounted and inert above, so terminals/tabs
            are intact on return) with an opaque canvas — no scrim and no focus
            trap: this is a page, not a dialog. You leave by the rail's pinned Back
            row, by Escape (item 1993 — the two affordances agree, and neither is
            a dialog dismissal), by opening another door, or by selecting a
            project; all of them clear activeGlobalSurface. Gated on the surface's
            owning module: a stale flag after a module toggle resolves to null and
            the workspace shows through. Settings, Plugins, Automations and Design
            are NOT doors — they float in the modal mount below (doors→modals,
            2026-09-01). */}
        {/* Surface, not canvas (MC-1844): a door is a working page, so it paints
            the neutral surface ground — the themed canvas (sage in the green
            themes) stays the sidebar/chrome's identity only. */}
        {activeGlobalSurfaceEntry ? (
          <div
            ref={setSurfaceRegionEl}
            // Focusable, ring-less: the door's keyboard home when its rail did not
            // replace the sidebar (see the focus effect above). `tabindex=-1` also
            // makes a click on the door's own empty canvas land here instead of on
            // `<body>`, which is what keeps Escape armed for the whole visit.
            tabIndex={-1}
            className="absolute inset-0 z-[var(--z-pane)] bg-[color:var(--bg-surface)] outline-none"
          >
            <GlobalSurfaceBarSlotContext.Provider value={surfaceBarSlot}>
              {/* The rail lifts into the app sidebar's column; the surface just
                  declares a rail and does not know which column it landed in. */}
              <ContextRailSlotContext.Provider value={surfaceRailSlot}>
              {/* The door's bar chevron leaves through here, so it restores the
                  keyboard to the row that opened the door exactly as Escape does. */}
              <SurfaceExitContext.Provider value={surfaceExit}>
              {/* A door failure stays a door failure (MC-1835): render/import
                  throws land in this boundary's contained fallback instead of
                  white-screening the renderer. */}
              <GlobalSurfaceErrorBoundary
                surfaceId={activeGlobalSurfaceEntry.id}
                surfaceLabel={surfaceLabel}
                onClose={closeGlobalSurface}
              >
                <React.Suspense fallback={<SuspenseFallback label="Loading surface" />}>
                  <activeGlobalSurfaceEntry.Component />
                </React.Suspense>
              </GlobalSurfaceErrorBoundary>
              </SurfaceExitContext.Provider>
              </ContextRailSlotContext.Provider>
            </GlobalSurfaceBarSlotContext.Provider>
          </div>
        ) : null}
        {/* The one first-run question the app cannot answer for itself. Held back
            while anything else owns the region — a door, the creation hub, the new
            chat panel — so it lands on a workspace the user has already reached
            rather than competing with the thing they opened. On a fresh profile
            nothing else has the region: the hub's auto-open waits for this
            question to be answered or dismissed first (MC-2094). */}
        {showFirstRunCliCard ? (
          <React.Suspense fallback={null}>
            <FirstRunCliCard onDismiss={dismissFirstRunCliCard} />
          </React.Suspense>
        ) : null}
        {/* Fifth mount kind (doors→modals, 2026-09-01): a modal surface floats
            over whatever owns the region — a workspace, a door, the empty state
            — in the shipped Modal shell: workbench width, panel layout, the
            flat darkening scrim (NEVER backdrop-filter — terminals render at
            60fps behind it), FocusTrap, Escape/scrim close, focus restored to
            the trigger glyph on close. Settings, Plugins, Automations and
            Design live here; the true doors (Sprints, Backlog, Roadmap,
            Reviews) keep the page mount above. With no bar/rail slot providers
            in scope, GlobalSurfaceShell renders its documented inline fallback
            — bar on top, aside rail beside the canvas — which is exactly the
            modal-interior anatomy. */}
        {activeModalSurfaceEntry ? (
          <Modal
            // Keyed by surface id: swapping one modal surface for another
            // (Settings → "Browse marketplace" → Plugins) must remount the
            // Modal so its FocusTrap and initial-focus effect re-run — an
            // in-place body swap dropped focus to <body>, outside the trap,
            // with the background reachable on Tab.
            key={activeModalSurfaceEntry.id}
            open
            onClose={closeModalSurface}
            label={activeModalSurfaceEntry.label}
            size="workbench"
            layout="panel"
          >
            {/* The frame owns the modal chrome contract (owner, 2026-09-01:
                one close mechanism — an X in the title bar): it provides the
                context the shell's bar claims, and renders the same bar itself
                while nothing claims it — a body loading in Suspense, or a
                third-party body that never renders GlobalSurfaceShell. */}
            <ModalSurfaceFrame label={activeModalSurfaceEntry.label} close={closeModalSurface}>
            <SurfaceExitContext.Provider value={modalSurfaceExit}>
              {/* A modal-surface failure stays contained (same contract as the
                  door boundary, MC-1835): the fallback offers Close/Reload
                  inside the dialog instead of white-screening the renderer. */}
              <GlobalSurfaceErrorBoundary
                surfaceId={activeModalSurfaceEntry.id}
                surfaceLabel={activeModalSurfaceEntry.label}
                onClose={closeModalSurface}
              >
                <React.Suspense fallback={<SuspenseFallback label="Loading surface" />}>
                  <activeModalSurfaceEntry.Component />
                </React.Suspense>
              </GlobalSurfaceErrorBoundary>
            </SurfaceExitContext.Provider>
            </ModalSurfaceFrame>
          </Modal>
        ) : null}
        {/* The New sprint dialog (MC-2062): a fixed overlay, so it works whether
            a workspace, a door, or the empty state owns the region beneath. */}
        {newSprintDialogState ? (
          <React.Suspense fallback={<SuspenseFallback label="Loading new sprint" />}>
            <NewSprintDialog
              initialFolderPath={newSprintDialogState.folderPath}
              initialSource={newSprintDialogState.initialSource}
              projectOptions={newChatProjectOptions}
              workspaceWindowId={workspaceWindowId}
              onClose={closeNewSprintDialog}
            />
          </React.Suspense>
        ) : null}
      </div>
      </div>
      </div>
      </div>
      <WorkspacePaneColumn
        activeWorkspaceId={windowActiveWorkspaceId}
        renderedWorkspaceIds={renderedWorkspaceIds}
        onStartFuturePlan={openFuturePlanWorkspace}
      />
      </div>
      {/* Win/linux caption buttons pin to the window's absolute top-right corner
          (above whatever column owns that edge — content or the aside column),
          since the split chrome has no full-width bar to host them. */}
      {window.api.platform !== 'darwin' ? (
        <div className="app-no-drag absolute right-0 top-0 z-[var(--z-float)] flex h-[36px] items-center">
          <WindowControls isMaximized={windowState.isMaximized} />
        </div>
      ) : null}
      </div>

      {diagnosticsOpen && (
        <React.Suspense fallback={null}>
          <DiagnosticsOverlay onClose={() => setDiagnosticsOpen(false)} />
        </React.Suspense>
      )}

      {showPalette && (
        <React.Suspense fallback={null}>
          <CommandPalette
            onClose={() => setShowPalette(false)}
            onNewWorkspace={openNewWorkspacePanel}
            onNewChat={() => createNewChatWorkspace()}
            onConnectRailway={() => { openNewChatPanel(undefined, { id: 'railway', name: 'Railway' }) }}
            onSpawnSpecialist={handleSelectSpecialist}
            workspaceWindowId={workspaceWindowId}
            workspaces={visibleWorkspaces}
            activeWorkspaceId={windowActiveWorkspaceId}
            activeScopes={activeCommandScopes}
            commandAvailability={commandAvailability}
            moduleCommandContext={moduleCommandContext}
            initialScope={paletteScope}
          />
        </React.Suspense>
      )}

      {tipModalOpen && (
        <React.Suspense fallback={null}>
          <TipStartupModal
            open
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
        </React.Suspense>
      )}
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

/**
 * Kill every terminal session the workspace holds. The returned promise settles
 * once main has acknowledged each kill — the pty has been signalled and the
 * session dropped from the registry — which is as close to "this workspace's
 * writers are done" as the renderer can get. Kill failures are absorbed: a
 * session that died first must not hold up the close.
 */
async function terminateWorkspaceTerminals(workspace: Workspace): Promise<void> {
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
  // The pane's terminal tabs own ptys the layout knows nothing about.
  for (const tab of workspace.paneState?.tabs ?? []) {
    if (tab.kind === 'terminal' && tab.terminalId) sessionIds.add(paneTerminalSessionId(tab.terminalId))
  }

  await Promise.all(
    [...sessionIds].map((sessionId) => window.api.terminalKill(sessionId).catch(() => {})),
  )
}

// The kit's EmptyState (MC-2117). This shipped in `--text-disabled` ink with a
// hand-rolled `rounded bg-…` button — a sentence meant to be read, greyed out as
// if it were a dead control, beside the one thing on screen you can actually do.
function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <KitEmptyState
      title="No workspace open"
      action={<PrimaryButton onClick={onNew}>New workspace</PrimaryButton>}
    />
  )
}
