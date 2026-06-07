import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  selectSprintEngineView,
  useSprintEngineViewStore,
  type SprintEngineView,
} from '../../store/sprintEngineViewStore'
import {
 CloseIconButton,
 OverflowMenu,
 GhostButton,
 Popover,
 SidePane,
 StatusDot,
 Section,
 Select,
 Tabs,
 DefinitionList,
 type OverflowMenuItem,
 type TabItem,
 type Tone,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { Modal, ModalBody, ModalButton, ModalFooter } from '../ui/Modal'
import { SuspenseFallback } from '../ui/SuspenseFallback'
import { focusOrAddComponentTab } from '../../utils/modelRegistry'

// Lazy so the run-summary report (+ its charts) only loads with the Summary tab.
const SprintEngineRunSummaryPanel = React.lazy(() => import('./SprintEngineRunSummaryPanel'))
import {
 buildRunSummary,
} from '../../utils/sprintengineRunSummary'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import type {
 AgentCli,
 SprintEngineArtifact,
 SprintEngineAutomationMode,
 SprintEngineAutomationRuntimeState,
 SprintEngineCliPermissionPreset,
 SprintEngineRole,
 SprintEngineRoleId,
 SprintEngineRoleRegistry,
 SprintEngineState,
 SprintEngineTaskBoardColumn,
 Workspace,
} from '../../types/workspace'
import { SprintEngineRoleIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import {
 bracketedTerminalPaste,
 buildSprintEngineRoleRegistry,
 formatSprintEngineLockAge,
 getNextSprintEngineAgentId,
 getSprintEngineBoardRunPhase,
 getSprintEngineTaskBoardColumn,
 getSprintEngineTaskOwnerLabel,
 getSprintEngineRoleAccent,
 getUserDisabledSprintEngineRoleIds,
 normalizeSprintEngineProjection,
 getSprintEngineRoleLabel,
 sprintEngineTaskStateLabel,
} from '../../utils/sprintengine'
import {
 deriveSprintEngineAutomationMode,
 sprintEngineAutomationModeOptions,
 sprintEngineCliWatchPollingForAutomationMode,
} from '../../utils/sprintengineAutomation'
import { normalizeSprintEngineAutomationRuntimeState } from '../../utils/sprintengineAutomationLifecycle'
import { applySprintEngineAutomationStopReason } from '../../utils/sprintengineSupervisorNotifications'
import {
 publishSprintEngineAutomationModeNotification,
} from '../../utils/sprintengineNotifications'
import { findFirstUncoveredSprintEngineRole } from '../../utils/sprintengineRoleOptions'
import {
 buildSprintEngineRosterRevisionPrompt,
} from '../../utils/sprintenginePlanReviewPrompts'
import { normalizeAgentIdentifier } from '../../utils/agentPrompt'
import { focusOrAddAgentTab } from '../../utils/modelRegistry'
import { publishDiagnostic, publishDiagnosticSync } from '../../utils/diagnostics'
import {
 getEffectiveKeybindingLabel,
 platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'
import { isEditableTarget } from '../../utils/keyboard'
import {
 artifactTimestampMs,
 runtimeStatusLabel,
 type ArtifactActionState,
 type SprintEngineInspectorSelection,
} from './sprintEngineInspector'
import { SprintEngineInspectorPanel } from './SprintEngineInspectorPanel'
import { SprintEngineTaskGraphView } from './SprintEngineTaskGraphView'
import {
 SprintEngineInboxIcon,
 SprintEngineRosterNavIcon,
 SprintEngineSummaryNavIcon,
 SprintEngineTasksNavIcon,
} from './sprintEngineBoard/SprintEngineBoardIcons'
import { SprintEngineInboxView } from './sprintEngineBoard/SprintEngineInboxView'
import { SprintEngineRosterView } from './sprintEngineBoard/SprintEngineRosterView'
import { SprintEngineTasksKanbanView } from './sprintEngineBoard/SprintEngineTasksKanbanView'
import { useSprintEngineBoardModel } from './sprintEngineBoard/useSprintEngineBoardModel'
import { useSprintEngineBoardArtifactActions } from './sprintEngineBoard/useSprintEngineBoardArtifactActions'
import { useSprintEngineBoardTerminalActions } from './sprintEngineBoard/useSprintEngineBoardTerminalActions'



const cliOptions: Array<{ value: AgentCli; label: string; description: string }> = [
 { value: 'codex', label: 'Codex', description: 'OpenAI Codex CLI' },
 { value: 'claude-code', label: 'Claude Code', description: 'Claude Code CLI' },
]
const sprintEngineCliPermissionOptions: Array<{
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


interface Props {
 workspaceId: string
 fixedView?: SprintEngineView
 /** When a host pins the Tasks tab to a single layout (Graph or Kanban),
  *  this hides the inline switcher and locks the rendered layout to that
  *  choice. Used when Tasks is mounted as a standalone flex tab that
  *  should not expose the switcher. */
 fixedTasksLayout?: SprintEngineTasksLayout
}

type SyncState = {
 status: 'idle' | 'syncing' | 'live' | 'error'
 message: string
}

type PendingRosterMemberSpawn = {
 agentId: string
 role: SprintEngineRoleId
}

type SprintEngineTasksLayout = 'graph' | 'kanban'

type SpawnDialogState = {
 agentId: string
 cli: AgentCli
 name: string
}

type RecoveryDialogState = {
 cli: AgentCli
}

const sprintEngineAutomationRuntimeLabels: Record<SprintEngineAutomationRuntimeState, string> = {
 idle: 'Idle',
 running: 'Running',
 paused: 'Paused',
 blocked: 'Blocked',
 failed: 'Failed',
 complete: 'Complete',
}

const sprintEngineAutomationRuntimeTones: Record<SprintEngineAutomationRuntimeState, Tone> = {
 idle: 'neutral',
 running: 'good',
 paused: 'warn',
 blocked: 'warn',
 failed: 'error',
 complete: 'good',
}

function sprintEngineAutomationRuntimeActionLabel(
 runtimeState: SprintEngineAutomationRuntimeState,
): string | null {
 if (runtimeState === 'failed') return 'Retry'
 if (runtimeState === 'paused' || runtimeState === 'blocked') return 'Resume'
 return null
}

function SprintEngineSettingsPopover({
 automationMode,
 runtimeState,
 runtimeReason,
 cliPermissionPreset,
 onChangeAutomationMode,
 onResumeAutomation,
 onUpdateCliPreset,
 onVerifyProgress,
 onClose,
}: {
 automationMode: SprintEngineAutomationMode
 runtimeState: SprintEngineAutomationRuntimeState
 runtimeReason?: string
 cliPermissionPreset: SprintEngineCliPermissionPreset
 onChangeAutomationMode: (mode: SprintEngineAutomationMode) => void
 onResumeAutomation: (() => void) | null
 onUpdateCliPreset: (preset: SprintEngineCliPermissionPreset) => void
 onVerifyProgress: (() => void) | null
 onClose: () => void
}) {
 const containerRef = useRef<HTMLDivElement>(null)
 const restoreFocusElementRef = useRef<HTMLElement | null>(null)
 useEffect(() => {
 restoreFocusElementRef.current = document.activeElement instanceof HTMLElement
 ? document.activeElement
 : null
 const frame = window.requestAnimationFrame(() => {
 const first = containerRef.current?.querySelector<HTMLElement>(
 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
 )
 ;(first ?? containerRef.current)?.focus()
 })
 return () => {
 window.cancelAnimationFrame(frame)
 const trigger = document.querySelector<HTMLElement>('[aria-label="Sprint Engine overflow"]')
 ;(trigger ?? restoreFocusElementRef.current)?.focus()
 }
 }, [])
 const onPanelKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
 if (event.key !== 'Tab') return
 const focusable = containerRef.current?.querySelectorAll<HTMLElement>(
 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
 )
 if (!focusable || focusable.length === 0) return
 const list = Array.from(focusable)
 const first = list[0]
 const last = list[list.length - 1]
 if (event.shiftKey && document.activeElement === first) {
 event.preventDefault()
 last.focus()
 } else if (!event.shiftKey && document.activeElement === last) {
 event.preventDefault()
 first.focus()
 }
 }
 const currentPresetLabel =
 sprintEngineCliPermissionOptions.find((option) => option.value === cliPermissionPreset)?.label
 ?? cliPermissionPreset
 const runtimeActionLabel = sprintEngineAutomationRuntimeActionLabel(runtimeState)
 return (
 <div
 ref={containerRef}
 aria-label="Sprint Engine settings"
 tabIndex={-1}
 onKeyDown={onPanelKey}
 className="w-[280px] overflow-hidden py-1"
 >
 <Section
 title="Run"
 level={3}
 inset={true}
 >
 <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Sprint Engine automation mode">
 {sprintEngineAutomationModeOptions.map((option) => {
 const checked = option.value === automationMode
 return (
 <button
 key={option.value}
 type="button"
 role="radio"
 aria-checked={checked}
 onClick={() => onChangeAutomationMode(option.value)}
 className={`
 grid w-full grid-cols-[14px_minmax(0,1fr)] items-start gap-2 rounded-md border px-2.5 py-2 text-left
 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
 ${checked
 ? 'border-[color:var(--color-6)] bg-[color:var(--bg-surface-raised)]'
 : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-surface-raised)]'}
 `}
 >
 <span
 className={`mt-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border ${
 checked ? 'border-[color:var(--text-strong)] bg-[color:var(--text-strong)]' : 'border-[color:var(--color-6)]'
 }`}
 aria-hidden="true"
 >
 {/* design-tokens-allow: radio selected indicator, not a status dot */}
 {checked ? <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--bg-app)]" /> : null}
 </span>
 <span className="min-w-0">
 <span className={`block text-[12px] font-medium ${checked ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}>
 {option.label}
 </span>
 <span className="mt-0.5 block text-[11px] leading-4 text-[color:var(--text-muted)]">{option.hint}</span>
 </span>
 </button>
 )
 })}
 </div>
 <div className="mt-2 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-2">
 <div className="flex items-center gap-2">
 <StatusDot
 tone={sprintEngineAutomationRuntimeTones[runtimeState]}
 label={`Automation status: ${sprintEngineAutomationRuntimeLabels[runtimeState]}`}
 />
 <div className="min-w-0 flex-1">
 <div className="truncate text-[11px] font-medium text-[color:var(--text-default)]">
 {sprintEngineAutomationRuntimeLabels[runtimeState]}
 </div>
 {runtimeReason ? (
 <div className="mt-0.5 truncate text-[11px] text-[color:var(--text-muted)]">
 {runtimeReason}
 </div>
 ) : null}
 </div>
 {runtimeActionLabel && onResumeAutomation ? (
 <GhostButton
 onClick={() => {
 onResumeAutomation()
 onClose()
 }}
 >
 {runtimeActionLabel}
 </GhostButton>
 ) : null}
 </div>
 </div>
 </Section>
 <Section title="CLI permissions" level={3} inset={true}>
 <div className="flex flex-col gap-1.5">
 <div className="text-[11px] text-[color:var(--text-muted)]">
 Current:{' '}
 <span className="text-[color:var(--text-default)]">{currentPresetLabel}</span>
 </div>
 <Select<SprintEngineCliPermissionPreset>
 ariaLabel="CLI permission preset"
 items={sprintEngineCliPermissionOptions.map(({ value, label }) => ({ value, label }))}
 value={cliPermissionPreset}
 onChange={onUpdateCliPreset}
 />
 </div>
 </Section>
 {onVerifyProgress ? (
 <Section title="Verification" level={3} inset={true}>
 <GhostButton
 onClick={() => {
 onVerifyProgress()
 onClose()
 }}
 >
 Verify progress
 </GhostButton>
 </Section>
 ) : null}
 </div>
 )
}

export default function SprintEngineBoardPanel(props: Props) {
 const workspace = useWorkspaceStore(
 (s) => s.workspaces.find((w) => w.id === props.workspaceId) ?? null
 )

 if (!workspace?.sprintEngineState) {
 return (
 <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] text-sm text-[color:var(--text-disabled)]">
 Sprint Engine workspace data is missing.
 </div>
 )
 }

 return (
 <SprintEngineBoardPanelContent
 {...props}
 workspace={workspace}
 sprintEngineState={workspace.sprintEngineState}
 />
 )
}

function SprintEngineBoardPanelContent({
 workspaceId,
 fixedView,
 fixedTasksLayout,
 workspace,
 sprintEngineState,
}: Props & {
 workspace: Workspace
 sprintEngineState: SprintEngineState
}) {
  const setSprintEngineState = useWorkspaceStore((s) => s.setSprintEngineState)
  const setSprintEngineAutomationMode = useWorkspaceStore((s) => s.setSprintEngineAutomationMode)
  const applySprintEngineAutomationEvent = useWorkspaceStore((s) => s.applySprintEngineAutomationEvent)
  const setSprintEngineCliPermissionPreset = useWorkspaceStore((s) => s.setSprintEngineCliPermissionPreset)
 const addSprintEngineMember = useWorkspaceStore((s) => s.addSprintEngineMember)
 const updateAgent = useWorkspaceStore((s) => s.updateAgent)
 const openFile = useWorkspaceStore((s) => s.openFile)
 const setFolderPath = useWorkspaceStore((s) => s.setFolderPath)
 const lastSelectedCli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli)
 const sprintEngineRoleSettings = useWorkspaceStore((s) => s.appSettings.sprintEngineRoleSettings)
 const keybindingSettings = useWorkspaceStore((s) => s.appSettings.keybindings)
 const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
 const shortcutFor = useCallback((commandId: string): string | undefined => (
 getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform) ?? undefined
 ), [keybindingPlatform, keybindingSettings])
 // Select the stable notifications array and derive the run-activity list +
 // unread count with useMemo. Returning the filtered array straight from the
 // selector hands Zustand v5's useSyncExternalStore a fresh reference every
 // render, which trips its "getSnapshot should be cached" invariant and throws
 // inside the panel — see the perf follow-up plan. (countUnread returns a
 // primitive, so it never tripped this on its own, but it shares the source.)
 const disabledRoleIds = useMemo<ReadonlySet<SprintEngineRoleId>>(
   () => getUserDisabledSprintEngineRoleIds(sprintEngineRoleSettings),
   [sprintEngineRoleSettings],
 )
 const dialog = useConfirmDialog()
 const {
 folderPath: savedFolderPath,
 folderReadyPath,
 folderMissing,
 checkingFolder,
 message: folderStatusMessage,
 checkedPath: folderCheckedPath,
 recheckFolder,
 } = useWorkspaceFolderStatus(workspaceId)
 const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
 const [previewedArtifact, setPreviewedArtifact] = useState<{
 id: string
 path: string
 name: string
 content: string
 } | null>(null)
 // The inbox row → inspector binding. Set by SprintEngineProjectView when
 // the user clicks an inbox artifact. Cleared whenever task/agent
 // selection changes so the inspector lights up the most recent intent.
 const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
 // Switching tasks clears the artifact preview so the aside returns to
 // task detail. Opening an artifact does not change selectedTaskId, so
 // this only fires on a real navigation.
 useEffect(() => {
 setPreviewedArtifact(null)
 }, [selectedTaskId])
 useEffect(() => {
 if (selectedTaskId !== null) setSelectedArtifactId(null)
 }, [selectedTaskId])
 // Selecting a different inbox artifact clears any open document preview
 // so the inspector switches to the newly-selected artifact instead of
 // sticking on the previously-opened document.
 useEffect(() => {
 setPreviewedArtifact((current) =>
 current && current.id !== selectedArtifactId ? null : current,
 )
 }, [selectedArtifactId])
 // Active SE view is shared with the workspace top-bar segmented nav, so it
 // lives in a small persisted store keyed by workspace id rather than local
 // state. The `fixedView` prop still wins when WorkspaceLayout pins a view
 // through the defensive legacy renderers.
 const activeView = useSprintEngineViewStore((state) => selectSprintEngineView(state, workspaceId))
 const setSprintEngineView = useSprintEngineViewStore((state) => state.setView)
 const setActiveView = useCallback(
 (view: SprintEngineView) => setSprintEngineView(workspaceId, view),
 [setSprintEngineView, workspaceId],
 )
 // The Tasks tab carries an inline layout switcher (Graph / Kanban). The
 // selection is persisted across tab switches so jumping away and back
 // returns to the same layout. When the host pins a layout via
 // `fixedTasksLayout` the switcher is hidden and the pinned value wins.
 const [activeTasksLayout, setActiveTasksLayout] = useState<SprintEngineTasksLayout>('kanban')
 const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
 const [inspectorExpanded, setInspectorExpanded] = useState(false)
 const [spawnDialog, setSpawnDialog] = useState<SpawnDialogState | null>(null)
 const [recoveryDialog, setRecoveryDialog] = useState<RecoveryDialogState | null>(null)
 const [requestChangesDialog, setRequestChangesDialog] = useState<{
 artifact: SprintEngineArtifact
 feedback: string
 submitting: boolean
 error: string | null
 } | null>(null)
 const [cliPickerOpen, setCliPickerOpen] = useState(false)
 const [settingsOpen, setSettingsOpen] = useState(false)
 const [addMemberOpen, setAddMemberOpen] = useState(false)
 const [addMemberRole, setAddMemberRole] = useState<SprintEngineRole>('developer')
 const [pendingRosterMemberSpawns, setPendingRosterMemberSpawns] = useState<PendingRosterMemberSpawn[]>([])
 const pendingRosterMemberSpawnInFlightRef = useRef<Set<string>>(new Set())
 const [manualRefreshBusy, setManualRefreshBusy] = useState(false)
 const [pendingAutomationMode, setPendingAutomationMode] = useState<SprintEngineAutomationMode | null>(null)
 const [artifactActions, setArtifactActions] = useState<Record<string, ArtifactActionState>>({})
 const [syncState, setSyncState] = useState<SyncState>({
 status: 'idle',
 message: 'Waiting for a Sprint Engine workspace folder.',
 })

 const sprintEngineContext = workspace?.sprintEngineContext ?? null
 // The Summary view only exists once the run is complete; coerce a stale
 // persisted `summary` back to Tasks for incomplete runs so it can't strand.
 const runComplete = Boolean(
 sprintEngineState && sprintEngineState.tasks.length > 0 &&
 sprintEngineState.tasks.every((task) => task.status === 'done')
 )
 const requestedView = fixedView ?? activeView
 const effectiveView: SprintEngineView =
 requestedView === 'summary' && !runComplete ? 'tasks' : requestedView
 const effectiveTasksLayout: SprintEngineTasksLayout = fixedTasksLayout ?? activeTasksLayout
 const folderPath = folderReadyPath
 const agents = workspace?.agents ?? {}
 const terminalSessions = useTerminalSessions()
  const projectedAutomationMode = deriveSprintEngineAutomationMode(workspace?.sprintEngineAutoState, sprintEngineState?.runner)
  const automationMode = pendingAutomationMode ?? projectedAutomationMode
  const automationRuntimeState = normalizeSprintEngineAutomationRuntimeState(
  workspace?.sprintEngineAutoState?.runtimeState,
  projectedAutomationMode,
  )
  const automationRuntimeReason = workspace?.sprintEngineAutoState?.reasonMessage
  const cliPermissionPreset = workspace?.sprintEngineAutoState?.cliPermissionPreset ?? 'default'

 // Sprint Engine role registry for the workspace. Loaded once per folder so
 // the Add Member options and uncovered-role detection surface custom enabled
 // registry roles alongside the bundled board roles. The list silently falls
 // back to the bundled set when the IPC bridge or the registry payload is
 // unavailable.
 const [roleRegistry, setRoleRegistry] = useState<SprintEngineRoleRegistry | null>(null)
 useEffect(() => {
   let cancelled = false
   if (!folderPath || typeof window.api.readSprintEngineRegistryRoles !== 'function') {
     setRoleRegistry(null)
     return undefined
   }
   void window.api.readSprintEngineRegistryRoles({ workspaceRoot: folderPath, includeShadowed: true })
     .then((result) => {
       if (cancelled) return
       if (result.ok) {
         setRoleRegistry(buildSprintEngineRoleRegistry(result.data))
       } else {
         setRoleRegistry(null)
       }
     })
     .catch(() => {
       if (cancelled) return
       setRoleRegistry(null)
     })
   return () => {
     cancelled = true
   }
 }, [folderPath])

 useEffect(() => {
 setPendingAutomationMode(null)
 setPendingRosterMemberSpawns([])
 pendingRosterMemberSpawnInFlightRef.current.clear()
 }, [sprintEngineContext?.statePath])

 const resolveReadableSprintEngineStatePath = async (): Promise<string | null> => {
 if (!folderPath) return null
 return sprintEngineContext?.statePath ?? null
 }

 const sprintEngineTasks = sprintEngineState?.tasks ?? []
 const {
 roster,
 rosterById,
 runtimeAgents,
 runtimeAgentById,
 readyTasks,
 boardColumns,
 reviewArtifacts,
 artifactsByTaskId,
 artifactBlockersByTaskId,
 tasksById,
 inboxArtifactCount,
 addMemberOptions,
 } = useSprintEngineBoardModel({ sprintEngineState, agents, roleRegistry, disabledRoleIds })

 const getLiveAgentTerminalSession = useCallback(
 (agentId: string) => {
 const agentSessionId = agents[agentId]?.cliSessionId
 return terminalSessions.find((session) =>
 session.processAlive
 && session.kind === 'agent'
 && session.workspaceId === workspaceId
 && (
 session.agentId === agentId
 || (agentSessionId ? session.sessionId === agentSessionId : false)
 )
 && (!sprintEngineContext || session.sprintEngineStatePath === sprintEngineContext.statePath)
 )
 },
 [agents, sprintEngineContext, terminalSessions, workspaceId]
 )

 const isAgentTerminalLive = useCallback(
 (agentId: string): boolean => Boolean(getLiveAgentTerminalSession(agentId)),
 [getLiveAgentTerminalSession]
 )

 useEffect(() => {
 if (!savedFolderPath) {
 setSyncState({
 status: 'idle',
 message: 'Choose a workspace folder to watch agent-managed Sprint Engine state.',
 })
 return
 }
 if (!folderPath) {
 setSyncState({
 status: folderMissing ? 'error' : 'idle',
 message: folderMissing
 ? `Saved workspace folder is missing: ${savedFolderPath}`
 : 'Checking workspace folder before watching Sprint Engine state.',
 })
 return
 }
 if (!sprintEngineContext?.statePath) {
 setSyncState({
 status: 'idle',
 message: 'Waiting for agent-managed state.',
 })
 return
 }

 setSyncState({
 status: 'live',
 message: `Watching agent-managed state at ${sprintEngineContext.statePath}`,
 })
 }, [folderMissing, folderPath, savedFolderPath, sprintEngineContext?.statePath])

 // startAgentTerminal / ensureWorkspaceFolderReadyForLaunch / startAgentTerminalWhenReady
 // moved to useSprintEngineBoardTerminalActions hook (initialized below).

 const previousColumnByTaskRef = useRef<Map<string, SprintEngineTaskBoardColumn>>(new Map())
 const [recentlyMovedTaskIds, setRecentlyMovedTaskIds] = useState<Set<string>>(new Set())

 useEffect(() => {
 if (!sprintEngineState) {
 previousColumnByTaskRef.current = new Map()
 return
 }
 const nextMap = new Map<string, SprintEngineTaskBoardColumn>()
 for (const task of sprintEngineState.tasks) {
 nextMap.set(task.id, getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks))
 }
 const moved: string[] = []
 for (const [taskId, column] of nextMap) {
 const previousColumn = previousColumnByTaskRef.current.get(taskId)
 if (previousColumn && previousColumn !== column) moved.push(taskId)
 }
 previousColumnByTaskRef.current = nextMap
 if (moved.length > 0) {
 setRecentlyMovedTaskIds(new Set(moved))
 }
 }, [sprintEngineState])

 useEffect(() => {
 if (recentlyMovedTaskIds.size === 0) return
 const handle = window.setTimeout(() => setRecentlyMovedTaskIds(new Set()), 700)
 return () => window.clearTimeout(handle)
 }, [recentlyMovedTaskIds])

 // Close the docked task-detail inspector with Escape from non-kanban
 // surfaces. The Kanban layout owns its own Escape handler scoped to the
 // board grid; everywhere else this global listener restores focus.
 // Two-stage: collapse an expanded inspector first, close on a second press.
 const tasksKanbanActive = effectiveView === 'tasks' && effectiveTasksLayout === 'kanban'
 useEffect(() => {
 if (!selectedTaskId || tasksKanbanActive) return
 const onKeyDown = (event: KeyboardEvent) => {
 if (event.key !== 'Escape') return
 if (isEditableTarget(event.target)) return
 event.preventDefault()
 if (inspectorExpanded) {
 setInspectorExpanded(false)
 return
 }
 setSelectedTaskId(null)
 }
 window.addEventListener('keydown', onKeyDown)
 return () => window.removeEventListener('keydown', onKeyDown)
 }, [selectedTaskId, tasksKanbanActive, inspectorExpanded])

 const handleKanbanKeyDown = useCallback(
 (event: React.KeyboardEvent<HTMLDivElement>) => {
 if (!tasksKanbanActive) return
 if (isEditableTarget(event.target)) return
 if (event.metaKey || event.ctrlKey || event.altKey) return

 if (event.key === 'Escape') {
 if (inspectorExpanded) {
 event.preventDefault()
 setInspectorExpanded(false)
 return
 }
 if (selectedTaskId !== null) {
 event.preventDefault()
 setSelectedTaskId(null)
 }
 return
 }

 const navKeys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'j', 'k', 'h', 'l']
 if (!navKeys.includes(event.key)) return
 event.preventDefault()
 if (boardColumns.length === 0) return

 const currentColumnIdx = selectedTaskId
 ? boardColumns.findIndex((column) => column.cards.some((card) => card.id === selectedTaskId))
 : -1
 const currentCards = currentColumnIdx >= 0 ? boardColumns[currentColumnIdx].cards : []
 const currentCardIdx = selectedTaskId
 ? currentCards.findIndex((card) => card.id === selectedTaskId)
 : -1

 const goVertical = (delta: number) => {
 if (currentColumnIdx < 0 || currentCards.length === 0) {
 for (const column of boardColumns) {
 if (column.cards.length > 0) {
 setSelectedTaskId(column.cards[0].id)
 return
 }
 }
 return
 }
 const next = currentCardIdx + delta
 if (next >= 0 && next < currentCards.length) {
 setSelectedTaskId(currentCards[next].id)
 }
 }

 const goHorizontal = (delta: number) => {
 const startColumn = currentColumnIdx >= 0 ? currentColumnIdx : 0
 for (let i = startColumn + delta; i >= 0 && i < boardColumns.length; i += delta) {
 const cards = boardColumns[i].cards
 if (cards.length > 0) {
 const fallbackIdx = currentCardIdx >= 0 ? currentCardIdx : 0
 const targetIdx = Math.min(Math.max(fallbackIdx, 0), cards.length - 1)
 setSelectedTaskId(cards[targetIdx].id)
 return
 }
 }
 }

 if (event.key === 'ArrowDown' || event.key === 'j') goVertical(1)
 else if (event.key === 'ArrowUp' || event.key === 'k') goVertical(-1)
 else if (event.key === 'ArrowRight' || event.key === 'l') goHorizontal(1)
 else if (event.key === 'ArrowLeft' || event.key === 'h') goHorizontal(-1)
 },
 [boardColumns, tasksKanbanActive, selectedTaskId, inspectorExpanded]
 )

 const selectedTask = sprintEngineState?.tasks.find((task) => task.id === selectedTaskId) ?? null

 const doneCount = sprintEngineState.tasks.filter((task) => task.status === 'done').length
 const runPhase = getSprintEngineBoardRunPhase(sprintEngineState, runtimeAgents)
 const allTasksDone = sprintEngineState.tasks.length > 0 && doneCount === sprintEngineState.tasks.length
 const runSummary = buildRunSummary(sprintEngineState.tasks)
 const totalTasks = sprintEngineState.tasks.length
 const progressPct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0
 const runPhaseTone: Tone =
 runPhase === 'Complete'
 ? 'good'
 : runPhase === 'Running'
 ? 'accent'
 : 'neutral'
 const projectionUnavailable = sprintEngineState.projection?.source === 'unavailable'
 const projectionErrorMessage = sprintEngineState.projection?.errorMessage
 const lockWarnings = sprintEngineState.locks?.warnings ?? []
 const hasProjectionBanner = projectionUnavailable || Boolean(projectionErrorMessage) || lockWarnings.length > 0
 const architectAgentId = roster.find((agent) => agent.role === 'architect')?.id ?? null
 // Bundled worker roles ship dedicated role-task launch buttons. Custom
 // registry roles do not yet, so they always defer to the generic focus
 // agent action below.
 const workerRoles: SprintEngineRole[] = ['developer', 'frontend', 'product', 'code_reviewer', 'nuclear_reviewer', 'spec_reviewer', 'performance', 'cross_platform', 'tester', 'security']
 const roleTaskLaunches = workerRoles.flatMap((role) => {
 const activeTask = sprintEngineState.tasks.find((task) =>
 task.role === role && (task.status === 'in_progress' || task.status === 'needs_input' || task.status === 'changes_requested')
 )
 const readyTask = readyTasks.find((task) => task.role === role && !task.ownerAgentId)
 const task = activeTask ?? readyTask
 if (!task) return []

 const ownerAgent = task.ownerAgentId ? rosterById[task.ownerAgentId] : undefined
 const agent = ownerAgent ?? roster.find((candidate) =>
 candidate.role === role && runtimeAgentById[candidate.id]?.status !== 'done'
 )
 return [{ role, task, agent }]
 })
 const roleTaskLaunchSet = new Set<SprintEngineRoleId>(roleTaskLaunches.map(({ role }) => role))
 const specialistReviewAgents = roster.filter((agent) => agent.role !== 'architect')
 const spawnDialogAgent = spawnDialog ? rosterById[spawnDialog.agentId] : undefined
 const spawnDialogRuntime = spawnDialog
 ? runtimeAgents.find((agent) => agent.agentId === spawnDialog.agentId)
 : undefined
 const spawnDialogDefaultName = spawnDialogAgent?.label ?? spawnDialog?.agentId ?? ''
 const spawnDialogDisplayName = spawnDialog
 ? normalizeAgentIdentifier(spawnDialog.name) || spawnDialogDefaultName
 : spawnDialogDefaultName
 const spawnDialogHasLiveTerminal = spawnDialog ? isAgentTerminalLive(spawnDialog.agentId) : false
 const selectedCliOption = cliOptions.find((option) => option.value === spawnDialog?.cli) ?? cliOptions[0]
 const selectedRecoveryCliOption =
 cliOptions.find((option) => option.value === recoveryDialog?.cli) ?? cliOptions[0]
 const hasPlannedTasks = sprintEngineState.tasks.length > 0
 const relinkFolder = async () => {
 const dir = await window.api.openDir()
 if (dir) setFolderPath(workspaceId, dir)
 }
 const refreshSprintEngineState = async () => {
 if (!folderPath || manualRefreshBusy) return

 setManualRefreshBusy(true)
 setSyncState({ status: 'syncing', message: 'Refreshing Sprint Engine state...' })
 try {
 const stateFilePath = await resolveReadableSprintEngineStatePath()
 if (!stateFilePath) throw new Error('No workspace folder is ready.')
 const projection = await window.api.readSprintEngineProjection(stateFilePath)
 if (!projection.ok) throw new Error(projection.message)
 const parsed = normalizeSprintEngineProjection(projection.data, sprintEngineContext?.teamName)
 if (!parsed) throw new Error('Sprint Engine projection was malformed.')
 setSprintEngineState(workspaceId, parsed)
 setSyncState({
 status: 'live',
 message: `Refreshed ${parsed.tasks.length} tasks from projection.json`,
 })
 } catch (error) {
 setSyncState({
 status: 'error',
 message: error instanceof Error ? error.message : 'Failed to refresh Sprint Engine state.',
 })
 } finally {
 setManualRefreshBusy(false)
 }
 }

 const {
 applySprintEngineProjectionContent,
 openArtifact,
 popOutPreviewedArtifact,
 approveArtifact,
 requestArtifactChanges,
 cancelRequestArtifactChangesDialog,
 submitRequestArtifactChanges,
 } = useSprintEngineBoardArtifactActions({
 workspaceId,
 statePath: sprintEngineContext?.statePath,
 teamName: sprintEngineContext?.teamName,
 setArtifactActions,
 setPreviewedArtifact,
 previewedArtifact,
 setRequestChangesDialog,
 requestChangesDialog,
 setSyncState,
 setSprintEngineState,
 openFile,
 refreshSprintEngineState,
 api: window.api,
 })

 const folderStatusBanner = savedFolderPath && !folderPath ? (
 <div className="border-b border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] px-4 py-2 text-[12px] text-[color:var(--text-muted)]">
 <div className="flex flex-wrap items-center justify-between gap-3">
 <span className="min-w-0 truncate">
 {checkingFolder ? 'Checking workspace folder...' : `Saved folder is missing: ${savedFolderPath}`}
 </span>
 {folderMissing ? (
 <span className="flex shrink-0 items-center gap-2">
 <button
 onClick={() => void recheckFolder()}
 className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-[color:var(--text-default)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
 >
 Retry
 </button>
 <button
 onClick={() => void relinkFolder()}
 className="rounded-md bg-[color:var(--accent-primary-soft)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--accent-primary)] interactive transition-colors hover:bg-[color:var(--accent-primary-soft)]"
 >
 Relink
 </button>
 </span>
 ) : null}
 </div>
 </div>
 ) : null
 const showPlanningActions = !hasPlannedTasks
 const needsInputAgent = runtimeAgents.find((agent) => agent.status === 'needs_input')
 const runningAgent = runtimeAgents.find((agent) => agent.status === 'running')
 const focusAgent = needsInputAgent ?? runningAgent
 const focusAgentRoster = focusAgent ? rosterById[focusAgent.agentId] : undefined
 const focusAgentHasLiveTerminal = focusAgent ? isAgentTerminalLive(focusAgent.agentId) : false
 const focusAgentRole = focusAgentRoster?.role ?? focusAgent?.role ?? null
 const showFocusAgentAction = Boolean(focusAgent)
 && (!focusAgentRole || focusAgentRole === 'architect' || !roleTaskLaunchSet.has(focusAgentRole))
 const focusAgentLabel = focusAgent
 ? focusAgentHasLiveTerminal
 ? `Focus ${focusAgentRoster?.label ?? focusAgent.agentId}`
 : `Spawn ${focusAgentRoster?.label ?? focusAgent.agentId}`
 : ''
 const runFocusAgentAction = () => {
 if (!focusAgent || !showFocusAgentAction) return false
 if (focusAgentHasLiveTerminal) openAgentTerminal(focusAgent.agentId)
 else openSpawnDialog(focusAgent.agentId)
 return true
 }
 const selectedTaskBoardColumn = selectedTask
 ? getSprintEngineTaskBoardColumn(selectedTask, sprintEngineState.tasks)
 : null
 const selectedTaskStatusLabel = selectedTask
 ? selectedTaskBoardColumn === 'ready' ? 'Ready' : sprintEngineTaskStateLabel[selectedTask.status]
 : ''
 const selectedTaskOwnerLabel = selectedTask ? getSprintEngineTaskOwnerLabel(selectedTask, rosterById) : ''
 const selectedTaskNeedsInputNote = selectedTask?.status === 'needs_input'
 ? 'Worker is waiting for input.'
 : null
 const selectedTaskArtifacts = selectedTask
 ? [...(artifactsByTaskId[selectedTask.id] ?? [])].sort((a, b) => {
 const timestampDelta = artifactTimestampMs(b) - artifactTimestampMs(a)
 if (timestampDelta !== 0) return timestampDelta
 return a.title.localeCompare(b.title)
 })
 : []
 const selectedTaskArtifactBlockers = selectedTask ? artifactBlockersByTaskId[selectedTask.id] ?? [] : []
 const inspectorSelectedAgent = selectedAgentId
 ? roster.find((entry) => entry.id === selectedAgentId) ?? null
 : null
 const inspectorSelectedArtifact = selectedArtifactId
 ? reviewArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null
 : null
 // Selection-to-inspector mapping is scoped by the active tab so a row
 // selected on one tab does not light up the right pane of another. The
 // artifact preview is the one exception: it's an in-place file preview the
 // inbox/tasks tab launches itself and always takes precedence over a stale
 // sibling selection.
 const inspectorSelection: SprintEngineInspectorSelection | null = (() => {
 if (previewedArtifact) {
 return { kind: 'artifact-preview', artifact: previewedArtifact }
 }
 if (effectiveView === 'inbox') {
 if (inspectorSelectedArtifact) return { kind: 'artifact', artifact: inspectorSelectedArtifact }
 if (selectedTask) return { kind: 'task', task: selectedTask }
 return null
 }
 if (effectiveView === 'roster') {
 if (inspectorSelectedAgent) return { kind: 'agent', agent: inspectorSelectedAgent }
 return null
 }
 // tasks (graph + kanban) and the summary drill-down all drive task detail.
 if (selectedTask) return { kind: 'task', task: selectedTask }
 return null
 })()
 const closeInspector = () => {
 setSelectedTaskId(null)
 setSelectedAgentId(null)
 setSelectedArtifactId(null)
 setPreviewedArtifact(null)
 setInspectorExpanded(false)
 }
 const toggleInspectorExpanded = () => {
 setInspectorExpanded((prev) => !prev)
 }
 // Expand state is meaningless when nothing is selected; reset it so a
 // future selection starts in the default (split) layout.
 useEffect(() => {
 if (!inspectorSelection && inspectorExpanded) setInspectorExpanded(false)
 }, [inspectorSelection, inspectorExpanded])
 // Inspector body, sans wrapper chrome. The project view embeds this in
 // the focal center slot when something is selected; task-graph and kanban
 // views keep the right-side aside via renderInspectorAside().
 const renderInspectorPanel = () => inspectorSelection ? (
 <SprintEngineInspectorPanel
 selection={inspectorSelection}
 sprintEngineState={sprintEngineState}
 runtimeAgents={runtimeAgents}
 agents={agents}
 tasksById={tasksById}
 selectedTaskBoardColumn={selectedTaskBoardColumn}
 selectedTaskStatusLabel={selectedTaskStatusLabel}
 selectedTaskOwnerLabel={selectedTaskOwnerLabel}
 selectedTaskNeedsInputNote={selectedTaskNeedsInputNote}
 selectedTaskArtifacts={selectedTaskArtifacts}
 selectedTaskArtifactBlockers={selectedTaskArtifactBlockers}
 artifactActions={artifactActions}
 onClose={closeInspector}
 onSelectTask={setSelectedTaskId}
 onOpenArtifact={openArtifact}
 onApproveArtifact={approveArtifact}
 onRequestArtifactChanges={requestArtifactChanges}
 onBackFromArtifact={() => setPreviewedArtifact(null)}
 onPopOutArtifact={popOutPreviewedArtifact}
 onSpawnAgent={openSpawnDialog}
 onOpenAgentTerminal={openAgentTerminal}
 isAgentTerminalLive={isAgentTerminalLive}
 isExpanded={inspectorExpanded}
 onToggleExpand={toggleInspectorExpanded}
 />
 ) : null
 const renderInspectorAside = () => {
 const panel = renderInspectorPanel()
 if (!panel) return null
 return (
 <SidePane side="right" width="md" expanded={inspectorExpanded} ariaLabel="Sprint Engine inspector">
 {panel}
 </SidePane>
 )
 }
  const updateAutomationMode = (nextMode: SprintEngineAutomationMode) => {
  if (nextMode === automationMode) return
  const previousMode = automationMode
 setPendingAutomationMode(nextMode)
 if (nextMode === 'manual') {
  applySprintEngineAutomationStopReason(workspaceId, 'user_manual_toggle')
 } else {
  setSprintEngineAutomationMode(workspaceId, nextMode)
 }
 if (!sprintEngineContext?.statePath) {
 if (nextMode !== 'manual') {
 setSprintEngineAutomationMode(workspaceId, previousMode)
 }
 setPendingAutomationMode(null)
 return
 }
 void (async () => {
 const stateFileExists = await window.api.pathExists(sprintEngineContext.statePath).catch(() => false)
 if (!stateFileExists) {
 if (nextMode !== 'manual') {
 setSprintEngineAutomationMode(workspaceId, previousMode)
 }
 setPendingAutomationMode(null)
 return
 }
 if (nextMode !== 'manual') {
 publishSprintEngineAutomationModeNotification({
 workspaceId,
 workspaceName: workspace?.name,
 mode: nextMode,
 })
 }
 const nextCliWatchPolling = sprintEngineCliWatchPollingForAutomationMode(nextMode)
 if (sprintEngineState?.runner?.cliWatchPolling === nextCliWatchPolling) return null
 return window.api.setSprintEngineRunnerMode({
 statePath: sprintEngineContext.statePath,
 cliWatchPolling: nextCliWatchPolling,
 })
 })().then(async (result) => {
 if (!result) {
 setPendingAutomationMode(null)
 return
 }
 if (!result.ok) {
 // The CLI-watch polling write to run.yaml failed. Keep the user's local
 // automation choice — the supervisor reads only local autoState, so the UI
 // is functionally correct. Surface a diagnostic so the user can retry if
 // they want the headless CLI co-existence flag synced.
 await publishDiagnostic({
 level: 'warning',
 source: 'sprintengine',
 title: 'CLI watch-polling flag was not synced to run.yaml',
 message: `${result.message} — local automation choice retained; toggle the mode again to retry the persist.`,
 workspaceId,
 workspaceName: workspace?.name,
 })
 setPendingAutomationMode(null)
 return
 }
 const projectionApplied = applySprintEngineProjectionContent(
 (result.data as { projectionContent?: unknown } | undefined)?.projectionContent
 )
 if (!projectionApplied) await refreshSprintEngineState()
 setPendingAutomationMode(null)
 }).catch(async (error) => {
 // Same as the !result.ok branch: keep the user's local choice and surface
 // the failure rather than reverting silently.
 await publishDiagnostic({
 level: 'warning',
 source: 'sprintengine',
 title: 'CLI watch-polling flag was not synced to run.yaml',
 message: `${error instanceof Error ? error.message : String(error)} — local automation choice retained; toggle the mode again to retry the persist.`,
 workspaceId,
 workspaceName: workspace?.name,
 })
  setPendingAutomationMode(null)
  })
  }

  const resumeAutomation = automationRuntimeState === 'paused'
  || automationRuntimeState === 'blocked'
  || automationRuntimeState === 'failed'
  ? () => {
  applySprintEngineAutomationEvent(workspaceId, { type: 'runner_started' })
  }
  : null

  const updateCliPermissionPreset = async (preset: SprintEngineCliPermissionPreset) => {
 if (preset === 'bypass_all') {
 const confirmed = await dialog.confirm({
 title: 'Bypass CLI permissions?',
 body: 'Spawned Sprint Engine agents will run without CLI approval prompts. Use this only in repositories and environments you trust.',
 confirmLabel: 'Bypass permissions',
 tone: 'danger',
 })
 if (!confirmed) return
 }

 setSprintEngineCliPermissionPreset(workspaceId, preset)
 }

 const getAgentName = (agentId: string, fallback: string) => agents[agentId]?.name ?? fallback

 const getCustomAgentName = (agentId: string, fallback: string) => {
 const name = agents[agentId]?.name
 return name && name !== fallback ? name : ''
 }

 const enqueuePendingRosterMemberSpawn = (pending: PendingRosterMemberSpawn) => {
 setPendingRosterMemberSpawns((current) => {
 if (current.some((candidate) => candidate.agentId === pending.agentId)) return current
 return [...current, pending]
 })
 }

 const openAddMemberDialog = () => {
 const uncoveredRole = findFirstUncoveredSprintEngineRole({
 registry: roleRegistry,
 disabledRoleIds,
 roster,
 tasks: sprintEngineTasks,
 })
 setAddMemberRole((uncoveredRole ?? 'developer') as SprintEngineRole)
 setAddMemberOpen(true)
 }

 const confirmAddMember = async (role = addMemberRole) => {
 if (sprintEngineState.rosterConfigured) {
 if (!architectAgentId || !sprintEngineContext) return
 const agentId = getNextSprintEngineAgentId(role, sprintEngineState.sprintEngineAgents)
 const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
 const label = getAgentName(architectAgentId, fallbackLabel)
 const prompt = buildSprintEngineRosterRevisionPrompt({
 role,
 agentId,
 teamSlug: sprintEngineContext.teamSlug,
 })
 const liveArchitectSession = getLiveAgentTerminalSession(architectAgentId)
 if (liveArchitectSession) {
 await window.api.terminalWrite(liveArchitectSession.sessionId, bracketedTerminalPaste(prompt))
 enqueuePendingRosterMemberSpawn({ agentId, role })
 focusOrAddAgentTab(workspaceId, architectAgentId, label)
 setSelectedAgentId(architectAgentId)
 setAddMemberOpen(false)
 return
 }
 const started = await startAgentTerminalWhenReady(architectAgentId, label, agents[architectAgentId]?.cli, {
 freshSession: true,
 agentName: getCustomAgentName(architectAgentId, fallbackLabel),
 startupPrompt: prompt,
 })
 if (!started) return
 enqueuePendingRosterMemberSpawn({ agentId, role })
 setSelectedAgentId(architectAgentId)
 setAddMemberOpen(false)
 return
 }

 const addedAgent = addSprintEngineMember(workspaceId, role)
 if (!addedAgent) return

 void startAgentTerminalWhenReady(addedAgent.id, addedAgent.label)
 setSelectedAgentId(addedAgent.id)
 setAddMemberOpen(false)
 }

 const {
 startAgentTerminalWhenReady,
 openAgentTerminal,
 openSpawnDialog,
 confirmSpawnDialog,
 openRecoveryDialog,
 confirmRecoveryAudit,
 requestPlanReviews,
 addressPlanReviews,
 } = useSprintEngineBoardTerminalActions({
 workspaceId,
 workspace,
 agents,
 sprintEngineState,
 rosterById,
 architectAgentId,
 specialistReviewAgents,
 savedFolderPath,
 folderPath,
 folderStatusMessage,
 folderCheckedPath,
 lastSelectedCli,
 spawnDialog,
 recoveryDialog,
 spawnDialogHasLiveTerminal,
 updateAgent,
 recheckFolder,
 setSelectedAgentId,
 setCliPickerOpen,
 setSpawnDialog,
 setRecoveryDialog,
 getAgentName,
 getCustomAgentName,
 getLiveAgentTerminalSession,
 })

 useEffect(() => {
 if (pendingRosterMemberSpawns.length === 0) return

 for (const pending of pendingRosterMemberSpawns) {
 const rosterAgent = rosterById[pending.agentId]
 if (!rosterAgent || rosterAgent.role !== pending.role) continue
 if (getLiveAgentTerminalSession(pending.agentId)) {
 setPendingRosterMemberSpawns((current) => current.filter((candidate) => candidate.agentId !== pending.agentId))
 continue
 }
 if (pendingRosterMemberSpawnInFlightRef.current.has(pending.agentId)) continue

 pendingRosterMemberSpawnInFlightRef.current.add(pending.agentId)
 const label = getAgentName(pending.agentId, rosterAgent.label)
 void startAgentTerminalWhenReady(
 pending.agentId,
 label,
 agents[pending.agentId]?.cli,
 ).then((started) => {
 if (!started) return
 setSelectedAgentId(pending.agentId)
 setPendingRosterMemberSpawns((current) => current.filter((candidate) => candidate.agentId !== pending.agentId))
 }).finally(() => {
 pendingRosterMemberSpawnInFlightRef.current.delete(pending.agentId)
 })
 }
 }, [
 agents,
 getAgentName,
 getLiveAgentTerminalSession,
 pendingRosterMemberSpawns,
 rosterById,
 startAgentTerminalWhenReady,
 ])

 const chromeOverflowItems: OverflowMenuItem[] = (() => {
 const items: OverflowMenuItem[] = []
 items.push({
 id: 'refresh',
 label: 'Refresh board',
 onSelect: () => void refreshSprintEngineState(),
 shortcut: shortcutFor('sprintengine.refresh.board'),
 disabled: !folderPath || manualRefreshBusy,
 })
 if (focusAgent && showFocusAgentAction) {
 items.push({
 id: 'focus-agent',
 label: focusAgentLabel,
 onSelect: runFocusAgentAction,
 })
 }
 items.push({ kind: 'separator', id: 'sep-1' })
 if (architectAgentId) {
 items.push({
 id: 'verify-progress',
 label: 'Verify progress',
 onSelect: openRecoveryDialog,
 })
 }
 items.push({
 id: 'more-roles',
 label: 'More roles',
 onSelect: openAddMemberDialog,
 })
 if (showPlanningActions) {
 items.push({
 id: 'request-plan-reviews',
 label: 'Request plan reviews',
 onSelect: requestPlanReviews,
 disabled: !folderPath || specialistReviewAgents.length === 0,
 })
 if (architectAgentId) {
 items.push({
 id: 'address-feedback',
 label: 'Address feedback',
 onSelect: addressPlanReviews,
 disabled: !folderPath,
 })
 }
 }
 items.push({ kind: 'separator', id: 'sep-2' })
 items.push({
 id: 'automation-settings',
 label: 'Automation settings',
 onSelect: () => setSettingsOpen(true),
 })
 items.push({ kind: 'separator', id: 'sep-3' })
 items.push({
 id: 'read-plan',
 label: 'Read plan',
 onSelect: () => focusOrAddComponentTab(workspaceId, 'sprintengine-plan-reader', 'Architect Plan'),
 })
 items.push({
 id: 'open-settings',
 label: 'Sprint Engine settings',
 onSelect: () => setSettingsOpen(true),
 shortcut: shortcutFor('sprintengine.open.settings'),
 })
 return items
 })()

 const chromeTabItems: TabItem<SprintEngineView>[] = [
 {
 id: 'inbox',
 label: 'Inbox',
 icon: SprintEngineInboxIcon,
 count: inboxArtifactCount > 0 ? inboxArtifactCount : undefined,
 },
 {
 id: 'roster',
 label: 'Roster',
 icon: SprintEngineRosterNavIcon,
 count: roster.length > 0 ? roster.length : undefined,
 },
 {
 id: 'tasks',
 label: 'Tasks',
 icon: SprintEngineTasksNavIcon,
 count: sprintEngineState.tasks.length > 0 ? sprintEngineState.tasks.length : undefined,
 },
 // The run summary lives as a view that only appears once the run is complete.
 ...(allTasksDone
 ? [{ id: 'summary' as const, label: 'Summary', icon: SprintEngineSummaryNavIcon }]
 : []),
 ]
 const activateView = (view: SprintEngineView) => {
 if (fixedView) return
 setActiveView(view)
 }

 // Listen for CommandPalette dispatches and the cross-cutting ⌘ , chord so the
 // palette and the panel-local overflow/settings popover route through the
 // same handlers. Listeners are registered once with a latest-handler ref so
 // normal re-renders don't churn global window listeners; the ref is refreshed
 // synchronously each render with the live closures it needs to dispatch.
 const commandHandlerRef = useRef<(detail: { id: unknown }) => void>(() => {})
 commandHandlerRef.current = (detail) => {
 if (!detail || typeof detail.id !== 'string') return
 switch (detail.id) {
 case 'sprintengine.open.automation-settings':
 setSettingsOpen(true)
 break
 case 'sprintengine.verify.progress':
 if (architectAgentId) {
 openRecoveryDialog()
 } else {
 publishDiagnosticSync({
 level: 'info',
 source: 'sprintengine',
 title: 'Verify progress is unavailable',
 message: 'No architect agent is on the roster yet. Spawn the architect to verify progress.',
 workspaceId,
 workspaceName: workspace?.name,
 })
 }
 break
 case 'sprintengine.add.role':
 openAddMemberDialog()
 break
 case 'sprintengine.request.plan-reviews':
 requestPlanReviews()
 break
 case 'sprintengine.address.feedback':
 addressPlanReviews()
 break
 case 'sprintengine.read.plan':
 focusOrAddComponentTab(workspaceId, 'sprintengine-plan-reader', 'Architect Plan')
 break
 case 'sprintengine.focus.agent':
 if (!runFocusAgentAction()) {
 publishDiagnosticSync({
 level: 'info',
 source: 'sprintengine',
 title: 'Focus active agent is unavailable',
 message: focusAgent
 ? `The ${getSprintEngineRoleLabel(focusAgent.role)} agent already has a role-task launch on the panel; use that instead.`
 : 'No agent is currently running or waiting for input.',
 workspaceId,
 workspaceName: workspace?.name,
 agentId: focusAgent?.agentId,
 })
 }
 break
 case 'sprintengine.refresh.board':
 if (folderPath && !manualRefreshBusy) void refreshSprintEngineState()
 break
 case 'sprintengine.goto.inbox':
 if (!fixedView) setActiveView('inbox')
 break
 case 'sprintengine.goto.roster':
 if (!fixedView) setActiveView('roster')
 break
 case 'sprintengine.goto.tasks':
 if (!fixedView) setActiveView('tasks')
 break
 case 'sprintengine.goto.graph':
 if (!fixedView) setActiveView('tasks')
 if (!fixedTasksLayout) setActiveTasksLayout('graph')
 break
 case 'sprintengine.goto.kanban':
 if (!fixedView) setActiveView('tasks')
 if (!fixedTasksLayout) setActiveTasksLayout('kanban')
 break
 case 'sprintengine.open.settings':
 case 'open.settings':
 setSettingsOpen(true)
 break
 }
 }
 useEffect(() => {
 const onCommand = (event: Event) => {
 commandHandlerRef.current((event as CustomEvent).detail)
 }
 window.addEventListener('multicode:panel-command', onCommand)
 return () => {
 window.removeEventListener('multicode:panel-command', onCommand)
 }
 }, [])

 const tasksLayoutToggle = effectiveView === 'tasks' && !fixedTasksLayout ? (
 <div
 role="group"
 aria-label="Tasks layout"
 className="inline-flex shrink-0 items-center gap-0.5 rounded border border-[color:var(--border-default)] bg-[color:var(--bg-app)] p-0.5"
 >
 {(['graph', 'kanban'] as SprintEngineTasksLayout[]).map((layout) => {
 const active = effectiveTasksLayout === layout
 const label = layout === 'graph' ? 'Graph' : 'Kanban'
 return (
 <button
 key={layout}
 type="button"
 aria-pressed={active}
 onClick={() => setActiveTasksLayout(layout)}
 className={`interactive rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] ${
 active
 ? 'bg-[color:var(--bg-surface-raised)] text-[color:var(--text-strong)]'
 : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-default)]'
 }`}
 >
 {label}
 </button>
 )
 })}
 </div>
 ) : null

 // Unified board chrome: the app shell already names the workspace immediately
 // above this panel, so this row only carries view navigation, task layout,
 // compact run state, and the shared overflow/settings menu.
 const runHero = (
 <header className="relative shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
 <div className="flex min-h-10 items-center justify-between gap-2 pr-3">
 {!fixedView ? (
 <Tabs<SprintEngineView>
 ariaLabel="Sprint Engine view"
 items={chromeTabItems}
 value={effectiveView}
 onChange={activateView}
 idPrefix="sprintengine-view"
 className="px-3"
 borderless
 />
 ) : (
 <span className="sr-only">{sprintEngineState.name}</span>
 )}
 <div className="flex min-w-0 shrink-0 items-center gap-2">
 <StatusDot tone={runPhaseTone} label={`Run phase: ${runPhase}`} />
  <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-muted)]">
  {doneCount}/{totalTasks}
  </span>
  <span
  className="hidden max-w-[180px] shrink-0 items-center gap-1.5 truncate text-[11px] text-[color:var(--text-muted)] sm:inline-flex"
  title={automationRuntimeReason ?? sprintEngineAutomationRuntimeLabels[automationRuntimeState]}
  >
  <StatusDot
  tone={sprintEngineAutomationRuntimeTones[automationRuntimeState]}
  label={`Automation status: ${sprintEngineAutomationRuntimeLabels[automationRuntimeState]}`}
  />
  <span className="truncate">{sprintEngineAutomationRuntimeLabels[automationRuntimeState]}</span>
  </span>
 {tasksLayoutToggle}
  <Popover
 open={settingsOpen}
 onOpenChange={setSettingsOpen}
 ariaLabel="Sprint Engine settings"
 popupRole="dialog"
 placement="bottom-end"
 renderTrigger={() => (
 <OverflowMenu ariaLabel="Sprint Engine overflow" items={chromeOverflowItems} />
 )}
 >
  <SprintEngineSettingsPopover
  automationMode={automationMode}
  runtimeState={automationRuntimeState}
  runtimeReason={automationRuntimeReason}
  cliPermissionPreset={cliPermissionPreset}
  onChangeAutomationMode={updateAutomationMode}
  onResumeAutomation={resumeAutomation}
  onUpdateCliPreset={updateCliPermissionPreset}
 onVerifyProgress={architectAgentId ? openRecoveryDialog : null}
 onClose={() => setSettingsOpen(false)}
 />
 </Popover>
 </div>
 </div>
 <div
 className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-[2px]"
 role="progressbar"
 aria-valuemin={0}
 aria-valuemax={totalTasks}
 aria-valuenow={doneCount}
 aria-label={`${doneCount} of ${totalTasks} tasks done`}
 >
 <div
 className="absolute inset-y-0 left-0 bg-[color:var(--accent-primary)] transition-[width]"
 style={{ width: `${progressPct}%` }}
 />
 </div>
 </header>
 )

 const projectionBanner = hasProjectionBanner ? (
 <div
 role="status"
 className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 text-[12px] leading-5"
 >
 <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
 <span className="inline-flex items-center gap-1.5">
 <StatusDot tone={projectionUnavailable ? 'error' : 'warn'} />
 <span className="font-mono text-[11px] text-[color:var(--text-muted)]">
 {projectionUnavailable ? 'Projection unavailable' : 'Projection warning'}
 </span>
 </span>
 {projectionErrorMessage ? (
 <span className="text-[color:var(--tone-error)] [overflow-wrap:anywhere]">
 {projectionErrorMessage}
 </span>
 ) : null}
 {lockWarnings.map((warning) => (
 <span key={warning.name} className="text-[color:var(--tone-warn)]">
 <span className="font-mono">{warning.name}</span>{' '}
 stale {formatSprintEngineLockAge(warning.ageSeconds)}
 </span>
 ))}
 </div>
 </div>
 ) : null

 const runCompleteBanner = allTasksDone ? (
 <Section
 title="Run complete"
 level={3}
 className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
 >
 <div className="text-[12px] text-[color:var(--text-default)]">
 Review uncommitted workspace changes and manually test the feature.
 </div>
 <div className="mt-1 text-[11px] text-[color:var(--text-muted)]">
 {runSummary.touchedFiles.length} files touched · {runSummary.commandsRan.length} commands recorded · {runSummary.results.length} validation results
 </div>
 </Section>
 ) : null

 return (
 <div className="relative flex h-full flex-col overflow-hidden bg-[color:var(--bg-app)] text-[color:var(--text-strong)]">
 {runHero}

 <div className="sr-only" role="status" aria-live="polite">
 {syncState.message}
 </div>

 {projectionBanner}
 {runCompleteBanner}
 {folderStatusBanner}

 {/* Board content area (columns / inspector / summary view). */}
 <div className="relative flex min-h-0 flex-1 flex-col">
 {effectiveView === 'summary' ? (
 <div
 id="sprintengine-view-panel-summary"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-summary"
 className="flex min-h-0 flex-1"
 >
 <div className="min-w-0 min-h-0 flex-1">
 <React.Suspense fallback={<SuspenseFallback label="Loading run summary" />}>
 <SprintEngineRunSummaryPanel
 workspaceId={workspaceId}
 embedded
 // Open task detail as an aside inside the Summary view — select the
 // task, don't navigate away to the Kanban.
 onOpenTask={(taskId) => setSelectedTaskId(taskId)}
 />
 </React.Suspense>
 </div>
 {renderInspectorAside()}
 </div>
 ) : null}

 {effectiveView === 'inbox' ? (
 <div
 id="sprintengine-view-panel-inbox"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-inbox"
 className="flex min-h-0 flex-1"
 >
 <SprintEngineInboxView
 sprintEngineState={sprintEngineState}
 reviewArtifacts={reviewArtifacts}
 runPhase={runPhase}
 selectedArtifactId={selectedArtifactId}
 onSelectArtifact={setSelectedArtifactId}
 onSelectTask={setSelectedTaskId}
 inspectorContent={renderInspectorPanel()}
 inspectorExpanded={inspectorExpanded}
 />
 </div>
 ) : null}

 {effectiveView === 'roster' ? (
 <div
 id="sprintengine-view-panel-roster"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-roster"
 className="flex min-h-0 flex-1"
 >
 <SprintEngineRosterView
 sprintEngineState={sprintEngineState}
 roster={roster}
 agents={agents}
 runtimeAgents={runtimeAgents}
 selectedAgentId={selectedAgentId}
 onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
 onAddRole={(role) => {
 void confirmAddMember(role)
 }}
 addMemberOptions={addMemberOptions}
 isAgentTerminalLive={isAgentTerminalLive}
 inspectorContent={renderInspectorPanel()}
 inspectorExpanded={inspectorExpanded}
 />
 </div>
 ) : null}

 {effectiveView === 'tasks' ? (
 <div
 id="sprintengine-view-panel-tasks"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-tasks"
 className={`flex min-h-0 flex-1 flex-col bg-[color:var(--bg-app)] ${effectiveTasksLayout === 'kanban' ? 'focus:outline-none' : ''}`}
 tabIndex={effectiveTasksLayout === 'kanban' ? 0 : -1}
 onKeyDown={effectiveTasksLayout === 'kanban' ? handleKanbanKeyDown : undefined}
 aria-label={effectiveTasksLayout === 'kanban' ? 'Sprint Engine kanban' : undefined}
 >
 {/* Tasks layout (Graph / Kanban) toggle now lives on the trailing edge of */}
 {/* the panel sub-nav row above so we don't stack a second horizontal bar. */}

 <div className="flex min-h-0 flex-1">
 {inspectorExpanded ? null : effectiveTasksLayout === 'graph' ? (
 <SprintEngineTaskGraphView
 sprintEngineState={sprintEngineState}
 rosterById={rosterById}
 selectedTaskId={selectedTaskId}
 onSelectTask={setSelectedTaskId}
 />
 ) : (
 <SprintEngineTasksKanbanView
 sprintEngineState={sprintEngineState}
 boardColumns={boardColumns}
 selectedTaskId={selectedTaskId}
 onSelectTask={setSelectedTaskId}
 recentlyMovedTaskIds={recentlyMovedTaskIds}
 />
 )}

 {renderInspectorAside()}
 </div>
 </div>
 ) : null}
 </div>

 {recoveryDialog ? (
 <Modal
 open
 contained
 width={520}
 labelledBy="recovery-dialog-title"
 onClose={() => {
 setCliPickerOpen(false)
 setRecoveryDialog(null)
 }}
 >
 <div className="flex items-start justify-between gap-4 border-b border-[color:var(--border-default)] px-5 py-4">
 <div className="min-w-0">
 <div className="mb-1 text-[10px] font-semibold text-[color:var(--text-disabled)]">
 Verify Progress
 </div>
 <h3 id="recovery-dialog-title" className="truncate text-[18px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
 Architect Audit
 </h3>
 <p className="mt-2 text-[13px] leading-6 text-[color:var(--text-muted)]">
 The Architect will inspect the run store, check each task in order, and update task status through the sprintengine Python tool.
 </p>
 </div>
 <CloseIconButton
 size="md"
 aria-label="Close"
 onClick={() => {
 setCliPickerOpen(false)
 setRecoveryDialog(null)
 }}
 />
 </div>

 <ModalBody className="space-y-4">
 <DefinitionList
 layout="compact-grid"
 className="gap-x-8"
 items={[
 { term: 'Tasks', description: `${sprintEngineState.tasks.length} to check` },
 { term: 'Backup', description: 'state-timestamp.yaml' },
 ]}
 />

 <div>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Architect CLI
 </div>
 <Popover
 open={cliPickerOpen}
 onOpenChange={setCliPickerOpen}
 ariaLabel="Architect CLI options"
 popupRole="listbox"
 placement="bottom-start"
 className="block w-full"
 surfaceClassName="left-0 right-0 w-full p-1"
 renderTrigger={({ ref, triggerProps, togglePopover }) => (
 <button
 ref={ref}
 type="button"
 onClick={togglePopover}
 className="flex min-h-[58px] w-full items-center gap-3 rounded-md bg-[color:var(--bg-surface-raised)] px-3 text-left text-[color:var(--text-strong)] outline-none interactive transition-colors hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--border-strong)]"
 {...triggerProps}
 >
 <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[color:var(--text-muted)]">
 <CliIcon cli={selectedRecoveryCliOption.value} className="h-5 w-5" />
 </span>
 <span className="min-w-0 flex-1">
 <span className="block text-sm font-semibold text-[color:var(--text-strong)]">
 {selectedRecoveryCliOption.label}
 </span>
 <span className="mt-0.5 block truncate text-[12px] text-[color:var(--text-disabled)]">
 {selectedRecoveryCliOption.description}
 </span>
 </span>
 <svg
 className={`icon-md shrink-0 text-[color:var(--text-disabled)] transition-transform ${cliPickerOpen ? 'rotate-180' : ''}`}
 viewBox="0 0 20 20"
 fill="none"
 aria-hidden="true"
 xmlns="http://www.w3.org/2000/svg"
 >
 <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 )}
 >
 {cliOptions.map((option) => {
 const selected = recoveryDialog.cli === option.value
 return (
 <button
 key={option.value}
 type="button"
 role="option"
 aria-selected={selected}
 onClick={() => {
 setRecoveryDialog((current) =>
 current ? { ...current, cli: option.value } : current
 )
 setCliPickerOpen(false)
 }}
 className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left interactive transition-colors ${
 selected
 ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
 : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
 }`}
 >
 <span
 className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
 selected
 ? 'text-[color:var(--text-muted)]'
 : 'text-[color:var(--text-disabled)]'
 }`}
 >
 <CliIcon cli={option.value} className="h-5 w-5" />
 </span>
 <span className="min-w-0 flex-1">
 <span className="block text-sm font-semibold">{option.label}</span>
 <span className="mt-0.5 block truncate text-[12px] text-[color:var(--text-disabled)]">
 {option.description}
 </span>
 </span>
 {selected ? (
 <svg className="icon-md shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
 <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 ) : null}
 </button>
 )
 })}
 </Popover>
 </div>

 <p className="border-l border-[color:var(--border-strong)] pl-3 text-sm leading-6 text-[color:var(--text-muted)]">
 The Architect runs the audit in a terminal and writes updates to the watched state file.
 </p>
 </ModalBody>

 <ModalFooter>
 <ModalButton
 onClick={() => {
 setCliPickerOpen(false)
 setRecoveryDialog(null)
 }}
 >
 Cancel
 </ModalButton>
 <ModalButton
 variant="primary"
 onClick={confirmRecoveryAudit}
 disabled={!folderPath || !architectAgentId}
 >
 Start Audit
 </ModalButton>
 </ModalFooter>
 </Modal>
 ) : null}

 {spawnDialog && spawnDialogAgent ? (
 <Modal
 open
 contained
 width={520}
 labelledBy="spawn-dialog-title"
 onClose={() => {
 setCliPickerOpen(false)
 setSpawnDialog(null)
 }}
 >
 <div className="flex items-start justify-between gap-4 border-b border-[color:var(--border-default)] px-5 py-4">
 <div className="min-w-0">
 <div className="mb-1 text-[10px] font-semibold text-[color:var(--text-disabled)]">
 Spawn Agent
 </div>
 <h3 id="spawn-dialog-title" className="truncate text-[18px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
 {spawnDialogDisplayName}
 </h3>
 <p className="mt-2 text-[13px] leading-6 text-[color:var(--text-muted)]">
 Choose the CLI and optional identifier for this specialist.
 </p>
 </div>
 <CloseIconButton
 size="md"
 aria-label="Close"
 onClick={() => {
 setCliPickerOpen(false)
 setSpawnDialog(null)
 }}
 />
 </div>

 <ModalBody className="space-y-4">
 <DefinitionList
 layout="compact-grid"
 className="gap-x-8"
 items={[
 { term: 'Role', description: getSprintEngineRoleLabel(spawnDialogAgent.role) },
 { term: 'Status', description: runtimeStatusLabel(spawnDialogRuntime?.status ?? 'idle') },
 ]}
 />

 <label className="block">
 <span className="mb-2 block text-[10px] font-bold text-[color:var(--text-disabled)]">
 Name
 </span>
 <input
 type="text"
 value={spawnDialog.name}
 onChange={(event) => {
 setSpawnDialog((current) =>
 current ? { ...current, name: event.target.value } : current
 )
 }}
 placeholder={spawnDialogDefaultName}
 className="h-10 w-full rounded-md bg-[color:var(--bg-surface-raised)] px-3 text-sm text-[color:var(--text-strong)] outline-none interactive transition-colors placeholder:text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--accent-primary-soft)]"
 />
 </label>

 <div>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 CLI
 </div>
 <Popover
 open={cliPickerOpen}
 onOpenChange={setCliPickerOpen}
 ariaLabel="Spawn agent CLI options"
 popupRole="listbox"
 placement="bottom-start"
 className="block w-full"
 surfaceClassName="left-0 right-0 w-full p-1"
 renderTrigger={({ ref, triggerProps, togglePopover }) => (
 <button
 ref={ref}
 type="button"
 onClick={togglePopover}
 className="flex min-h-[58px] w-full items-center gap-3 rounded-md bg-[color:var(--bg-surface-raised)] px-3 text-left text-[color:var(--text-strong)] outline-none interactive transition-colors hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--border-strong)]"
 {...triggerProps}
 >
 <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[color:var(--text-muted)]">
 <CliIcon cli={selectedCliOption.value} className="h-5 w-5" />
 </span>
 <span className="min-w-0 flex-1">
 <span className="block text-sm font-semibold text-[color:var(--text-strong)]">
 {selectedCliOption.label}
 </span>
 <span className="mt-0.5 block truncate text-[12px] text-[color:var(--text-disabled)]">
 {selectedCliOption.description}
 </span>
 </span>
 <svg
 className={`icon-md shrink-0 text-[color:var(--text-disabled)] transition-transform ${cliPickerOpen ? 'rotate-180' : ''}`}
 viewBox="0 0 20 20"
 fill="none"
 aria-hidden="true"
 xmlns="http://www.w3.org/2000/svg"
 >
 <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 )}
 >
 {cliOptions.map((option) => {
 const selected = spawnDialog.cli === option.value
 return (
 <button
 key={option.value}
 type="button"
 role="option"
 aria-selected={selected}
 onClick={() => {
 setSpawnDialog((current) =>
 current ? { ...current, cli: option.value } : current
 )
 setCliPickerOpen(false)
 }}
 className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left interactive transition-colors ${
 selected
 ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
 : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
 }`}
 >
 <span
 className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
 selected
 ? 'text-[color:var(--text-muted)]'
 : 'text-[color:var(--text-disabled)]'
 }`}
 >
 <CliIcon cli={option.value} className="h-5 w-5" />
 </span>
 <span className="min-w-0 flex-1">
 <span className="block text-sm font-semibold">{option.label}</span>
 <span className="mt-0.5 block truncate text-[12px] text-[color:var(--text-disabled)]">
 {option.description}
 </span>
 </span>
 {selected ? (
 <svg className="icon-md shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
 <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 ) : null}
 </button>
 )
 })}
 </Popover>
 </div>

 <p className="border-l border-[color:var(--border-strong)] pl-3 text-sm leading-6 text-[color:var(--text-muted)]">
 {cliOptions.find((option) => option.value === spawnDialog.cli)?.description}
 {spawnDialogHasLiveTerminal ? (
 <span className="text-[color:var(--text-disabled)]"> A terminal already exists, so this will focus it unless you changed the CLI.</span>
 ) : null}
 </p>
 </ModalBody>

 <ModalFooter>
 <ModalButton
 onClick={() => {
 setCliPickerOpen(false)
 setSpawnDialog(null)
 }}
 >
 Cancel
 </ModalButton>
 <ModalButton variant="primary" onClick={confirmSpawnDialog}>
 {spawnDialogHasLiveTerminal ? 'Open Terminal' : 'Spawn'}
 </ModalButton>
 </ModalFooter>
 </Modal>
 ) : null}

 {requestChangesDialog ? (
 <Modal
 open
 contained
 width={520}
 labelledBy="request-changes-dialog-title"
 onClose={cancelRequestArtifactChangesDialog}
 >
 <div className="flex items-start justify-between gap-4 border-b border-[color:var(--border-default)] px-5 py-4">
 <div className="min-w-0">
 <div className="mb-1 text-[10px] font-semibold text-[color:var(--text-disabled)]">
 Request Changes
 </div>
 <h3
 id="request-changes-dialog-title"
 className="truncate text-[18px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]"
 >
 {requestChangesDialog.artifact.title}
 </h3>
 <p className="mt-2 text-[13px] leading-6 text-[color:var(--text-muted)]">
 Sprint Engine records this feedback on the artifact and reopens the owning task for rework.
 </p>
 </div>
 <CloseIconButton
 size="md"
 aria-label="Close"
 onClick={cancelRequestArtifactChangesDialog}
 />
 </div>

 <ModalBody className="space-y-3">
 <label className="block">
 <span className="mb-2 block text-[10px] font-bold text-[color:var(--text-disabled)]">
 Feedback
 </span>
 <textarea
 value={requestChangesDialog.feedback}
 onChange={(event) => {
 const value = event.target.value
 setRequestChangesDialog((current) =>
 current ? { ...current, feedback: value, error: null } : current,
 )
 }}
 disabled={requestChangesDialog.submitting}
 placeholder="Describe what needs to change before this artifact can be approved."
 rows={5}
 className="block w-full resize-y rounded-md bg-[color:var(--bg-surface-raised)] px-3 py-2 text-sm leading-5 text-[color:var(--text-strong)] outline-none interactive transition-colors placeholder:text-[color:var(--text-disabled)] hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--accent-primary-soft)] disabled:cursor-not-allowed disabled:opacity-60"
 />
 </label>
 {requestChangesDialog.error ? (
 <p className="text-[12px] leading-5 text-[color:var(--tone-error)]">
 {requestChangesDialog.error}
 </p>
 ) : null}
 </ModalBody>

 <ModalFooter>
 <ModalButton
 onClick={cancelRequestArtifactChangesDialog}
 disabled={requestChangesDialog.submitting}
 >
 Cancel
 </ModalButton>
 <ModalButton
 variant="primary"
 onClick={() => void submitRequestArtifactChanges()}
 disabled={requestChangesDialog.submitting || requestChangesDialog.feedback.trim().length === 0}
 >
 {requestChangesDialog.submitting ? 'Requesting changes…' : 'Request changes'}
 </ModalButton>
 </ModalFooter>
 </Modal>
 ) : null}

 {addMemberOpen ? (
 <Modal
 open
 contained
 width={760}
 labelledBy="add-member-dialog-title"
 onClose={() => setAddMemberOpen(false)}
 >
 <div className="flex items-start justify-between gap-4 border-b border-[color:var(--border-default)] px-5 py-4">
 <div>
 <div className="mb-1 text-[10px] font-bold text-[color:var(--text-disabled)]">
 SprintEngine Roster
 </div>
 <h3 id="add-member-dialog-title" className="text-[18px] font-semibold leading-6 tracking-tight text-[color:var(--text-strong)]">
 {sprintEngineState.rosterConfigured ? 'Add Roster Member' : 'Spawn Team Member'}
 </h3>
 </div>
 <CloseIconButton
 size="md"
 aria-label="Close"
 onClick={() => setAddMemberOpen(false)}
 />
 </div>

 <ModalBody className="space-y-1">
 {addMemberOptions.map((option) => {
 const role = option.role
 const selected = role === addMemberRole

 return (
 <button
 key={role}
 onClick={() => setAddMemberRole(role as SprintEngineRole)}
 aria-pressed={selected}
 className={`w-full rounded-md border-l-2 px-3 py-3 text-left interactive transition-colors ${
 selected
 ? 'border-l-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
 : 'border-l-transparent text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
 }`}
 >
 <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
 <span
 className="hidden h-8 w-8 shrink-0 items-center justify-center rounded border bg-[color:var(--bg-surface-raised)] sm:flex"
 style={{
 borderColor: selected ? getSprintEngineRoleAccent(role) : 'var(--border-strong)',
 color: 'var(--text-muted)',
 }}
 >
 <SprintEngineRoleIcon role={role} className="icon-md" />
 </span>
 <div className="min-w-0 flex-1">
 <div className="truncate text-sm font-semibold">
 {option.label}
 </div>
 <p className={`mt-1 text-[12px] leading-5 ${selected ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-muted)]'}`}>
 {option.summary}
 </p>
 </div>
 <span className={`shrink-0 pt-0.5 text-right text-[11px] font-semibold ${
 selected ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-disabled)]'
 }`}>
 {option.activeForRole} active / {option.openTasksForRole} open
 </span>
 </div>
 </button>
 )
 })}
 </ModalBody>

 <ModalFooter>
 <ModalButton onClick={() => setAddMemberOpen(false)}>Cancel</ModalButton>
 <ModalButton
 variant="primary"
 onClick={() => void confirmAddMember()}
 >
 {sprintEngineState.rosterConfigured ? 'Ask Architect' : 'Spawn'} {getSprintEngineRoleLabel(addMemberRole)}
 </ModalButton>
 </ModalFooter>
 </Modal>
 ) : null}

 </div>
 )
}
