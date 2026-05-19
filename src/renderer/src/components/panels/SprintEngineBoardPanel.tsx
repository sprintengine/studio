import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
 BoardLane,
 CloseIconButton,
 Tabs,
 OverflowMenu,
 GhostButton,
 InboxSearchInput,
 PanelHeader,
 Popover,
 RoleAvatar,
 SidePane,
 StatusDot,
 Section,
 Select,
 Switch,
 TaskCard,
 Tooltip,
 DefinitionList,
 type OverflowMenuItem,
 type TabItem,
 type Tone,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { Modal, ModalBody, ModalButton, ModalFooter } from '../ui/Modal'
import { focusOrAddComponentTab } from '../../utils/modelRegistry'
import {
 buildRunSummary,
} from '../../utils/sprintengineRunSummary'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import type {
 AgentCli,
 AgentExecution,
 AgentState,
 SprintEngineArtifact,
 SprintEngineCliPermissionPreset,
 SprintEngineRole,
 SprintEngineState,
 SprintEngineTask,
 SprintEngineTaskBoardColumn,
} from '../../types/workspace'
import { SprintEngineRoleIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import {
 buildSprintEngineAgentRosterForState,
 formatSprintEngineLockAge,
 getNextSprintEngineAgentId,
 getReviewableSprintEngineArtifacts,
 getSprintEngineArtifactDependencyBlockers,
 getSprintEngineArtifactsByTaskId,
 getSprintEngineTaskBoardColumn,
 getSprintEngineVisibleBoardColumns,
 isSprintEngineTaskLaunchable,
 normalizeSprintEngineProjection,
 sprintEngineRoleAccent,
 sprintEngineRoleLabels,
 sprintEngineTaskStateLabel,
 type SprintEngineAgentRosterItem,
} from '../../utils/sprintengine'
import { normalizeAgentIdentifier, prependAgentIdentifier } from '../../utils/agentPrompt'
import { focusOrAddAgentTab, focusOrAddFileTab } from '../../utils/modelRegistry'
import { publishDiagnostic, publishDiagnosticSync } from '../../utils/diagnostics'
import { sendArtifactApprovalToTerminal } from '../../utils/terminalApproval'
import { agentCliSupportsConversationResume } from '../../utils/agentCliResume'
import { isEditableTarget } from '../../utils/keyboard'
import { basename, isAbsoluteFilePath, joinFilePath, parentPath } from '../../utils/paths'
import {
 artifactTimestampMs,
 getSprintEngineInboxArtifacts,
 runtimeStatusLabel,
 runtimeStatusTone,
 sprintEngineInboxEmptyMessage,
 type ArtifactActionState,
 type RuntimeAgentView,
 type SprintEngineInspectorSelection,
} from './sprintEngineInspector'
import {
 SprintEngineInspectorPanel,
 SprintEngineInboxRow,
 SprintEngineBlockedByRow,
} from './SprintEngineInspectorPanel'
import { SprintEngineTaskGraphView } from './SprintEngineTaskGraphView'



const addableRoles: SprintEngineRole[] = ['architect', 'product', 'frontend', 'developer', 'code_reviewer', 'spec_reviewer', 'performance', 'tester', 'security']
const cliOptions: Array<{ value: AgentCli; label: string; description: string }> = [
 { value: 'codex', label: 'Codex', description: 'OpenAI Codex CLI' },
 { value: 'claude', label: 'Claude', description: 'Claude Code CLI' },
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


type OpenedSprintEngineArtifact = {
 path: string
 name: string
 content: string
}

function normalizeComparablePath(path: string): string {
 const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
 return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
 const parent = normalizeComparablePath(parentPath)
 const target = normalizeComparablePath(targetPath)
 return target === parent || target.startsWith(`${parent}/`)
}

function resolveArtifactPathForEditor(statePath: string, artifactPathInput: string): string {
 const artifactPath = artifactPathInput.trim()
 if (!artifactPath) throw new Error('Artifact path is required.')
 if (/^https?:\/\//i.test(artifactPath)) {
 throw new Error('Remote artifact links cannot be opened in the editor.')
 }
 if (artifactPath.split(/[\\/]+/).includes('..')) {
 throw new Error('Artifact path must stay inside the Sprint Engine team directory.')
 }
 if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(artifactPath) && !isAbsoluteFilePath(artifactPath)) {
 throw new Error('Only workspace artifact file paths can be opened.')
 }

 const teamDirectory = parentPath(statePath)
 const workspaceRoot = parentPath(parentPath(parentPath(teamDirectory)))
 const targetPath = isAbsoluteFilePath(artifactPath)
 ? artifactPath
 : [
 joinFilePath(workspaceRoot, artifactPath),
 joinFilePath(teamDirectory, artifactPath),
 ].find((candidate) => isPathInsideOrEqual(teamDirectory, candidate))
 ?? joinFilePath(workspaceRoot, artifactPath)

 if (!isPathInsideOrEqual(teamDirectory, targetPath)) {
 throw new Error('Artifact path must stay inside the Sprint Engine team directory.')
 }

 return targetPath
}

const roleSummaries: Record<SprintEngineRole, string> = {
 architect: 'Plans the run and gates readiness.',
 product: 'Shapes scope, positioning, audience fit, and priority tradeoffs.',
 developer: 'Builds implementation and integration work.',
 frontend: 'Owns interaction design, visual quality, and UI implementation.',
 code_reviewer: 'Reviews implementation quality, regressions, and evidence.',
 spec_reviewer: 'Checks implementation against requirements, acceptance criteria, and tests.',
 performance: 'Reviews latency, CPU, memory, runtime cost, and measurement gaps.',
 tester: 'Validates behavior, regressions, and acceptance criteria.',
 security: 'Reviews trust boundaries, command safety, data handling, and hardening.',
}

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


type SprintEngineView = 'inbox' | 'roster' | 'tasks'
type SprintEngineTasksLayout = 'graph' | 'kanban'

type SpawnDialogState = {
 agentId: string
 cli: AgentCli
 name: string
}

type RecoveryDialogState = {
 cli: AgentCli
}

function SprintEngineSettingsPopover({
 autoEnabled,
 autoApproveArtifacts,
 cliPermissionPreset,
 onToggleAuto,
 onToggleArtifactAutoApproval,
 onUpdateCliPreset,
 onVerifyProgress,
 onClose,
}: {
 autoEnabled: boolean
 autoApproveArtifacts: boolean
 cliPermissionPreset: SprintEngineCliPermissionPreset
 onToggleAuto: () => void
 onToggleArtifactAutoApproval: () => void
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
 return (
 <div
 ref={containerRef}
 aria-label="Sprint Engine settings"
 tabIndex={-1}
 onKeyDown={onPanelKey}
 className="w-[280px] overflow-hidden py-1"
 >
 <Section title="Run" level={3} inset={true}>
 <div className="flex flex-col gap-2">
 <div className="flex items-center justify-between gap-3 text-[12px] text-[color:var(--text-default)]">
 <span id="sprintengine-settings-auto-label">Auto mode</span>
 <Switch
 checked={autoEnabled}
 onChange={onToggleAuto}
 ariaLabelledBy="sprintengine-settings-auto-label"
 />
 </div>
 <div
 className={`flex items-center justify-between gap-3 text-[12px] ${
 autoEnabled
 ? 'text-[color:var(--text-default)]'
 : 'text-[color:var(--text-disabled)]'
 }`}
 >
 <span id="sprintengine-settings-approve-label">Approve all artifacts</span>
 <Switch
 checked={autoApproveArtifacts}
 onChange={onToggleArtifactAutoApproval}
 ariaLabelledBy="sprintengine-settings-approve-label"
 />
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

export default function SprintEngineBoardPanel({ workspaceId, fixedView, fixedTasksLayout }: Props) {
 const workspace = useWorkspaceStore(
 (s) => s.workspaces.find((w) => w.id === workspaceId) ?? null
 )
 const setSprintEngineState = useWorkspaceStore((s) => s.setSprintEngineState)
 const setSprintEngineAutoEnabled = useWorkspaceStore((s) => s.setSprintEngineAutoEnabled)
 const setSprintEngineAutoApproveArtifacts = useWorkspaceStore((s) => s.setSprintEngineAutoApproveArtifacts)
 const setSprintEngineCliPermissionPreset = useWorkspaceStore((s) => s.setSprintEngineCliPermissionPreset)
 const addSprintEngineMember = useWorkspaceStore((s) => s.addSprintEngineMember)
 const updateAgent = useWorkspaceStore((s) => s.updateAgent)
 const openFile = useWorkspaceStore((s) => s.openFile)
 const setFolderPath = useWorkspaceStore((s) => s.setFolderPath)
 const lastSelectedCli = useWorkspaceStore((s) => s.appSettings.lastSelectedCli)
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
 const [activeView, setActiveView] = useState<SprintEngineView>('inbox')
 // The Tasks tab carries an inline layout switcher (Graph / Kanban). The
 // selection is persisted across tab switches so jumping away and back
 // returns to the same layout. When the host pins a layout via
 // `fixedTasksLayout` the switcher is hidden and the pinned value wins.
 const [activeTasksLayout, setActiveTasksLayout] = useState<SprintEngineTasksLayout>('kanban')
 const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
 const [inspectorExpanded, setInspectorExpanded] = useState(false)
 const [spawnDialog, setSpawnDialog] = useState<SpawnDialogState | null>(null)
 const [recoveryDialog, setRecoveryDialog] = useState<RecoveryDialogState | null>(null)
 const [cliPickerOpen, setCliPickerOpen] = useState(false)
 const [settingsOpen, setSettingsOpen] = useState(false)
 const [addMemberOpen, setAddMemberOpen] = useState(false)
 const [addMemberRole, setAddMemberRole] = useState<SprintEngineRole>('developer')
 const [manualRefreshBusy, setManualRefreshBusy] = useState(false)
 const [autoRunnerControlEnabled, setAutoRunnerControlEnabled] = useState<boolean | null>(null)
 const [artifactActions, setArtifactActions] = useState<Record<string, ArtifactActionState>>({})
 const [syncState, setSyncState] = useState<SyncState>({
 status: 'idle',
 message: 'Waiting for a Sprint Engine workspace folder.',
 })

 const sprintEngineState = workspace?.sprintEngineState ?? null
 const sprintEngineContext = workspace?.sprintEngineContext ?? null
 const effectiveView = fixedView ?? activeView
 const effectiveTasksLayout: SprintEngineTasksLayout = fixedTasksLayout ?? activeTasksLayout
 const folderPath = folderReadyPath
 const agents = workspace?.agents ?? {}
 const terminalSessions = useTerminalSessions()
 const projectedRunnerMode = sprintEngineState?.runner?.mode
 const projectedAutoEnabled = projectedRunnerMode
 ? projectedRunnerMode === 'auto'
 : workspace?.sprintEngineAutoState?.enabled ?? false
 const autoEnabled = autoRunnerControlEnabled ?? projectedAutoEnabled
 const autoApproveArtifacts = workspace?.sprintEngineAutoState?.autoApproveArtifacts ?? false
 const cliPermissionPreset = workspace?.sprintEngineAutoState?.cliPermissionPreset ?? 'default'

 useEffect(() => {
 setAutoRunnerControlEnabled(null)
 }, [sprintEngineContext?.statePath])

 const resolveReadableSprintEngineStatePath = async (): Promise<string | null> => {
 if (!folderPath) return null
 return sprintEngineContext?.statePath ?? null
 }

 const roster = useMemo(
 () => buildSprintEngineAgentRosterForState(sprintEngineState),
 [sprintEngineState]
 )

 const rosterById = useMemo(
 () => Object.fromEntries(roster.map((agent) => [agent.id, agent])),
 [roster]
 )

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

 const runtimeAgents = useMemo(
 () => roster.map((agent) => {
 const runtime = sprintEngineState?.sprintEngineAgents[agent.id]
 const localAgent = agents[agent.id]
 const localExited = Boolean(
 localAgent?.kind === 'sprintengine'
 && localAgent.cliLastExitedAt
 && !localAgent.cliStartRequested
 && !localAgent.cliHasLaunched
 )

 return {
 agentId: agent.id,
 label: agent.label,
 role: runtime?.role ?? agent.role,
 status: localExited ? 'exited' : runtime?.status ?? 'idle',
 currentTaskId: runtime?.currentTaskId ?? null,
 }
 }),
 [agents, roster, sprintEngineState?.sprintEngineAgents]
 )

 const runtimeAgentById = useMemo(
 () => Object.fromEntries(runtimeAgents.map((agent) => [agent.agentId, agent])),
 [runtimeAgents]
 )

 const readyTasks = useMemo(() => (
 sprintEngineState?.tasks.filter((task) => isSprintEngineTaskLaunchable(task, sprintEngineState)) ?? []
 ), [sprintEngineState])

 function startAgentTerminal(
 agentId: string,
 label: string,
 cli?: AgentCli,
 options?: {
 startupPrompt?: string
 freshSession?: boolean
 agentName?: string
 execution?: AgentExecution
 }
 ): boolean {
 const current = agents[agentId]
 const selectedCli = cli ?? current?.cli
 if (!selectedCli) {
 void publishDiagnostic({
 level: 'error',
 source: 'terminal',
 title: `${label} was not started`,
 message: 'Sprint Engine agent is missing its CLI selection.',
 details: [
 `Workspace ID: ${workspaceId}`,
 `Agent ID: ${agentId}`,
 ].join('\n'),
 workspaceId,
 workspaceName: workspace?.name,
 agentId,
 })
 return false
 }
 const role = sprintEngineState?.sprintEngineAgents[agentId]?.role
 const roleLabel = role
 ? sprintEngineRoleLabels[role]
 : undefined
 const startupPrompt = options?.startupPrompt && options.agentName
 ? prependAgentIdentifier(options.startupPrompt, options.agentName, roleLabel)
 : options?.startupPrompt
 const hasLegacyLaunchedSession =
 current?.cli === undefined
 && Boolean(current?.cliStartRequested || current?.cliHasLaunched || current?.cliSessionId)
 const shouldResetSession =
 hasLegacyLaunchedSession || (current?.cli !== undefined && current.cli !== selectedCli)
 const shouldStartFresh = Boolean(options?.freshSession || shouldResetSession)
 const previousSessionId = current?.cliSessionId
 const nextSessionId = current?.cliStartRequested && previousSessionId && !shouldStartFresh
 ? previousSessionId
 : crypto.randomUUID()

 if (shouldStartFresh && previousSessionId && previousSessionId !== nextSessionId) {
 void window.api.terminalKill(previousSessionId).catch(() => {})
 }

 updateAgent(workspaceId, agentId, {
 name: label,
 ...(options?.execution ? { execution: options.execution } : {}),
 cliStartRequested: true,
 cliSessionId: nextSessionId,
 cliHasLaunched: current?.cliStartRequested && !shouldStartFresh ? current.cliHasLaunched ?? false : false,
 cliOnboardingPromptSent: current?.cliStartRequested && !shouldStartFresh ? current.cliOnboardingPromptSent ?? false : false,
 cliResumeAvailable: shouldStartFresh ? false : current?.cliResumeAvailable ?? false,
 cliLastExitCode: undefined,
 cliLastExitedAt: undefined,
 cli: selectedCli,
 cliStartupPrompt: startupPrompt,
 kind: 'sprintengine',
 })
 focusOrAddAgentTab(workspaceId, agentId, label)
 return true
 }

 async function ensureWorkspaceFolderReadyForLaunch(agentId: string, label: string): Promise<boolean> {
 if (!savedFolderPath) return true

 const result = folderPath
 ? { ok: true as const, checkedPath: folderPath, message: `Workspace folder is ready: ${folderPath}` }
 : await window.api.checkWorkspaceFolder(savedFolderPath).catch((error): WorkspaceFolderCheckResult => ({
 ok: false,
 status: 'inaccessible',
 path: savedFolderPath,
 checkedPath: savedFolderPath,
 message: error instanceof Error ? error.message : 'Failed to check workspace folder.',
 }))

 if (result.ok) return true

 void recheckFolder()
 await publishDiagnostic({
 level: 'error',
 source: 'filesystem',
 title: `${label} was not started`,
 message: result.message || folderStatusMessage || 'Workspace folder could not be verified.',
 details: [
 `Saved path: ${savedFolderPath}`,
 `Checked path: ${result.checkedPath || folderCheckedPath || savedFolderPath}`,
 `Agent: ${agentId}`,
 ].join('\n'),
 workspaceId,
 workspaceName: workspace?.name,
 agentId,
 })
 return false
 }

 async function startAgentTerminalWhenReady(
 agentId: string,
 label: string,
 cli?: AgentCli,
 options?: {
 startupPrompt?: string
 freshSession?: boolean
 agentName?: string
 execution?: AgentExecution
 }
 ): Promise<boolean> {
 if (!(await ensureWorkspaceFolderReadyForLaunch(agentId, label))) return false
 return startAgentTerminal(agentId, label, cli, options)
 }

 const boardColumns = useMemo(() => {
 if (!sprintEngineState) return []

 return getSprintEngineVisibleBoardColumns(sprintEngineState).map((column) => ({
 ...column,
 cards: sprintEngineState.tasks.filter(
 (task) => getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks) === column.key
 ),
 }))
 }, [sprintEngineState])

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

 const reviewArtifacts = useMemo(
 () => getReviewableSprintEngineArtifacts(sprintEngineState?.artifacts ?? []),
 [sprintEngineState?.artifacts]
 )

 const artifactsByTaskId = useMemo(
 () => getSprintEngineArtifactsByTaskId(reviewArtifacts),
 [reviewArtifacts]
 )

 const artifactBlockersByTaskId = useMemo(() => {
 if (!sprintEngineState) return {}
 return Object.fromEntries(
 sprintEngineState.tasks.map((task) => [
 task.id,
 getSprintEngineArtifactDependencyBlockers(task, sprintEngineState.tasks, reviewArtifacts),
 ])
 )
 }, [reviewArtifacts, sprintEngineState])

 const tasksById = useMemo(
 () => Object.fromEntries((sprintEngineState?.tasks ?? []).map((task) => [task.id, task])),
 [sprintEngineState?.tasks]
 )

 const selectedTask = sprintEngineState?.tasks.find((task) => task.id === selectedTaskId) ?? null

 if (!sprintEngineState) {
 return (
 <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] text-sm text-[color:var(--text-disabled)]">
 Sprint Engine workspace data is missing.
 </div>
 )
 }

 const doneCount = sprintEngineState.tasks.filter((task) => task.status === 'done').length
 const runPhase = getRunPhase(sprintEngineState, runtimeAgents)
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
 const workerRoles: SprintEngineRole[] = ['developer', 'frontend', 'product', 'code_reviewer', 'spec_reviewer', 'performance', 'tester', 'security']
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
 const roleTaskLaunchSet = new Set<SprintEngineRole>(roleTaskLaunches.map(({ role }) => role))
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

 const applySprintEngineProjectionContent = (projectionContent: unknown): boolean => {
 if (typeof projectionContent !== 'string') return false
 try {
 const projection = JSON.parse(projectionContent) as unknown
 const parsed = normalizeSprintEngineProjection(projection, sprintEngineContext?.teamName)
 if (!parsed) return false
 setSprintEngineState(workspaceId, parsed)
 setSyncState({
 status: 'live',
 message: `Refreshed ${parsed.tasks.length} tasks from projection.json`,
 })
 return true
 } catch {
 return false
 }
 }

 const setArtifactAction = (
 artifactId: string,
 state: ArtifactActionState | null
 ) => {
 setArtifactActions((current) => {
 const next = { ...current }
 if (state) {
 next[artifactId] = state
 } else {
 delete next[artifactId]
 }
 return next
 })
 }

 const requireArtifactStatePath = (): string | null => {
 if (!sprintEngineContext?.statePath) {
 setSyncState({
 status: 'error',
 message: 'This Sprint Engine workspace is missing its selected team context.',
 })
 return null
 }
 return sprintEngineContext.statePath
 }

 const readArtifactForEditor = async (
 statePath: string,
 artifact: SprintEngineArtifact
 ): Promise<OpenedSprintEngineArtifact> => {
 const artifactPath = resolveArtifactPathForEditor(statePath, artifact.path)
 const exists = await window.api.pathExists(artifactPath)
 if (!exists) {
 throw new Error(`Artifact file does not exist: ${artifactPath}`)
 }

 const content = await window.api.readfile(artifactPath)
 return {
 path: artifactPath,
 name: basename(artifactPath) || artifact.title || artifact.id,
 content,
 }
 }

 const openArtifact = async (artifact: SprintEngineArtifact) => {
 const statePath = requireArtifactStatePath()
 if (!statePath) return

 setArtifactAction(artifact.id, { kind: 'open', status: 'pending', message: 'Opening...' })
 try {
 const openedArtifact = await readArtifactForEditor(statePath, artifact)
 setPreviewedArtifact({
 id: artifact.id,
 path: openedArtifact.path,
 name: openedArtifact.name,
 content: openedArtifact.content,
 })
 setArtifactAction(artifact.id, {
 kind: 'open',
 status: 'success',
 message: 'Opened in preview.',
 })
 } catch (error) {
 const message = error instanceof Error ? error.message : 'Failed to open artifact.'
 setArtifactAction(artifact.id, {
 kind: 'open',
 status: 'error',
 message,
 })
 setSyncState({
 status: 'error',
 message,
 })
 }
 }

 // Pop the previewed artifact out into a real flexlayout file-editor tab.
 // Useful when the user wants the full editor experience (split view, code
 // language features) instead of the inline preview.
 const popOutPreviewedArtifact = () => {
 if (!previewedArtifact) return
 openFile(workspaceId, previewedArtifact.path, previewedArtifact.name, previewedArtifact.content)
 focusOrAddFileTab(workspaceId, previewedArtifact.path, previewedArtifact.name)
 setPreviewedArtifact(null)
 }

 const resolveArtifactProducerAgentId = (artifact: SprintEngineArtifact): string | null => {
 const linkedTask = tasksById[artifact.taskId]
 const createdBy = artifact.createdBy.trim()
 if (createdBy && (rosterById[createdBy] || agents[createdBy] || sprintEngineState?.sprintEngineAgents[createdBy])) {
 return createdBy
 }

 if (linkedTask?.ownerAgentId) return linkedTask.ownerAgentId

 if (linkedTask) {
 const runningRoleAgents = roster.filter((agent) =>
 agent.role === linkedTask.role && isAgentTerminalLive(agent.id)
 )
 if (runningRoleAgents.length === 1) return runningRoleAgents[0].id
 }

 return null
 }

 const focusArtifactProducerTerminal = (artifact: SprintEngineArtifact): { agentId: string; label: string } | null => {
 const agentId = resolveArtifactProducerAgentId(artifact)
 if (!agentId) {
 setArtifactAction(artifact.id, {
 kind: 'requestChanges',
 status: 'error',
 message: 'No producer terminal is linked to this artifact.',
 })
 return null
 }

 const fallbackLabel = rosterById[agentId]?.label ?? agentId
 const label = getAgentName(agentId, fallbackLabel)
 setSelectedAgentId(agentId)
 focusOrAddAgentTab(workspaceId, agentId, label)
 return { agentId, label }
 }

 const runningArtifactProducerSessionId = async (agentId: string): Promise<string | null> => {
 const sessionId = agents[agentId]?.cliSessionId
 if (sessionId) {
 const status = await window.api.terminalStatus(sessionId).catch(() => ({ processAlive: false }))
 if (status.processAlive) return sessionId
 }

 const sessions = await window.api.terminalList().catch(() => [])
 const runningSession = sessions.find((session) =>
 session.processAlive
 && session.kind === 'agent'
 && session.workspaceId === workspaceId
 && session.agentId === agentId
 && (!sprintEngineContext || session.sprintEngineStatePath === sprintEngineContext.statePath)
 )
 if (!runningSession) return null

 const effectiveCli = runningSession.cli ?? agents[agentId]?.cli
 if (!effectiveCli) {
 await publishDiagnostic({
 level: 'error',
 source: 'terminal',
 title: `${agentId} terminal was not attached`,
 message: 'Running Sprint Engine terminal is missing its CLI selection.',
 workspaceId,
 workspaceName: workspace?.name,
 agentId,
 })
 return null
 }

 updateAgent(workspaceId, agentId, {
 cliSessionId: runningSession.sessionId,
 cliStartRequested: true,
 cliHasLaunched: true,
 cliResumeAvailable: agentCliSupportsConversationResume(effectiveCli),
 cli: effectiveCli,
 })
 return runningSession.sessionId
 }

 // Review actions are terminal handoffs. The renderer must not invoke sprintengine
 // Python mutation commands; the producing agent receives the user's decision
 // and updates Sprint Engine state through its own tool flow.
 const approveArtifact = async (artifact: SprintEngineArtifact) => {
 setArtifactAction(artifact.id, { kind: 'approve', status: 'pending', message: 'Sending approval...' })
 try {
 const target = focusArtifactProducerTerminal(artifact)
 if (!target) return

 const sessionId = await runningArtifactProducerSessionId(target.agentId)
 if (!sessionId) {
 throw new Error(`Opened ${target.label}. Start or wait for the producer CLI before approving.`)
 }

 await sendArtifactApprovalToTerminal(sessionId)
 setArtifactAction(artifact.id, {
 kind: 'approve',
 status: 'success',
 message: `Sent approval to ${target.label}.`,
 })
 } catch (error) {
 const message = error instanceof Error ? error.message : 'Failed to send approval.'
 setArtifactAction(artifact.id, {
 kind: 'approve',
 status: 'error',
 message,
 })
 }
 }

 const requestArtifactChanges = (artifact: SprintEngineArtifact) => {
 const target = focusArtifactProducerTerminal(artifact)
 if (!target) return

 setArtifactAction(artifact.id, {
 kind: 'requestChanges',
 status: 'success',
 message: `Focused ${target.label}. Type your change request in the terminal.`,
 })
 }

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
 const selectedTaskOwnerLabel = selectedTask ? getTaskOwnerLabel(selectedTask, rosterById) : ''
 const selectedTaskNeedsInputNote = selectedTask?.status === 'needs_input'
 ? selectedTask.notes[0] || 'Worker is waiting for input.'
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
 // tasks: graph and kanban both drive task detail.
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
 const activateView = (view: SprintEngineView) => {
 if (fixedView) return
 setActiveView(view)
 }

 const toggleAuto = () => {
 const nextEnabled = !autoEnabled
 const nextMode = nextEnabled ? 'auto' : 'off'
 setAutoRunnerControlEnabled(nextEnabled)
 setSprintEngineAutoEnabled(workspaceId, nextEnabled)
 if (!sprintEngineContext?.statePath) {
 setAutoRunnerControlEnabled(null)
 return
 }
 void (async () => {
 const stateFileExists = await window.api.pathExists(sprintEngineContext.statePath).catch(() => false)
 if (!stateFileExists) {
 setAutoRunnerControlEnabled(null)
 return
 }
 return window.api.setSprintEngineRunnerMode({
 statePath: sprintEngineContext.statePath,
 mode: nextMode,
 })
 })().then(async (result) => {
 if (!result) return
 if (!result.ok) {
 setAutoRunnerControlEnabled(autoEnabled)
 setSprintEngineAutoEnabled(workspaceId, autoEnabled)
 await publishDiagnostic({
 level: 'warning',
 source: 'sprintengine',
 title: 'Roster runner mode was not updated',
 message: result.message,
 workspaceId,
 workspaceName: workspace?.name,
 })
 return
 }
 const projectionApplied = applySprintEngineProjectionContent(
 (result.data as { projectionContent?: unknown } | undefined)?.projectionContent
 )
 if (!projectionApplied) await refreshSprintEngineState()
 setAutoRunnerControlEnabled(null)
 }).catch(async (error) => {
 setAutoRunnerControlEnabled(autoEnabled)
 setSprintEngineAutoEnabled(workspaceId, autoEnabled)
 await publishDiagnostic({
 level: 'warning',
 source: 'sprintengine',
 title: 'Roster runner mode was not updated',
 message: error instanceof Error ? error.message : String(error),
 workspaceId,
 workspaceName: workspace?.name,
 })
 })
 }

 const toggleArtifactAutoApproval = () => {
 setSprintEngineAutoApproveArtifacts(workspaceId, !autoApproveArtifacts)
 }

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

 const openAddMemberDialog = () => {
 const uncoveredRole = addableRoles.find((role) =>
 sprintEngineState.tasks.some((task) => task.role === role && task.status !== 'done')
 && !roster.some((agent) => agent.role === role)
 )
 setAddMemberRole(uncoveredRole ?? 'developer')
 setAddMemberOpen(true)
 }

 const confirmAddMember = async (role = addMemberRole) => {
 if (sprintEngineState.rosterConfigured) {
 if (!architectAgentId || !sprintEngineContext) return
 const agentId = getNextSprintEngineAgentId(role, sprintEngineState.sprintEngineAgents)
 const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
 const label = getAgentName(architectAgentId, fallbackLabel)
 const prompt = buildRosterRevisionPrompt(role, agentId, sprintEngineContext.teamSlug)
 const liveArchitectSession = getLiveAgentTerminalSession(architectAgentId)
 if (liveArchitectSession) {
 await window.api.terminalWrite(liveArchitectSession.sessionId, bracketedTerminalPaste(prompt))
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

 const openAgentTerminal = (agentId: string) => {
 const fallbackLabel = rosterById[agentId]?.label ?? agentId
 const label = getAgentName(agentId, fallbackLabel)
 setSelectedAgentId(agentId)
 void startAgentTerminalWhenReady(agentId, label)
 }

 const openSpawnDialog = (agentId: string) => {
 const agentState = agents[agentId]
 const defaultName = rosterById[agentId]?.label ?? agentId
 const role = rosterById[agentId]?.role
 const defaultCli = role ? workspace?.sprintEngineRoleCliDefaults?.[role] ?? lastSelectedCli : lastSelectedCli
 const savedName = agentState?.name && agentState.name !== defaultName ? agentState.name : ''
 setSelectedAgentId(agentId)
 setCliPickerOpen(false)
 setSpawnDialog({
 agentId,
 cli: agentState?.cli ?? defaultCli,
 name: savedName,
 })
 }

 const confirmSpawnDialog = async () => {
 if (!spawnDialog) return
 const defaultName = rosterById[spawnDialog.agentId]?.label ?? spawnDialog.agentId
 const agentName = normalizeAgentIdentifier(spawnDialog.name)
 const label = agentName || defaultName
 const started = await startAgentTerminalWhenReady(spawnDialog.agentId, label, spawnDialog.cli, {
 agentName,
 freshSession: !spawnDialogHasLiveTerminal,
 })
 if (!started) return
 setCliPickerOpen(false)
 setSpawnDialog(null)
 }

 const openRecoveryDialog = () => {
 setCliPickerOpen(false)
 setRecoveryDialog({ cli: 'codex' })
 }

 const confirmRecoveryAudit = async () => {
 if (!recoveryDialog || !architectAgentId || !folderPath) return
 const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
 const label = getAgentName(architectAgentId, fallbackLabel)

 const started = await startAgentTerminalWhenReady(architectAgentId, label, recoveryDialog.cli, {
 freshSession: true,
 agentName: getCustomAgentName(architectAgentId, fallbackLabel),
 startupPrompt: buildRecoveryAuditPrompt(),
 })
 if (!started) return
 setSelectedAgentId(architectAgentId)
 setCliPickerOpen(false)
 setRecoveryDialog(null)
 }

 const requestPlanReviews = () => {
 if (!folderPath || specialistReviewAgents.length === 0) return

 specialistReviewAgents.forEach((agent) => {
 const label = getAgentName(agent.id, agent.label)
 void startAgentTerminalWhenReady(agent.id, label, agents[agent.id]?.cli, {
 freshSession: true,
 agentName: getCustomAgentName(agent.id, agent.label),
 startupPrompt: buildPlanReviewStartupPrompt(agent.role, agent.id),
 })
 })

 setSelectedAgentId(specialistReviewAgents.at(-1)?.id ?? null)
 }

 const addressPlanReviews = () => {
 if (!folderPath || !architectAgentId) return
 const fallbackLabel = rosterById[architectAgentId]?.label ?? 'Architect'
 const label = getAgentName(architectAgentId, fallbackLabel)

 void startAgentTerminalWhenReady(architectAgentId, label, agents[architectAgentId]?.cli, {
 freshSession: true,
 agentName: getCustomAgentName(architectAgentId, fallbackLabel),
 startupPrompt: buildAddressPlanReviewsPrompt(),
 })
 setSelectedAgentId(architectAgentId)
 }

 const chromeOverflowItems: OverflowMenuItem[] = (() => {
 const items: OverflowMenuItem[] = []
 items.push({
 id: 'refresh',
 label: 'Refresh board',
 onSelect: () => void refreshSprintEngineState(),
 shortcut: '⌘ R',
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
 id: 'toggle-roster-runner',
 label: autoEnabled ? 'Pause roster runner' : 'Start roster runner',
 onSelect: toggleAuto,
 })
 items.push({
 id: 'approve-all-artifacts',
 label: autoApproveArtifacts ? 'Stop approving all artifacts' : 'Approve all artifacts',
 onSelect: toggleArtifactAutoApproval,
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
 shortcut: '⌘ ,',
 })
 return items
 })()

 const inboxArtifactCount = useMemo(
 () => getSprintEngineInboxArtifacts(reviewArtifacts).length,
 [reviewArtifacts]
 )
 const chromeTabItems: TabItem<SprintEngineView>[] = [
 { id: 'inbox', label: 'Inbox', count: inboxArtifactCount > 0 ? inboxArtifactCount : undefined },
 { id: 'roster', label: 'Roster', count: roster.length > 0 ? roster.length : undefined },
 { id: 'tasks', label: 'Tasks', count: sprintEngineState.tasks.length > 0 ? sprintEngineState.tasks.length : undefined },
 ]

 // Listen for CommandPalette dispatches and the cross-cutting ⌘ , chord so the
 // palette and the panel-local overflow/settings popover route through the
 // same handlers. Listeners are registered once with a latest-handler ref so
 // normal re-renders don't churn global window listeners; the ref is refreshed
 // synchronously each render with the live closures it needs to dispatch.
 const commandHandlerRef = useRef<(detail: { id: unknown }) => void>(() => {})
 const settingsChordHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
 commandHandlerRef.current = (detail) => {
 if (!detail || typeof detail.id !== 'string') return
 switch (detail.id) {
 case 'sprintengine.toggle.roster-runner':
 toggleAuto()
 break
 case 'sprintengine.toggle.approve-all':
 toggleArtifactAutoApproval()
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
 ? `The ${sprintEngineRoleLabels[focusAgent.role] ?? focusAgent.role} agent already has a role-task launch on the panel; use that instead.`
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
 settingsChordHandlerRef.current = (event) => {
 if (isEditableTarget(event.target)) return
 if ((event.metaKey || event.ctrlKey) && event.key === ',' && !event.shiftKey && !event.altKey) {
 event.preventDefault()
 setSettingsOpen(true)
 }
 }
 useEffect(() => {
 const onCommand = (event: Event) => {
 commandHandlerRef.current((event as CustomEvent).detail)
 }
 const onKey = (event: KeyboardEvent) => {
 settingsChordHandlerRef.current(event)
 }
 window.addEventListener('multicode:panel-command', onCommand)
 window.addEventListener('keydown', onKey)
 return () => {
 window.removeEventListener('multicode:panel-command', onCommand)
 window.removeEventListener('keydown', onKey)
 }
 }, [])

 // Hero strip: the run's identity (status dot + name + done/total) and the
 // single overflow menu that hosts settings, the runner, plan actions, and
 // verify-progress. Replaces the generic panel header entirely — the panel
 // title and total count were both redundant with the tab strip and per-tab
 // content; the focus-agent primary button moved into the overflow menu.
 const runHero = (
 <header className="relative shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2.5">
 <div className="flex items-center gap-2">
 <StatusDot tone={runPhaseTone} label={`Run phase: ${runPhase}`} />
 <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
 {sprintEngineState.name}
 </h2>
 <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-muted)]">
 {doneCount}/{totalTasks}
 </span>
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
 autoEnabled={autoEnabled}
 autoApproveArtifacts={autoApproveArtifacts}
 cliPermissionPreset={cliPermissionPreset}
 onToggleAuto={toggleAuto}
 onToggleArtifactAutoApproval={toggleArtifactAutoApproval}
 onUpdateCliPreset={updateCliPermissionPreset}
 onVerifyProgress={architectAgentId ? openRecoveryDialog : null}
 onClose={() => setSettingsOpen(false)}
 />
 </Popover>
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
 action={
 <GhostButton onClick={() => focusOrAddComponentTab(workspaceId, 'sprintengine-run-summary', 'Run Summary')}>
 View run summary
 </GhostButton>
 }
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

 {!fixedView ? (
 <div className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
 <Tabs<SprintEngineView>
 ariaLabel="Sprint Engine view"
 items={chromeTabItems}
 value={effectiveView}
 onChange={activateView}
 idPrefix="sprintengine-view"
 className="px-3"
 />
 </div>
 ) : null}

 <div className="sr-only" role="status" aria-live="polite">
 {syncState.message}
 </div>

 {projectionBanner}
 {runCompleteBanner}
 {folderStatusBanner}

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
 {!fixedTasksLayout ? (
 <div className="flex shrink-0 items-center gap-1 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-1.5">
 <div
 role="group"
 aria-label="Tasks layout"
 className="inline-flex items-center gap-0.5 rounded border border-[color:var(--border-default)] bg-[color:var(--bg-app)] p-0.5"
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
 </div>
 ) : null}

 <div className="flex min-h-0 flex-1">
 {inspectorExpanded ? null : effectiveTasksLayout === 'graph' ? (
 <SprintEngineTaskGraphView
 sprintEngineState={sprintEngineState}
 rosterById={rosterById}
 selectedTaskId={selectedTaskId}
 onSelectTask={setSelectedTaskId}
 />
 ) : (
 <div className="flex min-w-0 flex-1 flex-col">
 <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1.5 py-2">
 {sprintEngineState.tasks.length === 0 ? (
 <div className="flex h-full min-h-[320px] w-full items-center justify-center p-6 text-center">
 <div className="max-w-xl">
 <div className="text-[13px] font-semibold text-[color:var(--text-strong)]">
 Waiting for the architect plan
 </div>
 <p className="mt-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
 The board will populate as the architect adds tasks through the Sprint Engine tool.
 </p>
 </div>
 </div>
 ) : null}
 {sprintEngineState.tasks.length > 0 ? boardColumns.map((column) => {
 return (
 <BoardLane
 key={column.key}
 label={column.label}
 count={column.cards.length}
 flipKey={column.cards.map((card) => card.id).join(',')}
 >
 {column.cards.map((task) => {
 const boardColumn = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
 const cardTone: Tone =
 task.status === 'done'
 ? 'good'
 : task.status === 'needs_input'
 ? 'warn'
 : task.status === 'in_progress'
 || boardColumn === 'ready'
 || boardColumn === 'changes_requested'
 || boardColumn === 'review'
 || boardColumn === 'testing'
 || boardColumn === 'product'
 ? 'accent'
 : 'neutral'
 const taskSelected = selectedTaskId === task.id
 const justMoved = recentlyMovedTaskIds.has(task.id)
 const isLive = task.status === 'in_progress'
 return (
 <TaskCard
 key={task.id}
 variant="card"
 tone={cardTone}
 pulse={isLive}
 identifier={task.id}
 title={task.title}
 selected={taskSelected}
 onSelect={() => setSelectedTaskId(task.id)}
 flipKey={task.id}
 justMovedClassName={justMoved ? 'card-just-moved-gold' : undefined}
 trailing={
 <span
 // design-tokens-allow: role glyph is the one place per the redesign where role tones are retained.
 style={{ color: sprintEngineRoleAccent[task.role] }}
 aria-label={`Role: ${sprintEngineRoleLabels[task.role]}`}
 role="img"
 >
 <SprintEngineRoleIcon role={task.role} className="icon-sm" />
 </span>
 }
 />
 )
 })}

 {column.cards.length === 0 ? (
 <li className="m-1 rounded-[5px] px-2 py-3 text-[11px] leading-5 text-[color:var(--text-disabled)]">
 {emptyKanbanColumnLabel(column.key)}
 </li>
 ) : null}
 </BoardLane>
 )
 }) : null}
 </div>
 </div>
 )}

 {renderInspectorAside()}
 </div>
 </div>
 ) : null}

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
 { term: 'Role', description: sprintEngineRoleLabels[spawnDialogAgent.role] },
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
 {addableRoles.map((role) => {
 const selected = role === addMemberRole
 const activeForRole = roster.filter((agent) => agent.role === role).length
 const openTasksForRole = sprintEngineState.tasks.filter(
 (task) => task.role === role && task.status !== 'done'
 ).length

 return (
 <button
 key={role}
 onClick={() => setAddMemberRole(role)}
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
 borderColor: selected ? sprintEngineRoleAccent[role] : 'var(--border-strong)',
 color: 'var(--text-muted)',
 }}
 >
 <SprintEngineRoleIcon role={role} className="icon-md" />
 </span>
 <div className="min-w-0 flex-1">
 <div className="truncate text-sm font-semibold">
 {sprintEngineRoleLabels[role]}
 </div>
 <p className={`mt-1 text-[12px] leading-5 ${selected ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-muted)]'}`}>
 {roleSummaries[role]}
 </p>
 </div>
 <span className={`shrink-0 pt-0.5 text-right text-[11px] font-semibold ${
 selected ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-disabled)]'
 }`}>
 {activeForRole} active / {openTasksForRole} open
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
 {sprintEngineState.rosterConfigured ? 'Ask Architect' : 'Spawn'} {sprintEngineRoleLabels[addMemberRole]}
 </ModalButton>
 </ModalFooter>
 </Modal>
 ) : null}

 </div>
 )
}


function SprintEngineEmptyDetail({ message }: { message: string }) {
 return (
 <section className="flex min-w-0 flex-1 items-center justify-center bg-[color:var(--bg-app)] p-6 text-center">
 <p className="max-w-md text-[12px] leading-5 text-[color:var(--text-muted)]">
 {message}
 </p>
 </section>
 )
}

const SPRINTENGINE_INBOX_TITLE_ID = 'sprintengine-inbox-title'

// Inbox tab: list + detail. The artifact queue sits in the primary content
// column on the left; the inspector fills the remaining width when something
// is selected, and a quiet empty state when not. This matches Watchtower's
// two-pane chrome — the roster lives on its own tab now, so the right pane
// never has to compete for width with a third column. The "Inbox · N"
// header and search live inside the list pane so the active tab carries
// its own identity (the panel-wide hero shows run status, not list state).
function SprintEngineInboxView({
 sprintEngineState,
 reviewArtifacts,
 runPhase,
 selectedArtifactId,
 onSelectArtifact,
 onSelectTask,
 inspectorContent,
 inspectorExpanded,
}: {
 sprintEngineState: SprintEngineState
 reviewArtifacts: SprintEngineArtifact[]
 runPhase: string
 selectedArtifactId: string | null
 onSelectArtifact: (artifactId: string | null) => void
 onSelectTask: (taskId: string) => void
 inspectorContent: React.ReactNode
 inspectorExpanded: boolean
}) {
 const tasksById = useMemo(
 () => Object.fromEntries(sprintEngineState.tasks.map((task) => [task.id, task])),
 [sprintEngineState.tasks]
 )
 const inboxArtifacts = useMemo(
 () => getSprintEngineInboxArtifacts(reviewArtifacts),
 [reviewArtifacts]
 )
 const [search, setSearch] = useState('')
 const visibleArtifacts = useMemo(() => {
 const query = search.trim().toLowerCase()
 if (!query) return inboxArtifacts
 return inboxArtifacts.filter((artifact) => {
 const task = tasksById[artifact.taskId]
 const haystack = [
 artifact.id,
 artifact.title,
 artifact.kind,
 artifact.createdBy,
 task?.id,
 task?.title,
 ]
 .filter(Boolean)
 .join(' ')
 .toLowerCase()
 return haystack.includes(query)
 })
 }, [inboxArtifacts, search, tasksById])
 const blockedByArtifacts = useMemo(() => (
 sprintEngineState.tasks
 .map((task) => ({
 task,
 blockers: getSprintEngineArtifactDependencyBlockers(task, sprintEngineState.tasks, reviewArtifacts),
 }))
 .filter(({ blockers }) => blockers.length > 0)
 ), [reviewArtifacts, sprintEngineState.tasks])

 const inboxEmptyMessage = sprintEngineInboxEmptyMessage(runPhase)
 const filteringActive = search.trim().length > 0
 const emptyMessage =
 filteringActive && inboxArtifacts.length > 0
 ? 'No inbox artifacts match the current search.'
 : inboxEmptyMessage

 // Drop a selection when the search has filtered it out so the inspector
 // never shows an artifact that isn't visible in the list.
 useEffect(() => {
 if (selectedArtifactId && !visibleArtifacts.some((artifact) => artifact.id === selectedArtifactId)) {
 onSelectArtifact(null)
 }
 }, [selectedArtifactId, visibleArtifacts, onSelectArtifact])
 const handleInboxKeyDown = useCallback(
 (event: React.KeyboardEvent<HTMLDivElement>) => {
 if (isEditableTarget(event.target)) return
 if (visibleArtifacts.length === 0) return
 if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
 event.preventDefault()
 const currentIndex = selectedArtifactId
 ? visibleArtifacts.findIndex((artifact) => artifact.id === selectedArtifactId)
 : -1
 const delta = event.key === 'ArrowDown' ? 1 : -1
 let nextIndex: number
 if (currentIndex === -1) {
 nextIndex = event.key === 'ArrowDown' ? 0 : visibleArtifacts.length - 1
 } else {
 nextIndex = (currentIndex + delta + visibleArtifacts.length) % visibleArtifacts.length
 }
 onSelectArtifact(visibleArtifacts[nextIndex].id)
 return
 }
 if (event.key === 'Home') {
 event.preventDefault()
 onSelectArtifact(visibleArtifacts[0].id)
 return
 }
 if (event.key === 'End') {
 event.preventDefault()
 onSelectArtifact(visibleArtifacts[visibleArtifacts.length - 1].id)
 return
 }
 if (event.key === 'Escape' && selectedArtifactId) {
 event.preventDefault()
 onSelectArtifact(null)
 }
 },
 [visibleArtifacts, onSelectArtifact, selectedArtifactId]
 )

 const hasInspector = inspectorContent !== null && inspectorContent !== undefined

 return (
 <div className="flex min-h-0 flex-1 min-w-0">
 {inspectorExpanded ? null : (
 <SidePane as="section" side="left" width="lg" ariaLabelledBy={SPRINTENGINE_INBOX_TITLE_ID}>
 <PanelHeader
 title="Inbox"
 titleId={SPRINTENGINE_INBOX_TITLE_ID}
 count={visibleArtifacts.length}
 />
 <div className="flex shrink-0 items-center gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
 <InboxSearchInput
 value={search}
 onChange={setSearch}
 ariaLabel="Search inbox artifacts"
 />
 </div>
 <div className="flex flex-1 flex-col overflow-auto">
 <div
 tabIndex={0}
 onKeyDown={handleInboxKeyDown}
 className="focus:outline-none"
 role="region"
 aria-label="Inbox artifacts (use arrow keys)"
 >
 {visibleArtifacts.length === 0 ? (
 <div className="px-3 py-6 text-[12px] leading-5 text-[color:var(--text-muted)]">
 {emptyMessage}
 </div>
 ) : (
 <ul>
 {visibleArtifacts.map((artifact) => (
 <li key={artifact.id}>
 <SprintEngineInboxRow
 artifact={artifact}
 task={tasksById[artifact.taskId]}
 selected={selectedArtifactId === artifact.id}
 onSelect={() => onSelectArtifact(artifact.id)}
 />
 </li>
 ))}
 </ul>
 )}
 </div>

 {blockedByArtifacts.length > 0 ? (
 <div role="region" aria-label="Tasks blocked by review">
 <Section
 title="Blocked by review"
 count={blockedByArtifacts.length}
 level={3}
 inset={false}
 className="border-t border-[color:var(--border-default)]"
 >
 <ul>
 {blockedByArtifacts.map(({ task, blockers }) => (
 <li key={task.id}>
 <SprintEngineBlockedByRow
 task={task}
 blockers={blockers}
 selected={false}
 onSelect={() => onSelectTask(task.id)}
 />
 </li>
 ))}
 </ul>
 </Section>
 </div>
 ) : null}
 </div>
 </SidePane>
 )}

 {hasInspector ? (
 <section
 className="flex min-w-0 flex-1 flex-col"
 aria-label="Selected item detail"
 >
 {inspectorContent}
 </section>
 ) : (
 <SprintEngineEmptyDetail
 message={
 inboxArtifacts.length > 0
 ? 'Pick an artifact on the left to review evidence, approve, or request changes.'
 : 'Nothing is queued for review. New artifacts land here as workers finish and reviewers gate them.'
 }
 />
 )}
 </div>
 )
}

// Roster tab: agent list + detail. Mirrors the Inbox shape — roster on the
// left, inspector (with agent-specific actions) on the right when an agent
// is selected. Add-member affordance sticks to the foot of the list rail so
// it stays one click away regardless of how many agents are on board.
function SprintEngineRosterView({
 sprintEngineState,
 roster,
 agents,
 runtimeAgents,
 selectedAgentId,
 onSelectAgent,
 onAddRole,
 isAgentTerminalLive,
 inspectorContent,
 inspectorExpanded,
}: {
 sprintEngineState: SprintEngineState
 roster: SprintEngineAgentRosterItem[]
 agents: Record<string, AgentState>
 runtimeAgents: RuntimeAgentView[]
 selectedAgentId: string | null
 onSelectAgent: (agentId: string) => void
 onAddRole: (role: SprintEngineRole) => void
 isAgentTerminalLive: (agentId: string) => boolean
 inspectorContent: React.ReactNode
 inspectorExpanded: boolean
}) {
 const rosterCountByRole = useMemo(() => {
 const counts = Object.fromEntries(addableRoles.map((role) => [role, 0])) as Record<SprintEngineRole, number>
 for (const agent of roster) {
 counts[agent.role] = (counts[agent.role] ?? 0) + 1
 }
 return counts
 }, [roster])

 const hasInspector = inspectorContent !== null && inspectorContent !== undefined

 return (
 <div className="flex min-h-0 flex-1 min-w-0">
 {inspectorExpanded ? null : (
 <SidePane as="section" side="left" width="lg" ariaLabel="Roster agents">
 <div className="flex-1 overflow-auto">
 {roster.length === 0 ? (
 <div className="px-3 py-6 text-[12px] leading-5 text-[color:var(--text-subtle)]">
 No agents on roster yet. Pick a role below to add the first member.
 </div>
 ) : (
 <ol aria-label="Roster agents">
 {roster.map((agent) => {
 const runtime = runtimeAgents.find((entry) => entry.agentId === agent.id) ?? null
 const hasLiveTerminal = isAgentTerminalLive(agent.id)
 const statusKey = runtime?.status ?? (hasLiveTerminal ? 'running' : 'idle')
 const displayName = agents[agent.id]?.name?.trim() || agent.label
 const roleSlotLabel = agent.label !== displayName ? agent.label : null
 const currentTask = runtime?.currentTaskId
 ? sprintEngineState.tasks.find((task) => task.id === runtime.currentTaskId) ?? null
 : null
 const selected = selectedAgentId === agent.id
 return (
 <li key={agent.id}>
 <button
 type="button"
 onClick={() => onSelectAgent(agent.id)}
 aria-pressed={selected}
 className={`interactive relative flex w-full min-w-0 gap-2.5 px-3 py-2.5 text-left border-b border-[color:var(--border-default)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] focus-visible:ring-inset ${
 selected
 ? 'bg-[color:var(--bg-hover)] pl-[9px] text-[color:var(--text-strong)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r before:bg-[color:var(--accent-primary)]'
 : 'hover:bg-[color:var(--bg-surface)] text-[color:var(--text-default)]'
 }`}
 >
 <RoleAvatar role={agent.role} size="md" className="mt-0.5" ariaLabel="" />
 <span className="min-w-0 flex-1 space-y-0.5">
 <span className="flex min-w-0 items-baseline gap-2">
 <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
 {displayName}
 </span>
 {roleSlotLabel ? (
 <span className="min-w-0 shrink truncate text-[11px] text-[color:var(--text-muted)]">
 {roleSlotLabel}
 </span>
 ) : null}
 </span>
 <span className="flex min-w-0 items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
 <span className="flex shrink-0 items-center gap-1.5">
 <StatusDot tone={runtimeStatusTone(statusKey)} />
 <span className="capitalize">{statusKey}</span>
 </span>
 {currentTask ? (
 <span className="min-w-0 truncate">
 <span className="font-mono text-[color:var(--text-muted)]">{currentTask.id}</span>
 <span className="text-[color:var(--text-disabled)]"> · </span>
 <span>{currentTask.title}</span>
 </span>
 ) : (
 <span className="text-[color:var(--text-disabled)]">No active task</span>
 )}
 </span>
 </span>
 </button>
 </li>
 )
 })}
 </ol>
 )}
 </div>

 <section
 aria-label="Add a roster member"
 className="shrink-0 border-t border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
 >
 <div className="flex items-center justify-between gap-3 px-3 py-2">
 <h4 className="truncate text-[11px] font-semibold text-[color:var(--text-muted)]">
 Add member
 </h4>
 <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-subtle)]">
 {addableRoles.length} roles
 </span>
 </div>
 <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
 {addableRoles.map((role) => {
 const count = rosterCountByRole[role] ?? 0
 const addLabel = `${count > 0 ? 'Add another' : 'Add'} ${sprintEngineRoleLabels[role]}`
 return (
 <Tooltip key={role} content={addLabel}>
 <button
 type="button"
 onClick={() => onAddRole(role)}
 aria-label={addLabel}
 className="interactive inline-flex items-center gap-1.5 rounded border border-dashed border-[color:var(--border-strong)] px-2 py-1 text-[11px] font-medium text-[color:var(--text-default)] transition-colors hover:border-[color:var(--accent-primary-soft)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
 >
 <RoleAvatar role={role} size="xs" ariaLabel="" />
 <span>{sprintEngineRoleLabels[role]}</span>
 {count > 0 ? (
 <span className="ml-0.5 rounded bg-[color:var(--bg-hover)] px-1 tabular-nums text-[color:var(--text-muted)]">
 {count}
 </span>
 ) : null}
 </button>
 </Tooltip>
 )
 })}
 </div>
 </section>
 </SidePane>
 )}

 {hasInspector ? (
 <section
 className="flex min-w-0 flex-1 flex-col"
 aria-label="Selected agent detail"
 >
 {inspectorContent}
 </section>
 ) : (
 <SprintEngineEmptyDetail
 message={
 roster.length > 0
 ? 'Select an agent on the left to open their terminal, see current task, or focus the session.'
 : 'Add a role from the footer to put the first agent on the roster.'
 }
 />
 )}
 </div>
 )
}






