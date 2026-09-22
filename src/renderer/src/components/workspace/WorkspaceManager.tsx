import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { useShallow } from 'zustand/react/shallow'
import { shouldAutoOpenNewChat, shouldShowFirstRunCliCard } from '../../store/onboardingState'
import { planAgentConfigAdoption } from '../onboarding/agentConfigAdoption'
import { EmptyState as KitEmptyState, PrimaryButton } from '../ui'
import { Modal } from '../ui/Modal'
import { SuspenseFallback } from '../ui/SuspenseFallback'
import { useNotificationStore } from '../../store/notificationStore'
import { generatedWorkspaceTitleRequester } from '../../store/generatedWorkspaceTitle'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { SoloChatSeed } from '../../store/slices/workspacesSlice'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET, normalizeSelectedCli } from '../../store/slices/settingsSlice'
import {
  isAgentCliAvailable,
  resolveCliReasoning,
  resolveLaunchableAgentCli,
  resolveSurfaceModel,
  resolveTemplateAgentCli,
  selectAgentCliCatalog,
} from './newWorkspace/cliRuntimeOptions'
import { AGENTS_SETTINGS_TAB } from './cliInstallRoute'
import { resumeCapabilitiesForCli, subscribePluginCatalogRefreshOnFocus } from '../../store/slices/pluginsSlice'
import { subscribeHostedCardFeedChanges } from '../../store/slices/hostedCardFeedSlice'
import { subscribeCliVersionAdvisoryChanges } from '../../store/slices/cliVersionAdvisorySlice'
import {
  discoveredModelAdditions,
  newModelsNotice,
  sourceUpdatesNotice,
  updateReadyNotice,
} from '../../utils/feedNotifications'
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
import type {
  AgentCli,
  AgentExecution,
  AgentId,
  AppNotification,
  Workspace,
  WorkspaceId,
  WorkspaceWindowId,
  WorkspaceWorktree,
} from '../../types/workspace'
import {
  agentWorktreePaths,
  workspaceProjectRoot,
  workspaceProjectRootOf,
  worktreeIdFromPath,
} from '../../utils/workspaceWorktree'
import { ensureSkillForAgent, renderChatSkillPrefill, skillsSpawnAgentPatch } from '../../utils/skillInvocation'
import { resolveModelPermissionPreset } from '../ui'
import { BACKLOG_SKILL_ID, backlogHandoffPrompt } from '../../utils/backlogHandoff'
import { recordBacklogAgentHandoff } from '../../utils/backlogAgentHandoff'
import { setBacklogHandoffHost, type BacklogHandoffRequest } from '../backlog/backlogHandoffHost'
import type { CardRunResult, WorkspaceSkill } from '../../../../shared/electron-api'
import type { HostedCard } from '../../../../shared/hosted-card-feed'
import type { CardLaunchChoice } from './globalSurface/extensions/home/CardGoPicker'
import { pickRandomAgentName } from '../../utils/agentNames'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { initLaunchSettingsSync } from '../../utils/launchSettingsSync'
import { initBackgroundModeSync } from '../../utils/backgroundModeSync'
import { initTelemetryConsentSync } from '../../utils/telemetryConsentSync'
import {
  addNewAgentTab,
  addTerminalTab,
  convertNewAgentTabToTerminal,
  focusOrAddAgentTab,
  focusOrAddFileTab,
  focusOrAddTerminalTab,
  getModel,
  removeAgentTab,
  removeNewAgentTab,
  togglePanelRailComponent,
  visibleTerminalTabInLayout,
} from '../../utils/modelRegistry'
import { agentCliSupportsConversationResume, agentCliUsesStableSessionIdForResume } from '../../utils/agentCliResume'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import {
  type AgentComposerConfirm,
  type AgentComposerConnector,
  type AgentComposerSelection,
} from './agentComposer/useAgentComposer'
// Always-on observer of background automation run events (raises run
// notifications). Automations is no longer a workspace type, so the shell mounts
// its global supervisor directly, gated on the automations module + primary
// window — the same role the workspace-type `supervisors` list used to play.
import AutomationsRunSupervisor from '../automations/AutomationsRunSupervisor'
import WorkspaceLayout from './WorkspaceLayout'
import WorkspaceSidebar from './WorkspaceSidebar'
import { AppRail, railSurfacesOf, type RailSurface } from './AppRail'
import { useRailBadges } from './useRailBadges'
import { EXTENSIONS_HOME_SURFACE_ID, surfaceTakesSidebarColumn } from './extensionsDrawer'
import {
  dispatchExtensionsSurfaceTarget,
  EXTENSIONS_DRAWER_VIEWS,
} from './globalSurface/extensions/extensionsSurfaceTarget'
import { resolveDefaultParentPath } from './newWorkspace/folderCreation'
import SidebarAccountBar from './SidebarAccountBar'
import type { SidebarSection } from '../../store/slices/settingsSlice'
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
import { fleetTerminalTabName } from '../panels/fleet/fleetModel'
import { remoteWorkspaceName, type RemoteSessionOpenSpec } from './remoteBand/remoteSessionsModel'
import { useSurfaceView } from './surfaceView'
import type { RemoteNewChatLaunch } from './agentComposer/NewAgentPanel'
import {
  clearNewChatDraft,
  newChatDraftHasContent,
  readNewChatDraft,
  rescopeNewChatDraft,
  writeNewChatDraft,
} from './agentComposer/newChatDraft'
import { showToast } from '../../store/toastStore'
import { WorkspaceHeader } from './WorkspaceHeader'
import { GlobalSurfaceBarSlotContext } from './globalSurface/surfaceBarSlot'
import { ModalSurfaceFrame } from './globalSurface/GlobalSurfaceShell'
import { GlobalSurfaceErrorBoundary } from './globalSurface/surfaceErrorBoundary'
import {
  doorLabelForSurfaceId,
  resolveActiveDoorSurface,
  resolveActiveModalSurface,
} from './globalSurface/absentDoorSurface'
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
import { isWorkspacePaneFocused } from './pane/paneFocus'
import { closePaneTabAndItsTerminal } from './pane/paneTerminals'
import { terminateWorkspaceTerminals } from './workspaceTerminalTermination'
import { WindowControls, paneStripOwnsCaptionCorner, windowCaptionReserve } from './WindowControls'
import { WorkspaceIdentity } from './WorkspaceIdentity'
import { WorkspaceActions, type SessionGroup, type SessionItem } from './WorkspaceActions'
import {
  buildSidebarWorkspaceOrder,
  getSessionItems,
  getWorkspaceActivity,
  uniqueAgentName,
  type WorkspaceActivity,
} from './workspaceManagerHelpers'
import { residentAgentWorkspaceIds } from '../../utils/workspaceResidency'
import {
  EMPTY_WORKSPACE_NAVIGATION_HISTORY,
  recordNavigationVisit,
  NEW_CHAT_NAV_ENTRY,
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
import { LAYOUT_TEMPLATES } from '../../layouts/templates'
import { collectWorkspaceTypeSupervisors } from '../../modules/workspace-type-supervisors'
import { WorkspaceTypeSupervisorHost } from '../../modules/WorkspaceTypeSupervisorHost'
import { RendererCommandDispatcher } from '../../commands/commandDispatcher'
import { getCommandDefinition } from '../../commands/commandRegistry'
import { getElectronAccelerator } from '../../commands/effectiveKeybindings'
import { LEGACY_COMMAND_ID_ALIASES, type KeybindingPlatform } from '../../commands/keybindings'
import type { CommandAvailabilityContext } from '../../commands/availability'
import type { CommandScope, ModuleCommandContext } from '../../commands/types'
import { dispatchPanelCommandEvent } from '../../utils/panelCommands'
// From the pure search module, not the palette component: the palette is
// React.lazy and importing a type through it would be a needless edge into the
// deferred chunk.
import type { PaletteScope } from '../commandPaletteSearch'
import { subscribePaletteOpenRequest, type PaletteAgentTarget } from '../palette/paletteOpenRequest'
import { isGlobalShortcutSuppressedTarget, isTerminalKeyTarget } from '../../utils/keyboard'
import { controlTabContextItemOf, controlTabContextOf, cycleFocusedControlTabScope } from '../../utils/controlTab'
import { useExtensionsDrawerRows } from './extensionsDrawerRows'
import { showCliUpdateToast } from './manager/cliUpdateToast'
import { selectWorkspaceManagerWorkspaces } from './manager/workspaceSelector'
import {
  closeActiveLayoutTab,
  cycleActiveLayoutTab,
  firstTabset,
  getNextWorkspaceId,
  placeSpawnedAgentTab,
  stopActiveTerminal,
  workspaceWindowBoundsForDrop,
  type AgentSpawnPlacement,
} from './manager/layoutTabActions'

// The pre-creation New Chat panel — agent + engine chooser that creates nothing
// until the user starts the chat. Code-split out of the eager boot chunk;
// rendered only when the New chat door or the tab strip's "+" asks for it.
//
// This is the ONE way in (owner, 2026-09-04). The New workspace hub — the
// five-tab creation modal whose Workspace tab minted the old Editor-plus-one-
// agent layout — is gone: New chat searches the projects, browses the disk,
// imports from Git and picks the engine, which is everything the wizard asked
// for.
//
// One surface, two destinations: pressing "+" retypes a tab into the
// agent's terminal; New chat creates a solo workspace in the picked project.
// The panel that used to serve the second — NewChatPanel — is gone rather than
// left beside this one, because two launch surfaces drift.
const NewAgentPanel = React.lazy(() => import('./agentComposer/NewAgentPanel'))

// On-demand overlays kept off the eager boot chunk: each mounts only when the
// user reaches for it (Cmd-K palette, the diagnostics overlay), so its subtree —
// and the diagnostics report formatter it pulls — is fetched at open time, not
// at boot.
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
// The Diff popout — the pane's Diff tab floated in a workbench modal — was a
// third host for one viewer and is gone (git-commit-window T3, 2026-09-09). A
// diff opens in its own OS window or in the pane's tab; the `diff` modal
// surface id is unclaimed again.
// The Extensions home (the app rail's Extensions glyph, 2026-09-05): the page
// the glyph opens in the card region, with the Extensions drawer standing
// beside it. A DOOR, shaped like a registered global surface so the mount path
// is identical to every module's (Extensions drawer ruling, Stage 2 — it was
// the `marketplace` modal for a few hours the same day). Core like Settings:
// it is where the product's own parts are offered, so no module may gate it,
// and its id is reserved in the registry the same way.
//
// `railPlacement: 'inline'` because it brings no rail at all and the drawer
// beside it is the navigation: taking that column would empty it.
const ExtensionsHomeSurface = React.lazy(() => import('../extensions/ExtensionsHomeSurface'))
const CORE_EXTENSIONS_HOME_SURFACE = {
  id: EXTENSIONS_HOME_SURFACE_ID,
  moduleId: 'core',
  label: 'Extensions',
  railPlacement: 'inline',
  Component: ExtensionsHomeSurface,
} as const
// The workspace pane column (browser-pane epic): the right-edge column that
// hosts Files, Git, Backlog, Diff and the browser. It renders collapsed to zero
// width until the active workspace's pane is opened, so nothing it draws is on
// screen at first paint — and the tab strip, the browser guest and the pane
// bodies behind it are a large part of the boot graph. Fetched when the column
// mounts; `fallback={null}` because a collapsed column occupies no space and a
// loader there would be a stripe of chrome nobody asked for.
const WorkspacePaneColumn = React.lazy(() =>
  import('./pane/WorkspacePaneColumn').then((m) => ({ default: m.WorkspacePaneColumn })),
)
// The toast region and its app-level producers (pair requests, the tailnet
// listener notice, fleet loss/revocation). Nothing it draws exists at first
// paint — the region is empty until something raises a toast, and its producers
// are subscriptions to events that arrive after boot — so it is fetched with
// the rest of the deferred shell rather than carried through it.
const ToastHost = React.lazy(() => import('./ToastHost').then((m) => ({ default: m.ToastHost })))
const DiagnosticsOverlay = React.lazy(() => import('../diagnostics/DiagnosticsOverlay'))
// First-run only: the CLI onboarding card (and the CliInstallControl subtree it
// shares with the lazy Settings panel) mounts on machines with no CLI installed,
// so it stays out of the eager boot chunk (bundle-budget ratchet).
const FirstRunCliCard = React.lazy(() => import('../onboarding/FirstRunCliCard'))

// Display name for a New Chat project scope: the folder's last path segment.
function newChatFolderLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

// Automations is a content-area destination (not a modal): it renders inside the
// workspace card in place of workspace content, like the New chat door.
// Lazy so the control center + schema-driven editor stay out of the boot chunk.

const MENU_BAR_ITEMS = ['File', 'Edit', 'View', 'Window', 'Help'] as const

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
  // The same hand-off for a diff (git-commit-window T3): the diff window's
  // "Show in the app" closes itself and broadcasts this. The window that holds
  // the workspace opens the pane's Diff tab on the repository the window was
  // reading — never a root re-derived from the workspace — brings that
  // workspace forward so the tab is actually on screen, and flips the sticky
  // preference home. The preference is written HERE rather than in the diff
  // window because this window's store is the one that owns the settings
  // envelope; the aux window's copy is as old as the window.
  useEffect(() => {
    if (typeof window.api.onDockDiffToWorkspace !== 'function') return
    return window.api.onDockDiffToWorkspace(
      ({ requestId, workspaceId, repoRoot, focusPath, focusKind, changelistId }) => {
        const state = useWorkspaceStore.getState()
        if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) return
        // Windows that do not hold this workspace no-op, exactly as the docked
        // file does. An unregistered window list (the single-window default)
        // holds everything.
        const held = state.workspaceWindows.find((entry) => entry.id === workspaceWindowId)?.workspaceIds
        if (held && !held.includes(workspaceId)) return
        const opened = state.openPaneTab(workspaceId, {
          kind: 'diff',
          // The window's changelist filter comes home with it (agent changelists).
          diff: { repoRoot, focusPath, focusKind, ...(changelistId ? { changelistId } : {}) },
        })
        if (!opened) return
        state.setActiveWorkspaceForWindow(workspaceWindowId, workspaceId)
        state.setDiffOpensInWindow(false)
        // The ack is the last thing, and only on the path that actually opened
        // the tab: it is what lets the diff window close itself, so every early
        // return above has to leave it unsaid.
        window.api.ackDockDiffToWorkspace?.(requestId)
      },
    )
  }, [workspaceWindowId])
  // Main composes agent launches with no window open, so the settings
  // a launch reads are mirrored to it from here.
  useEffect(() => initLaunchSettingsSync(), [])
  // Background mode is read by main at last-window-close, so it is mirrored the
  // same way the launch settings are.
  useEffect(() => initBackgroundModeSync(), [])
  // The usage-data choice is read by main on every event it records, including
  // ones with no window open, so it is mirrored the same way.
  useEffect(() => initTelemetryConsentSync(), [])
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
  // The app rail's active section (app shell, 2026-09-05).
  const sidebarSection = useWorkspaceStore((s) => s.sidebarSection)
  const setSidebarSection = useWorkspaceStore((s) => s.setSidebarSection)
  const sidebarWidth = useWorkspaceStore((s) => s.sidebarWidth)
  const setSidebarWidth = useWorkspaceStore((s) => s.setSidebarWidth)
  const settingsOverlayOpen = useWorkspaceStore((s) => s.activeModalSurface === 'settings')
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const closeSettingsOverlay = useWorkspaceStore((s) => s.closeSettingsOverlay)
  // The modal surface floating over this window (doors→modals, 2026-09-01):
  // its registered id, or null. A float, not a mount kind — the card region
  // keeps whatever owns it underneath.
  const activeModalSurface = useWorkspaceStore((s) => s.activeModalSurface)
  // The workspace the open modal was opened from (the pane strip passes its
  // own). Handed to the surface body below — a modal floats over the window
  // rather than inside a workspace card, so this is the only thing that tells
  // it which workspace it is acting on.
  const activeModalSurfaceWorkspaceId = useWorkspaceStore((s) => s.activeModalSurfaceWorkspaceId)
  const closeModalSurface = useWorkspaceStore((s) => s.closeModalSurface)
  // The door-routed full-page surface for this window (global-surfaces epic 1704):
  // its registered id, or null when a workspace owns the card region.
  const activeGlobalSurface = useWorkspaceStore((s) => s.activeGlobalSurface)
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  const closeGlobalSurface = useWorkspaceStore((s) => s.closeGlobalSurface)
  const extensionsDrawerRows = useExtensionsDrawerRows()
  // Written back after a card's `install.mcp`: main synced the CLI configs, and
  // the settings store is where the app's own list of servers lives.
  const upsertMcpServer = useWorkspaceStore((s) => s.upsertMcpServer)
  const openExtensionsSurface = useWorkspaceStore((s) => s.openExtensionsSurface)
  const forgetFolder = useWorkspaceStore((s) => s.forgetFolder)
  const recordWorkspaceTerminalActivity = useWorkspaceStore((s) => s.recordWorkspaceTerminalActivity)
  const recordWorkspaceUserMessage = useWorkspaceStore((s) => s.recordWorkspaceUserMessage)
  const recordWorkspaceTurnEnd = useWorkspaceStore((s) => s.recordWorkspaceTurnEnd)
  const reconcileWorkspaceAgentLaunchFlags = useWorkspaceStore((s) => s.reconcileWorkspaceAgentLaunchFlags)
  const projectLaunchedAgentSessions = useWorkspaceStore((s) => s.projectLaunchedAgentSessions)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const authState = useWorkspaceStore((s) => s.authState)
  const setAuthState = useWorkspaceStore((s) => s.setAuthState)
  const lastSelectedCli = useWorkspaceStore((s) => normalizeSelectedCli(s.appSettings.lastSelectedCli))
  const setLastSelectedCli = useWorkspaceStore((s) => s.setLastSelectedCli)
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
    (s) => s.appSettings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  )
  const lastSelectedAgentModel = useWorkspaceStore((s) => s.appSettings.lastSelectedAgentModel ?? null)
  const keybindingSettings = useWorkspaceStore((s) => s.appSettings.keybindings)
  const notifications = useNotificationStore((s) => s.notifications)
  const markNotificationRead = useNotificationStore((s) => s.markRead)
  const markAllNotificationsRead = useNotificationStore((s) => s.markAllRead)
  const clearNotifications = useNotificationStore((s) => s.clearAll)

  // Resolve a notification's Open action(s). Two layers (see
  // backlog/2026-06-14-notification-open-action-deep-link.md): the owning
  // module's registered provider can return a deep-focus action (e.g. open the
  // module's own record, or open the Automations screen at a run), and the shell
  // guarantees a generic workspace-reveal fallback for any notification that
  // names a workspace that still exists. Provider actions are offered whether or not the
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
        workspaceExists: (id) => workspaces.some((workspace) => workspace.id === id),
      }),
    [moduleEnablement, setActiveWorkspaceForWindow, workspaceWindowId, workspaces],
  )

  const currentWorkspaceWindow = useMemo(
    () =>
      workspaceWindows.find((windowState) => windowState.id === workspaceWindowId) ??
      workspaceWindows.find((windowState) => windowState.id === primaryWorkspaceWindowId) ??
      null,
    [primaryWorkspaceWindowId, workspaceWindowId, workspaceWindows],
  )
  const isPrimaryWorkspaceWindow = workspaceWindowId === (primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID)
  const openPaneTab = useWorkspaceStore((s) => s.openPaneTab)
  const setPaneOpen = useWorkspaceStore((s) => s.setPaneOpen)
  const togglePaneKind = useWorkspaceStore((s) => s.togglePaneKind)
  const visibleWorkspaceIdSet = useMemo(
    () => new Set(currentWorkspaceWindow?.workspaceIds ?? workspaces.map((workspace) => workspace.id)),
    [currentWorkspaceWindow, workspaces],
  )
  const visibleWorkspaces = useMemo(
    () => workspaces.filter((workspace) => visibleWorkspaceIdSet.has(workspace.id)),
    [visibleWorkspaceIdSet, workspaces],
  )
  // Rail-navigable subset of this window's workspaces: rail-hidden workspaces —
  // the background Automations host, and any workspace type that declares
  // itself hidden — stay assigned and mounted (they are in `visibleWorkspaces`)
  // but are never a rail row, a keyboard switch target, or counted toward "has a
  // workspace". Sequential switching and the empty-state derive from this list so
  // a profile holding only hidden workspaces never strands the user on one.
  // Explicit activation (the T5 reveal path) still works and still renders the
  // workspace whole — see `windowActiveWorkspaceId` below.
  const railWorkspaces = useMemo(
    () => visibleWorkspaces.filter((workspace) => !isHiddenFromRail(workspace, moduleEnablement)),
    [visibleWorkspaces, moduleEnablement],
  )
  const windowActiveWorkspaceId =
    currentWorkspaceWindow?.activeWorkspaceId && visibleWorkspaceIdSet.has(currentWorkspaceWindow.activeWorkspaceId)
      ? // An explicitly-activated workspace is honored even when it is rail-hidden
        // (the T5 reveal path sets it) — so its terminals render with their whole
        // layout, header, and tabs.
        // Only the implicit fallback refuses to auto-activate a hidden workspace, so
        // a profile holding only hidden ones yields a null active id and the "no
        // workspaces" empty state instead of stranding the user on one.
        currentWorkspaceWindow.activeWorkspaceId
      : (railWorkspaces[0]?.id ?? null)
  const activeWorkspace = visibleWorkspaces.find((workspace) => workspace.id === windowActiveWorkspaceId) ?? null
  // Whether the workspace pane column stands at the window's right edge. On
  // win/linux the floating caption buttons sit over whichever top strip owns
  // that corner, and that strip leaves them room (WindowCaptionReserve): the
  // pane's own strip while it is open, the WorkspaceHeader otherwise.
  const paneOwnsRightEdge = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === windowActiveWorkspaceId)?.paneState?.open ?? false,
  )
  // The caption corner is narrower than the right edge: a MAXIMISED pane fills
  // the row below the header, so the header keeps the corner and its own
  // reserve (paneStripOwnsCaptionCorner). The card's right-edge gap below still
  // reads `paneOwnsRightEdge`, so maximising reflows nothing under the pane.
  const paneMaximised = useWorkspaceStore((s) => s.workspacePaneMaximised)
  const paneOwnsCaptionCorner = paneStripOwnsCaptionCorner({ open: paneOwnsRightEdge, maximised: paneMaximised })
  // (Was `activePaneOpen`, derived from `activeWorkspace`. Removed: the card's
  // right-edge gap is its only consumer and it now reads `paneOwnsRightEdge`
  // above, which selects `paneState.open` straight off the live store — one
  // boolean, no projection in between. The projection `activeWorkspace` comes
  // from compares `paneState` too now, but a selector on the one field is
  // still the cheaper subscription for a flag.)
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
  // Guards the async adoption against a second workspace creation landing before
  // the persisted `hasAdoptedAgentConfig` flag has been written.
  const adoptionInFlightRef = useRef(false)
  const [showPalette, setShowPalette] = useState(false)
  // Which groups the palette opens filtered to. ⌘K and Shift Shift raise the
  // full launcher; ⌘⇧F raises the same overlay narrowed to files and their
  // contents; the terminal pane's star raises it narrowed to skills and
  // plugins. Held here rather than inside the palette because the thing that
  // opens it is what decides it, and the palette is unmounted at that moment.
  const [paletteScope, setPaletteScope] = useState<PaletteScope>('all')
  // The agent a chosen skill should land in without asking. Only a surface that
  // knows which pane the person is looking at can answer that, so only the star
  // sets it; every other way of opening the palette clears it.
  const [paletteTarget, setPaletteTarget] = useState<PaletteAgentTarget | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  // Installed conversation providers, loaded lazily when a spawn surface opens.
  // Kept separate from `agentCliCatalog`: this is the provider/model catalog for
  // the conversation runtime, not the terminal CLI plugin catalog. `null` means
  // "not loaded yet"; an `ok: false` result drives the unavailable row.
  const [conversationProviderResult, setConversationProviderResult] = useState<ConversationProviderListResult | null>(
    null,
  )
  // The app-wide default preset, straight from settings. It used to be mirrored
  // into local state so a spawn surface could edit it; a preset is remembered
  // against a MODEL ROW now (ui/modelPermissionPresets), so nothing on a spawn
  // surface writes this any more — it is the fallback a row nobody has set
  // resolves to, and Settings is where it is changed.
  const agentSpawnPermissionPreset = lastAgentSpawnPermissionPreset
  // Debug Mode is intentionally transient and never persisted (unlike the
  // permission preset): it defaults off and resets off after each spawn, so a
  // debug agent never silently leaves the next unrelated spawn in debug.
  const [agentSpawnDebugMode, setAgentSpawnDebugMode] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
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
  const reportedUserMessageRef = useRef<Map<string, number>>(new Map())
  const reportedTurnEndRef = useRef<Map<string, number>>(new Map())
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
  // is not what the chrome is describing any more. The New chat door counts —
  // and the tab strip's "+" does NOT, because that one lives inside a workspace
  // whose header is still true.
  const workspaceActionsEnabled = activeWorkspace && !newChatPanelOpen
  const commandDispatcherRef = useRef(new RendererCommandDispatcher())
  // Per-window visit history backing mouse back/forward workspace navigation.
  // Transient shell state: a ref (not store state) because navigation must not
  // re-render anything on its own, and per-renderer because each BrowserWindow
  // tracks only its own activations.
  const workspaceNavigationHistoryRef = useRef<WorkspaceNavigationHistory>(EMPTY_WORKSPACE_NAVIGATION_HISTORY)
  const disabledCommandIds = useMemo(() => {
    const disabled = new Set(
      Object.entries(keybindingSettings?.disabled ?? {})
        .filter(([, isDisabled]) => isDisabled === true)
        .map(([commandId]) => commandId),
    )
    // Persisted disables keyed by a command's legacy id keep suppressing its
    // migrated id (see LEGACY_COMMAND_ID_ALIASES).
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
    // Generic module panel scope: the active mode's owning module (via the
    // workspace-type registry) gets `panel:<moduleId>` — this is how module
    // commands gate on "my workspace is active" without a shell enum arm per
    // module.
    const owningModule = getRendererHost().getWorkspaceTypeModule(activeWorkspace.mode)
    if (owningModule && selectModuleEnabled(moduleEnablement, owningModule)) {
      scopes.push(`panel:${owningModule}`)
    }
    return scopes
    // moduleRegistryGeneration: a late third-party load re-derives the
    // registry-backed panel scope for the already-active workspace.
    // moduleEnablement: a live module toggle must drop its panel scope
    // without a reload.
  }, [activeWorkspace?.mode, workspaceActionsEnabled, moduleRegistryGeneration, moduleEnablement])
  // The published context view module availability predicates evaluate
  // against — shared by the dispatcher and the palette so both agree.
  const moduleCommandContext = useMemo(
    (): ModuleCommandContext => ({
      activeWorkspaceId: workspaceActionsEnabled ? (windowActiveWorkspaceId ?? null) : null,
      activeWorkspaceMode: workspaceActionsEnabled ? (activeWorkspace?.mode ?? null) : null,
    }),
    [workspaceActionsEnabled, windowActiveWorkspaceId, activeWorkspace?.mode],
  )
  // Runtime preconditions for registry commands, derived from the same active
  // scopes the dispatcher uses plus the panels' own availability predicates.
  // The dispatcher and the command palette both read this context so keyboard
  // dispatch and palette rows agree on which commands are actually runnable.
  // `activeFile` is intentionally omitted: no command declares it yet, and
  // inventing a value here would be a fake precondition.
  const commandAvailability = useMemo((): CommandAvailabilityContext => {
    const commandWorkspace = windowActiveWorkspaceId
      ? (useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId) ?? null)
      : null
    const context: CommandAvailabilityContext = {}
    if (workspaceActionsEnabled) context.activeWorkspace = true
    // The performance diagnostics panel is an engineering tool, offered only in
    // dev or when SPRINTENGINE_DIAGNOSTICS=1 (matching the View-menu gate).
    if (window.api.isDevelopment || window.api.isDiagnosticsEnabled) context.diagnosticsEnabled = true
    // The Knowledge Graph toggle is the panel's only entry point (no rail
    // glyph), so its availability tracks the memory-graph module directly.
    if (selectModuleEnabled(moduleEnablement, 'memory-graph')) context.memoryGraphEnabled = true
    // The Canvas tab is a pane tab the canvas module gates; with it off the
    // pane renders the unavailable surface, so the toggle is not offered.
    if (selectModuleEnabled(moduleEnablement, 'canvas')) context.canvasEnabled = true
    // The global Automations screen needs the automations module (its store/IPC).
    if (selectModuleEnabled(moduleEnablement, 'automations')) context.automationsEnabled = true
    // The Git panel mounts only while its pane tab is the one showing (the
    // pane unmounts a hidden Git tab) and the git module is on — a disabled
    // module renders the unavailable surface, whose handlers cannot act.
    const pane = commandWorkspace?.paneState
    if (
      pane?.open &&
      selectModuleEnabled(moduleEnablement, 'git') &&
      pane.tabs.some((tab) => tab.id === pane.activeTabId && tab.kind === 'git')
    ) {
      context.gitPanelActive = true
    }
    if (
      terminalSessions.some(
        (session) => session.kind === 'terminal' && session.workspaceId === commandWorkspace?.id && session.terminalId,
      )
    ) {
      context.terminalActive = true
    }
    return context
  }, [workspaceActionsEnabled, moduleEnablement, activeCommandScopes, windowActiveWorkspaceId, terminalSessions])
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
  const sessions = getSessionItems(useWorkspaceStore.getState().workspaces, terminalSessions, conversationSessions, {
    resolveDetachedLabel: resolveDetachedSessionLabel,
  }).filter((item) => item.group.kind === 'detached' || visibleWorkspaceIdSet.has(item.group.id))
  const sidebarWorkspaceOrder = useMemo(() => buildSidebarWorkspaceOrder(railWorkspaces), [railWorkspaces])
  // The bell badge is an error counter: only unread errors increment it (and
  // drive the red just-changed pulse), so a flood of info/warning notifications
  // never inflates the count. Warnings/info still appear in the popover list and
  // are reachable through its severity filters.
  const unreadErrorCount = notifications.filter(
    (notification) => !notification.read && notification.level === 'error',
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
    () => collectWorkspaceTypeSupervisors(getRendererHost().getWorkspaceTypes(moduleEnabled), ownsGlobalSupervisors),
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
  // door — the door says its module is absent and links into
  // Extensions, rather than silently dropping the region back to the workspace.
  // The persisted id is deliberately left intact: reinstalling or re-enabling
  // the module lands the user back on the door they were in.
  //
  // Which view the open door is standing on, published by the surface itself
  // (surfaceView.ts). The navigation history reads it so a multi-view door is
  // as many history locations as it has views.
  const activeSurfaceView = useSurfaceView(activeGlobalSurface ?? '')
  const activeGlobalSurfaceEntry = useMemo(() => {
    if (!activeGlobalSurface) return null
    // The Extensions home resolves from the app, never the registry: it is
    // where modules are offered, so a module toggle must not be able to take it
    // away — the same reasoning that keeps Settings out of the modal registry.
    if (activeGlobalSurface === EXTENSIONS_HOME_SURFACE_ID) return CORE_EXTENSIONS_HOME_SURFACE
    return resolveActiveDoorSurface(
      activeGlobalSurface,
      (id) => getRendererHost().getGlobalSurface(id),
      (moduleId) => selectModuleEnabled(moduleEnablement, moduleId),
      (target) => openExtensionsSurface(target),
    )
  }, [activeGlobalSurface, moduleEnablement, moduleRegistryGeneration, openExtensionsSurface])

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
      (target) => openExtensionsSurface(target),
    )
  }, [activeModalSurface, moduleEnablement, moduleRegistryGeneration, openExtensionsSurface])

  // The first-run "you have no agent CLI" card. Two halves:
  //   - shouldShowFirstRunCliCard is the honest answer to "does this machine
  //     have any agent CLI", and refuses to answer until the probe resolves;
  //   - the region check keeps it out of the way of whatever the user is
  //     already looking at.
  // Deliberately NOT gated on having a workspace: a user who closes New chat
  // on an empty profile still deserves the answer. New chat does not race it
  // on a fresh profile — the auto-open below waits on the same probe.
  const showFirstRunCliCard =
    shouldShowFirstRunCliCard({ cliAvailabilityStatus, cliAvailability, firstRunCliCardDismissed }) &&
    !activeGlobalSurfaceEntry &&
    !newChatPanelOpen

  // The open door's human name, for the bar's fallback title, the rail's
  // accessible name and the error boundary's title. The registered label wins
  // over the capitalised id, because the two genuinely differ: the `extensions`
  // surface is called Plugins everywhere a person can read it. Derived once so
  // no two of them can disagree.
  const surfaceLabel = activeGlobalSurfaceEntry
    ? doorLabelForSurfaceId(activeGlobalSurfaceEntry.id, activeGlobalSurfaceEntry.label)
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
  // Whether the OPEN door takes the sidebar column at all (Extensions drawer
  // ruling, 2026-09-05). A door that is itself a row of the Extensions drawer
  // declares `railPlacement: 'inline'`: the drawer is the navigation that
  // reached it and has to stay put while the card region swaps, so its rail
  // renders beside its own canvas instead. Withholding the slot is the whole
  // mechanism — with no provider in scope `GlobalSurfaceShell` falls back to
  // its documented inline aside, and the surface never learns which host it
  // got.
  const surfaceLiftsRail = surfaceTakesSidebarColumn(activeGlobalSurfaceEntry)
  const surfaceRailSlot = useMemo(() => ({ el: surfaceRailEl, onRailPresence: setSurfaceHasRail }), [surfaceRailEl])
  // Derived, never trusted on its own: `surfaceHasRail` is reported BY the
  // surface, so it is still true for a commit after the surface has gone. Reading
  // it through the live entry is what puts the workspaces rail back in the same
  // commit that clears the door — which is in turn what makes focus land on the
  // door's own row rather than on a row that is still `display:none`.
  const contextRailActive = activeGlobalSurfaceEntry !== null && surfaceHasRail && surfaceLiftsRail
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

  // A rail glyph names a section of the sidebar column, so choosing one shows
  // that column: it expands a collapsed sidebar, and it leaves any open door,
  // whose rail would otherwise keep the column. Choosing the section already
  // showing is a no-op rather than a toggle, so the rail always has a
  // selected section.
  //
  // Extensions is the one section with a page of its own: choosing it also
  // opens the Extensions home in the card region (owner, 2026-09-05), while the
  // column beside it becomes the drawer — Design, Plugins, Skills,
  // Agent CLIs. Choosing it again from somewhere else reopens the home — the
  // glyph's promise is the page.
  //
  // Leaving the open door FIRST and opening the home second, rather than
  // letting `openGlobalSurface` replace it: `leaveGlobalSurface` is what hands
  // the keyboard back to the row that opened the door, and it only fires while
  // the door is genuinely closing.
  const selectSidebarSection = useCallback(
    (section: SidebarSection) => {
      if (activeGlobalSurface) leaveGlobalSurface()
      setSidebarSection(section)
      if (sidebarCollapsed) setSidebarCollapsed(false)
      if (section === 'extensions') openGlobalSurface(EXTENSIONS_HOME_SURFACE_ID)
    },
    [
      activeGlobalSurface,
      leaveGlobalSurface,
      openGlobalSurface,
      setSidebarCollapsed,
      setSidebarSection,
      sidebarCollapsed,
    ],
  )

  // The module surfaces that stand on the app rail (Automations, and only
  // Automations since the drawer ruling): the host's enablement-filtered door
  // list, in rail order. Same registry, same gating and same late-loader bump
  // as the Extensions drawer's rows.
  const railSurfaces = useMemo(
    () => railSurfacesOf(getRendererHost().getGlobalSurfaces((id) => selectModuleEnabled(moduleEnablement, id))),
    [moduleEnablement, moduleRegistryGeneration],
  )
  const openRailSurface = useCallback(
    (surface: RailSurface) => {
      // A plain open lands on the surface's default view: the surface discards
      // any stale deep-link latch in `onOpen` first (the drawer's rows do the
      // same).
      surface.onOpen?.()
      openGlobalSurface(surface.id)
    },
    [openGlobalSurface],
  )

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
  // never claimed the keystroke and the door had no keyboard exit. This covers
  // the one-commit settle before a swapping surface has answered — and, since
  // the Extensions drawer ruling (2026-09-05), every drawer door: Design and
  // Plugins keep their rail inline so the drawer survives them, which means
  // focus stays on the drawer row they were opened from unless the region takes
  // it. The trigger-focus capture above runs first, so the row is still recorded
  // and Escape hands the keyboard straight back to it.
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
    // is exactly when a confirm or prompt is likely to be open — deleting a door's
    // last row both empties the rail and holds a dialog. Taking focus to the region
    // behind it would leave that dialog un-dismissable from the keyboard.
    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      active.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')
    )
      return
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

  const pickNewChatName = useCallback(
    (folderPath: string | null): string => {
      const folderWorkspaces = workspaces.filter((workspace) => workspace.folderPath === folderPath)
      const existingNames = new Set(folderWorkspaces.map((workspace) => workspace.name.trim().toLowerCase()))
      if (!existingNames.has('chat')) return 'Chat'
      for (let index = 2; index < 1000; index += 1) {
        const name = `Chat ${index}`
        if (!existingNames.has(name.toLowerCase())) return name
      }
      return `Chat ${Date.now()}`
    },
    [workspaces],
  )

  // Agent CLIs offered across every renderer picker (sidebar New chat, top-bar
  // spawn menu, New workspace roster). Driven by the installed-plugin catalog
  // from T2 plus any configured cliRuntimes, so the lists scale with installed
  // agents instead of a hardcoded list. While the registry is loading or after a
  // registry error this falls back to the legacy bundled options.
  const agentCliCatalog = useMemo(
    () =>
      selectAgentCliCatalog(
        pluginCatalogStatus,
        pluginCatalogEntries,
        cliRuntimes,
        {
          map: cliAvailability,
          status: cliAvailabilityStatus,
        },
        cliModelCatalog,
      ),
    [pluginCatalogStatus, pluginCatalogEntries, cliRuntimes, cliAvailability, cliAvailabilityStatus, cliModelCatalog],
  )
  // The CLI a new spawn should launch: the remembered one when it is installed,
  // otherwise the first installed entry — and `null` when this machine has no
  // agent CLI at all. The old rescue answered with the remembered id
  // in that case, seeding an agent against a binary that is not here; a spawn
  // that gets `null` opens the install surface instead.
  const launchableSpawnCli = (cli: AgentCli): AgentCli | null => resolveLaunchableAgentCli(cli, agentCliCatalog)
  const routeToCliInstall = (): void => {
    openSettingsOverlay({ initialTab: AGENTS_SETTINGS_TAB })
  }

  // Conversation spawn is offered only in standard workspaces; a module-owned
  // agents stay terminal/MCP-owned (AgentPanel enforces this too).
  const conversationSpawnEnabled = activeWorkspace?.mode === 'standard'
  // Every surface that can spawn a conversation agent asks for the catalog by
  // bumping this counter: the launch surface and the launcher's
  // picker both offer the row. It used to be keyed on the top bar's spawn
  // menu alone, which no longer exists, and while it was, the row
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
    () =>
      resolveDefaultConversationOption(
        conversationSpawnOptions,
        rememberedConversationModel,
        conversationDynamicProviderIds,
      ),
    [conversationSpawnOptions, rememberedConversationModel, conversationDynamicProviderIds],
  )
  const conversationSpawnAvailable = conversationSpawnEnabled && conversationDefaultOption !== null
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
      // No root, nothing to adopt into: a chat started with no project picked
      // (or on a remote machine) is not a failure to report — the flag stays
      // unset and the next rooted creation adopts.
      if (!workspaceRoot) return
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

  // Create a fresh single-agent "solo chat" workspace. `folderPath === undefined`
  // inherits the active workspace's folder (the plain New chat default); an
  // explicit value (sidebar) targets that folder. `seedAgent` opens a specific
  // agent (terminal/general/conversation) in the new workspace, seeded at
  // creation so it is race-free before first render. Shared by createNewChat and
  // the Open-in-new-chat handlers.
  const createSoloChatWorkspace = useCallback(
    (opts: {
      folderPath?: string | null
      templateAgentCli?: AgentCli | null
      seedAgent?: SoloChatSeed
      name?: string
      // Marks the new solo chat as worktree-backed (connector chats). `folderPath`
      // must already point at the worktree so resolveWorkspaceWorktree resolves the
      // Git view/glyph to it.
      worktree?: WorkspaceWorktree
    }): WorkspaceId | null => {
      if (!SOLO_CHAT_TEMPLATE) {
        publishDiagnosticSync({
          level: 'error',
          source: 'workspace',
          title: 'New chat unavailable',
          message: 'The Solo layout template is missing, so a one-agent chat cannot be created.',
        })
        return null
      }
      const targetFolderPath = opts.folderPath === undefined ? (activeWorkspace?.folderPath ?? null) : opts.folderPath
      // The id is returned so a caller that must reach the agent it just seeded —
      // the Backlog handoff, which records the item ↔ agent link — can find it
      // without racing the mount. Every other caller ignores it.
      const createdId = addWorkspace(SOLO_CHAT_TEMPLATE, {
        name: opts.name ?? pickNewChatName(targetFolderPath),
        folderPath: targetFolderPath,
        windowId: workspaceWindowId,
        templateAgentCli: opts.templateAgentCli,
        seedAgent: opts.seedAgent,
        ...(opts.worktree ? { worktree: opts.worktree } : {}),
      })
      // A real workspace root now exists — for a fresh profile this is the first
      // one — which is the earliest point an existing agent config can be
      // adopted. Guarded once-per-profile inside; a chat with no project, or a
      // remote one, has no local root and passes null, which is skipped quietly.
      runFirstRunAgentConfigAdoption(targetFolderPath)
      closeSettingsOverlay()
      setNotificationsOpen(false)
      return createdId
    },
    [
      activeWorkspace?.folderPath,
      addWorkspace,
      closeSettingsOverlay,
      pickNewChatName,
      runFirstRunAgentConfigAdoption,
      workspaceWindowId,
    ],
  )

  const createNewChat = useCallback(
    (
      folderPath?: string | null,
      cli?: AgentCli,
      skills?: WorkspaceSkill[],
      // What the launch surface typed. A new chat is a solo workspace whose agent
      // starts itself, so the prompt rides its seed patch rather than a tab.
      startupPrompt?: string,
      // The chat lives in a worktree the door just made: `folderPath` IS that
      // worktree, and the marker carries its branch for the Git view and row.
      worktree?: WorkspaceWorktree,
      // The model the composer is standing on. Always handed over from the
      // confirm so the terminal starts on the chip, not on a later re-read of
      // the remembered defaults. `null` is the CLI's own default.
      selectedModel?: string | null,
      // The effort of that same row. Same contract as the model: present on the
      // confirm, `null` for the CLI's own default.
      selectedReasoning?: string | null,
    ): { workspaceId: WorkspaceId; agentId: AgentId } | null => {
      const chosenCli = cli && cli.trim() ? cli.trim() : null
      // A plain New chat rides the app's remembered CLI unless the caller named
      // one. The result is clamped to an installed catalog entry so a stale value
      // cannot seed a chat with an uninstalled plugin id; explicit picks come
      // from the catalog already.
      const templateAgentCli = resolveTemplateAgentCli(chosenCli, lastSelectedCli, agentCliCatalog)
      // A New chat seeds an agent that starts itself, so on a machine with no
      // agent CLI it would create a workspace around a binary that is not here.
      // The install is the honest answer to "start a chat" instead.
      if (!resolveLaunchableAgentCli(templateAgentCli, agentCliCatalog)) {
        openSettingsOverlay({ initialTab: AGENTS_SETTINGS_TAB })
        return null
      }
      // Ride the remembered model when it belongs to the spawning CLI. Seeded via
      // an agentPatch (no tabName, so the layout is untouched). The patch always
      // carries the composer's permission preset and debug mode.
      const cliModel =
        selectedModel !== undefined
          ? (selectedModel ?? undefined)
          : resolveSurfaceModel(templateAgentCli, lastSelectedAgentModel ?? undefined)
      const cliReasoning =
        selectedReasoning !== undefined
          ? (selectedReasoning ?? undefined)
          : resolveCliReasoning(templateAgentCli, lastSelectedAgentModel ?? undefined)
      const workspaceId = createSoloChatWorkspace({
        folderPath,
        templateAgentCli,
        ...(worktree ? { worktree } : {}),
        seedAgent: {
          agentPatch: {
            ...(cliModel ? { cliModel } : {}),
            ...(cliReasoning ? { cliReasoning } : {}),
            cliPermissionPreset: resolveModelPermissionPreset(templateAgentCli, cliModel, agentSpawnPermissionPreset),
            debugMode: agentSpawnDebugMode,
            ...(startupPrompt ? { cliStartupPrompt: startupPrompt } : {}),
            ...skillsSpawnAgentPatch(
              skills ?? [],
              pluginCatalogEntries.find((entry) => entry.id === templateAgentCli)?.skillIntegration,
            ),
          },
        },
      })
      // Remember an explicit pick as the app-wide default CLI: a New chat is the
      // app's own agent, so the CLI it was started on is the answer every surface
      // without a remembered CLI of its own falls back to.
      if (chosenCli) setLastSelectedCli(chosenCli)
      if (agentSpawnDebugMode) setAgentSpawnDebugMode(false)
      // The solo template carries exactly one agent tab, and the seed patch above
      // was merged onto it at creation, so the lone agent record IS this chat's
      // agent. Read back rather than guessed: the id is the template's, not one
      // this function minted.
      if (!workspaceId) return null
      const created = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)
      const agentId = Object.keys(created?.agents ?? {})[0]
      return agentId ? { workspaceId, agentId } : null
    },
    [
      agentCliCatalog,
      agentSpawnDebugMode,
      agentSpawnPermissionPreset,
      createSoloChatWorkspace,
      openSettingsOverlay,
      pluginCatalogEntries,
      lastSelectedAgentModel,
      lastSelectedCli,
      setLastSelectedCli,
    ],
  )

  // The isolated connector-chat runtime (a worktree per connector, single-
  // server MCP) left with the Skills & MCPs picker: MCP picks are synced into
  // the workspace's CLI config on pick and the agent starts in the workspace.

  const openSettings = useCallback(
    (checkForUpdates = false, targetTab: string | null = null) => {
      openSettingsOverlay({ initialTab: targetTab, checkForUpdates })
      setSessionsOpen(false)
      setViewMenuOpen(false)
      setNotificationsOpen(false)
      setAccountOpen(false)
    },
    [openSettingsOverlay],
  )

  useEffect(() => {
    registerWorkspaceWindow(workspaceWindowId, isPrimaryWorkspaceWindow ? 'primary' : 'detached')
  }, [isPrimaryWorkspaceWindow, registerWorkspaceWindow, workspaceWindowId])

  // The plugin catalog loads once at startup (workspaceStore) and on explicit
  // Settings retry. Re-sync it when this window regains focus / becomes visible
  // so plugins installed or removed while the user was away show up without an
  // app reload. Background mode avoids a loading flicker; refreshPluginCatalog
  // dedups concurrent calls during rapid focus changes.
  // Plugin sources: the hourly check (backlog/2026-09-05-plugin-sources.md,
  // "Update notifications") says which repositories moved past the commit
  // they were scanned at. Only drift the check DISCOVERED is news — a source
  // already marked stays marked on its rail row and is not announced again.
  // Button-free, like every toast but the CLI update; Sync lives on the source.
  useEffect(() => {
    if (typeof window.api?.onSkillSourcesUpdated !== 'function') return
    return window.api.onSkillSourcesUpdated((check) => {
      const notice = sourceUpdatesNotice(check)
      if (!notice) return
      showToast({ tone: 'accent', title: notice.title, description: notice.description })
      // On the Plugins row of the Extensions drawer, where the notice sends
      // the person; Sync there takes the changes for Skills too.
      publishDiagnosticSync({
        level: 'info',
        source: 'marketplace',
        title: notice.title,
        message: notice.description,
        extensionsRow: 'plugins',
      })
    })
  }, [])

  // Model discovery boot goes here: ask the installed CLIs for their models once detection settles.

  // Models a refresh added. Every picker re-derives its rows from
  // `appSettings.cliModelCatalog` on its own; this only announces the ids a
  // refresh introduced for an installed CLI (see discoveredModelAdditions for
  // what is not news: a first-ever probe, the catalogs arriving at boot, rows
  // without `firstSeenAt`).
  useEffect(() => {
    return useWorkspaceStore.subscribe((state, previousState) => {
      const next = state.appSettings.cliModelCatalog
      const previous = previousState.appSettings.cliModelCatalog
      if (next === previous) return
      const added = newModelsNotice({
        additions: discoveredModelAdditions(previous, next),
        installed: new Set(
          Object.values(state.cliAvailability)
            .filter((entry) => entry?.installed)
            .map((entry) => entry!.cli),
        ),
        userModels: (cli) => state.appSettings.cliRuntimes?.[cli]?.models ?? [],
        displayName: (cli) => state.pluginCatalogEntries.find((entry) => entry.id === cli)?.displayName ?? cli,
      })
      if (!added) return
      showToast({ tone: 'accent', title: added.title, description: added.description })
      publishDiagnosticSync({
        level: 'info',
        source: 'models',
        title: added.title,
        message: added.description,
        navigationTarget: { kind: 'settings', ref: 'agents' },
      })
    })
  }, [])

  // The hosted card feed: the disk copy at boot so the Extensions home has its
  // cards before anyone presses the door, then every push from main replaces
  // them. No notices — the home page never announces its own network
  // (epic ruling R6). The returned unsubscribe detaches the ipcRenderer
  // listener, so a window that goes away stops being sent feeds.
  useEffect(() => {
    void useWorkspaceStore.getState().loadCards()
    return subscribeHostedCardFeedChanges((result) => {
      useWorkspaceStore.getState().applyHostedCardFeedResult(result)
    })
  }, [])

  // The app update, once downloaded: one good toast and one bell row. The
  // Settings banner is unchanged; autoInstallOnAppQuit does the rest.
  useEffect(() => {
    const api = typeof window === 'undefined' ? null : window.api
    if (!api || typeof api.onUpdateStateChanged !== 'function') return
    let last: string | null = null
    return api.onUpdateStateChanged((state) => {
      if (state.status === 'downloaded' && last !== 'downloaded') {
        const notice = updateReadyNotice('SprintEngine Studio', state.updateVersion)
        showToast({ tone: 'good', title: notice.title, description: notice.description })
        publishDiagnosticSync({
          level: 'info',
          source: 'update',
          title: notice.title,
          message: notice.description,
          navigationTarget: { kind: 'settings', ref: 'general' },
        })
      }
      last = state.status
    })
  }, [])

  // CLI version advisories: the Settings switch is mirrored into main (which
  // runs the hourly check), the first answer is asked for once the window is
  // up, and every later push lands in the store.
  const checkCliVersions = useWorkspaceStore((s) => s.checkCliVersions)
  useEffect(() => {
    const api = typeof window === 'undefined' ? null : window.api
    if (api && typeof api.cliVersionChecksSetEnabled === 'function')
      void api.cliVersionChecksSetEnabled(checkCliVersions)
    if (checkCliVersions) {
      const store = useWorkspaceStore.getState()
      void store.refreshCliVersionAdvisories({ cliRuntimes: store.appSettings.cliRuntimes })
    }
  }, [checkCliVersions])
  useEffect(
    () =>
      subscribeCliVersionAdvisoryChanges((result) => {
        const store = useWorkspaceStore.getState()
        store.applyCliVersionAdvisories(result)
        if (!result.ok || !result.newlyOutdated?.length) return
        for (const advisory of result.newlyOutdated) showCliUpdateToast(advisory)
      }),
    [],
  )

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
    [],
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
    void window.api
      .getWindowPlacement()
      .then((placement) => {
        if (!placement) return
        updateWorkspaceWindowPlacement(workspaceWindowId, placement)
      })
      .catch(() => {})

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
    document.title = [windowName, projectName, 'SprintEngine Studio'].filter(Boolean).join(' - ')
  }, [activeWorkspace?.folderPath, activeWorkspace?.name])

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
  // it (a file editor, a panel), and layers are never unmounted on switch
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
      // No terminal on screen (a Files-only or panel-only layout, or a layout
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
      // A live browser tab is a held resource, like a live pty. Evicting the
      // layer destroys the <webview> guest, and with it everything the page was
      // holding — a session the person signed into, a half-filled form, the tab
      // an agent is driving mid-interaction. None of that survives a remount,
      // and none of its loss is visible until someone comes back to it. An
      // idle-looking workspace with a browser tab open is not idle.
      if (workspace.paneState?.tabs?.some((tab) => tab.kind === 'browser')) {
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
    const timeout = window.setTimeout(
      () => {
        setWorkspaceLayoutRetentionTick(Date.now())
      },
      Math.max(1_000, nextDeadline - now + 50),
    )
    return () => window.clearTimeout(timeout)
  }, [mountedWorkspaceIds, terminalSessions, visibleWorkspaces, windowActiveWorkspaceId, workspaceLayoutRetentionTick])

  // Auto-open New chat when there are no workspaces — unless the first-run CLI
  // question still owns that window. Precedence lives HERE, at the
  // opener, not on the card: the card's own "don't fight for the region" gate
  // above stays exactly as it is, and it is satisfied because New chat simply
  // has not opened yet. A scalar boolean, not the availability map, is what the
  // effect depends on — a background re-probe hands back a fresh map object
  // every time, and depending on that would re-open a panel the user closed.
  const autoOpenNewChat = shouldAutoOpenNewChat({
    workspaceCount: railWorkspaces.length,
    cliAvailabilityStatus,
    cliAvailability,
    firstRunCliCardDismissed,
  })
  // Read through a ref: the presenter's identity follows the active folder,
  // and the effect must fire on the boolean's transition alone. Present, not
  // open: the auto-open never closes a door or modal the person is in.
  const presentNewChatPanelRef = useRef<(folderPath?: string | null) => void>(() => {})

  useEffect(() => {
    // No explicit folder: a parked draft's project resumes, else no project.
    if (autoOpenNewChat) presentNewChatPanelRef.current()
  }, [autoOpenNewChat])

  useEffect(() => {
    let disposed = false

    void window.api
      .authGetState()
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

      // Persist "last message the person sent" the same way, from the
      // `UserPromptSubmit` prompt each session carries. This is what the
      // sidebar orders by: keystrokes above answer "did the person touch this
      // terminal", which reordered the list when someone pressed an arrow key,
      // and a message answers "did the person say something here", which is
      // the event they mean when they expect a chat to move.
      const userMessageByWorkspace = new Map<string, number>()
      for (const session of sessions) {
        if (typeof session.workspaceId !== 'string') continue
        const at = session.lastPrompt?.at
        if (typeof at !== 'number') continue
        const current = userMessageByWorkspace.get(session.workspaceId)
        if (current === undefined || at > current) {
          userMessageByWorkspace.set(session.workspaceId, at)
        }
      }
      for (const [workspaceId, at] of userMessageByWorkspace) {
        const lastReported = reportedUserMessageRef.current.get(workspaceId)
        if (lastReported !== undefined && lastReported >= at) continue
        reportedUserMessageRef.current.set(workspaceId, at)
        recordWorkspaceUserMessage(workspaceId, at)
      }

      // Persist "last finished" the same way, from the hook-reported turn end
      // each session carries, so a parked chat still knows when its agent
      // stopped after the session is gone (owner, 2026-09-05).
      const turnEndByWorkspace = new Map<string, number>()
      for (const session of sessions) {
        if (typeof session.workspaceId !== 'string') continue
        if (typeof session.lastTurnEndedAt !== 'number') continue
        const current = turnEndByWorkspace.get(session.workspaceId)
        if (current === undefined || session.lastTurnEndedAt > current) {
          turnEndByWorkspace.set(session.workspaceId, session.lastTurnEndedAt)
        }
      }
      for (const [workspaceId, at] of turnEndByWorkspace) {
        const lastReported = reportedTurnEndRef.current.get(workspaceId)
        if (lastReported !== undefined && lastReported >= at) continue
        reportedTurnEndRef.current.set(workspaceId, at)
        recordWorkspaceTurnEnd(workspaceId, at)
      }

      // Name a new chat after the first real prompt sent inside it, so a sidebar
      // of them says what each was for instead of "Chat 44". The requester
      // lands the heuristic title at once and, when the person has it on, lets
      // their own agent's title replace it when it arrives. The store action
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
        generatedWorkspaceTitleRequester().titleFromPrompt(session.workspaceId, prompt.text)
      }

      if (!reconciledLaunchFlagsRef.current) {
        reconciledLaunchFlagsRef.current = true
        reconcileWorkspaceAgentLaunchFlags(sessions)
      }

      // Agents the MAIN process launched have no record here until
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
        const host = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === projected.workspaceId)
        revealAgentTerminalTab(
          {
            workspaceId: projected.workspaceId,
            agentId: projected.agentId,
            name: projected.agent.name,
          },
          // A launch into a standard workspace is something the operator asked
          // for and gets the view; a launch into a rail-hidden host (Automations,
          // a module's background host) gets its tab without moving anyone into it.
          { activateWorkspace: !host || !isHiddenFromRail(host, moduleEnablement) },
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
    recordWorkspaceUserMessage,
    recordWorkspaceTurnEnd,
    reconcileWorkspaceAgentLaunchFlags,
    projectLaunchedAgentSessions,
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

  // Outside-click and Escape for the top-bar menus (sessions, view,
  // notifications, account) are owned by the Popover primitive: its surface
  // is portaled to <body>, so a manual `menuRef.contains(target)` guard here would
  // read every click inside the portaled surface as "outside" and close the menu
  // before the row's click lands — which silently broke agent spawning. Each
  // Popover's onOpenChange already drives these open-states, so no handler is
  // needed (mirrors the account menu, which never had one).

  useEffect(() => {
    setSessionsOpen(false)
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
    [removeWorkspace],
  )

  const handleForgetFolder = useCallback(
    (folderPath: string) => {
      const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
      const targetKey = normalize(folderPath)
      workspaces.forEach((workspace) => {
        // The same predicate the store's forgetFolder uses: the project the
        // workspace files under, so a worktree chat's terminals are terminated
        // along with the parent's rather than outliving the record.
        const projectRoot = workspaceProjectRoot(workspace)
        if (projectRoot && normalize(projectRoot) === targetKey) {
          // Nothing on disk is touched afterwards, so the kills run in the
          // background rather than holding the folder out of the sidebar.
          void terminateWorkspaceTerminals(workspace)
        }
      })
      forgetFolder(folderPath)
    },
    [workspaces, forgetFolder],
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
    [currentWorkspaceWindow?.bounds, moveWorkspaceToWindow, registerWorkspaceWindow, workspaceWindowId],
  )

  const moveWorkspaceToPrimaryWindow = useCallback(
    (workspaceId: string) => {
      const primaryWindowId = primaryWorkspaceWindowId || PRIMARY_WORKSPACE_WINDOW_ID
      moveWorkspaceToWindow(workspaceId, primaryWindowId, workspaceWindowId)
      if (!isPrimaryWorkspaceWindow && visibleWorkspaces.length <= 1) {
        void window.api.windowClose()
      }
    },
    [
      isPrimaryWorkspaceWindow,
      moveWorkspaceToWindow,
      primaryWorkspaceWindowId,
      visibleWorkspaces.length,
      workspaceWindowId,
    ],
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
  const residentWorkspaceIds = useMemo(() => residentAgentWorkspaceIds(terminalSessions), [terminalSessions])

  const terminalRecencyByWorkspaceId = useMemo(() => {
    const map: Record<
      string,
      { hasRunning: boolean; idleSince: number | null; lastInputAt: number | null; workingSince: number | null }
    > = {}
    for (const workspace of workspaces) {
      const persistedLastInputAt =
        typeof workspace.lastTerminalActivityAt === 'number' ? workspace.lastTerminalActivityAt : null
      const activity = deriveWorkspaceTerminalActivity(workspace.id, terminalSessions, persistedLastInputAt)
      const hasRunning = activity.kind === 'working' || activity.kind === 'failed'
      const persistedTurnEndedAt = typeof workspace.lastTurnEndedAt === 'number' ? workspace.lastTurnEndedAt : null
      const idleSince = deriveWorkspaceIdleSince(
        workspace.id,
        terminalSessions,
        persistedLastInputAt,
        persistedTurnEndedAt,
      )
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

  // The sidebar's "finished while you were away" marks, reported up: the
  // sidebar owns them (it is the layer that knows what the person has looked
  // at), and the rail's Home badge counts them alongside the chats blocked on
  // a prompt. A chat under a door is off screen, so it counts too.
  const [unseenDoneIds, setUnseenDoneIds] = useState<ReadonlySet<string>>(() => new Set())
  // And the chats it is hiding because they are asleep (snooze, 2026-09-10),
  // reported up the same way and for the same reason: the badge counts what
  // the sidebar shows.
  const [snoozedWorkspaceIds, setSnoozedWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set())
  const railBadges = useRailBadges({
    workspaces: visibleWorkspaces,
    activityByWorkspaceId,
    unseenDoneIds,
    snoozedWorkspaceIds,
    onScreenWorkspaceId: activeGlobalSurface ? null : windowActiveWorkspaceId,
    activeGlobalSurface,
  })

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

  const addNewCliAgent = async (
    cli: AgentCli,
    skills?: WorkspaceSkill[],
    worktree?: { name: string },
    // The model the composer is standing on. Always
    // handed over from the confirm so the terminal starts on the chip.
    selectedModel?: string | null,
    placement?: AgentSpawnPlacement,
    // The rest of that same row. The composer always names the effort; a
    // card's `Go` is the other caller with a row that was never written to
    // the defaults (item 2473).
    //
    // Model and EFFORT only. The preset is not an axis a caller may hand over —
    // see the `cliPermissionPreset` note below.
    picked?: { reasoning?: string | null },
  ) => {
    if (!windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = useWorkspaceStore
      .getState()
      .workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    const spawnCli = launchableSpawnCli(cli)
    if (!spawnCli) {
      routeToCliInstall()
      return
    }
    // The clamp above answers with SOME installed runtime — the first in the
    // catalogue when the one asked for is not in it — and a caller that handed
    // over a model row would then launch that row's model, effort and preset on
    // a different runtime's binary. A row is one answer: if its runtime did not
    // survive the clamp, its other three axes go with it and this spawn falls
    // back to what the runtime it CAN launch remembers.
    const askedForSurvived = isAgentCliAvailable(cli, agentCliCatalog)
    const row = askedForSurvived ? picked : undefined
    const rowModel = askedForSurvived ? selectedModel : undefined
    // An agent gets a real first+last name from the shared pool, not a numbered
    // "General Agent 2/3…" placeholder. A launch from a new-agent tab keeps the
    // name that tab is already wearing.
    const tabName =
      placement?.agentName ||
      pickRandomAgentName(Object.values(activeWorkspace?.agents ?? {}).map((agent) => agent.name))
    const newId = `agent-${spawnCli}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

    let execution: AgentExecution | undefined
    if (worktree) {
      if (!activeWorkspace) return
      const created = await createAgentSpawnWorktree(activeWorkspace, newId, tabName, worktree.name)
      if (!created) return
      execution = created
    }

    const cliModel =
      rowModel !== undefined
        ? (rowModel ?? undefined)
        : resolveSurfaceModel(spawnCli, lastSelectedAgentModel ?? undefined)
    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      cli: spawnCli,
      cliModel,
      cliReasoning:
        row?.reasoning !== undefined
          ? (row.reasoning ?? undefined)
          : resolveCliReasoning(spawnCli, lastSelectedAgentModel ?? undefined),
      ...(execution ? { execution } : {}),
      // The preset is a property of the model ROW (2026-09-05), so it is read
      // HERE, from the (cli, model) this spawn is actually launching — never
      // taken from the caller, not even one that swears it read the preset off
      // this very row. The model and the effort above have to be passed in
      // because nothing on this side can recover them; the preset is the axis
      // where that reason does not hold, and accepting it anyway is how a spawn
      // seeds a preset belonging to a row other than the one it launches: the
      // caller resolved against its own fallback, at its own moment, against
      // the cli it asked for rather than the one the clamp above answered with.
      // Today those agree, which is exactly why the drift would ship unnoticed.
      // `createNewChat` reads it the same way, for the same reason.
      cliPermissionPreset: resolveModelPermissionPreset(spawnCli, cliModel, agentSpawnPermissionPreset),
      debugMode: agentSpawnDebugMode,
      cliStartupPrompt: placement?.prompt || undefined,
      cliOnboardingPromptSent: false,
      cliHasLaunched: false,
      cliResumeAvailable: false,
      ...skillsSpawnAgentPatch(
        skills ?? [],
        pluginCatalogEntries.find((entry) => entry.id === spawnCli)?.skillIntegration,
      ),
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
    skills?: WorkspaceSkill[],
    placement?: AgentSpawnPlacement,
  ) => {
    if (!windowActiveWorkspaceId) return
    const model = getModel(windowActiveWorkspaceId)
    if (!model) return

    const activeWorkspace = useWorkspaceStore
      .getState()
      .workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
    if (!activeWorkspace || activeWorkspace.mode !== 'standard') return

    const tabName = uniqueAgentName(modelLabel || 'Conversation Agent', activeWorkspace.agents)
    const newId = `conversation-${providerId}-${nanoid(6)}`
    if (!(model.getActiveTabset() ?? firstTabset(model))) return

    // Skill-at-spawn on the conversation transport: make the skill present in
    // the workspace (best-effort) and seed the chat composer draft with the
    // invocation — prefilled, never auto-sent.
    const firstSkill = skills?.[0]
    if (activeWorkspace.folderPath) {
      for (const skill of skills ?? []) void ensureSkillForAgent({ workspaceRoot: activeWorkspace.folderPath, skill })
    }
    updateAgent(windowActiveWorkspaceId, newId, {
      name: tabName,
      ...conversationAgentRuntimePatch(providerId, modelId),
      // A conversation is not a model-picker row — it is a provider/model pair
      // with no CLI — so there is no per-row preset stored against it and the
      // app-wide default is what it starts on. AgentChatView reads this record
      // field and lets the user change it mid-conversation.
      cliPermissionPreset: agentSpawnPermissionPreset,
      // The chat prefill is one sentence opener; with several skills the first
      // leads and the rest are named after it.
      ...(firstSkill
        ? {
            chatComposerPrefill:
              (skills ?? []).length > 1
                ? `${renderChatSkillPrefill(firstSkill)}(also ${(skills ?? [])
                    .slice(1)
                    .map((skill) => skill.id)
                    .join(', ')}) `
                : renderChatSkillPrefill(firstSkill),
          }
        : {}),
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
    skills?: WorkspaceSkill[],
    provider?: { providerId: string; modelId: string; modelLabel: string },
    placement?: AgentSpawnPlacement,
  ) => {
    const target = provider ?? conversationDefaultOption
    if (!target) return
    addNewConversationAgent(target.providerId, target.modelId, target.modelLabel, skills, placement)
  }

  const addNewTerminal = (placement?: AgentSpawnPlacement) => {
    if (!windowActiveWorkspaceId) return
    const newId = `terminal-${nanoid(6)}`
    // From a new-agent tab, the shell opens in that tab rather than beside it.
    if (placement?.tabId && convertNewAgentTabToTerminal(windowActiveWorkspaceId, placement.tabId, newId, 'Terminal')) {
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
    skills?: WorkspaceSkill[],
    startupPrompt?: string,
    worktree?: WorkspaceWorktree,
    // The rest of the row the composer is standing on (see `createNewChat`).
    selectedModel?: string | null,
    selectedReasoning?: string | null,
  ) => createNewChat(folderPath, cli, skills, startupPrompt, worktree, selectedModel, selectedReasoning)

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
    skills?: WorkspaceSkill[],
    startupPrompt?: string,
    worktree?: WorkspaceWorktree,
    selectedModel?: string | null,
    selectedReasoning?: string | null,
  ) => {
    setLastNewChatAgent({ kind: 'general' })
    openGeneralInNewChat(cli, folderPath, skills, startupPrompt, worktree, selectedModel, selectedReasoning)
  }
  // The worktree the New chat door asked for under ⋯ (found at the seam of
  // checkout-and-branch-on-remote-create: the door offered the option and
  // `confirmNewChat` dropped it on the floor). Same container, branch and
  // include-set as the tab strip's worktree spawn; the chat then opens IN the
  // worktree, the way the Worktree panel's "New chat here" does. Null after a
  // diagnostic when it cannot be made — the caller aborts rather than start
  // the chat in the checkout the person asked to keep clean.
  //
  // The returned marker records the chat's project so the sidebar files it under
  // the project it was cut from instead of founding a header named after the
  // slug. It is deliberately the folder the chat was scoped to and not the
  // git-resolved `repoRoot` below: under a symlinked root git's realpath would
  // not string-match the open parent workspace's folderPath, and the chat would
  // found its own header all over again.
  //
  // The scoped folder can itself be one of our worktrees — the plain New chat
  // button inherits the active workspace's folder, and that workspace may be a
  // worktree chat. Everything here works off the PROJECT behind it, so the new
  // worktree is a sibling of the one it was started from rather than nested
  // inside its container, and records the real project as its own.
  const createNewChatWorktree = async (
    folderPath: string | null,
    requestedName: string,
  ): Promise<{ folderPath: string; worktree: WorkspaceWorktree } | null> => {
    const fail = (title: string, message: string) => {
      publishDiagnosticSync({ level: 'error', source: 'workspace', title, message })
      return null
    }
    if (!folderPath)
      return fail('Worktree needs a project', 'Choose a project folder before starting a chat on a worktree.')
    const projectFolder = workspaceProjectRootOf({ folderPath }) ?? folderPath
    const repoRoot = await window.api.getGitRepoRoot(projectFolder)
    if (!repoRoot) {
      return fail(
        'Worktree needs a git repository',
        'This project is not a git repository, so a worktree cannot be created.',
      )
    }
    const name = requestedName.trim() || `chat-${nanoid(4).toLowerCase()}`
    const paths = agentWorktreePaths(repoRoot, name)
    if (!paths) return fail('Worktree name invalid', `"${name}" does not reduce to a usable worktree name.`)
    const result = await window.api.createGitWorktree({
      repoRoot,
      containerPath: paths.containerPath,
      destinationPath: paths.destinationPath,
      branchName: paths.branchName,
      baseRef: 'HEAD',
      copyIncludedFiles: true,
    })
    if (!result.ok) return fail('Worktree failed', result.message)
    return {
      folderPath: result.data.path,
      worktree: { branch: result.data.branch ?? paths.branchName, baseRef: 'HEAD', repoRoot: projectFolder },
    }
  }

  // Open the pre-creation New Chat panel. `folderPath === undefined` inherits the
  // active workspace's folder (the plain New chat button); an explicit value
  // scopes the chat to that project (folder/workspace-row menus). `connector`
  // opens the composer with that connector attached (the connector "New chat"
  // entry points). Nothing is created here — the panel's confirm does that.
  //
  // A parked draft resumes (new-chat-survives-back-and-forward): with no
  // explicit folder, the door reopens on the project the draft was scoped to,
  // and the panel seeds itself from the draft under `workspaceWindowId`. An
  // explicit folder (a context-menu "New chat in project") wins for the
  // project, and the draft is rescoped onto it — words and images travel,
  // project-bound picks do not.
  //
  // `presentNewChatPanel` is the state half alone — the panel is set, nothing
  // else is disturbed. The first-run auto-open uses it: that fires whenever
  // this window's workspace count reaches zero, and closing the door or modal
  // the person is in at that moment (closing the last project from a
  // door, opening Settings before the CLI probe resolves) is not what an
  // auto-open may do. The panel simply waits under whatever is open.
  const presentNewChatPanel = useCallback(
    (folderPath?: string | null, connector?: AgentComposerConnector | null) => {
      // A draft with nothing in it — no words, no images, no picks — is not a
      // draft, and resuming it would only pin the project and engine of the last
      // open onto every New chat after it. It is dropped here; the reopen scopes
      // to the active workspace like a first open.
      let parked = readNewChatDraft(workspaceWindowId)
      if (parked && !newChatDraftHasContent(parked)) {
        clearNewChatDraft(workspaceWindowId)
        parked = null
      }
      const resolved =
        folderPath === undefined ? (parked?.folderPath ?? activeWorkspace?.folderPath ?? null) : folderPath
      rescopeNewChatDraft(workspaceWindowId, resolved)
      setNewChatPanelState({
        folderPath: resolved,
        folderLabel: resolved ? newChatFolderLabel(resolved) : null,
        connector: connector ?? null,
      })
    },
    [activeWorkspace?.folderPath, workspaceWindowId],
  )
  presentNewChatPanelRef.current = presentNewChatPanel
  const openNewChatPanel = useCallback(
    (folderPath?: string | null, connector?: AgentComposerConnector | null) => {
      presentNewChatPanel(folderPath, connector)
      // The panel mounts inside the workspace-card container, which is inert and
      // painted over while a door surface is active — the door closes first or
      // this click is a visible no-op. An
      // open modal (a connector "New chat" comes from the Plugins modal) closes
      // for the same reason: the panel would open behind its scrim.
      // closeModalSurface also clears the settings request.
      closeGlobalSurface()
      closeModalSurface()
      setNotificationsOpen(false)
      // A chat is a Home thing: the tree is where its row will appear.
      setSidebarSection('home')
    },
    [closeGlobalSurface, closeModalSurface, presentNewChatPanel, setSidebarSection],
  )
  // Closing ON PURPOSE — ×, Escape, or the chat starting — is the one thing
  // besides launch that forgets the draft. Every other way off the door
  // (Back, a sidebar click, a door) only parks it:
  // `setNewChatPanelState(null)` alone.
  const closeNewChatPanel = useCallback(() => {
    setNewChatPanelState(null)
    clearNewChatDraft(workspaceWindowId)
  }, [workspaceWindowId])
  // The project the door is scoped to rides with the draft, so a reopen lands
  // on the project the person last picked — Browse, the selector, or a clone.
  const newChatPanelFolderPath = newChatPanelState?.folderPath
  useEffect(() => {
    if (newChatPanelFolderPath === undefined) return
    writeNewChatDraft(workspaceWindowId, { folderPath: newChatPanelFolderPath })
  }, [newChatPanelFolderPath, workspaceWindowId])

  /**
   * `Go` on a card on the Extensions home (item 2469, owner ruling R4: "Go
   * goes"). One press installs what the card names and lands the person in the
   * chat with the prompt SENT — no consent screen, no plan, no progress modal.
   *
   * The one thing between the press and the work is the MODEL PICKER (ruling
   * R4b, item 2473), and choosing a row in it is what calls this. `launch` is
   * that row: its cli, its model, its reasoning effort and the permission preset
   * remembered against it. All four are ONE answer and stay one — the chat is
   * spawned from `launch` and from nothing else, so no launch is ever assembled
   * out of a runtime from here and a model from there. They ride `cards:run`
   * too, so the hand-off main sends back describes the whole launch rather than
   * half of it, and a later reader of that record is not left guessing.
   *
   * `require.cli` is not a second opinion about the runtime. It fails a card
   * whose CLI this machine does not have, and it preselects that CLI in the
   * picker; what the person then chooses is what runs, because a card's skills
   * are copied into every skills-capable harness on the machine rather than into
   * one.
   *
   * The whole of the run happens in main, in one call: `cards:run` composes the
   * installers that already own each concern, in the card's own order, stopping
   * at the first failure. Nothing here installs anything, so there is no second
   * implementation of "install a skill" living in the renderer to drift from the
   * first. What comes back is a report and, at most, two things to do — open a
   * door, open a chat — because those are the two a main process cannot do.
   *
   * The three facts the request carries that a card does not are all the app's:
   * the workspace the person is in (a card carries none by design), where this
   * app puts projects, and the MCP servers this machine has configured, which
   * live in this store rather than on disk in main. They are read at press time
   * from `getState()`, never from a value captured at render, because the run is
   * a round trip and a settings object from the last render can be minutes old.
   *
   * It never rejects: a failure is a toast, named and specific, and the promise
   * settles either way so the card's one button can re-enable itself.
   */
  const runCardGo = useCallback(
    async (card: HostedCard, launch: CardLaunchChoice): Promise<void> => {
      if (typeof window.api?.cardsRun !== 'function') return
      const state = useWorkspaceStore.getState()
      const workspaceRoot =
        state.workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)?.folderPath ?? null
      const result = await window.api
        .cardsRun({
          slug: card.slug,
          actions: card.go,
          workspaceRoot,
          // Where a `clone.repo` lands: the same smart parent the New chat
          // selector's own clone uses. A card names a repository and never a
          // place — this is the place.
          cloneParentDir: resolveDefaultParentPath({
            folderPath: workspaceRoot,
            recentFolders: state.appSettings.recentWorkspaceFolders ?? [],
          }),
          mcpServers: Object.values(state.appSettings.mcp?.servers ?? {}),
          // The switch as it stands, not as a card would like it. Main flips it
          // on only when the card actually adds a server, which is the same thing
          // `upsertMcpServer` does below with that same server — so a person who
          // turned MCP sync off keeps it off unless they install something.
          mcpSyncEnabled: state.appSettings.mcp?.syncEnabled === true,
          // The row the person chose, carried whole. Main reads none of the three
          // and hands all three back on the chat.
          model: launch.model,
          reasoning: launch.reasoning,
          permissionPreset: launch.permissionPreset,
        })
        .catch((error: unknown): CardRunResult => ({
          ok: false,
          outcomes: [],
          workspaceRoot,
          mcpServers: [],
          chat: null,
          surface: null,
          message: error instanceof Error ? error.message : String(error),
        }))

      // Written back BEFORE the ok check, and deliberately. A run that installed
      // a server and then failed on the next action has already written that
      // server to disk; leaving it out of the settings would be the one outcome
      // the review focus names — a workspace in a state the person cannot see and
      // cannot undo. Whatever main reports is what the store now says.
      //
      // `result.mcpServers` is the servers this run ADDED, never the merged list:
      // `upsertMcpServer` turns MCP sync back on for every server it is handed,
      // and re-upserting servers the person already had would flip that switch on
      // their behalf for something they did not just install.
      for (const server of result.mcpServers) upsertMcpServer(server)

      if (!result.ok) {
        // A card refused before anything ran marks EVERY outcome `skipped`, so
        // counting them said "3 later steps did not run" when nothing ran at all
        // and there was no earlier step to be later than. The count is only worth
        // saying when something did happen first.
        const ran = result.outcomes.some((outcome) => outcome.status !== 'skipped')
        const notRun = result.outcomes.filter((outcome) => outcome.status === 'skipped').length
        const said = result.message ?? 'Something went wrong.'
        // A toast, not a modal and not a stack trace: it names what failed and,
        // when there was more to do, how much of it did not run.
        showToast({
          tone: 'warn',
          title: `${card.title} ${ran ? 'did not finish' : 'did not run'}`,
          description:
            ran && notRun > 0 ? `${said} ${notRun} later ${notRun === 1 ? 'step' : 'steps'} did not run.` : said,
        })
        return
      }

      if (result.surface) {
        // `home` is the app's own surface and the rest are views of the
        // Extensions door, which is exactly the split `CardSurfaceView` states.
        if (result.surface.view === 'home') {
          openGlobalSurface(EXTENSIONS_HOME_SURFACE_ID)
        } else {
          // Latch first, open second — the order every deep-link opener in this
          // file uses, so an already-open door and a cold one both land on the
          // row the card named.
          dispatchExtensionsSurfaceTarget({
            view: EXTENSIONS_DRAWER_VIEWS[result.surface.view === 'agent-clis' ? 'agentClis' : result.surface.view],
            ...(result.surface.installed ? { installed: true } : {}),
          })
          openGlobalSurface('extensions')
        }
      }

      if (!result.chat) {
        // A run that opens no surface and no chat — an `install.module` card is
        // the first — would otherwise end with the button still reading
        // "Install" and nothing on screen to say it worked. Main composes the one
        // sentence worth showing for each action ("Reviews installed. Restart
        // SprintEngine Studio to use it."); say them.
        if (!result.surface) {
          const said = result.outcomes
            .filter((outcome) => outcome.status === 'done' || outcome.status === 'already')
            .map((outcome) => outcome.message.trim())
            .filter((message) => message.length > 0)
          if (said.length > 0) {
            showToast({ tone: 'good', title: card.title, description: said.join(' ') })
          }
        }
        return
      }
      const chat = result.chat
      const chatRoot = result.workspaceRoot
      // The skills the card named, as the workspace actually holds them. A name
      // this workspace does not have is a chip that is not attached rather than a
      // refusal: the install that would have put it there has already reported
      // for itself, and dropping the whole chat over a stale name would throw
      // away the run that succeeded.
      const skills =
        chatRoot && chat.skills.length > 0 && typeof window.api.workspaceSkillsList === 'function'
          ? await window.api
              .workspaceSkillsList({ workspaceRoot: chatRoot })
              .then((listed) => (listed.ok ? listed.skills.filter((skill) => chat.skills.includes(skill.id)) : []))
              .catch(() => [] as WorkspaceSkill[])
          : []

      // The card's MCP servers need no attaching here: `install.mcp` wrote them
      // into this workspace's `.mcp.json` through `mcpConfigService.sync` on the
      // way past, so the agent launched below already reads them.
      const movedWorkspace = chatRoot !== null && chatRoot !== workspaceRoot
      // Which workspace the person is looking at NOW, read live from the store
      // rather than from the render this press came out of. The run is a round
      // trip and a person can switch projects during it; `addNewCliAgent` places
      // the new tab in the workspace that was active when Go was pressed, which
      // is the right place — it is where every install went — but it can no
      // longer be the workspace on screen, and a prompt that SENDS would then be
      // an agent working somewhere nobody is looking.
      const activeNow =
        useWorkspaceStore.getState().workspaceWindows.find((windowState) => windowState.id === workspaceWindowId)
          ?.activeWorkspaceId ?? null
      const switchedAway =
        windowActiveWorkspaceId !== null && activeNow !== null && activeNow !== windowActiveWorkspaceId

      if (chat.send && !movedWorkspace && workspaceRoot) {
        // R4, kept: a general agent with the skills attached and the prompt as its
        // startup prompt, which is the launch path that SENDS.
        //
        // THE CHOSEN ROW WINS OUTRIGHT (R4b, item 2473). Its cli, its model and
        // its effort are one answer and are handed over as one: nothing here takes
        // the runtime from one source and the model from another. The hand-off's
        // own `cli` — the one a card's `require.cli` named — is not consulted,
        // because it is not a second opinion about the launch: a card's skills are
        // installed into every skills-capable harness on the machine
        // (`resolveInstalledSkillHarnesses`), so `require.cli`'s job is to fail a
        // card whose CLI is missing, not to overrule the person's pick. Splitting
        // the two is how a Codex model id used to ride a Claude Code launch.
        //
        // Those three are passed rather than read back out of the remembered
        // defaults, because the picker deliberately writes none of them: choosing
        // how to run one card must not move the engine of the person's next New
        // chat. The row's fourth axis, its preset, is NOT passed — it is stored
        // against (cli, model) and the spawn re-reads it from the pair it is
        // handed here, so it arrives without being carried.
        closeGlobalSurface()
        closeModalSurface()
        void addNewCliAgent(
          launch.cli,
          skills,
          undefined,
          launch.model,
          { prompt: chat.prompt },
          { reasoning: launch.reasoning },
        )
        if (switchedAway) {
          // Not silently, and not by dragging them back: the agent is running in
          // the project the card set up, and the least this can do is say which.
          const landed = useWorkspaceStore
            .getState()
            .workspaces.find((workspace) => workspace.id === windowActiveWorkspaceId)
          showToast({
            tone: 'neutral',
            title: `${card.title} started in ${landed?.name ?? 'the project you pressed Go in'}`,
            description:
              'You moved to another project while it was setting up, so the chat opened where the card installed.',
          })
        }
        return
      }
      // Three cases land here, and all three go through the New chat door. Two of
      // them used to arrive with no explanation at all — a prompt sitting in a
      // composer, and nothing on screen saying why it had not been sent.
      //
      // `send: false` is the card saying so, and the composer is where a prompt
      // waits for somebody to press Start. That one needs no line.
      //
      // A `clone.repo` that moved the workspace is the second, and it is a limit
      // rather than a choice: `addNewCliAgent` spawns into the ACTIVE workspace,
      // and the clone is not one yet — this app makes a folder into a project
      // through the New chat door (`cloneNewChatProject` above does exactly this
      // with the same folder). Spawning into the workspace the person happened to
      // be in would run the card's prompt against the wrong repository, which is
      // worse than a prompt that waits one press.
      //
      // No project open at all is the third: `addNewCliAgent` early-returns
      // without one, so a card whose only action is `open.chat` pressed on a
      // fresh install closed the door and did nothing whatsoever.
      //
      // The row the person picked RIDES THE DRAFT, because nothing else carries
      // it: the picker writes no defaults (R4b, item 2473 — a card must not move
      // the engine of the next New chat), and a draft already holding a selection
      // wins over the panel's own, so a person who had picked a row
      // before pressing Go would have come back to New chat standing on it and
      // launched its engine rather than the row they had just chosen. The draft
      // says both: a general agent, on this engine. It carries what only the
      // CARD knows besides — the prompt and the skills.
      openNewChatPanel(chatRoot ?? undefined)
      writeNewChatDraft(workspaceWindowId, {
        prompt: chat.prompt,
        skills,
        selection: { kind: 'general' },
        engine: { cli: launch.cli, model: launch.model, reasoning: launch.reasoning },
      })
      if (chat.send) {
        showToast({
          tone: 'neutral',
          title: `${card.title} is ready`,
          description: movedWorkspace
            ? 'The clone is not a project yet, so the prompt is waiting in New chat — press Start and it runs in the clone.'
            : 'There is no project open, so the prompt is waiting in New chat — choose a folder and press Start.',
        })
      }
    },
    [
      addNewCliAgent,
      closeGlobalSurface,
      closeModalSurface,
      openGlobalSurface,
      openNewChatPanel,
      upsertMcpServer,
      windowActiveWorkspaceId,
      workspaceWindowId,
    ],
  )

  // The Extensions door's host-action seam: the door is a
  // zero-prop registered surface, so the shell's three connector routes are
  // registered into the extensionsSurfaceHost singleton instead of riding
  // props the way the retired modal's did. Registered once; the delegates read
  // the latest handlers through a render-refreshed ref so they never go stale.
  const extensionsHostRef = useRef<ExtensionsSurfaceHostPorts | null>(null)
  extensionsHostRef.current = {
    onLaunchConnector: (connector) => {
      // "New chat" on a connector opens the composer with it already attached,
      // rather than auto-spawning: the user still picks the agent, CLI, and
      // model. openNewChatPanel closes the door itself (the door's own contract).
      openNewChatPanel(undefined, connector)
    },
    onUseSkillInNewAgent: (skill) => {
      // "Use in agent → New agent…" on an installed skill row: an agent on the
      // remembered default CLI, with the skill ensure-installed and its
      // invocation prefilled. addNewCliAgent targets the active workspace's
      // layout, so the hosting surface — the Plugins modal, or a door in the
      // no-host fallback — must close first or the new tab lands behind it.
      closeGlobalSurface()
      closeModalSurface()
      void addNewCliAgent(resolveTemplateAgentCli(null, lastSelectedCli, agentCliCatalog), [skill])
    },
    onRunCard: (card, launch) => runCardGo(card, launch),
    onUseInAutomation: () => {
      // The route to author a connector automation is the Automations door
      // (Extensions drawer ruling, 2026-09-05; a modal before that); the
      // connector pre-selection lands in T8. Plugins is itself a door, so the
      // hop is door→door and the card region simply changes hands. The button
      // renders whether or not the module is on, and the door host resolves a
      // disabled module to the not-installed explainer — say so rather than let
      // the click land silently.
      if (!selectModuleEnabled(moduleEnablement, 'automations')) {
        showToast({
          tone: 'warn',
          title: 'Automations is turned off',
          description: 'Turn the Automations module on in Settings → Modules to use a connector in an automation.',
        })
        return
      }
      openGlobalSurface('automations')
    },
  }
  useEffect(() => {
    setExtensionsSurfaceHost({
      onLaunchConnector: (connector) => extensionsHostRef.current?.onLaunchConnector(connector),
      onUseInAutomation: (serverId) => extensionsHostRef.current?.onUseInAutomation(serverId),
      onUseSkillInNewAgent: (skill) => extensionsHostRef.current?.onUseSkillInNewAgent(skill),
      onRunCard: (card, launch) => extensionsHostRef.current?.onRunCard(card, launch) ?? Promise.resolve(),
    })
    return () => setExtensionsSurfaceHost(null)
  }, [])

  // The terminal pane's star: "find a skill or plugin, for THIS agent". The
  // palette's open state has to live here — the shortcuts that raise it fire
  // while it is unmounted — and the pane is eight components down, so the
  // request arrives as an event rather than as a prop threaded through every
  // pane between them (components/palette/paletteOpenRequest.ts).
  useEffect(
    () =>
      subscribePaletteOpenRequest((request) => {
        setPaletteScope(request.scope ?? 'all')
        setPaletteTarget(request.target ?? null)
        setShowPalette(true)
        setSessionsOpen(false)
        setViewMenuOpen(false)
        setNotificationsOpen(false)
      }),
    [],
  )

  // "Hand to agent" on a Backlog item (backlogHandoffHost). The item's detail
  // pane is mounted by BOTH the workspace panel and the Backlog door, and
  // neither of them creates agents — the shell does, so the route is registered
  // here and the button reads it at click time.
  //
  // The chat is scoped to the ITEM'S OWN project, never the active workspace: an
  // item handed off from the Backlog door — which lists every open project at
  // once — has to land where its own repo is. Lifecycle is untouched, exactly as
  // `backlog.work` and the drag-drop handoff leave it: the Backlog skill's
  // contract owns status, and all this does is start the agent and record who is
  // working the item.
  const handBacklogItemToAgent = useCallback(
    async (request: BacklogHandoffRequest) => {
      // Install the Backlog skill into the CLI's harness dir BEFORE the launch, so
      // the invocation resolves when it lands (backlog.work's own order). A
      // refused install is not fatal — the prompt falls back to the plain-language
      // lifecycle block, which needs nothing on disk.
      const ensured = await ensureSkillForAgent({
        workspaceRoot: request.workspaceRoot,
        skill: { id: BACKLOG_SKILL_ID },
      })
      const prompt = backlogHandoffPrompt({
        relativePath: request.relativePath,
        integration: ensured.ok
          ? pluginCatalogEntries.find((entry) => entry.id === request.cli)?.skillIntegration
          : undefined,
      })
      const started = createNewChat(request.workspaceRoot, request.cli, undefined, prompt, undefined, request.model)
      // A launch that never happened (no installed CLI, missing solo template) has
      // already said so through its own route; there is no agent to link to.
      if (!started) return
      await recordBacklogAgentHandoff({
        workspaceId: started.workspaceId,
        workspaceRoot: request.workspaceRoot,
        agentId: started.agentId,
        relativePath: request.relativePath,
        title: request.title,
      })
    },
    [createNewChat, pluginCatalogEntries],
  )
  useEffect(() => {
    setBacklogHandoffHost({ handToAgent: handBacklogItemToAgent })
    return () => setBacklogHandoffHost(null)
  }, [handBacklogItemToAgent])

  // The panel's project chip: distinct folders across this window's open
  // workspaces, in rail order. Browse admits a folder the studio doesn't know.
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
  // The New-chat selector's Import-from-Git clone lives HERE, not in the
  // selector (remote-sessions-ux / project-selector-sources): a clone that
  // finishes after the selector closed used to call `onSelect` into an
  // unmounted panel and the project was never adopted. The host outlives the
  // popover, so success always lands — the panel is reopened on that project
  // if it was closed meanwhile — and the toast names what arrived.
  const cloneNewChatProject = useCallback(
    async (input: {
      url: string
      parentDir: string
      folderName: string
    }): Promise<{ ok: true; path: string } | { ok: false; message: string }> => {
      const cloned = await window.api
        .cloneGitHubRepo(input)
        .catch((caught: unknown): { ok: false; message: string } => ({
          ok: false,
          message: caught instanceof Error ? caught.message : 'Could not clone the repository.',
        }))
      if (!cloned.ok) return cloned
      setNewChatPanelState((prev) =>
        prev
          ? { ...prev, folderPath: cloned.path, folderLabel: newChatFolderLabel(cloned.path) }
          : { folderPath: cloned.path, folderLabel: newChatFolderLabel(cloned.path), connector: null },
      )
      showToast({
        tone: 'good',
        title: `Cloned ${newChatFolderLabel(cloned.path)}`,
        description: `${cloned.path} — selected in New chat.`,
      })
      return { ok: true, path: cloned.path }
    },
    [],
  )
  // Switching workspaces parks the pre-creation panel: the user has moved on,
  // and the panel would otherwise sit over the newly revealed workspace. The
  // draft stays parked — Forward, or the next New chat, resumes it.
  useEffect(() => {
    setNewChatPanelState(null)
  }, [windowActiveWorkspaceId])
  // So does opening a door. Left mounted under the door's inert canvas the
  // panel kept its window-level Escape listener, and Escape meant to leave the
  // door closed the panel ON PURPOSE instead — draft gone, door still up.
  // Parked, it comes back through history (Back from the door lands on it).
  useEffect(() => {
    if (activeGlobalSurfaceEntry) setNewChatPanelState(null)
  }, [activeGlobalSurfaceEntry])
  // Map the composer's confirm to the existing new-chat spawn handlers (which
  // persist lastNewChatAgent and seed the solo workspace), then close the panel.
  // `folderPathOverride` is the project the door's own selector picked;
  // omitting it falls back to the panel's scope.
  // One confirm at a time: minting a worktree takes real seconds on a large
  // repo (copyIncludedFiles), and a second Enter during that window used to
  // mint a second worktree and a second chat.
  const newChatConfirmInFlight = useRef(false)
  const confirmNewChat = async (
    confirm: AgentComposerConfirm,
    folderPathOverride?: string | null,
    startupPrompt?: string,
  ) => {
    if (newChatConfirmInFlight.current) return
    newChatConfirmInFlight.current = true
    try {
      await confirmNewChatNow(confirm, folderPathOverride, startupPrompt)
    } finally {
      newChatConfirmInFlight.current = false
    }
  }
  const confirmNewChatNow = async (
    confirm: AgentComposerConfirm,
    folderPathOverride?: string | null,
    startupPrompt?: string,
  ) => {
    const scopedFolder = folderPathOverride !== undefined ? folderPathOverride : (newChatPanelState?.folderPath ?? null)
    // An agent asked for a worktree starts IN it: the folder becomes the
    // worktree and the marker rides along. A worktree that cannot be made
    // leaves the door open with the diagnostic, never a chat in the checkout.
    let folderPath = scopedFolder
    let worktree: WorkspaceWorktree | undefined
    if (confirm.kind === 'general' && confirm.worktree) {
      const made = await createNewChatWorktree(scopedFolder, confirm.worktree.name)
      if (!made) return
      folderPath = made.folderPath
      worktree = made.worktree
    }
    switch (confirm.kind) {
      case 'terminal':
        pickNewChatTerminal(folderPath)
        break
      // MCP picks were synced into the workspace's CLI config on pick
      // (SkillsAndMcpsPicker), so the spawn has nothing to route: the agent
      // starts in the workspace and finds them there. The isolated connector
      // worktree runtime is no longer a New chat path.
      case 'general':
        pickNewChatGeneral(
          confirm.cli,
          folderPath,
          confirm.skills,
          startupPrompt,
          worktree,
          confirm.model,
          confirm.reasoning,
        )
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
  // A session on a paired machine, opened from the sidebar's Remote band
  // (remote-sessions-in-the-sidebar): the row that already is that session
  // is focused; any other becomes a solo workspace whose lone pane is the
  // fleet attachment — the same shape a chat started over there takes,
  // minus the create. Provenance is stamped with the session id so the band
  // recognises the row next time it reads the machine.
  const openRemoteSession = useCallback(
    (spec: RemoteSessionOpenSpec): void => {
      setNewChatPanelState(null)
      if (spec.attachedWorkspaceId) {
        setActiveWorkspaceForWindow(workspaceWindowId, spec.attachedWorkspaceId)
        return
      }
      if (!SOLO_CHAT_TEMPLATE) {
        showToast({
          tone: 'error',
          title: `Could not open ${spec.title} from ${spec.machineName}`,
          description: 'The Solo layout template is missing.',
        })
        return
      }
      addWorkspace(SOLO_CHAT_TEMPLATE, {
        // The CHAT's name over there, not the agent's (owner, 2026-09-13). This
        // used to read `${spec.title} · ${spec.workspaceName}` — an agent's name
        // in front of every remote row, so a sidebar of chats read as a sidebar
        // of strangers. The agent's name survives where it belongs: the tab, and
        // its line's mark on the row.
        name: remoteWorkspaceName(spec.title, spec.workspaceName),
        folderPath: null,
        remoteOrigin: {
          connectionId: spec.connectionId,
          machineName: spec.machineName,
          workspaceId: spec.workspaceId ?? spec.sessionId,
          workspaceName: spec.workspaceName ?? '',
          workspaceRoot: spec.workspaceRoot,
          sessionId: spec.sessionId,
          repository: spec.repository,
          // The checkout as the machine listed it; this device never moves it.
          checkout: { mode: 'current', branch: spec.branch, worktreePath: null },
        },
        windowId: workspaceWindowId,
        seedAgent: {
          tabName: fleetTerminalTabName(spec.machineName, spec.title),
          fleet: {
            connectionId: spec.connectionId,
            machineName: spec.machineName,
            remoteSessionId: spec.sessionId,
          },
        },
      })
    },
    [addWorkspace, setActiveWorkspaceForWindow, setNewChatPanelState, workspaceWindowId],
  )

  const confirmRemoteNewChat = useCallback(
    async (launch: RemoteNewChatLaunch): Promise<void> => {
      const created = await window.api
        .fleetCreateTerminal({
          connectionId: launch.connectionId,
          workspaceId: launch.remoteWorkspaceId,
          cli: launch.cli,
          prompt: launch.prompt || undefined,
          cliModel: launch.cliModel ?? undefined,
          permissionPreset: launch.permissionPreset === 'none' ? undefined : launch.permissionPreset,
          // The checkout choice (checkout-and-branch-on-remote-create): a
          // worktree is minted THERE by the remote's own agent.launch, and its
          // refusal — a pairing without workspace:operate — comes back verbatim.
          checkout: launch.checkout,
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
          description: `The Solo layout template is missing. "${created.title}" is listed under Remote in the sidebar.`,
        })
        closeNewChatPanel()
        return
      }
      addWorkspace(SOLO_CHAT_TEMPLATE, {
        // The chat's name over there, same rule as `openRemoteSession`.
        name: remoteWorkspaceName(created.title, launch.remoteWorkspaceName),
        // No local checkout: the code lives on the other machine, and a local
        // folder here would claim otherwise. Where it DOES live is the
        // workspace's provenance, stamped once so the sidebar can group and
        // badge it by machine after this pane is long closed.
        folderPath: null,
        remoteOrigin: {
          connectionId: launch.connectionId,
          machineName: launch.machineName,
          workspaceId: launch.remoteWorkspaceId,
          workspaceName: launch.remoteWorkspaceName,
          workspaceRoot: launch.remoteWorkspaceRoot,
          // The session the pane attaches to: how the sidebar's Remote band
          // knows the row the machine lists is this one.
          sessionId: created.sessionId,
          // Which repository that is, as the machine served it (kept for New
          // chat's "Run on", which filters machines by project).
          repository: launch.remoteRepository,
          // What the chat landed on: the worktree's branch as the remote minted
          // it, or the checkout's branch as the panel read it before asking.
          checkout: {
            mode: created.checkout.mode,
            branch: created.checkout.branch ?? launch.branch,
            worktreePath: created.checkout.worktreePath,
          },
        },
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
      const landedBranch = created.checkout.branch ?? launch.branch
      showToast({
        tone: 'good',
        title: `Started on ${launch.machineName}`,
        description:
          created.checkout.mode === 'worktree'
            ? `${created.title} in ${launch.remoteWorkspaceName}, on a new worktree${landedBranch ? ` (${landedBranch})` : ''}`
            : `${created.title} in ${launch.remoteWorkspaceName}${landedBranch ? ` · ${landedBranch}` : ''}`,
      })
    },
    [addWorkspace, closeNewChatPanel, workspaceWindowId],
  )

  // Optional workspaceId targets a single workspace's panel. The mode-scoped
  // panels ignore it, but the Git panel (which can be mounted in several
  // background workspaces at once) uses it so a destructive command like commit
  // only runs in the active workspace's repo, never a stale background one.
  const dispatchPanelCommand = useCallback((id: string, workspaceId?: string) => {
    dispatchPanelCommandEvent(id, workspaceId)
  }, [])

  const runCommand = useCallback(
    (commandId: string): boolean => {
      if (commandId === 'app.settings.open') {
        openSettings(false)
        return true
      }
      if (commandId === 'app.updates.check') {
        // Updates folded into the General tab; land there and run the check.
        openSettings(true, 'general')
        return true
      }
      // ⌘K, Shift Shift and ⌘⇧F raise the same overlay and dismiss the same
      // competing surfaces; they differ only in the scope it opens filtered to
      // (and, for the first two, not even that — they are separate commands so
      // they are separately rebindable). Sharing the branch is what keeps them
      // from drifting into three slightly different "open the palette" behaviours.
      if (
        commandId === 'commandPalette.open' ||
        commandId === 'search.everywhere' ||
        commandId === 'search.files.open'
      ) {
        setPaletteScope(commandId === 'search.files.open' ? 'text' : 'all')
        // A keyboard-raised palette belongs to no pane: whatever the star last
        // aimed it at must not silently steer this one.
        setPaletteTarget(null)
        setShowPalette(true)
        setSessionsOpen(false)
        setViewMenuOpen(false)
        setNotificationsOpen(false)
        return true
      }
      if (commandId === 'diagnostics.open') {
        setDiagnosticsOpen(true)
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
              // "Mirrors the mount" has to mean the mount's OWN resolution, not
              // the registry alone: the Extensions home is core and resolves from
              // the app (CORE_EXTENSIONS_HOME_SURFACE), so a registry-only
              // predicate found nothing and Back/Forward stepped straight past
              // the one door the rail's own glyph opens.
              if (entry.id === EXTENSIONS_HOME_SURFACE_ID) return true
              const surface = getRendererHost().getGlobalSurface(entry.id)
              return surface !== undefined && selectModuleEnabled(moduleEnablement, surface.moduleId)
            }
            // The New chat door is a place (new-chat-survives-back-and-forward):
            // reachable while it is not the one showing AND something is parked
            // there — after × or a launch there is nothing to return to, and an
            // empty New chat is not a place worth a Back. It needs no workspace;
            // it opens over the empty stage too.
            if (entry.kind === 'new-chat') {
              return !newChatPanelOpen && newChatDraftHasContent(readNewChatDraft(workspaceWindowId))
            }
            // A workspace entry is the current location only when nothing
            // overlays it; otherwise Back from a door — or from New chat — to its
            // own underlying workspace is valid.
            if (!activeGlobalSurface && !newChatPanelOpen && entry.id === windowActiveWorkspaceId) return false
            // Assignment, not rail membership: history holds places the operator
            // actually visited, and a rail-hidden workspace (the automations
            // host) is reached by explicit activation. Gating on the rail would
            // let Back reach its terminals but never Forward.
            return visibleWorkspaceIdSet.has(entry.id)
          },
        )
        if (!step) return false
        workspaceNavigationHistoryRef.current = step.history
        if (step.entry.kind === 'new-chat') {
          // Reopen on the parked draft (openNewChatPanel closes any door itself).
          openNewChatPanel()
          return true
        }
        // Stepping off New chat parks it — explicitly, because Back to the very
        // workspace it sits over changes no workspace id and would otherwise
        // leave the panel showing. Opening the door sets the surface without
        // touching the underlying workspace; activating a workspace clears any
        // open door as a side effect.
        setNewChatPanelState(null)
        if (step.entry.kind === 'surface') {
          const entry = step.entry
          const surface = getRendererHost().getGlobalSurface(entry.id)
          const view = entry.view ? surface?.views?.find((candidate) => candidate.id === entry.view) : undefined
          if (view) {
            // The entry names a view, so the step latches THAT view — the same
            // call the drawer row makes. Running `onOpen` here instead would
            // discard the latch it just needs, which is exactly how Back out of
            // Skills used to land on Plugins.
            view.open()
          } else {
            // A plain open — "the room I was in", not "the row I clicked" — so it
            // discards stale deep-link latches the way a rail glyph does. Without
            // this a latch left by a dispatch that never mounted could reroute
            // Back to a different view than the entry names.
            surface?.onOpen?.()
          }
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
        setActiveWorkspaceForWindow(workspaceWindowId, nextWorkspaceId)
        return true
      }
      if (commandId.startsWith('workspace.switch.')) {
        const workspaceIndex = Number(commandId.slice('workspace.switch.'.length)) - 1
        const workspace = railWorkspaces[workspaceIndex]
        if (!workspace) return false
        setActiveWorkspaceForWindow(workspaceWindowId, workspace.id)
        return true
      }
      if (commandId === 'layout.tab.next' || commandId === 'layout.tab.previous') {
        const step = commandId === 'layout.tab.previous' ? -1 : 1
        if (controlTabContextOf(document.activeElement) === 'extensions') {
          if (extensionsDrawerRows.length < 2) return true
          const focusedRowKey = controlTabContextItemOf(document.activeElement)
          const currentIndex = extensionsDrawerRows.findIndex((row) =>
            focusedRowKey ? row.key === focusedRowKey : row.active,
          )
          const nextIndex =
            currentIndex === -1
              ? step === 1
                ? 0
                : extensionsDrawerRows.length - 1
              : (currentIndex + step + extensionsDrawerRows.length) % extensionsDrawerRows.length
          extensionsDrawerRows[nextIndex]?.open()
          return true
        }
        if (cycleFocusedControlTabScope(document.activeElement, step)) return true
        if (!windowActiveWorkspaceId) return false
        return cycleActiveLayoutTab(windowActiveWorkspaceId, step)
      }
      if (commandId === 'layout.tab.close') {
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
        const open =
          useWorkspaceStore.getState().workspaces.find((w) => w.id === windowActiveWorkspaceId)?.paneState?.open ??
          false
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
      if (commandId === 'panel.canvas.toggle' && windowActiveWorkspaceId) {
        // The module guard mirrors the command's availability, so a binding that
        // outlived a module being turned off cannot mount a surface that is not
        // there.
        if (!selectModuleEnabled(moduleEnablement, 'canvas')) return false
        // The pane keeps whatever width the person last gave it: a new Canvas
        // tab opens docked like every other kind (owner ruling 2026-09-22), and
        // Maximise in the pane strip is one click away when a board wants room.
        togglePaneKind(windowActiveWorkspaceId, 'canvas')
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
      if (commandId === 'terminal.new') {
        addNewTerminal()
        return true
      }
      if (commandId === 'terminal.focus' && windowActiveWorkspaceId) {
        const session = terminalSessions.find(
          (item) => item.kind === 'terminal' && item.workspaceId === windowActiveWorkspaceId && item.terminalId,
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
      // Registry-backed panel-event commands: the registry names the event, so
      // the palette and a keybinding reach the same panel listener (a module's
      // ids and the chat view's model-picker toggle alike); module-contributed
      // ids were handled above.
      if (getCommandDefinition(commandId)?.handlerPath.kind === 'panel-event') {
        dispatchPanelCommand(commandId)
        return true
      }
      return false
    },
    [
      openSettings,
      openNewChatPanel,
      newChatPanelOpen,
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
      terminalSessions,
      moduleEnablement,
      dispatchPanelCommand,
      extensionsDrawerRows,
    ],
  )

  useEffect(() => {
    const dispatcherContext = (event: KeyboardEvent) => ({
      // The `terminal` scope is per-KEYSTROKE, not per-workspace: it is active
      // exactly when this key came from inside a terminal surface. Deriving it
      // from the event rather than from the active tab is what keeps ⌘F inside
      // a Monaco editor as Monaco's own find — the shell never claims a key it
      // did not receive from a terminal.
      activeScopes: isTerminalKeyTarget(event.target)
        ? [...activeCommandScopes, 'terminal' as const]
        : activeCommandScopes,
      commands: commandContributions,
      disabledCommandIds,
      keybindingOverrides: keybindingSettings?.overrides,
      availability: commandAvailability,
      moduleContext: moduleCommandContext,
      isSuppressedTarget: isGlobalShortcutSuppressedTarget,
      platform: (window.api.platform === 'darwin'
        ? 'darwin'
        : window.api.platform === 'win32'
          ? 'windows'
          : 'linux') as KeybindingPlatform,
    })

    const onKey = (event: KeyboardEvent) => {
      const result = commandDispatcherRef.current.resolve(event, dispatcherContext(event))
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

    // The release half of the lone-modifier double tap (Shift Shift). A tap is
    // only a tap once the key comes back up with nothing pressed in between,
    // so the gesture is decided on keyup; every other keyup falls through.
    const onKeyUp = (event: KeyboardEvent) => {
      const result = commandDispatcherRef.current.resolveKeyUp(event, dispatcherContext(event))
      if (result.kind !== 'matched') return
      if (runCommand(result.commandId)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    // Losing the window mid-gesture drops it: the keyup for a modifier released
    // while another app has focus never arrives here.
    const onBlur = () => commandDispatcherRef.current.reset()

    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
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
  // over the workspace it overlays (the door is what you're looking at), then
  // the New chat door over its workspace for the same reason, so opening or
  // leaving either is itself a visit. Resolves to null only before anything is
  // active.
  const currentNavLocation = useMemo<NavHistoryEntry | null>(() => {
    if (activeGlobalSurfaceEntry && activeGlobalSurface) {
      // The view is part of the location for a door that has views: the
      // Extensions door's three catalogues are three places, and a history
      // entry that named only the door could not step back into two of them.
      return { kind: 'surface', id: activeGlobalSurface, ...(activeSurfaceView ? { view: activeSurfaceView } : {}) }
    }
    if (newChatPanelOpen) return NEW_CHAT_NAV_ENTRY
    if (windowActiveWorkspaceId) return { kind: 'workspace', id: windowActiveWorkspaceId }
    return null
  }, [activeGlobalSurfaceEntry, activeGlobalSurface, activeSurfaceView, newChatPanelOpen, windowActiveWorkspaceId])

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
      // The New chat door is a history location of its own (its draft parks),
      // so the mouse buttons walk history through it like anywhere else.
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
        runCommand(definition.id)
        return
      }
      // Everything the app menu sends is a command id, resolved above. The
      // About item is the one exception: it opens Settings rather than running
      // a command, so it has no id to send.
      if (command === 'show-about') openSettings(false)
    })
  }, [openSettings, runCommand])

  useEffect(() => {
    const updates = MENU_ACCELERATOR_COMMAND_IDS.map((commandId) => ({
      commandId,
      accelerator: getElectronAccelerator(commandId, keybindingSettings),
    }))
    void window.api.updateAppMenuAccelerators(updates).catch(() => {})
  }, [keybindingSettings])

  // New chat opens on the General agent — the only agent a plain spawn has.
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
        // MCP picks were synced into the workspace's CLI config on pick; the
        // spawn carries only the skills to prefill. Model and effort ride the
        // confirm so the terminal starts on the chip, not a later defaults read.
        void addNewCliAgent(confirm.cli, confirm.skills, confirm.worktree, confirm.model, placement, {
          reasoning: confirm.reasoning,
        })
        break
      case 'conversation':
        spawnConversationAgent(confirm.skills, confirm.provider, placement)
        break
    }
  }

  // ── The tab strip's "+" ──────────────────────────────────────────
  // Opens the tab the agent will run in. Standard workspaces only: a module's
  // workspace type (the automations host) runs its own agents and would read a
  // hand-spawned terminal in that strip as one of its own.
  const canOpenNewAgentTab = Boolean(windowActiveWorkspaceId) && activeWorkspace?.mode === 'standard'

  const openNewAgentTab = (hostTabsetId?: string) => {
    if (!canOpenNewAgentTab || !windowActiveWorkspaceId) return
    // Named now, not at spawn: the tab is a terminal-in-waiting and carries the
    // name the agent will take. The strip whose "+" was clicked is the host —
    // a new tab in that panel, not a split beside it.
    const taken = Object.values(activeWorkspace?.agents ?? {}).map((agent) => agent.name)
    addNewAgentTab(windowActiveWorkspaceId, pickRandomAgentName(taken), hostTabsetId)
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
      setAuthState(
        await window.api.authGetState().catch(() => ({
          ...authState,
          status: 'error' as const,
          message,
        })),
      )
      publishDiagnosticSync({
        level: 'error',
        source: 'auth',
        title: 'Sign-in did not open',
        message,
        // Provider-agnostic on purpose: the message the adapter threw
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
    // A session row can carry an agentId that has no workspace.agents record;
    // updateAgent would fabricate one and focusOrAddAgentTab would open a pane
    // for it. For those rows activation is plain workspace focus only.
    //
    // A review guide is the opposite case: it is an ordinary agent terminal
    // that main spawned without this window's knowledge, so it has no record
    // until something adopts it. Opening it from here IS that adoption — the
    // same one the Reviews door performs — and without it the reviewer lands in
    // the Reviews host with no tab.
    const agentId =
      item.agentId &&
      (workspace.agents[item.agentId] || getRendererHost().getAgentIdNamespace(item.agentId, moduleEnabled))
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
    // Guarded like openSession: a detached row's agentId has no
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
    label: (typeof MENU_BAR_ITEMS)[number],
  ) => {
    const rect = event.currentTarget.getBoundingClientRect()
    await window.api.showMenubarMenu(label, {
      x: rect.left,
      y: rect.bottom + 4,
    })
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[color:var(--bg-canvas)] text-[color:var(--text-strong)]">
      {workspaceTypeSupervisors.map((supervisor) => (
        <WorkspaceTypeSupervisorHost key={supervisor.key} supervisor={supervisor} />
      ))}
      {automationsEnabled && ownsGlobalSupervisors ? <AutomationsRunSupervisor /> : null}
      {/* The one toast region (design-system/components/toast) + its app-level
          producers. Fixed-position; its place in this tree carries no layout. */}
      <React.Suspense fallback={null}>
        <ToastHost />
      </React.Suspense>

      <div className="relative flex min-h-0 flex-1 flex-row">
        {/* The app rail (app shell, 2026-09-05): the window's far-left
          column of section glyphs. It stays put whether the sidebar beside it
          is expanded, collapsed, or taken over by a door's rail, and it carries
          the account + Settings cluster at its foot. */}
        <AppRail
          section={sidebarSection}
          onSelectSection={selectSidebarSection}
          badges={railBadges}
          surfaces={railSurfaces}
          activeGlobalSurface={activeGlobalSurface}
          onOpenSurface={openRailSurface}
          accountSlot={
            <SidebarAccountBar
              collapsed
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
          }
        />
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
          onUnseenDoneChange={setUnseenDoneIds}
          onSnoozedWorkspacesChange={setSnoozedWorkspaceIds}
          onOpenRemoteSession={openRemoteSession}
          onSelectWorkspace={(id) => {
            // Park explicitly: selecting the very workspace New chat sits over
            // changes no workspace id, and the id-keyed park would not fire.
            setNewChatPanelState(null)
            setActiveWorkspaceForWindow(workspaceWindowId, id)
            setSidebarSection('home')
          }}
          onMoveWorkspaceToNewWindow={(id, placement) => void moveWorkspaceToNewWindow(id, placement)}
          onMoveWorkspaceToMainWindow={moveWorkspaceToPrimaryWindow}
          onCloseWorkspace={closeWorkspaceById}
          onForgetFolder={handleForgetFolder}
          onNewChat={() => openNewChatPanel()}
          onNewChatInFolder={(folderPath) => openNewChatPanel(folderPath)}
          onRevealFolder={handleRevealFolder}
          onSetSidebarCollapsed={setSidebarCollapsed}
          sidebarWidth={sidebarWidth}
          onSetSidebarWidth={setSidebarWidth}
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
              captionReserve={paneOwnsCaptionCorner ? 0 : windowCaptionReserve(window.api.platform === 'darwin')}
              isFullScreen={windowState.isFullScreen}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => runCommand('workspace.sidebar.toggle')}
              onOpenSearch={() => runCommand('commandPalette.open')}
              onNewChat={() => openNewChatPanel()}
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
              onOpenDiagnostics={
                window.api.isDevelopment || window.api.isDiagnosticsEnabled ? () => setDiagnosticsOpen(true) : null
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
          app-level chrome (sidebar left, pane right). The pane column's inner
          hairline is gone (workspaceAsideColumn): the 4px gap between the two
          cards does the separating now, so the card still draws no border.
          The TOP corners round too: the header above no longer paints the card's
          colour under glass, so the card's top edge is real geometry rather than
          a seam inside one slab, and a square corner there reads as a slab
          jammed under the bar. `overflow-hidden` stays — it is what clips the
          door surface to the card.

          It paints NO ground of its own any more. Inside it every FlexLayout
          tabset is its own --bg-surface card, so with one terminal the region
          looks exactly as it did, and with a split the frost shows down the
          splitter between them instead of a dark rule. A ground here would sit
          in that gap and there would be nothing to see through.

          `mb-[--shell-card-gap]` is the bottom inset: the card's bottom corners
          have been rounded for a long time with nothing to show against,
          because the card sat flush on the window's edge. 4px — the same token
          as every other gap in the shell, deliberately NOT an oversized
          band, which is mostly that app's status bar.

          All four corners round unconditionally now. What `paneOwnsRightEdge`
          still decides is the right-edge GAP: with the pane open the pane card
          brings its own left margin, so a margin here too would double it to
          8px beside 4px everywhere else; with the pane closed this card owns
          the window's right edge and takes the gap itself.

          It reads `paneOwnsRightEdge`, the one-field selector off the live
          store, which is what the caption-reserve logic already uses. (The
          workspace projection used to skip `paneState` in its equality check,
          so a flag derived from it never flipped after first render; the
          check compares it now, but a subscription to one boolean is still
          the right size for one boolean.) */}
              <div
                className={`flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--shell-card-radius)] mb-[var(--shell-card-gap)] ${
                  paneOwnsRightEdge ? '' : 'mr-[var(--shell-card-gap)]'
                }`}
              >
                {/* The workspace identity + control groups live in the WorkspaceHeader
          above this card (WorkspaceIdentity / WorkspaceActions slots), so the
          card opens directly with content. */}
                <div className="relative min-h-0 flex-1">
                  <div
                    className="absolute inset-0"
                    aria-hidden={activeGlobalSurfaceEntry !== null || undefined}
                    {...(activeGlobalSurfaceEntry !== null ? ({ inert: '' } as Record<string, string>) : {})}
                  >
                    <>
                      {railWorkspaces.length === 0 && !activeWorkspace && (
                        <EmptyState onNew={() => openNewChatPanel()} />
                      )}
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
                            {/* New chat opens the SAME launch surface the tab
                        strip's "+" opens. One shell, two destinations — here it
                        creates a solo workspace in the picked project rather
                        than retyping a tab. The composer seeds its connector
                        attachment on mount, so a connector "New chat" over an
                        open panel must remount; keyed on identity, so removing
                        the chip never does. */}
                            <NewAgentPanel
                              key={newChatPanelState.connector?.id ?? 'plain'}
                              initialMcpServers={newChatPanelState.connector ? [newChatPanelState.connector] : null}
                              workspaceId={windowActiveWorkspaceId ?? ''}
                              conversationAvailable={conversationSpawnAvailable}
                              onRequestConversationCatalog={requestConversationCatalog}
                              folderPath={newChatPanelState.folderPath}
                              projectOptions={newChatProjectOptions}
                              onSelectProject={selectNewChatProject}
                              onBrowseProject={() => void browseNewChatProject()}
                              initialSelection={lastNewChatAgent ?? { kind: 'general' }}
                              permissionPreset={agentSpawnPermissionPreset}
                              debugMode={agentSpawnDebugMode}
                              onChangeDebugMode={setAgentSpawnDebugMode}
                              onLaunch={({ prompt, ...confirm }) => {
                                // confirmNewChat closes the panel (and forgets the draft) itself.
                                void confirmNewChat(confirm, newChatPanelState.folderPath, prompt)
                              }}
                              // The promise itself, not a void wrapper: the panel's
                              // one-launch-at-a-time guard waits on it, and a wrapper
                              // returning undefined released the guard a microtask later.
                              onLaunchRemote={confirmRemoteNewChat}
                              onCloneProject={cloneNewChatProject}
                              onClose={closeNewChatPanel}
                              // The parked draft lives per window; the panel seeds
                              // from it and writes through, the host clears it.
                              draftKey={workspaceWindowId}
                              // The door has no tab to close, so the surface carries the
                              // control itself.
                              showCloseButton
                            />
                          </React.Suspense>
                        </div>
                      ) : null}
                    </>
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
            the workspace shows through. Automations, Design and Plugins are
            doors again (Extensions drawer ruling, 2026-09-05); Settings and
            Reviews stay modals in the mount below. The Diff popout is not on
            that list any more: the diff opens in its own OS window or in the
            pane's Diff tab, and the in-app modal went with the epic (T3). */}
                  {/* Surface, not canvas: a door is a working page, so it paints
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
                        <ContextRailSlotContext.Provider value={surfaceLiftsRail ? surfaceRailSlot : null}>
                          {/* The door's bar chevron leaves through here, so it restores the
                  keyboard to the row that opened the door exactly as Escape does. */}
                          <SurfaceExitContext.Provider value={surfaceExit}>
                            {/* A door failure stays a door failure: render/import
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
            while anything else owns the region — a door, the New chat door, the new
            chat panel — so it lands on a workspace the user has already reached
            rather than competing with the thing they opened. On a fresh profile
            nothing else has the region: the hub's auto-open waits for this
            question to be answered or dismissed first. */}
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
            the element that opened it. Settings and Reviews live here —
            pick-and-close tasks over work that stays put; every
            destination the shell's own chrome offers is a door in the mount
            above (Extensions drawer ruling, 2026-09-05). With no bar/rail slot providers
            in scope, GlobalSurfaceShell renders its documented inline fallback
            — bar on top, aside rail beside the canvas — which is exactly the
            modal-interior anatomy. */}
                  {activeModalSurfaceEntry ? (
                    <Modal
                      // Keyed by surface id: swapping one modal surface for another must
                      // remount the Modal so its FocusTrap and initial-focus effect
                      // re-run — an in-place body swap dropped focus to <body>, outside
                      // the trap, with the background reachable on Tab.
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
                  door boundary): the fallback offers Close/Reload
                  inside the dialog instead of white-screening the renderer. */}
                          <GlobalSurfaceErrorBoundary
                            surfaceId={activeModalSurfaceEntry.id}
                            surfaceLabel={activeModalSurfaceEntry.label}
                            onClose={closeModalSurface}
                          >
                            <React.Suspense fallback={<SuspenseFallback label="Loading surface" />}>
                              <activeModalSurfaceEntry.Component
                                workspaceId={activeModalSurfaceWorkspaceId ?? undefined}
                              />
                            </React.Suspense>
                          </GlobalSurfaceErrorBoundary>
                        </SurfaceExitContext.Provider>
                      </ModalSurfaceFrame>
                    </Modal>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
          <React.Suspense fallback={null}>
            <WorkspacePaneColumn
              activeWorkspaceId={windowActiveWorkspaceId}
              renderedWorkspaceIds={renderedWorkspaceIds}
            />
          </React.Suspense>
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
            onClose={() => {
              setShowPalette(false)
              setPaletteTarget(null)
            }}
            onRunCommand={runCommand}
            onOpenRemoteConnections={() => openSettings(false, 'remote')}
            workspaceWindowId={workspaceWindowId}
            workspaces={visibleWorkspaces}
            activeWorkspaceId={windowActiveWorkspaceId}
            activeScopes={activeCommandScopes}
            commandAvailability={commandAvailability}
            moduleCommandContext={moduleCommandContext}
            initialScope={paletteScope}
            preferredTarget={paletteTarget}
          />
        </React.Suspense>
      )}
    </div>
  )
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

// The kit's EmptyState. This shipped in `--text-disabled` ink with a
// hand-rolled `rounded bg-…` button — a sentence meant to be read, greyed out as
// if it were a dead control, beside the one thing on screen you can actually do.
function EmptyState({ onNew }: { onNew: () => void }) {
  return <KitEmptyState title="No workspace open" action={<PrimaryButton onClick={onNew}>New chat</PrimaryButton>} />
}