function emptyKanbanColumnLabel(column: SprintEngineTaskBoardColumn): string {
 switch (column) {
 case 'ready':
 return 'No ready work. Waiting on dependencies or active workers.'
 case 'changes_requested':
 return 'No rework queued from reviewers or testers.'
 case 'in_progress':
 return 'No workers are actively claiming tasks.'
 case 'review':
 return 'No tasks awaiting review gates.'
 case 'testing':
 return 'No tasks awaiting test verification.'
 case 'product':
 return 'No tasks awaiting product acceptance.'
 case 'needs_input':
 return 'No blocked tasks or worker questions.'
 case 'done':
 return 'Completed work will collect here.'
 default:
 return 'Planned tasks that are waiting on dependencies appear here.'
 }
}







function getTaskOwnerLabel(
 task: SprintEngineTask,
 rosterById: Record<string, { label: string } | undefined>
): string {
 if (task.ownerAgentId) {
 return rosterById[task.ownerAgentId]?.label ?? task.ownerAgentId
 }

 return task.status === 'done' ? sprintEngineRoleLabels[task.role] : 'No active worker'
}

function getRunPhase(sprintEngineState: SprintEngineState, runtimeAgents: RuntimeAgentView[]): string {
 if (sprintEngineState.tasks.length > 0 && sprintEngineState.tasks.every((task) => task.status === 'done')) {
 return 'Complete'
 }
 if (runtimeAgents.some((agent) => agent.status === 'running' || agent.status === 'needs_input')) {
 return 'Running'
 }
 if (sprintEngineState.tasks.length > 0) {
 return 'Tasked'
 }
 return 'Planning'
}


function buildRecoveryAuditPrompt(): string {
 return [
 'Fetch the canonical recovery instructions from the Python tool.',
 'Run `sprintengine recover` now.',
 ].join('\n')
}

function buildPlanReviewStartupPrompt(role: SprintEngineRole, agentId: string): string {
 return [
 'Fetch the canonical plan review instructions from the Python tool.',
 `Run \`Sprint Engine plan start-review --role ${role} --id ${agentId}\` now.`,
 ].join('\n')
}

function buildAddressPlanReviewsPrompt(): string {
 return [
 'Fetch the canonical plan review feedback instructions from the Python tool.',
 'Run `Sprint Engine plan address-reviews --actor architect` now.',
 ].join('\n')
}

function bracketedTerminalPaste(text: string): string {
 return `\x1b[200~${text.replace(/\r?\n/g, '\n')}\x1b[201~\r`
}

function buildRosterRevisionPrompt(role: SprintEngineRole, agentId: string, teamSlug: string): string {
 return [
 'Revise this Sprint Engine plan for a newly added roster member.',
 `Team: \`${teamSlug}\``,
 `New roster member: ${sprintEngineRoleLabels[role]} (\`${role}\`) with agent id \`${agentId}\`.`,
 '',
 'First add the member to the canonical Sprint Engine roster:',
 '',
 '```shell',
 `sprintengine roster add --role ${role} --id ${agentId} --actor architect`,
 '```',
 '',
 'Then inspect the current plan, task graph, completed evidence, and open risks. If this new specialist should do work, add only the needed task cards with normal `Sprint Engine plan add-task` commands and correct dependencies. If no task is needed, record a concise rationale in the architect terminal and stop.',
 '',
 'Do not implement work yourself. Do not create tasks for unrelated roles. Do not edit Sprint Engine run-store files directly.',
 ].join('\n')
}
