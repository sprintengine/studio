import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
 PanelHeader,
 Tabs,
 OverflowMenu,
 PrimaryButton,
 GhostButton,
 StatusDot,
 Section,
 Select,
 Switch,
 TaskCard,
 type OverflowMenuItem,
 type TabItem,
 type Tone,
} from '../ui'
import { useFlipReorder } from '../../utils/flipReorder'
import { Modal, ModalBody, ModalButton, ModalFooter } from '../ui/Modal'
import { focusOrAddComponentTab } from '../../utils/modelRegistry'
import {
 buildRunSummary,
 feedbackFindingAreaLabels,
 feedbackFindingKindLabels,
 feedbackFindingSeverityLabels,
 feedbackFindingStatusLabels,
 feedbackIssueCategoryLabels,
 feedbackIssueSeverityLabels,
 feedbackIssueStatusLabels,
 feedbackScoreLabels,
 formatSprintEngineGoal,
} from '../../utils/sprintengineRunSummary'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import type {
 AgentCli,
 AgentExecution,
 SprintEngineArtifact,
 SprintEngineCliPermissionPreset,
 SprintEngineRole,
 SprintEngineState,
 SprintEngineTask,
 SprintEngineTaskBoardColumn,
 SprintEngineTaskFeedback,
 SprintEngineTaskFeedbackFinding,
 SprintEngineTaskFeedbackIssue,
 SprintEngineTaskStatus,
} from '../../types/workspace'
import { SprintEngineRoleIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import {
 buildSprintEngineAgentRosterForState,
 getSprintEngineArtifactAutoApprovalEligibility,
 getNextSprintEngineAgentId,
 getReviewableSprintEngineArtifacts,
 getSprintEngineArtifactDependencyBlockers,
 getSprintEngineArtifactsByTaskId,
 getSprintEngineTaskBoardColumn,
 sprintEngineRoleAccent,
 sprintEngineArtifactKindLabels,
 sprintEngineArtifactStatusLabels,
 sprintEngineRoleLabels,
} from '../../utils/sprintengine'
import { renderMarkdown } from '../../utils/markdown'
import { formatRelativeTime } from '../../utils/switchboardBoard'
import { normalizeAgentIdentifier, prependAgentIdentifier } from '../../utils/agentPrompt'
import {
 parseSprintEngineStateFile,
} from '../../utils/sprintengineStateFile'
import { focusOrAddAgentTab, focusOrAddFileTab } from '../../utils/modelRegistry'
import { publishDiagnostic, publishDiagnosticSync } from '../../utils/diagnostics'
import { sendArtifactApprovalToTerminal } from '../../utils/terminalApproval'

const columnMeta: { key: SprintEngineTaskBoardColumn; label: string }[] = [
 { key: 'todo', label: 'Todo' },
 { key: 'ready', label: 'Ready' },
 { key: 'in_progress', label: 'In Progress' },
 { key: 'needs_input', label: 'Needs Input' },
 { key: 'done', label: 'Done' },
]

function isEditableTarget(target: EventTarget | null): boolean {
 if (!(target instanceof HTMLElement)) return false
 const tag = target.tagName
 if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
 if (target.isContentEditable) return true
 return false
}

function KanbanCardList({
 children,
 animateKey,
}: {
 children: React.ReactNode
 animateKey: string
}) {
 const ref = useRef<HTMLOListElement | null>(null)
 useFlipReorder(ref, animateKey)
 return (
 <ol ref={ref} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2">
 {children}
 </ol>
 )
}

const taskStateLabel: Record<SprintEngineTaskStatus, string> = {
 todo: 'Todo',
 in_progress: 'In Progress',
 needs_input: 'Needs Input',
 done: 'Done',
}

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

function ZoomInSprintEngineIcon() {
 return (
 <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
 <path
 d="M7.25 11.25a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm2.9-1.1 3.1 3.1M7.25 5.45v3.6M5.45 7.25h3.6"
 stroke="currentColor"
 strokeWidth="1.35"
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 </svg>
 )
}

function ZoomOutSprintEngineIcon() {
 return (
 <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
 <path
 d="M7.25 11.25a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm2.9-1.1 3.1 3.1M5.45 7.25h3.6"
 stroke="currentColor"
 strokeWidth="1.35"
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 </svg>
 )
}

function ResetGraphZoomIcon() {
 return (
 <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
 <path
 d="M12.75 5.5A5 5 0 1 0 13 8m-.25-2.5V2.75m0 2.75H10"
 stroke="currentColor"
 strokeWidth="1.35"
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 </svg>
 )
}

function FitGraphZoomIcon() {
 return (
 <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5" fill="none">
 <path
 d="M3.25 6V3.25H6m4 0h2.75V6m0 4v2.75H10m-4 0H3.25V10"
 stroke="currentColor"
 strokeWidth="1.35"
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 </svg>
 )
}

function getParentDirectoryPath(path: string): string {
 const trimmed = path.replace(/[\\/]+$/, '')
 const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
 return separatorIndex >= 0 ? trimmed.slice(0, separatorIndex) : trimmed
}

function getBaseName(path: string): string {
 const trimmed = path.replace(/[\\/]+$/, '')
 const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
 return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed
}

type OpenedSprintEngineArtifact = {
 path: string
 name: string
 content: string
}

function joinFilePath(basePath: string, childPath: string): string {
 const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/'
 return `${basePath.replace(/[\\/]+$/, '')}${separator}${childPath.replace(/^[\\/]+/, '')}`
}

function isAbsoluteFilePath(path: string): boolean {
 return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)
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

 const teamDirectory = getParentDirectoryPath(statePath)
 const workspaceRoot = getParentDirectoryPath(getParentDirectoryPath(getParentDirectoryPath(teamDirectory)))
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
}

type SyncState = {
 status: 'idle' | 'syncing' | 'live' | 'error'
 message: string
}


type SprintEngineView = 'project' | 'task-graph' | 'kanban'

type SpawnDialogState = {
 agentId: string
 cli: AgentCli
 name: string
}

type RecoveryDialogState = {
 cli: AgentCli
}

type ArtifactActionKind = 'open' | 'approve' | 'requestChanges'

type ArtifactActionState = {
 kind: ArtifactActionKind
 status: 'pending' | 'success' | 'error'
 message: string
}

type TaskReadyActionState = {
 status: 'pending' | 'success' | 'error'
 message: string
}

function buildWorkerRespawnStartupPrompt(
 role: SprintEngineRole,
 agentId: string
): string {
 return [
 'Fetch the canonical Sprint Engine instructions from the Python tool.',
 `You are assigned role: ${role}. Only claim and work Sprint Engine tasks whose role exactly matches ${role}. Use the Sprint Engine join/task-next flow with this same agent id. If no ${role} task is ready, wait briefly with a foreground sleep/backoff, then retry while this Sprint Engine roster session remains active. Do not leave a background polling loop running, and stop all idle retrying as soon as a task is returned. After you claim one task, focus only on that task: complete it, publish evidence, mark it done, then stop. Stop earlier if you are blocked, you need user input, or your context window is about 70% full. At about 70% context, publish a concise continuation note, compact or restart, fetch your Soul again, rerun the Sprint Engine join command with this same id, and continue. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role.`,
 'On Windows, prefer the repo virtual environment command if `sprintengine` or global Python is unreliable:',
 [
 '```powershell',
 `& ".\\.venv\\Scripts\\python.exe" .\\scripts\\sprintengine_tool.py join --role ${role} --id ${agentId}`,
 '```',
 ].join('\n'),
 'Otherwise run:',
 `\`\`\`\nsprintengine join --role ${role} --id ${agentId}\n\`\`\``,
 ].filter(Boolean).join('\n\n')
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
 useEffect(() => {
 const onKey = (event: KeyboardEvent) => {
 if (event.key === 'Escape') {
 event.preventDefault()
 onClose()
 }
 }
 const onPointer = (event: MouseEvent) => {
 const target = event.target as Node | null
 if (!target) return
 if (containerRef.current?.contains(target)) return
 onClose()
 }
 window.addEventListener('keydown', onKey)
 window.addEventListener('mousedown', onPointer)
 return () => {
 window.removeEventListener('keydown', onKey)
 window.removeEventListener('mousedown', onPointer)
 }
 }, [onClose])
 const currentPresetLabel =
 sprintEngineCliPermissionOptions.find((option) => option.value === cliPermissionPreset)?.label
 ?? cliPermissionPreset
 return (
 <div
 ref={containerRef}
 role="dialog"
 aria-label="Sprint Engine settings"
 tabIndex={-1}
 onKeyDown={onPanelKey}
 className="popover-enter absolute right-3 top-full z-30 mt-1 w-[280px] overflow-hidden rounded-[7px] border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] py-1"
 >
 <Section title="Run" level={3} inset={true}>
 <div className="flex flex-col gap-2">
 <div className="flex items-center justify-between gap-3 text-[12px] text-[color:var(--text-default)]">
 <span id="sprintengine-settings-auto-label">Auto roster runner</span>
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
 disabled={!autoEnabled}
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

export default function SprintEngineBoardPanel({ workspaceId, fixedView }: Props) {
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
 // Switching tasks clears the artifact preview so the aside returns to
 // task detail. Opening an artifact does not change selectedTaskId, so
 // this only fires on a real navigation.
 useEffect(() => {
 setPreviewedArtifact(null)
 }, [selectedTaskId])
 const [activeView, setActiveView] = useState<SprintEngineView>('project')
 const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
 const [spawnDialog, setSpawnDialog] = useState<SpawnDialogState | null>(null)
 const [recoveryDialog, setRecoveryDialog] = useState<RecoveryDialogState | null>(null)
 const [cliPickerOpen, setCliPickerOpen] = useState(false)
 const [settingsOpen, setSettingsOpen] = useState(false)
 const [addMemberOpen, setAddMemberOpen] = useState(false)
 const [addMemberRole, setAddMemberRole] = useState<SprintEngineRole>('developer')
 const [manualRefreshBusy, setManualRefreshBusy] = useState(false)
 const [artifactActions, setArtifactActions] = useState<Record<string, ArtifactActionState>>({})
 const [taskReadyActions, setTaskReadyActions] = useState<Record<string, TaskReadyActionState>>({})
 const [syncState, setSyncState] = useState<SyncState>({
 status: 'idle',
 message: 'Waiting for a Sprint Engine workspace folder.',
 })

 const sprintEngineState = workspace?.sprintEngineState ?? null
 const sprintEngineContext = workspace?.sprintEngineContext ?? null
 const effectiveView = fixedView ?? activeView
 const folderPath = folderReadyPath
 const agents = workspace?.agents ?? {}
 const terminalSessions = useTerminalSessions()
 const autoEnabled = workspace?.sprintEngineAutoState?.enabled ?? false
 const autoApproveArtifacts = workspace?.sprintEngineAutoState?.autoApproveArtifacts ?? false
 const cliPermissionPreset = workspace?.sprintEngineAutoState?.cliPermissionPreset ?? 'default'

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
 sprintEngineState?.tasks.filter(
 (task) => getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks) === 'ready'
 ) ?? []
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
 ) {
 const current = agents[agentId]
 const selectedCli = cli ?? current?.cli ?? 'codex'
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
 startAgentTerminal(agentId, label, cli, options)
 return true
 }

 const boardColumns = useMemo(() => {
 if (!sprintEngineState) return []

 return columnMeta.map((column) => ({
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

 // Close the docked task-detail inspector with Escape from non-kanban views.
 // Kanban view has its own Escape handler scoped to the board grid.
 useEffect(() => {
 if (!selectedTaskId || effectiveView === 'kanban') return
 const onKeyDown = (event: KeyboardEvent) => {
 if (event.key !== 'Escape') return
 if (isEditableTarget(event.target)) return
 event.preventDefault()
 setSelectedTaskId(null)
 }
 window.addEventListener('keydown', onKeyDown)
 return () => window.removeEventListener('keydown', onKeyDown)
 }, [selectedTaskId, effectiveView])

 const handleKanbanKeyDown = useCallback(
 (event: React.KeyboardEvent<HTMLDivElement>) => {
 if (effectiveView !== 'kanban') return
 if (isEditableTarget(event.target)) return
 if (event.metaKey || event.ctrlKey || event.altKey) return

 if (event.key === 'Escape') {
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
 [boardColumns, effectiveView, selectedTaskId]
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
 const architectAgentId = roster.find((agent) => agent.role === 'architect')?.id ?? null
 const resolvedSelectedAgentId = selectedAgentId ?? architectAgentId ?? roster[0]?.id ?? null
 const workerRoles: SprintEngineRole[] = ['developer', 'frontend', 'product', 'code_reviewer', 'spec_reviewer', 'performance', 'tester', 'security']
 const roleTaskLaunches = workerRoles.flatMap((role) => {
 const activeTask = sprintEngineState.tasks.find((task) =>
 task.role === role && (task.status === 'in_progress' || task.status === 'needs_input')
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
 const content = await window.api.readfile(stateFilePath)
 const parsed = parseSprintEngineStateFile(content, getBaseName(getParentDirectoryPath(stateFilePath)))
 setSprintEngineState(workspaceId, parsed)
 setSyncState({
 status: 'live',
 message: `Refreshed ${parsed.tasks.length} tasks from ${stateFilePath}`,
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

 const markTaskReady = async (task: SprintEngineTask) => {
 if (!sprintEngineContext?.statePath) {
 setSyncState({
 status: 'error',
 message: 'This Sprint Engine workspace is missing its selected team context.',
 })
 return
 }

 setTaskReadyActions((current) => ({
 ...current,
 [task.id]: { status: 'pending', message: 'Moving task to Ready...' },
 }))
 try {
 const result = await window.api.readySprintEngineTask(sprintEngineContext.statePath, task.id)
 if (!result.ok) throw new Error(result.message)

 const data = result.data && typeof result.data === 'object'
 ? result.data as { stateContent?: unknown }
 : {}
 if (typeof data.stateContent === 'string') {
 const parsed = parseSprintEngineStateFile(data.stateContent, sprintEngineContext.teamName)
 setSprintEngineState(workspaceId, parsed)
 } else {
 await refreshSprintEngineState()
 }

 setTaskReadyActions((current) => ({
 ...current,
 [task.id]: { status: 'success', message: 'Task moved to Ready.' },
 }))
 setSyncState({
 status: 'live',
 message: `Moved ${task.id} to Ready.`,
 })
 } catch (error) {
 const message = error instanceof Error ? error.message : 'Failed to move task to Ready.'
 setTaskReadyActions((current) => ({
 ...current,
 [task.id]: { status: 'error', message },
 }))
 setSyncState({ status: 'error', message })
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
 name: getBaseName(artifactPath) || artifact.title || artifact.id,
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

 updateAgent(workspaceId, agentId, {
 cliSessionId: runningSession.sessionId,
 cliStartRequested: true,
 cliHasLaunched: true,
 cliResumeAvailable: (runningSession.cli ?? agents[agentId]?.cli ?? 'codex') === 'codex',
 cli: runningSession.cli ?? agents[agentId]?.cli ?? 'codex',
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
 const selectedTaskBoardColumn = selectedTask
 ? getSprintEngineTaskBoardColumn(selectedTask, sprintEngineState.tasks)
 : null
 const selectedTaskStatusLabel = selectedTask
 ? selectedTaskBoardColumn === 'ready' ? 'Ready' : taskStateLabel[selectedTask.status]
 : ''
 const selectedTaskOwnerLabel = selectedTask ? getTaskOwnerLabel(selectedTask, rosterById) : ''
 const selectedTaskNeedsInputNote = selectedTask?.status === 'needs_input'
 ? selectedTask.notes[0] || 'Worker is waiting for input.'
 : null
 const selectedTaskCanMarkReady = selectedTask?.status === 'todo'
 && !selectedTask.ownerAgentId
 && selectedTask.dispatch?.mode === 'manual'
 && selectedTask.dispatch.status !== 'ready'
 const selectedTaskCanSpawnWorker = selectedTaskBoardColumn === 'ready' && !selectedTask?.ownerAgentId
 const selectedTaskCanManageWorker = selectedTask?.status === 'in_progress' || selectedTask?.status === 'needs_input'
 const selectedTaskOwnerHasLiveTerminal = selectedTask?.ownerAgentId
 ? isAgentTerminalLive(selectedTask.ownerAgentId)
 : false
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
 const inspectorSelection: SprintEngineInspectorSelection | null = previewedArtifact
 ? { kind: 'artifact', artifact: previewedArtifact }
 : selectedTask
 ? { kind: 'task', task: selectedTask }
 : inspectorSelectedAgent
 ? { kind: 'agent', agent: inspectorSelectedAgent }
 : null
 const closeInspector = () => {
 setSelectedTaskId(null)
 setSelectedAgentId(null)
 setPreviewedArtifact(null)
 }
 const renderInspectorAside = () => inspectorSelection ? (
 <aside
 className="flex w-[42%] min-w-[320px] max-w-[560px] flex-col border-l border-[color:var(--border-default)]"
 aria-label="Sprint Engine inspector"
 >
 <SprintEngineInspectorPanel
 selection={inspectorSelection}
 sprintEngineState={sprintEngineState}
 runtimeAgents={runtimeAgents}
 tasksById={tasksById}
 selectedTaskBoardColumn={selectedTaskBoardColumn}
 selectedTaskStatusLabel={selectedTaskStatusLabel}
 selectedTaskOwnerLabel={selectedTaskOwnerLabel}
 selectedTaskNeedsInputNote={selectedTaskNeedsInputNote}
 selectedTaskCanMarkReady={selectedTaskCanMarkReady}
 selectedTaskCanSpawnWorker={selectedTaskCanSpawnWorker}
 selectedTaskCanManageWorker={selectedTaskCanManageWorker}
 selectedTaskOwnerCliRunning={selectedTaskOwnerHasLiveTerminal}
 selectedTaskArtifacts={selectedTaskArtifacts}
 selectedTaskArtifactBlockers={selectedTaskArtifactBlockers}
 taskReadyActions={taskReadyActions}
 artifactActions={artifactActions}
 onClose={closeInspector}
 onSelectTask={setSelectedTaskId}
 onMarkTaskReady={markTaskReady}
 onOpenReadyTaskWorker={openReadyTaskWorker}
 onOpenArtifact={openArtifact}
 onApproveArtifact={approveArtifact}
 onRequestArtifactChanges={requestArtifactChanges}
 onBackFromArtifact={() => setPreviewedArtifact(null)}
 onPopOutArtifact={popOutPreviewedArtifact}
 onSpawnAgent={openSpawnDialog}
 onOpenAgentTerminal={openAgentTerminal}
 isAgentTerminalLive={isAgentTerminalLive}
 />
 </aside>
 ) : null
 const activateView = (view: SprintEngineView) => {
 if (fixedView) return
 setActiveView(view)
 }

 const toggleAuto = () => {
 setSprintEngineAutoEnabled(workspaceId, !autoEnabled)
 }

 const toggleArtifactAutoApproval = () => {
 if (!autoEnabled) return
 setSprintEngineAutoApproveArtifacts(workspaceId, !autoApproveArtifacts)
 }

 const updateCliPermissionPreset = (preset: SprintEngineCliPermissionPreset) => {
 if (preset === 'bypass_all') {
 const confirmed = window.confirm(
 'Bypass permissions lets spawned Sprint Engine agents run without CLI approval prompts. Use this only in repositories and environments you trust.'
 )
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
 const started = await startAgentTerminalWhenReady(architectAgentId, label, agents[architectAgentId]?.cli ?? 'codex', {
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
 const savedName = agentState?.name && agentState.name !== defaultName ? agentState.name : ''
 setSelectedAgentId(agentId)
 setCliPickerOpen(false)
 setSpawnDialog({
 agentId,
 cli: agentState?.cli ?? 'codex',
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

 const openReadySpawnDialogForRole = (role: SprintEngineRole) => {
 const existing = roster.find((agent) =>
 agent.role === role
 && runtimeAgentById[agent.id]?.status !== 'done'
 && !isAgentTerminalLive(agent.id)
 )
 ?? roster.find((agent) =>
 agent.role === role
 && runtimeAgentById[agent.id]?.status !== 'done'
 )
 const agent = existing ?? addSprintEngineMember(workspaceId, role)
 if (!agent) return

 openSpawnDialog(agent.id)
 }

 const openReadyTaskWorker = (task: SprintEngineTask) => {
 if (task.ownerAgentId) {
 const agentId = task.ownerAgentId
 const agent = rosterById[agentId]
 const fallbackLabel = agent?.label ?? agentId
 const label = getAgentName(agentId, fallbackLabel)

 if (isAgentTerminalLive(agentId)) {
 openAgentTerminal(agentId)
 return
 }

 setSelectedAgentId(agentId)
 void startAgentTerminalWhenReady(agentId, label, agents[agentId]?.cli ?? 'codex', {
 freshSession: true,
 agentName: getCustomAgentName(agentId, fallbackLabel),
 startupPrompt: buildWorkerRespawnStartupPrompt(agent?.role ?? task.role, agentId),
 })
 return
 }

 openReadySpawnDialogForRole(task.role)
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
 void startAgentTerminalWhenReady(agent.id, label, agents[agent.id]?.cli ?? 'codex', {
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

 void startAgentTerminalWhenReady(architectAgentId, label, agents[architectAgentId]?.cli ?? 'codex', {
 freshSession: true,
 agentName: getCustomAgentName(architectAgentId, fallbackLabel),
 startupPrompt: buildAddressPlanReviewsPrompt(),
 })
 setSelectedAgentId(architectAgentId)
 }

 // State-bound primary action: exactly one button surfaces in the header. The
 // priority ladder mirrors the run lifecycle — verify when complete, hand off
 // ready worker work, focus a stuck agent, spawn architect during planning.
 const chromePrimaryAction: { label: string; onClick: () => void } | null = (() => {
 if (allTasksDone && architectAgentId) {
 return { label: 'Verify progress', onClick: openRecoveryDialog }
 }
 const firstLaunch = roleTaskLaunches[0]
 if (firstLaunch) {
 const ownerAgentId = firstLaunch.task.ownerAgentId
 const targetAgentId = ownerAgentId ?? firstLaunch.agent?.id ?? null
 const targetHasLiveTerminal = targetAgentId ? isAgentTerminalLive(targetAgentId) : false
 const targetLabel = ownerAgentId
 ? firstLaunch.agent?.label ?? ownerAgentId
 : firstLaunch.agent?.label ?? sprintEngineRoleLabels[firstLaunch.role]
 const label = ownerAgentId
 ? targetHasLiveTerminal
 ? `Open ${targetLabel}`
 : `Respawn ${targetLabel}`
 : targetHasLiveTerminal
 ? `Open ${targetLabel}`
 : `Spawn ${sprintEngineRoleLabels[firstLaunch.role]}`
 return {
 label,
 onClick: () => {
 if (!ownerAgentId && targetAgentId && targetHasLiveTerminal) {
 openAgentTerminal(targetAgentId)
 } else {
 openReadyTaskWorker(firstLaunch.task)
 }
 },
 }
 }
 if (showFocusAgentAction && focusAgent) {
 const label = focusAgentHasLiveTerminal
 ? `Open ${focusAgentRoster?.label ?? focusAgent.agentId}`
 : `Spawn ${focusAgentRoster?.label ?? focusAgent.agentId}`
 return {
 label,
 onClick: () => {
 if (focusAgentHasLiveTerminal) {
 openAgentTerminal(focusAgent.agentId)
 } else {
 openSpawnDialog(focusAgent.agentId)
 }
 },
 }
 }
 if (architectAgentId && showPlanningActions) {
 const liveArchitect = isAgentTerminalLive(architectAgentId)
 return {
 label: liveArchitect ? 'Open Architect' : 'Spawn Architect',
 onClick: () => openSpawnDialog(architectAgentId),
 }
 }
 return null
 })()

 const chromeOverflowItems: OverflowMenuItem[] = (() => {
 const items: OverflowMenuItem[] = []
 items.push({
 id: 'refresh',
 label: 'Refresh board',
 onSelect: () => void refreshSprintEngineState(),
 shortcut: '⌘ R',
 disabled: !folderPath || manualRefreshBusy,
 })
 if (focusAgent && !chromePrimaryAction) {
 items.push({
 id: 'focus-agent',
 label: focusAgentHasLiveTerminal
 ? `Focus ${focusAgentRoster?.label ?? focusAgent.agentId}`
 : `Spawn ${focusAgentRoster?.label ?? focusAgent.agentId}`,
 onSelect: () => {
 if (focusAgentHasLiveTerminal) openAgentTerminal(focusAgent.agentId)
 else openSpawnDialog(focusAgent.agentId)
 },
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
 disabled: !autoEnabled,
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

 const chromePrimaryButton = chromePrimaryAction ? (
 <PrimaryButton onClick={chromePrimaryAction.onClick}>{chromePrimaryAction.label}</PrimaryButton>
 ) : null

 const chromeTabItems: TabItem<SprintEngineView>[] = [
 { id: 'project', label: 'Project' },
 { id: 'task-graph', label: 'Graph' },
 { id: 'kanban', label: 'Kanban' },
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
 if (focusAgent && showFocusAgentAction) {
 if (focusAgentHasLiveTerminal) openAgentTerminal(focusAgent.agentId)
 else openSpawnDialog(focusAgent.agentId)
 } else {
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
 case 'sprintengine.goto.project':
 if (!fixedView) setActiveView('project')
 break
 case 'sprintengine.goto.graph':
 if (!fixedView) setActiveView('task-graph')
 break
 case 'sprintengine.goto.kanban':
 if (!fixedView) setActiveView('kanban')
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

 return (
 <div className="relative flex h-full flex-col overflow-hidden bg-[color:var(--bg-app)] text-[color:var(--text-strong)]">
 {/* Sprint Engine chrome — PanelHeader + Tabs + state-bound primary + overflow.
 Auto-runner, approve-all, CLI preset, and verify-progress live in the
 Settings popover. Sync status is announced via aria-live; visible
 workspace status bar wiring is owed to a follow-up task. */}
 <div className="relative shrink-0 bg-[color:var(--bg-surface)]">
 <PanelHeader
 tool="sprintengine"
 title="Sprint Engine"
 count={sprintEngineState.tasks.length}
 primaryAction={chromePrimaryButton}
 overflow={
 <OverflowMenu ariaLabel="Sprint Engine overflow" items={chromeOverflowItems} />
 }
 />
 {!fixedView ? (
 <Tabs<SprintEngineView>
 ariaLabel="Sprint Engine view"
 items={chromeTabItems}
 value={effectiveView}
 onChange={activateView}
 idPrefix="sprintengine-view"
 className="px-3"
 />
 ) : null}
 <div className="sr-only" role="status" aria-live="polite">
 {syncState.message}
 </div>
 {settingsOpen ? (
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
 ) : null}
 </div>

 {folderStatusBanner}

 {effectiveView === 'project' ? (
 <div
 id="sprintengine-view-panel-project"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-project"
 tabIndex={0}
 className="flex min-h-0 flex-1"
 >
 <SprintEngineProjectView
 sprintEngineState={sprintEngineState}
 roster={roster}
 runtimeAgents={runtimeAgents}
 runPhase={runPhase}
 doneCount={doneCount}
 allTasksDone={allTasksDone}
 runSummary={runSummary}
 onViewRunSummary={() =>
 focusOrAddComponentTab(workspaceId, 'sprintengine-run-summary', 'Run Summary')
 }
 reviewArtifacts={reviewArtifacts}
 artifactActions={artifactActions}
 selectedAgentId={resolvedSelectedAgentId}
 onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
 onSelectTask={setSelectedTaskId}
 onAddRole={(role) => {
 void confirmAddMember(role)
 }}
 onOpenArtifact={(artifact) => void openArtifact(artifact)}
 onApproveArtifact={(artifact) => void approveArtifact(artifact)}
 onRequestArtifactChanges={requestArtifactChanges}
 isAgentTerminalLive={isAgentTerminalLive}
 />
 {renderInspectorAside()}
 </div>
 ) : null}

 {effectiveView === 'task-graph' ? (
 <div
 id="sprintengine-view-panel-task-graph"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-task-graph"
 tabIndex={0}
 className="flex min-h-0 flex-1"
 >
 <SprintEngineTaskGraphView
 sprintEngineState={sprintEngineState}
 rosterById={rosterById}
 selectedTaskId={selectedTaskId}
 onSelectTask={setSelectedTaskId}
 />
 {renderInspectorAside()}
 </div>
 ) : null}

 {effectiveView === 'kanban' ? (
 <div
 id="sprintengine-view-panel-kanban"
 role="tabpanel"
 aria-labelledby="sprintengine-view-tab-kanban"
 className="flex min-h-0 flex-1 bg-[color:var(--bg-app)] focus:outline-none"
 tabIndex={0}
 onKeyDown={handleKanbanKeyDown}
 aria-label="Sprint Engine kanban"
 >
 <div className="flex min-w-0 flex-1 flex-col">
 {/* Inner Kanban header dropped; panel-level PanelHeader carries the
 count and the Tabs strip carries the view name. Keyboard hint is
 announced to AT via the kanban container aria-label. */}
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
 <section
 key={column.key}
 className="flex h-full min-w-[260px] flex-1 flex-col"
 aria-label={`${column.label} lane`}
 >
 <div className="flex items-center justify-between gap-2 px-2 py-1.5">
 <span className="truncate text-[12px] font-medium text-[color:var(--text-default)]">
 {column.label}
 </span>
 <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-muted)]">
 {column.cards.length}
 </span>
 </div>
 <KanbanCardList animateKey={column.cards.map((card) => card.id).join(',')}>
 {column.cards.map((task) => {
 // Kanban card surface is intentionally minimal — status dot, ID,
 // title, role glyph. All chips, attention quotes, artifact pills,
 // mobile-decision flags, action buttons, and the Ready gate move
 // to the inspector aside on selection.
 const boardColumn = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
 const cardTone: Tone =
 task.status === 'done'
 ? 'good'
 : task.status === 'needs_input'
 ? 'warn'
 : task.status === 'in_progress' || boardColumn === 'ready'
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
 <SprintEngineRoleIcon role={task.role} className="h-3.5 w-3.5" />
 </span>
 }
 />
 )
 })}

 {column.cards.length === 0 ? (
 <div className="m-1 rounded-[5px] px-2 py-3 text-[11px] leading-5 text-[color:var(--text-disabled)]">
 {emptyKanbanColumnLabel(column.key)}
 </div>
 ) : null}
 </KanbanCardList>
 </section>
 )
 }) : null}
 </div>
 </div>

 {renderInspectorAside()}
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
 The Architect will back up state.yaml, check each task in order, and update task status through the sprintengine Python tool.
 </p>
 </div>
 <button
 type="button"
 onClick={() => {
 setCliPickerOpen(false)
 setRecoveryDialog(null)
 }}
 aria-label="Close"
 className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] interactive transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary-soft)]"
 >
 <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
 <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
 </svg>
 </button>
 </div>

 <ModalBody className="space-y-4">
 <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
 <MetaItem label="Tasks" value={`${sprintEngineState.tasks.length} to check`} />
 <MetaItem label="Backup" value="state-timestamp.yaml" />
 </div>

 <div className="relative">
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Architect CLI
 </div>
 <button
 type="button"
 onClick={() => setCliPickerOpen((open) => !open)}
 aria-haspopup="listbox"
 aria-expanded={cliPickerOpen}
 className="flex min-h-[58px] w-full items-center gap-3 rounded-md bg-[color:var(--bg-surface-raised)] px-3 text-left text-[color:var(--text-strong)] outline-none interactive transition-colors hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--border-strong)]"
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
 className={`h-4 w-4 shrink-0 text-[color:var(--text-disabled)] transition-transform ${cliPickerOpen ? 'rotate-180' : ''}`}
 viewBox="0 0 20 20"
 fill="none"
 aria-hidden="true"
 xmlns="http://www.w3.org/2000/svg"
 >
 <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>

 {cliPickerOpen ? (
 <div
 role="listbox"
 // design-tokens-allow: CLI picker popover elevation reuses the canonical shadow.
 className="popover-enter absolute left-0 right-0 top-[76px] z-30 overflow-hidden rounded-md bg-[color:var(--bg-surface)] p-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]"
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
 <svg className="h-4 w-4 shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
 <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 ) : null}
 </button>
 )
 })}
 </div>
 ) : null}
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
 <button
 type="button"
 onClick={() => {
 setCliPickerOpen(false)
 setSpawnDialog(null)
 }}
 aria-label="Close"
 className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] interactive transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary-soft)]"
 >
 <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
 <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
 </svg>
 </button>
 </div>

 <ModalBody className="space-y-4">
 <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
 <MetaItem label="Role" value={sprintEngineRoleLabels[spawnDialogAgent.role]} />
 <MetaItem label="Status" value={runtimeStatusLabel(spawnDialogRuntime?.status ?? 'idle')} />
 </div>

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

 <div className="relative">
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 CLI
 </div>
 <button
 type="button"
 onClick={() => setCliPickerOpen((open) => !open)}
 aria-haspopup="listbox"
 aria-expanded={cliPickerOpen}
 className="flex min-h-[58px] w-full items-center gap-3 rounded-md bg-[color:var(--bg-surface-raised)] px-3 text-left text-[color:var(--text-strong)] outline-none interactive transition-colors hover:bg-[color:var(--bg-hover)] focus:ring-1 focus:ring-[color:var(--border-strong)]"
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
 className={`h-4 w-4 shrink-0 text-[color:var(--text-disabled)] transition-transform ${cliPickerOpen ? 'rotate-180' : ''}`}
 viewBox="0 0 20 20"
 fill="none"
 aria-hidden="true"
 xmlns="http://www.w3.org/2000/svg"
 >
 <path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>

 {cliPickerOpen ? (
 <div
 role="listbox"
 // design-tokens-allow: CLI picker popover elevation reuses the canonical shadow.
 className="popover-enter absolute left-0 right-0 top-[76px] z-30 overflow-hidden rounded-md bg-[color:var(--bg-surface)] p-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]"
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
 <svg className="h-4 w-4 shrink-0 text-[color:var(--text-muted)]" viewBox="0 0 20 20" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
 <path d="M4.5 10.5L8 14L15.5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 ) : null}
 </button>
 )
 })}
 </div>
 ) : null}
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
 <button
 type="button"
 onClick={() => setAddMemberOpen(false)}
 aria-label="Close"
 className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] interactive transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary-soft)]"
 >
 <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
 <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
 </svg>
 </button>
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
 <SprintEngineRoleIcon role={role} className="h-4 w-4" />
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

type RosterItem = {
 id: string
 label: string
 role: SprintEngineRole
}

type RuntimeAgentView = {
 agentId: string
 role: SprintEngineRole
 status: string
 currentTaskId: string | null
}

type SprintEngineInspectorSelection =
 | { kind: 'task'; task: SprintEngineTask }
 | { kind: 'agent'; agent: RosterItem }
 | {
 kind: 'artifact'
 artifact: { id: string; path: string; name: string; content: string }
 }

function SprintEngineInspectorPanel({
 selection,
 sprintEngineState,
 runtimeAgents,
 tasksById,
 selectedTaskBoardColumn,
 selectedTaskStatusLabel,
 selectedTaskOwnerLabel,
 selectedTaskNeedsInputNote,
 selectedTaskCanMarkReady,
 selectedTaskCanSpawnWorker,
 selectedTaskCanManageWorker,
 selectedTaskOwnerCliRunning,
 selectedTaskArtifacts,
 selectedTaskArtifactBlockers,
 taskReadyActions,
 artifactActions,
 onClose,
 onSelectTask,
 onMarkTaskReady,
 onOpenReadyTaskWorker,
 onOpenArtifact,
 onApproveArtifact,
 onRequestArtifactChanges,
 onBackFromArtifact,
 onPopOutArtifact,
 onSpawnAgent,
 onOpenAgentTerminal,
 isAgentTerminalLive,
}: {
 selection: SprintEngineInspectorSelection
 sprintEngineState: SprintEngineState
 runtimeAgents: RuntimeAgentView[]
 tasksById: Record<string, SprintEngineTask>
 selectedTaskBoardColumn: SprintEngineTaskBoardColumn | null
 selectedTaskStatusLabel: string
 selectedTaskOwnerLabel: string
 selectedTaskNeedsInputNote: string | null
 selectedTaskCanMarkReady: boolean
 selectedTaskCanSpawnWorker: boolean
 selectedTaskCanManageWorker: boolean
 selectedTaskOwnerCliRunning: boolean
 selectedTaskArtifacts: SprintEngineArtifact[]
 selectedTaskArtifactBlockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
 taskReadyActions: Record<string, TaskReadyActionState>
 artifactActions: Record<string, ArtifactActionState>
 onClose: () => void
 onSelectTask: (taskId: string) => void
 onMarkTaskReady: (task: SprintEngineTask) => void | Promise<void>
 onOpenReadyTaskWorker: (task: SprintEngineTask) => void
 onOpenArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
 onApproveArtifact: (artifact: SprintEngineArtifact) => void | Promise<void>
 onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
 onBackFromArtifact: () => void
 onPopOutArtifact: () => void
 onSpawnAgent: (agentId: string) => void
 onOpenAgentTerminal: (agentId: string) => void
 isAgentTerminalLive: (agentId: string) => boolean
}) {
 if (selection.kind === 'artifact') {
 return (
 <SprintEngineArtifactPreview
 artifact={selection.artifact}
 onBack={onBackFromArtifact}
 onPopOut={onPopOutArtifact}
 />
 )
 }

 if (selection.kind === 'agent') {
 const agent = selection.agent
 const runtime = runtimeAgents.find((entry) => entry.agentId === agent.id) ?? null
 const hasLiveTerminal = isAgentTerminalLive(agent.id)
 const currentTask = runtime?.currentTaskId
 ? sprintEngineState.tasks.find((task) => task.id === runtime.currentTaskId) ?? null
 : null
 const tasksOwnedByAgent = sprintEngineState.tasks.filter(
 (task) => task.ownerAgentId === agent.id
 )
 return (
 <div className="flex h-full min-h-0 flex-col">
 <header className="border-b border-[color:var(--border-default)] px-5 py-4">
 <div className="flex items-start justify-between gap-3">
 <div className="min-w-0">
 <div className="flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
 <span
 className="flex h-6 w-6 items-center justify-center rounded-full"
 style={{
 backgroundColor: hexToRgba(sprintEngineRoleAccent[agent.role], 0.18),
 color: sprintEngineRoleAccent[agent.role],
 }}
 >
 <SprintEngineRoleIcon role={agent.role} className="h-3.5 w-3.5" />
 </span>
 <span>{sprintEngineRoleLabels[agent.role]}</span>
 <span>·</span>
 <span className="flex items-center gap-1.5">
 <StatusDot tone={runtimeStatusTone(runtime?.status ?? (hasLiveTerminal ? 'running' : 'idle'))} />
 {runtime?.status ?? (hasLiveTerminal ? 'running' : 'idle')}
 </span>
 </div>
 <h3 className="mt-2 truncate text-[18px] font-semibold leading-7 text-[color:var(--text-strong)]">
 {agent.label}
 </h3>
 <div className="mt-1 font-mono text-[11px] text-[color:var(--text-disabled)]">{agent.id}</div>
 </div>
 <button
 type="button"
 onClick={onClose}
 aria-label="Close agent detail"
 className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] interactive transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary-soft)]"
 >
 <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
 <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
 </svg>
 </button>
 </div>
 <div className="mt-3 flex flex-wrap gap-1.5">
 {hasLiveTerminal ? (
 <button
 type="button"
 onClick={() => onOpenAgentTerminal(agent.id)}
 className="h-7 rounded border border-[color:var(--border-strong)] px-2.5 text-[11px] font-medium text-[color:var(--text-default)] interactive transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]"
 >
 Open Terminal
 </button>
 ) : (
 <button
 type="button"
 onClick={() => onSpawnAgent(agent.id)}
 className="h-7 rounded border border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)] px-2.5 text-[11px] font-semibold text-[color:var(--accent-primary)] interactive transition-colors hover:bg-[color:var(--accent-primary-soft-strong)]"
 >
 Spawn {sprintEngineRoleLabels[agent.role]}
 </button>
 )}
 </div>
 </header>

 <div className="flex-1 space-y-5 overflow-auto px-5 py-4 text-[13px] leading-6 text-[color:var(--text-default)]">
 <div>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Currently Working On
 </div>
 {currentTask ? (
 <button
 type="button"
 onClick={() => onSelectTask(currentTask.id)}
 className="block w-full rounded-md border border-[color:var(--border-default)] px-3 py-2 text-left interactive transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-surface-raised)]"
 >
 <div className="font-mono text-[11px] text-[color:var(--tone-warn)]">{currentTask.id}</div>
 <div className="mt-1 truncate text-sm font-semibold text-[color:var(--text-strong)]">
 {currentTask.title}
 </div>
 </button>
 ) : (
 <div className="text-[color:var(--text-subtle)]">No active task assignment.</div>
 )}
 </div>

 <div>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Assigned Tasks ({tasksOwnedByAgent.length})
 </div>
 {tasksOwnedByAgent.length === 0 ? (
 <div className="text-[color:var(--text-subtle)]">No tasks assigned.</div>
 ) : (
 <ul className="divide-y divide-[color:var(--border-default)] border-y border-[color:var(--border-default)]">
 {tasksOwnedByAgent.map((task) => (
 <li key={task.id}>
 <button
 type="button"
 onClick={() => onSelectTask(task.id)}
 className="block w-full px-1 py-2.5 text-left interactive transition-colors hover:bg-[color:var(--bg-surface-raised)]"
 >
 <div className="flex items-center gap-2 text-[11px]">
 <span className="font-mono text-[color:var(--tone-warn)]">{task.id}</span>
 <span className="text-[color:var(--text-subtle)]">{task.status}</span>
 </div>
 <div className="mt-0.5 truncate text-sm text-[color:var(--text-strong)]">{task.title}</div>
 </button>
 </li>
 ))}
 </ul>
 )}
 </div>
 </div>
 </div>
 )
 }

 // Task mode (default branch).
 const selectedTask = selection.task
 return (
 <div className="flex h-full min-h-0 flex-col">
 <header className="border-b border-[color:var(--border-default)] px-5 py-4">
 <div className="flex items-start justify-between gap-3">
 <div className="min-w-0">
 <div className="flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)]">
 <span className="font-mono tabular-nums text-[12px] text-[color:var(--text-muted)]">{selectedTask.id}</span>
 <span>·</span>
 <span className="flex items-center gap-1.5">
 <SprintEngineTaskStatusIcon
 column={selectedTaskBoardColumn ?? 'todo'}
 className="h-3 w-3 text-[color:var(--text-muted)]"
 />
 {selectedTaskStatusLabel}
 </span>
 <span>·</span>
 <span>{sprintEngineRoleLabels[selectedTask.role]}</span>
 </div>
 <h3 className="mt-2 text-[18px] font-semibold leading-7 text-[color:var(--text-strong)]">
 {selectedTask.title}
 </h3>
 </div>
 <button
 type="button"
 onClick={onClose}
 aria-label="Close task detail"
 className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] interactive transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary-soft)]"
 >
 <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
 <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
 </svg>
 </button>
 </div>
 <div className="mt-3 flex flex-wrap gap-1.5">
 {selectedTaskCanMarkReady ? (
 <button
 type="button"
 disabled={taskReadyActions[selectedTask.id]?.status === 'pending'}
 onClick={() => void onMarkTaskReady(selectedTask)}
 className="h-7 rounded border border-[color:var(--tone-warn-soft)] bg-[color:var(--tone-warn-soft)] px-2.5 text-[11px] font-semibold text-[color:var(--tone-warn)] interactive transition-colors hover:bg-[color:var(--tone-warn-soft)] disabled:cursor-wait disabled:opacity-60"
 >
 Move To Ready
 </button>
 ) : null}
 {selectedTaskCanSpawnWorker || (selectedTask.ownerAgentId && selectedTaskCanManageWorker) ? (
 <button
 type="button"
 onClick={() => onOpenReadyTaskWorker(selectedTask)}
 className="h-7 rounded border border-[color:var(--border-strong)] px-2.5 text-[11px] font-medium text-[color:var(--text-default)] interactive transition-colors hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]"
 >
 {selectedTask.ownerAgentId
 ? selectedTaskOwnerCliRunning ? 'Open Terminal' : 'Respawn'
 : `Spawn ${sprintEngineRoleLabels[selectedTask.role]}`}
 </button>
 ) : null}
 </div>
 </header>

 <div className="flex-1 space-y-5 overflow-auto px-5 py-4 text-[13px] leading-6 text-[color:var(--text-default)]">
 <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
 <MetaItem label="Source" value={formatTaskSourceLabel(selectedTask)} />
 <MetaItem label="Owner" value={selectedTaskOwnerLabel} />
 <MetaItem label="Dependencies" value={selectedTask.dependsOn.join(', ') || 'None'} />
 <MetaItem
 label={selectedTask.completedAt ? 'Completed' : 'Started'}
 value={formatTimestamp(selectedTask.completedAt ?? selectedTask.startedAt)}
 />
 </div>

 {selectedTask.source?.type === 'github' ? (
 <div className="border-l border-[color:var(--border-strong)] pl-3">
 <div className="text-[10px] font-bold text-[color:var(--text-disabled)]">
 GitHub Issue
 </div>
 <div className="mt-1 truncate text-sm text-[color:var(--text-default)]">
 {selectedTask.source.repo ? `${selectedTask.source.repo} ` : ''}
 {selectedTask.source.externalId ? `#${selectedTask.source.externalId}` : ''}
 </div>
 {formatTaskSyncStatusLabel(selectedTask) ? (
 <div className="mt-2 text-[12px] leading-5 text-[color:var(--tone-warn)]">
 {formatTaskSyncStatusDescription(selectedTask)}
 </div>
 ) : null}
 {selectedTask.source.externalUrl ? (
 <button
 type="button"
 onClick={() => {
 window.open(selectedTask.source?.externalUrl, '_blank', 'noopener,noreferrer')
 }}
 className="mt-2 rounded px-2 py-1 text-[11px] font-semibold text-[color:var(--tone-warn)] interactive transition-colors hover:bg-[color:var(--tone-warn-soft)]"
 >
 Open Issue
 </button>
 ) : null}
 </div>
 ) : null}

 {selectedTaskNeedsInputNote ? (
 <div className="border-l border-[color:var(--tone-warn-soft)] pl-3 text-sm text-[color:var(--tone-warn)]">
 <div className="text-[10px] font-bold text-[color:var(--tone-warn)]">
 Needs Input
 </div>
 <div className="mt-2 leading-6">{selectedTaskNeedsInputNote}</div>
 <div className="mt-2 text-[12px] text-[color:var(--tone-warn)]">
 Respond in the worker CLI to unblock this task.
 </div>
 </div>
 ) : null}

 {selectedTaskArtifactBlockers.length > 0 ? (
 <ArtifactBlockerList blockers={selectedTaskArtifactBlockers} />
 ) : null}

 {selectedTask.triage ? (
 <div className="border-l border-[color:var(--tone-warn)] pl-3 text-sm text-[color:var(--tone-warn)]">
 <div className="text-[10px] font-bold text-[color:var(--tone-warn)]">
 Architect Triage
 </div>
 <div className="mt-2 leading-6">{selectedTask.triage.summary}</div>
 </div>
 ) : null}

 {taskReadyActions[selectedTask.id]?.message ? (
 <div className={`border-l pl-3 text-[12px] leading-5 ${
 taskReadyActions[selectedTask.id]?.status === 'error'
 ? 'border-[color:var(--tone-error-soft)] text-[color:var(--tone-error)]'
 : 'border-[color:var(--border-strong)] text-[color:var(--text-muted)]'
 }`}>
 {taskReadyActions[selectedTask.id]?.message}
 </div>
 ) : null}

 <div>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Description
 </div>
 <div>{selectedTask.description || 'No description recorded.'}</div>
 </div>

 <SectionList
 title="Acceptance Criteria"
 items={selectedTask.acceptanceCriteria}
 emptyLabel="No acceptance criteria recorded."
 />
 <SectionList title="Owned Paths" items={selectedTask.ownedPaths} emptyLabel="No owned paths recorded." />
 <SectionList
 title="Implementation Notes"
 items={selectedTask.implementationNotes}
 emptyLabel="No implementation notes recorded."
 />
 <SectionList title="Notes" items={selectedTask.notes} emptyLabel="No notes recorded." />
 <SectionList
 title="Comments"
 items={selectedTask.comments.map((comment) => `${comment.actor}: ${comment.body}`)}
 emptyLabel="No comments recorded."
 />

 <SprintEngineArtifactList
 artifacts={selectedTaskArtifacts}
 tasksById={tasksById}
 actions={artifactActions}
 emptyLabel="No review artifacts are attached to this task."
 onSelectTask={onSelectTask}
 onOpenArtifact={(artifact) => void onOpenArtifact(artifact)}
 onApproveArtifact={(artifact) => void onApproveArtifact(artifact)}
 onRequestArtifactChanges={onRequestArtifactChanges}
 />

 <div>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Evidence Summary
 </div>
 <div>{selectedTask.evidence.summary || 'No completion summary recorded yet.'}</div>
 </div>

 {selectedTask.feedback ? <AgentFeedback feedback={selectedTask.feedback} /> : null}

 <SectionList
 title="Commands Run"
 items={selectedTask.evidence.commandsRan}
 emptyLabel="No commands recorded."
 />
 <SectionList
 title="Results"
 items={selectedTask.evidence.results}
 emptyLabel="No test or validation results recorded."
 />
 <SectionList
 title="Touched Files"
 items={selectedTask.evidence.touchedFiles}
 emptyLabel="No touched files recorded."
 />
 </div>
 </div>
 )
}

function SprintEngineProjectView({
 sprintEngineState,
 roster,
 runtimeAgents,
 runPhase,
 doneCount,
 allTasksDone,
 runSummary,
 onViewRunSummary,
 reviewArtifacts,
 artifactActions,
 selectedAgentId,
 onSelectAgent,
 onSelectTask,
 onAddRole,
 onOpenArtifact,
 onApproveArtifact,
 onRequestArtifactChanges,
 isAgentTerminalLive,
}: {
 sprintEngineState: SprintEngineState
 roster: RosterItem[]
 runtimeAgents: RuntimeAgentView[]
 runPhase: string
 doneCount: number
 allTasksDone: boolean
 runSummary: ReturnType<typeof buildRunSummary>
 onViewRunSummary: () => void
 reviewArtifacts: SprintEngineArtifact[]
 artifactActions: Record<string, ArtifactActionState>
 selectedAgentId: string | null
 onSelectAgent: (agentId: string) => void
 onSelectTask: (taskId: string) => void
 onAddRole: (role: SprintEngineRole) => void
 onOpenArtifact: (artifact: SprintEngineArtifact) => void
 onApproveArtifact: (artifact: SprintEngineArtifact) => void
 onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
 isAgentTerminalLive: (agentId: string) => boolean
}) {
 // runPhase → semantic tone for the project name's status dot.
 const runPhaseTone: Tone =
 runPhase === 'Complete'
 ? 'good'
 : runPhase === 'Running'
 ? 'accent'
 : runPhase === 'Tasked'
 ? 'neutral'
 : 'neutral'
 const totalTasks = sprintEngineState.tasks.length
 const progressPct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0
 const dispatchRoleAdd = (role: SprintEngineRole) => {
 onAddRole(role)
 }
 const tasksById = useMemo(
 () => Object.fromEntries(sprintEngineState.tasks.map((task) => [task.id, task])),
 [sprintEngineState.tasks]
 )
 const inboxArtifacts = useMemo(
 () => getSprintEngineInboxArtifacts(reviewArtifacts),
 [reviewArtifacts]
 )
 const blockedByArtifacts = useMemo(() => (
 sprintEngineState.tasks
 .map((task) => ({
 task,
 blockers: getSprintEngineArtifactDependencyBlockers(task, sprintEngineState.tasks, reviewArtifacts),
 }))
 .filter(({ blockers }) => blockers.length > 0)
 ), [reviewArtifacts, sprintEngineState.tasks])

 const rosterCountByRole = useMemo(() => {
 const counts = Object.fromEntries(addableRoles.map((role) => [role, 0])) as Record<SprintEngineRole, number>
 for (const agent of roster) {
 counts[agent.role] = (counts[agent.role] ?? 0) + 1
 }
 return counts
 }, [roster])

 return (
 <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[color:var(--bg-app)] text-[color:var(--text-default)]">
 {/* Run-complete sits above the project header as a quiet Section, replacing
 the prior celebratory green banner. Visible only when allTasksDone. */}
 {allTasksDone ? (
 <Section
 title="Run complete"
 level={3}
 action={
 <GhostButton onClick={onViewRunSummary}>View run summary</GhostButton>
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
 ) : null}
 {/* Project hero collapsed to: status dot + project name + count + 2 px
 progress hairline overlaid on the header's bottom border. Goal text and
 plan reader live in the outer panel overflow (Read plan), not the hero. */}
 <header className="relative shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2.5">
 <div className="flex items-center gap-2">
 <StatusDot tone={runPhaseTone} label={`Run phase: ${runPhase}`} />
 <h2 className="min-w-0 truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
 {sprintEngineState.name}
 </h2>
 <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-muted)]">
 {doneCount}/{totalTasks}
 </span>
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

 <div className="flex min-h-0 flex-1 min-w-0">
 <section
 className="flex w-[44%] min-w-[320px] max-w-[560px] flex-col border-r border-[color:var(--border-default)]"
 aria-label="Inbox"
 >
 <header className="flex items-center justify-between gap-3 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2.5">
 <div className="flex min-w-0 items-center gap-2">
 <StatusDot tone="accent" />
 <h2 className="truncate text-[11px] font-semibold text-[color:var(--text-strong)]">
 Inbox
 </h2>
 <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-subtle)]">
 {inboxArtifacts.length}
 </span>
 </div>
 </header>

 <div className="flex-1 overflow-auto">
 <SprintEngineArtifactList
 artifacts={inboxArtifacts}
 tasksById={tasksById}
 actions={artifactActions}
 hideHeader
 emptyLabel="Inbox empty. The handover and any artifacts agents produce will appear here."
 onSelectTask={onSelectTask}
 onOpenArtifact={onOpenArtifact}
 onApproveArtifact={onApproveArtifact}
 onRequestArtifactChanges={onRequestArtifactChanges}
 />

 {blockedByArtifacts.length > 0 ? (
 <Section
 title="Blocked by review"
 count={blockedByArtifacts.length}
 level={3}
 inset={false}
 className="border-t border-[color:var(--border-default)]"
 >
 <ol className="divide-y divide-[color:var(--border-default)]">
 {blockedByArtifacts.map(({ task, blockers }) => (
 <li key={task.id}>
 <button
 type="button"
 onClick={() => onSelectTask(task.id)}
 className="interactive flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-[color:var(--bg-surface)]"
 >
 <div className="flex min-w-0 items-baseline gap-2">
 <span className="shrink-0 font-mono tabular-nums text-[11px] text-[color:var(--text-muted)]">
 {task.id}
 </span>
 <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[color:var(--text-strong)]">
 {task.title}
 </span>
 </div>
 <div className="text-[11px] text-[color:var(--tone-warn)]">
 Waiting on {formatArtifactBlockerSummary(blockers)}
 </div>
 </button>
 </li>
 ))}
 </ol>
 </Section>
 ) : null}
 </div>
 </section>

 <section
 className="flex min-w-0 flex-1 flex-col"
 aria-label="Roster"
 >
 <header className="flex items-center justify-between gap-3 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2.5">
 <div className="flex min-w-0 items-center gap-2">
 <StatusDot tone="accent" />
 <h2 className="truncate text-[11px] font-semibold text-[color:var(--text-strong)]">
 Roster
 </h2>
 <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-subtle)]">
 {roster.length}
 </span>
 </div>
 <span className="text-[11px] text-[color:var(--text-subtle)]">Pick a role below to add another member</span>
 </header>

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
 <span
 className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
 style={{
 backgroundColor: hexToRgba(sprintEngineRoleAccent[agent.role], 0.18),
 color: sprintEngineRoleAccent[agent.role],
 }}
 aria-hidden="true"
 >
 <SprintEngineRoleIcon role={agent.role} className="h-4 w-4" />
 </span>
 <span className="min-w-0 flex-1 space-y-0.5">
 <span className="flex min-w-0 items-baseline gap-2">
 <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
 {agent.label}
 </span>
 <span className="shrink-0 rounded border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[color:var(--text-muted)]">
 {sprintEngineRoleLabels[agent.role]}
 </span>
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
 {hasLiveTerminal ? (
 <span className="ml-auto shrink-0 rounded border border-[color:var(--tone-good-soft)] bg-[color:var(--tone-good-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--tone-good)]">
 Terminal live
 </span>
 ) : null}
 </span>
 </span>
 </button>
 </li>
 )
 })}
 </ol>
 )}

 <section aria-label="Add a roster member" className="border-t border-[color:var(--border-default)]">
 <div className="flex items-center justify-between gap-3 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
 <h3 className="truncate text-[11px] font-semibold text-[color:var(--text-muted)]">
 Add member
 </h3>
 <span className="shrink-0 tabular-nums text-[11px] text-[color:var(--text-subtle)]">
 {addableRoles.length} roles
 </span>
 </div>
 <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
 {addableRoles.map((role) => {
 const count = rosterCountByRole[role] ?? 0
 return (
 <button
 key={role}
 type="button"
 onClick={() => dispatchRoleAdd(role)}
 title={`${count > 0 ? 'Add another' : 'Add'} ${sprintEngineRoleLabels[role]}`}
 className="interactive inline-flex items-center gap-1.5 rounded border border-dashed border-[color:var(--border-strong)] px-2 py-1 text-[11px] font-medium text-[color:var(--text-default)] transition-colors hover:border-[color:var(--accent-primary-soft)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
 >
 <span
 className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
 style={{
 backgroundColor: hexToRgba(sprintEngineRoleAccent[role], 0.14),
 color: sprintEngineRoleAccent[role],
 }}
 aria-hidden="true"
 >
 <SprintEngineRoleIcon role={role} className="h-3 w-3" />
 </span>
 <span>{sprintEngineRoleLabels[role]}</span>
 {count > 0 ? (
 <span className="ml-0.5 rounded bg-[color:var(--bg-hover)] px-1 tabular-nums text-[color:var(--text-muted)]">
 {count}
 </span>
 ) : null}
 </button>
 )
 })}
 </div>
 </section>
 </div>
 </section>
 </div>
 </div>
 )
}

function SprintEngineTaskGraphView({
 sprintEngineState,
 rosterById,
 selectedTaskId,
 onSelectTask,
}: {
 sprintEngineState: SprintEngineState
 rosterById: Record<string, RosterItem | undefined>
 selectedTaskId: string | null
 onSelectTask: (taskId: string) => void
}) {
 const graph = useMemo(() => buildTaskGraphLayout(sprintEngineState.tasks), [sprintEngineState.tasks])
 const focusTaskId = useMemo(() => getTaskGraphFocusTaskId(sprintEngineState.tasks), [sprintEngineState.tasks])
 const [graphZoom, setGraphZoom] = useState(defaultTaskGraphZoom)
 const graphCanvasRef = useRef<HTMLDivElement | null>(null)
 const graphScrollRef = useRef<HTMLDivElement | null>(null)
 const lastCenteredKeyRef = useRef<string | null>(null)
 const zoomAnchorRef = useRef<TaskGraphZoomAnchor | null>(null)

 const captureZoomAnchor = (viewportX?: number, viewportY?: number): TaskGraphZoomAnchor | null => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl) return null

 const resolvedViewportX = viewportX ?? scrollEl.clientWidth / 2
 const resolvedViewportY = viewportY ?? scrollEl.clientHeight / 2

 return {
 graphX: (scrollEl.scrollLeft + resolvedViewportX) / graphZoom,
 graphY: (scrollEl.scrollTop + resolvedViewportY) / graphZoom,
 viewportX: resolvedViewportX,
 viewportY: resolvedViewportY,
 }
 }

 const setGraphZoomFromAnchor = (
 nextZoom: number,
 anchor: TaskGraphZoomAnchor | null = captureZoomAnchor()
 ) => {
 if (Math.abs(nextZoom - graphZoom) < 0.001) return
 zoomAnchorRef.current = anchor
 setGraphZoom(nextZoom)
 }

 const fitGraphToViewport = () => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl) return

 const availableWidth = Math.max(1, scrollEl.clientWidth - 48)
 const availableHeight = Math.max(1, scrollEl.clientHeight - 48)
 const fitZoom = Math.min(1, availableWidth / graph.canvasWidth, availableHeight / graph.canvasHeight)
 setGraphZoomFromAnchor(Math.max(minTaskGraphZoom, Math.min(maxTaskGraphZoom, fitZoom)))
 }

 useEffect(() => {
 const scrollEl = graphScrollRef.current
 const focusNode = focusTaskId ? graph.nodesById[focusTaskId] : null
 if (!scrollEl || !focusNode) return

 const centerKey = `${focusTaskId}:${graph.canvasWidth}:${graph.canvasHeight}`
 if (lastCenteredKeyRef.current === centerKey) return
 lastCenteredKeyRef.current = centerKey

 const frame = window.requestAnimationFrame(() => {
 scrollEl.scrollTo({
 left: Math.max(0, focusNode.x * graphZoom - scrollEl.clientWidth / 2),
 top: Math.max(0, focusNode.y * graphZoom - scrollEl.clientHeight / 2),
 behavior: 'smooth',
 })
 })

 return () => window.cancelAnimationFrame(frame)
 }, [focusTaskId, graph, graphZoom])

 useEffect(() => {
 const scrollEl = graphScrollRef.current
 const anchor = zoomAnchorRef.current
 if (!scrollEl || !anchor) return
 zoomAnchorRef.current = null

 const frame = window.requestAnimationFrame(() => {
 scrollEl.scrollLeft = Math.max(0, anchor.graphX * graphZoom - anchor.viewportX)
 scrollEl.scrollTop = Math.max(0, anchor.graphY * graphZoom - anchor.viewportY)
 })

 return () => window.cancelAnimationFrame(frame)
 }, [graphZoom])

 const handleGraphWheel = (event: React.WheelEvent<HTMLDivElement>) => {
 if (!event.ctrlKey && !event.metaKey) return

 event.preventDefault()
 const scrollEl = graphScrollRef.current
 if (!scrollEl) return

 const rect = scrollEl.getBoundingClientRect()
 const anchor = captureZoomAnchor(event.clientX - rect.left, event.clientY - rect.top)
 setGraphZoomFromAnchor(getNextTaskGraphZoom(graphZoom, event.deltaY < 0 ? 'in' : 'out'), anchor)
 }

 const terminalCount = graph.terminalTaskIds.length
 const zoomPercent = Math.round(graphZoom * 100)
 const canZoomOut = graphZoom > minTaskGraphZoom + 0.001
 const canZoomIn = graphZoom < maxTaskGraphZoom - 0.001
 const canResetZoom = Math.abs(graphZoom - defaultTaskGraphZoom) >= 0.001

 const taskCount = sprintEngineState.tasks.length
 const readyCount = useMemo(
 () => sprintEngineState.tasks.filter(
 (task) => getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks) === 'ready'
 ).length,
 [sprintEngineState.tasks]
 )
 const doneCount = useMemo(
 () => sprintEngineState.tasks.filter((task) => task.status === 'done').length,
 [sprintEngineState.tasks]
 )
 const inFlightCount = useMemo(
 () => sprintEngineState.tasks.filter(
 (task) => task.status === 'in_progress' || task.status === 'needs_input'
 ).length,
 [sprintEngineState.tasks]
 )

 const hasWarning = graph.hasCycle || graph.missingDependencyCount > 0
 const warningMessage = [
 graph.hasCycle ? 'Dependency cycle detected' : null,
 graph.missingDependencyCount > 0
 ? `${graph.missingDependencyCount} missing ${graph.missingDependencyCount === 1 ? 'dependency' : 'dependencies'}`
 : null,
 ].filter(Boolean).join(' · ')

 const [legendOpen, setLegendOpen] = useState(true)
 const [minimapOpen, setMinimapOpen] = useState(true)
 const [viewportState, setViewportState] = useState({
 scrollLeft: 0,
 scrollTop: 0,
 clientWidth: 0,
 clientHeight: 0,
 })

 useEffect(() => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl) return

 let frame: number | null = null
 const updateViewport = () => {
 if (frame !== null) return
 frame = window.requestAnimationFrame(() => {
 frame = null
 setViewportState({
 scrollLeft: scrollEl.scrollLeft,
 scrollTop: scrollEl.scrollTop,
 clientWidth: scrollEl.clientWidth,
 clientHeight: scrollEl.clientHeight,
 })
 })
 }

 updateViewport()
 scrollEl.addEventListener('scroll', updateViewport, { passive: true })
 const resizeObserver = new ResizeObserver(updateViewport)
 resizeObserver.observe(scrollEl)

 return () => {
 if (frame !== null) window.cancelAnimationFrame(frame)
 scrollEl.removeEventListener('scroll', updateViewport)
 resizeObserver.disconnect()
 }
 }, [graph.canvasWidth, graph.canvasHeight])

 const MINIMAP_MAX_WIDTH = 168
 const MINIMAP_MAX_HEIGHT = 112
 const minimapScale = graph.canvasWidth > 0 && graph.canvasHeight > 0
 ? Math.min(MINIMAP_MAX_WIDTH / graph.canvasWidth, MINIMAP_MAX_HEIGHT / graph.canvasHeight)
 : 1
 const minimapInnerWidth = Math.max(1, graph.canvasWidth * minimapScale)
 const minimapInnerHeight = Math.max(1, graph.canvasHeight * minimapScale)
 const viewportGraphLeft = viewportState.scrollLeft / graphZoom
 const viewportGraphTop = viewportState.scrollTop / graphZoom
 const viewportGraphWidth = viewportState.clientWidth / graphZoom
 const viewportGraphHeight = viewportState.clientHeight / graphZoom
 const minimapViewportRect = {
 x: Math.max(0, viewportGraphLeft * minimapScale),
 y: Math.max(0, viewportGraphTop * minimapScale),
 width: Math.max(4, Math.min(minimapInnerWidth, viewportGraphWidth * minimapScale)),
 height: Math.max(4, Math.min(minimapInnerHeight, viewportGraphHeight * minimapScale)),
 }

 const panFromMinimap = (clientX: number, clientY: number, element: HTMLElement) => {
 const scrollEl = graphScrollRef.current
 if (!scrollEl || minimapScale <= 0) return
 const rect = element.getBoundingClientRect()
 const graphX = (clientX - rect.left) / minimapScale
 const graphY = (clientY - rect.top) / minimapScale
 scrollEl.scrollTo({
 left: Math.max(0, graphX * graphZoom - scrollEl.clientWidth / 2),
 top: Math.max(0, graphY * graphZoom - scrollEl.clientHeight / 2),
 })
 }

 const handleGraphKeyDown = useCallback(
 (event: React.KeyboardEvent<HTMLDivElement>) => {
 if (isEditableTarget(event.target)) return
 if (event.metaKey || event.ctrlKey || event.altKey) return

 const isArrow = event.key === 'ArrowUp' || event.key === 'ArrowDown'
 || event.key === 'ArrowLeft' || event.key === 'ArrowRight'
 if (!isArrow) return

 const firstTaskNode = graph.nodes.find((node) => node.type === 'task')
 const currentId = selectedTaskId ?? focusTaskId ?? firstTaskNode?.id ?? null
 if (!currentId) return

 event.preventDefault()
 const goBack = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
 let nextId: string | null = null
 if (goBack) {
 const predecessor = graph.edges.find((edge) => edge.toId === currentId)
 if (predecessor) nextId = predecessor.fromId
 } else {
 const successor = graph.edges.find(
 (edge) => edge.fromId === currentId && edge.toId !== 'end-product'
 )
 if (successor) nextId = successor.toId
 }

 if (!nextId) {
 // No neighbor in that direction; if nothing is selected yet, seed selection.
 if (!selectedTaskId) {
 onSelectTask(currentId)
 }
 return
 }

 onSelectTask(nextId)

 const scrollEl = graphScrollRef.current
 const nextNode = graph.nodesById[nextId]
 if (scrollEl && nextNode) {
 scrollEl.scrollTo({
 left: Math.max(0, nextNode.x * graphZoom - scrollEl.clientWidth / 2),
 top: Math.max(0, nextNode.y * graphZoom - scrollEl.clientHeight / 2),
 behavior: 'smooth',
 })
 const button = scrollEl.querySelector<HTMLButtonElement>(
 `[data-task-graph-node="${nextId}"]`
 )
 button?.focus()
 }
 },
 [focusTaskId, graph, graphZoom, onSelectTask, selectedTaskId]
 )

 return (
 <div
 className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[color:var(--bg-app)] focus:outline-none"
 onKeyDown={handleGraphKeyDown}
 >
 <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-6 py-3">
 <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
 <h3 className="text-[10px] font-bold text-[color:var(--text-muted)]">
 Task Graph
 </h3>
 <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[color:var(--text-subtle)]">
 <span>
 <span className="font-semibold text-[color:var(--text-default)]">{taskCount}</span> task{taskCount === 1 ? '' : 's'}
 </span>
 {readyCount > 0 ? (
 <span className="text-[color:var(--tone-good)]">
 <span className="font-semibold">{readyCount}</span> ready
 </span>
 ) : null}
 {inFlightCount > 0 ? (
 <span className="text-[color:var(--tone-warn)]">
 <span className="font-semibold">{inFlightCount}</span> in flight
 </span>
 ) : null}
 {doneCount > 0 ? (
 <span className="text-[color:var(--tone-good)]">
 <span className="font-semibold">{doneCount}</span> done
 </span>
 ) : null}
 {terminalCount > 0 ? (
 <span>
 <span className="font-semibold text-[color:var(--text-default)]">{terminalCount}</span> final {terminalCount === 1 ? 'chain' : 'chains'}
 </span>
 ) : null}
 </div>
 {hasWarning ? (
 <span
 role="alert"
 className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--tone-warn-soft)] px-2 py-1 text-[11px] font-semibold text-[color:var(--tone-warn)]"
 >
 <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
 <path d="M8 1.75L14.75 13.5H1.25L8 1.75Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
 <path d="M8 6.5V9.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
 <circle cx="8" cy="11.6" r="0.7" fill="currentColor" />
 </svg>
 {warningMessage}
 </span>
 ) : null}
 </div>
 <div className="flex items-center gap-1 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-0.5">
 <button
 type="button"
 onClick={() => setGraphZoomFromAnchor(getNextTaskGraphZoom(graphZoom, 'out'))}
 disabled={!canZoomOut}
 className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--text-muted)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]"
 aria-label="Zoom out task graph"
 title="Zoom out"
 >
 <ZoomOutSprintEngineIcon />
 </button>
 <div
 className="min-w-[2.75rem] px-1 text-center text-[11px] font-semibold tabular-nums text-[color:var(--text-default)]"
 aria-live="polite"
 >
 {zoomPercent}%
 </div>
 <button
 type="button"
 onClick={() => setGraphZoomFromAnchor(getNextTaskGraphZoom(graphZoom, 'in'))}
 disabled={!canZoomIn}
 className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--text-muted)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]"
 aria-label="Zoom in task graph"
 title="Zoom in"
 >
 <ZoomInSprintEngineIcon />
 </button>
 <span className="mx-0.5 h-4 w-px bg-[color:var(--border-default)]" aria-hidden="true" />
 <button
 type="button"
 onClick={fitGraphToViewport}
 className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--text-muted)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
 aria-label="Fit task graph to viewport"
 title="Fit graph"
 >
 <FitGraphZoomIcon />
 </button>
 <button
 type="button"
 onClick={() => setGraphZoomFromAnchor(defaultTaskGraphZoom)}
 disabled={!canResetZoom}
 className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--text-muted)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-muted)]"
 aria-label="Reset task graph zoom"
 title="Reset zoom"
 >
 <ResetGraphZoomIcon />
 </button>
 </div>
 </header>

 <div className="relative min-h-[460px] flex-1">
 <div
 ref={graphScrollRef}
 onWheel={handleGraphWheel}
 className="absolute inset-0 overflow-auto"
 >
 {taskCount === 0 ? (
 <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
 <div className="max-w-xl">
 <div
 aria-hidden="true"
 className="mx-auto h-10 w-10 rounded-full border border-[color:var(--border-default)]"
 />
 <div className="mt-4 text-sm font-semibold text-[color:var(--text-strong)]">
 Waiting for the architect plan
 </div>
 <p className="mt-2 text-sm leading-6 text-[color:var(--text-muted)]">
 Tasks and their dependencies will appear here as the architect builds out the run.
 </p>
 </div>
 </div>
 ) : (
 <div
 className="relative"
 style={{
 width: graph.canvasWidth * graphZoom,
 height: graph.canvasHeight * graphZoom,
 }}
 >
 <div
 ref={graphCanvasRef}
 className="relative"
 style={{
 width: graph.canvasWidth,
 height: graph.canvasHeight,
 transform: `scale(${graphZoom})`,
 transformOrigin: 'top left',
 backgroundColor: 'var(--bg-app)',
 }}
 >
 <svg
 className="pointer-events-none absolute inset-0"
 width={graph.canvasWidth}
 height={graph.canvasHeight}
 viewBox={`0 0 ${graph.canvasWidth} ${graph.canvasHeight}`}
 >
 {graph.edges.map((edge) => {
 const from = graph.nodesById[edge.fromId]
 const to = graph.nodesById[edge.toId]
 if (!from || !to) return null
 return (
 <path
 key={edge.id}
 d={taskGraphEdgePath(from, to)}
 fill="none"
 stroke={edge.color}
 strokeWidth={edge.weight}
 strokeDasharray={edge.dashed ? '7 8' : undefined}
 opacity={edge.opacity}
 strokeLinecap="round"
 strokeLinejoin="round"
 />
 )
 })}
 {graph.nodes.map((node) => (
 <rect
 key={`${node.id}:line-blocker`}
 x={node.x - node.width / 2 - 8}
 y={node.y - node.height / 2 - 8}
 width={node.width + 16}
 height={node.height + 16}
 rx="14"
 fill="var(--bg-app)"
 />
 ))}
 </svg>

 {graph.nodes.map((node) => {
 if (node.type === 'end') {
 return (
 <div
 key={node.id}
 className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-[color:var(--tone-good-soft)] bg-[color:var(--tone-good-soft)] px-5 py-4 text-center"
 style={{
 left: node.x,
 top: node.y,
 width: node.width,
 minHeight: node.height,
 }}
 >
 <div className="flex items-center gap-1.5 text-[10px] font-bold text-[color:var(--tone-good)]">
 <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
 <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 Goal
 </div>
 <div className="mt-2 line-clamp-3 text-sm font-semibold leading-5 text-[color:var(--tone-good)]">
 {formatSprintEngineGoalPreview(sprintEngineState.goal)}
 </div>
 <div className="mt-3 text-[10px] text-[color:var(--text-muted)]">
 {terminalCount} final {terminalCount === 1 ? 'chain' : 'chains'}
 </div>
 </div>
 )
 }

 const task = node.task
 const ownerAgent = task.ownerAgentId ? rosterById[task.ownerAgentId] : undefined
 const ownerRole = ownerAgent?.role ?? (task.ownerAgentId ? task.role : null)
 const ownerLabel = task.ownerAgentId ? ownerAgent?.label ?? task.ownerAgentId : null
 const isFocused = task.id === focusTaskId
 const isSelected = task.id === selectedTaskId
 const boardColumn = getSprintEngineTaskBoardColumn(task, sprintEngineState.tasks)
 const dependencyLabel = task.dependsOn.length > 0
 ? `${task.dependsOn.length} ${task.dependsOn.length === 1 ? 'dep' : 'deps'}`
 : 'root'

 return (
 <button
 key={node.id}
 data-task-graph-node={task.id}
 onClick={() => onSelectTask(task.id)}
 aria-pressed={isSelected}
 className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border p-3 text-left transition-transform hover:scale-[1.01] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary-soft)] ${
 isSelected || isFocused ? 'z-10' : 'z-0'
 }`}
 style={{
 ...taskGraphNodeStyle(task, ownerRole, isFocused, isSelected),
 left: node.x,
 top: node.y,
 width: node.width,
 minHeight: node.height,
 }}
 >
 <span
 aria-hidden="true"
 className="pointer-events-none absolute inset-y-3 left-0 w-1 rounded-r-full"
 style={{
 backgroundColor: sprintEngineRoleAccent[task.role],
 }}
 />
 <div className="flex items-start justify-between gap-3 pl-2">
 <div className="min-w-0">
 <div className="line-clamp-2 text-sm font-semibold leading-5 text-[color:var(--text-strong)]">{task.title}</div>
 <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-[color:var(--text-disabled)]">
 <span>{task.id}</span>
 {/* design-tokens-allow: role accent swatch on the task-graph node label — role color is the documented exception. */}
 <span
 className="h-1.5 w-1.5 shrink-0 rounded-full"
 style={{
 backgroundColor: sprintEngineRoleAccent[task.role],
 }}
 />
 <span className="min-w-0 truncate" style={{ color: sprintEngineRoleAccent[task.role] }}>
 {sprintEngineRoleLabels[task.role]}
 </span>
 </div>
 </div>
 <span
 className={`max-w-[92px] shrink-0 truncate rounded-full px-2 py-1 text-[10px] font-bold ${taskGraphStatusTone(task.status, boardColumn)}`}
 >
 {boardColumn === 'ready' ? 'Ready' : taskStateLabel[task.status]}
 </span>
 </div>

 <p className="mt-3 line-clamp-2 pl-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
 {task.description || 'No description recorded.'}
 </p>

 <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 pl-2 text-[10px] text-[color:var(--text-disabled)]">
 <span>
 {dependencyLabel}
 </span>
 <span className="text-[color:var(--text-disabled)]">/</span>
 <span>
 {task.acceptanceCriteria.length} checks
 </span>
 {ownerLabel && ownerRole ? (
 <>
 <span className="text-[color:var(--text-disabled)]">/</span>
 <span className="max-w-full truncate" style={{ color: sprintEngineRoleAccent[ownerRole] }}>
 {ownerLabel}
 </span>
 </>
 ) : null}
 </div>
 </button>
 )
 })}
 </div>
 </div>
 )}

 </div>

 {taskCount > 0 ? (
 <div className="pointer-events-none absolute bottom-3 left-3 z-30">
 <div className="pointer-events-auto inline-flex flex-col items-start">
 <button
 type="button"
 onClick={() => setLegendOpen((open) => !open)}
 aria-expanded={legendOpen}
 className="flex items-center gap-1.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-1 text-[10px] font-bold text-[color:var(--text-muted)] backdrop-blur interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
 >
 Legend
 <svg
 className={`h-3 w-3 transition-transform ${legendOpen ? 'rotate-180' : ''}`}
 viewBox="0 0 12 12"
 fill="none"
 aria-hidden="true"
 >
 <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 {legendOpen ? (
 // design-tokens-allow: legend popover elevation reuses the canonical shadow.
 <div className="popover-enter mt-1 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-3 text-[11px] backdrop-blur shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]">
 <div className="text-[9px] font-bold text-[color:var(--text-disabled)]">
 Status
 </div>
 <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[color:var(--text-muted)]">
 <TaskGraphLegendDot color="var(--tone-good)" label="Ready" />
 <TaskGraphLegendDot color="var(--tone-warn)" label="In progress" />
 <TaskGraphLegendDot color="var(--tone-warn)" label="Needs input" />
 <TaskGraphLegendDot color="var(--tone-good)" label="Done" />
 <TaskGraphLegendDot color="var(--text-muted)" label="Todo" />
 </div>
 <div className="mt-3 border-t border-[color:var(--border-default)] pt-2 text-[10px] leading-5 text-[color:var(--text-subtle)]">
 <div>Left bar &middot; role accent</div>
 <div>Edge color &middot; dependency state (green when complete)</div>
 </div>
 </div>
 ) : null}
 </div>
 </div>
 ) : null}

 {taskCount > 0 ? (
 <div className="pointer-events-none absolute bottom-3 right-3 z-30">
 <div className="pointer-events-auto inline-flex flex-col items-end">
 <button
 type="button"
 onClick={() => setMinimapOpen((open) => !open)}
 aria-expanded={minimapOpen}
 className="flex items-center gap-1.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-1 text-[10px] font-bold text-[color:var(--text-muted)] backdrop-blur interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary-soft)]"
 >
 Minimap
 <svg
 className={`h-3 w-3 transition-transform ${minimapOpen ? 'rotate-180' : ''}`}
 viewBox="0 0 12 12"
 fill="none"
 aria-hidden="true"
 >
 <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 </button>
 {minimapOpen ? (
 // design-tokens-allow: minimap popover elevation reuses the canonical shadow.
 <div className="popover-enter mt-1 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-2 backdrop-blur shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]">
 <div
 className="relative cursor-crosshair overflow-hidden rounded bg-[color:var(--bg-app)]"
 style={{ width: minimapInnerWidth, height: minimapInnerHeight }}
 onPointerDown={(event) => {
 if (event.button !== 0) return
 const element = event.currentTarget
 element.setPointerCapture(event.pointerId)
 panFromMinimap(event.clientX, event.clientY, element)
 }}
 onPointerMove={(event) => {
 if (event.buttons !== 1) return
 panFromMinimap(event.clientX, event.clientY, event.currentTarget)
 }}
 role="img"
 aria-label="Task graph minimap"
 >
 {graph.nodes.map((node) => {
 if (node.type === 'end') {
 return (
 <div
 key={`mini-${node.id}`}
 className="pointer-events-none absolute rounded-sm"
 style={{
 left: (node.x - node.width / 2) * minimapScale,
 top: (node.y - node.height / 2) * minimapScale,
 width: Math.max(3, node.width * minimapScale),
 height: Math.max(3, node.height * minimapScale),
 backgroundColor: hexToRgba('var(--tone-good)', 0.7),
 }}
 />
 )
 }
 return (
 <div
 key={`mini-${node.id}`}
 className="pointer-events-none absolute rounded-sm"
 style={{
 left: (node.x - node.width / 2) * minimapScale,
 top: (node.y - node.height / 2) * minimapScale,
 width: Math.max(3, node.width * minimapScale),
 height: Math.max(3, node.height * minimapScale),
 backgroundColor: hexToRgba(sprintEngineRoleAccent[node.task.role], 0.55),
 }}
 />
 )
 })}
 <div
 className="pointer-events-none absolute rounded-sm border border-[color:var(--accent-primary-soft)] bg-[color:var(--accent-primary-soft)]"
 style={{
 left: minimapViewportRect.x,
 top: minimapViewportRect.y,
 width: minimapViewportRect.width,
 height: minimapViewportRect.height,
 }}
 />
 </div>
 </div>
 ) : null}
 </div>
 </div>
 ) : null}
 </div>
 </div>
 )
}

function TaskGraphLegendDot({ color, label }: { color: string; label: string }) {
 return (
 <span className="flex items-center gap-1.5">
 <span
 aria-hidden="true"
 // design-tokens-allow: legend swatch displays a caller-provided role color, not a status tone.
 className="inline-block h-2 w-2 rounded-full"
 style={{ backgroundColor: color }}
 />
 <span>{label}</span>
 </span>
 )
}


type TaskGraphLayoutNode =
 | {
 id: string
 type: 'task'
 task: SprintEngineTask
 x: number
 y: number
 width: number
 height: number
 }
 | {
 id: string
 type: 'end'
 x: number
 y: number
 width: number
 height: number
 }

type TaskGraphLayoutEdge = {
 id: string
 fromId: string
 toId: string
 color: string
 opacity: number
 weight: number
 dashed: boolean
}

type TaskGraphLayout = {
 nodes: TaskGraphLayoutNode[]
 nodesById: Record<string, TaskGraphLayoutNode>
 edges: TaskGraphLayoutEdge[]
 canvasWidth: number
 canvasHeight: number
 terminalTaskIds: string[]
 hasCycle: boolean
 missingDependencyCount: number
}

type TaskGraphZoomAnchor = {
 graphX: number
 graphY: number
 viewportX: number
 viewportY: number
}

const taskGraphZoomLevels = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2]
const defaultTaskGraphZoom = 1
const minTaskGraphZoom = taskGraphZoomLevels[0]
const maxTaskGraphZoom = taskGraphZoomLevels[taskGraphZoomLevels.length - 1]

function getNextTaskGraphZoom(currentZoom: number, direction: 'in' | 'out'): number {
 if (direction === 'in') {
 return taskGraphZoomLevels.find((level) => level > currentZoom + 0.001) ?? taskGraphZoomLevels[taskGraphZoomLevels.length - 1]
 }

 return [...taskGraphZoomLevels].reverse().find((level) => level < currentZoom - 0.001) ?? taskGraphZoomLevels[0]
}

function buildTaskGraphLayout(tasks: SprintEngineTask[]): TaskGraphLayout {
 const nodeWidth = 272
 const nodeHeight = 154
 const endNodeWidth = 252
 const endNodeHeight = 154
 const levelGap = 420
 const rowGap = 236
 const paddingX = 220
 const paddingY = 132
 const minCanvasWidth = 1180
 const minCanvasHeight = 720

 if (tasks.length === 0) {
 return {
 nodes: [],
 nodesById: {},
 edges: [],
 canvasWidth: minCanvasWidth,
 canvasHeight: minCanvasHeight,
 terminalTaskIds: [],
 hasCycle: false,
 missingDependencyCount: 0,
 }
 }

 const taskById = new Map(tasks.map((task) => [task.id, task]))
 const validDepsByTask = new Map<string, string[]>()
 const dependentsByTask = new Map<string, string[]>()
 const indegreeByTask = new Map<string, number>()
 let missingDependencyCount = 0

 tasks.forEach((task) => {
 validDepsByTask.set(task.id, [])
 dependentsByTask.set(task.id, [])
 indegreeByTask.set(task.id, 0)
 })

 tasks.forEach((task) => {
 const uniqueDeps = Array.from(new Set(task.dependsOn))
 uniqueDeps.forEach((depId) => {
 if (depId === task.id || !taskById.has(depId)) {
 missingDependencyCount += 1
 return
 }

 validDepsByTask.get(task.id)?.push(depId)
 dependentsByTask.get(depId)?.push(task.id)
 indegreeByTask.set(task.id, (indegreeByTask.get(task.id) ?? 0) + 1)
 })
 })

 const levelByTask = new Map<string, number>()
 const queue = tasks
 .filter((task) => (indegreeByTask.get(task.id) ?? 0) === 0)
 .map((task) => task.id)
 const visited = new Set<string>()

 queue.forEach((taskId) => levelByTask.set(taskId, 0))

 while (queue.length > 0) {
 const taskId = queue.shift()!
 visited.add(taskId)
 const currentLevel = levelByTask.get(taskId) ?? 0

 dependentsByTask.get(taskId)?.forEach((dependentId) => {
 levelByTask.set(dependentId, Math.max(levelByTask.get(dependentId) ?? 0, currentLevel + 1))
 const nextIndegree = (indegreeByTask.get(dependentId) ?? 0) - 1
 indegreeByTask.set(dependentId, nextIndegree)
 if (nextIndegree === 0) queue.push(dependentId)
 })
 }

 const hasCycle = visited.size < tasks.length
 if (hasCycle) {
 const fallbackStart = Math.max(0, ...Array.from(levelByTask.values())) + 1
 tasks.forEach((task, index) => {
 if (visited.has(task.id)) return
 const dependencyLevels = (validDepsByTask.get(task.id) ?? [])
 .map((depId) => levelByTask.get(depId))
 .filter((level): level is number => typeof level === 'number')
 const nextLevel = dependencyLevels.length > 0
 ? Math.max(...dependencyLevels) + 1
 : fallbackStart + Math.floor(index / 3)
 levelByTask.set(task.id, nextLevel)
 })
 }

 const groups = new Map<number, SprintEngineTask[]>()
 tasks.forEach((task) => {
 const level = levelByTask.get(task.id) ?? 0
 const group = groups.get(level) ?? []
 group.push(task)
 groups.set(level, group)
 })

 const maxTaskLevel = Math.max(0, ...Array.from(groups.keys()))
 const endLevel = maxTaskLevel + 1
 const maxRows = Math.max(1, ...Array.from(groups.values()).map((group) => group.length))
 const canvasHeight = Math.max(minCanvasHeight, paddingY * 2 + nodeHeight + (maxRows - 1) * rowGap)
 const canvasWidth = Math.max(minCanvasWidth, paddingX * 2 + endLevel * levelGap + endNodeWidth)
 const nodes: TaskGraphLayoutNode[] = []

 Array.from(groups.entries())
 .sort(([a], [b]) => a - b)
 .forEach(([level, group]) => {
 const columnTop = canvasHeight / 2 - ((group.length - 1) * rowGap) / 2
 group.forEach((task, index) => {
 nodes.push({
 id: task.id,
 type: 'task',
 task,
 x: paddingX + level * levelGap,
 y: columnTop + index * rowGap,
 width: nodeWidth,
 height: nodeHeight,
 })
 })
 })

 const endNode: TaskGraphLayoutNode = {
 id: 'end-product',
 type: 'end',
 x: paddingX + endLevel * levelGap,
 y: canvasHeight / 2,
 width: endNodeWidth,
 height: endNodeHeight,
 }
 nodes.push(endNode)

 const terminalTaskIds = tasks
 .filter((task) => (dependentsByTask.get(task.id) ?? []).length === 0)
 .map((task) => task.id)
 const fallbackTerminalTaskIds = terminalTaskIds.length > 0
 ? terminalTaskIds
 : tasks.filter((task) => (levelByTask.get(task.id) ?? 0) === maxTaskLevel).map((task) => task.id)

 const edges: TaskGraphLayoutEdge[] = []
 tasks.forEach((task) => {
 ;(validDepsByTask.get(task.id) ?? []).forEach((depId) => {
 const dependency = taskById.get(depId)
 if (!dependency) return
 edges.push({
 id: `${depId}->${task.id}`,
 fromId: depId,
 toId: task.id,
 ...taskGraphEdgeStyle(dependency, task),
 })
 })
 })

 fallbackTerminalTaskIds.forEach((taskId) => {
 const task = taskById.get(taskId)
 if (!task) return
 edges.push({
 id: `${taskId}->end-product`,
 fromId: taskId,
 toId: 'end-product',
 ...taskGraphEndEdgeStyle(task),
 })
 })

 const nodesById = Object.fromEntries(nodes.map((node) => [node.id, node]))

 return {
 nodes,
 nodesById,
 edges,
 canvasWidth,
 canvasHeight,
 terminalTaskIds: fallbackTerminalTaskIds,
 hasCycle,
 missingDependencyCount,
 }
}

function getTaskGraphFocusTaskId(tasks: SprintEngineTask[]): string | null {
 const newestBy = (candidates: SprintEngineTask[], field: 'startedAt' | 'completedAt') =>
 candidates
 .map((task, index) => ({ task, index }))
 .sort((a, b) => {
 const timeDelta = timestampMs(b.task[field]) - timestampMs(a.task[field])
 return timeDelta !== 0 ? timeDelta : b.index - a.index
 })[0]?.task.id ?? null

 return (
 newestBy(tasks.filter((task) => task.status === 'in_progress'), 'startedAt')
 ?? newestBy(tasks.filter((task) => task.status === 'needs_input'), 'startedAt')
 ?? newestBy(tasks.filter((task) => task.status === 'done'), 'completedAt')
 ?? tasks.find((task) => getSprintEngineTaskBoardColumn(task, tasks) === 'ready')?.id
 ?? tasks[0]?.id
 ?? null
 )
}

function timestampMs(value: string | null): number {
 if (!value) return 0
 const parsed = Date.parse(value)
 return Number.isFinite(parsed) ? parsed : 0
}

function taskGraphEdgePath(from: TaskGraphLayoutNode, to: TaskGraphLayoutNode): string {
 const startX = from.x + from.width / 2
 const startY = from.y
 const endX = to.x - to.width / 2
 const endY = to.y
 const horizontalGap = endX - startX

 if (horizontalGap < 120) {
 const curve = Math.max(72, horizontalGap * 0.42)
 return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`
 }

 if (Math.abs(endY - startY) < 2) {
 return `M ${startX} ${startY} H ${endX}`
 }

 const gutterX = startX + horizontalGap / 2
 const direction = endY > startY ? 1 : -1
 const radius = Math.min(22, Math.abs(endY - startY) / 2, Math.abs(gutterX - startX) / 2, Math.abs(endX - gutterX) / 2)

 return [
 `M ${startX} ${startY}`,
 `H ${gutterX - radius}`,
 `Q ${gutterX} ${startY} ${gutterX} ${startY + radius * direction}`,
 `V ${endY - radius * direction}`,
 `Q ${gutterX} ${endY} ${gutterX + radius} ${endY}`,
 `H ${endX}`,
 ].join(' ')
}

function taskGraphEdgeStyle(
 dependency: SprintEngineTask,
 dependent: SprintEngineTask
): Omit<TaskGraphLayoutEdge, 'id' | 'fromId' | 'toId'> {
 const dependencyDone = dependency.status === 'done'
 const active = dependent.status === 'in_progress' || dependent.status === 'needs_input'
 const color = active
 ? sprintEngineRoleAccent[dependent.role]
 : dependencyDone
 ? 'var(--tone-good)'
 : sprintEngineRoleAccent[dependency.role]

 return {
 color,
 opacity: active ? 0.68 : dependencyDone ? 0.48 : 0.3,
 weight: active ? 2.2 : 1.6,
 dashed: false,
 }
}

function taskGraphEndEdgeStyle(
 task: SprintEngineTask
): Omit<TaskGraphLayoutEdge, 'id' | 'fromId' | 'toId'> {
 return {
 color: task.status === 'done' ? 'var(--tone-good)' : sprintEngineRoleAccent[task.role],
 opacity: task.status === 'done' ? 0.58 : 0.32,
 weight: task.status === 'done' ? 2 : 1.5,
 dashed: false,
 }
}

function runtimeStatusTone(status: string): Tone {
 switch (status) {
 case 'running':
 case 'needs_input':
 return 'warn'
 case 'complete':
 return 'good'
 case 'error':
 return 'error'
 case 'planning':
 case 'exited':
 default:
 return 'neutral'
 }
}

function MetaItem({ label, value }: { label: string; value: string }) {
 return (
 <div className="min-w-0">
 <div className="text-[10px] text-[color:var(--text-disabled)]">{label}</div>
 <div className="mt-1 font-medium text-[color:var(--text-strong)] [overflow-wrap:anywhere]">{value}</div>
 </div>
 )
}

function SprintEngineArtifactPreview({
 artifact,
 onBack,
 onPopOut,
}: {
 artifact: { id: string; path: string; name: string; content: string }
 onBack: () => void
 onPopOut: () => void
}) {
 const isMarkdown = artifact.path.toLowerCase().endsWith('.md')
 return (
 <div className="flex h-full min-h-0 flex-col">
 <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-default)] px-5 py-3">
 <div className="flex min-w-0 items-center gap-2">
 <button
 type="button"
 onClick={onBack}
 className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[12px] font-semibold text-[color:var(--text-muted)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
 aria-label="Back to task detail"
 >
 <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3">
 <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 Back
 </button>
 <span className="min-w-0 truncate text-[13px] font-semibold text-[color:var(--text-strong)]" title={artifact.path}>
 {artifact.name}
 </span>
 </div>
 <button
 type="button"
 onClick={onPopOut}
 className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[11px] font-semibold text-[color:var(--text-muted)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
 title="Open in editor tab"
 >
 <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3">
 <path d="M9 3H13V7M13 3L7.5 8.5M6 4H4C3.45 4 3 4.45 3 5V12C3 12.55 3.45 13 4 13H11C11.55 13 12 12.55 12 12V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 Open in editor
 </button>
 </header>
 <div className="flex-1 overflow-auto px-5 py-4 text-[13px] leading-6 text-[color:var(--text-default)]">
 {isMarkdown ? (
 <div className="markdown-body">{renderMarkdown(artifact.content)}</div>
 ) : (
 <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-5 text-[color:var(--text-default)]">
 {artifact.content}
 </pre>
 )}
 </div>
 </div>
 )
}

function SectionList({
 title,
 items,
 emptyLabel,
}: {
 title: string
 items: string[]
 emptyLabel: string
}) {
 return (
 <div>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">{title}</div>
 {items.length > 0 ? (
 <ul className="space-y-1.5 text-[color:var(--text-default)]">
 {items.map((item) => (
 <li key={item} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
 <span className="mt-[0.65rem] h-1 w-1 rounded-full bg-[color:var(--text-disabled)]" aria-hidden="true" />
 <span className="[overflow-wrap:anywhere]">{item}</span>
 </li>
 ))}
 </ul>
 ) : (
 <div className="text-[12px] text-[color:var(--text-disabled)]">
 {emptyLabel}
 </div>
 )}
 </div>
 )
}

function AgentFeedback({ feedback }: { feedback: SprintEngineTaskFeedback }) {
 const scores = feedbackScoreLabels.flatMap((metric) => {
 const value = feedback.scores[metric.key]
 return typeof value === 'number' ? [{ ...metric, value }] : []
 })

 return (
 <div>
 <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
 <div className="text-[10px] font-bold text-[color:var(--text-disabled)]">
 Agent Feedback
 </div>
 <div className="text-[11px] text-[color:var(--text-disabled)]">
 {feedback.agentId} - {formatTimestamp(feedback.capturedAt)}
 </div>
 </div>
 {scores.length > 0 ? (
 <div className="grid gap-x-4 gap-y-2 md:grid-cols-2">
 {scores.map((metric) => (
 <div key={metric.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[12px]">
 <span className="text-[color:var(--text-muted)]">{metric.label}</span>
 <span className="font-mono text-[color:var(--text-strong)]">{metric.value}%</span>
 </div>
 ))}
 </div>
 ) : null}
 {feedback.topFriction ? (
 <div className="mt-3 text-[12px] text-[color:var(--text-default)]">
 <span className="text-[color:var(--text-muted)]">Top friction: </span>{feedback.topFriction}
 </div>
 ) : null}
 {feedback.suggestedImprovement ? (
 <div className="mt-1 text-[12px] text-[color:var(--text-default)]">
 <span className="text-[color:var(--text-muted)]">Suggested improvement: </span>{feedback.suggestedImprovement}
 </div>
 ) : null}
 {feedback.issues && feedback.issues.length > 0 ? (
 <PromptImprovementIssues issues={feedback.issues} className="mt-4" />
 ) : null}
 {feedback.findings && feedback.findings.length > 0 ? (
 <RoleFindings findings={feedback.findings} className="mt-4" />
 ) : null}
 </div>
 )
}

function PromptImprovementIssues({
 issues,
 className = '',
}: {
 issues: SprintEngineTaskFeedbackIssue[]
 className?: string
}) {
 if (issues.length === 0) return null

 return (
 <div className={className}>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Prompt Improvement Signals
 </div>
 <div className="space-y-3">
 {issues.map((issue) => (
 <div key={issue.id} className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-3">
 <div className="flex flex-wrap items-center gap-2 text-[11px]">
 <span className="font-semibold text-[color:var(--text-strong)]">{issue.title}</span>
 <span className="text-[color:var(--text-disabled)]">{feedbackIssueCategoryLabels[issue.category]}</span>
 <span className="text-[color:var(--text-disabled)]">{feedbackIssueSeverityLabels[issue.severity]}</span>
 <span className="text-[color:var(--text-disabled)]">{feedbackIssueStatusLabels[issue.status ?? 'new']}</span>
 {issue.target ? <span className="font-mono text-[color:var(--text-muted)]">{issue.target}</span> : null}
 </div>
 <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-default)]">{issue.detail}</div>
 {issue.evidence ? (
 <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-muted)]">
 Evidence: {issue.evidence}
 </div>
 ) : null}
 {issue.suggestedPromptChange ? (
 <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-default)]">
 <span className="text-[color:var(--text-muted)]">Prompt change: </span>{issue.suggestedPromptChange}
 </div>
 ) : null}
 {issue.suggestedProcessChange ? (
 <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-default)]">
 <span className="text-[color:var(--text-muted)]">Process change: </span>{issue.suggestedProcessChange}
 </div>
 ) : null}
 </div>
 ))}
 </div>
 </div>
 )
}

function RoleFindings({
 findings,
 className = '',
}: {
 findings: SprintEngineTaskFeedbackFinding[]
 className?: string
}) {
 if (findings.length === 0) return null

 return (
 <div className={className}>
 <div className="mb-2 text-[10px] font-bold text-[color:var(--text-disabled)]">
 Role Findings
 </div>
 <div className="space-y-3">
 {findings.map((finding) => (
 <div key={finding.id} className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-3">
 <div className="flex flex-wrap items-center gap-2 text-[11px]">
 <span className="font-semibold text-[color:var(--text-strong)]">{finding.title}</span>
 <span className="text-[color:var(--text-disabled)]">{feedbackFindingKindLabels[finding.kind]}</span>
 <span className="text-[color:var(--text-disabled)]">{feedbackFindingSeverityLabels[finding.severity]}</span>
 <span className="text-[color:var(--text-disabled)]">{feedbackFindingAreaLabels[finding.area]}</span>
 <span className="text-[color:var(--text-disabled)]">{feedbackFindingStatusLabels[finding.status ?? 'open']}</span>
 {finding.requirementId ? <span className="font-mono text-[color:var(--text-muted)]">{finding.requirementId}</span> : null}
 {finding.file ? <span className="font-mono text-[color:var(--text-muted)] [overflow-wrap:anywhere]">{finding.file}</span> : null}
 </div>
 <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-default)]">{finding.detail}</div>
 {finding.recommendation ? (
 <div className="mt-2 text-[12px] leading-5 text-[color:var(--text-default)]">
 <span className="text-[color:var(--text-muted)]">Recommendation: </span>{finding.recommendation}
 </div>
 ) : null}
 </div>
 ))}
 </div>
 </div>
 )
}

function ConfidenceDial({ value, size = 14, label }: { value: number; size?: number; label?: string }) {
 const clamped = Math.max(0, Math.min(100, Math.round(value)))
 const stroke = 1.5
 const radius = size / 2 - stroke / 2 - 0.5
 const cx = size / 2
 const cy = size / 2
 const tone = clamped >= 80 ? 'var(--tone-good)' : clamped >= 50 ? 'var(--tone-warn)' : 'var(--tone-error)'
 const trackTone = 'var(--border-strong)'
 const ariaLabel = label ? `${label}: ${clamped}% confidence` : `${clamped}% confidence`

 let arc: React.ReactNode = null
 if (clamped >= 100) {
 arc = <circle cx={cx} cy={cy} r={radius} stroke={tone} strokeWidth={stroke} fill="none" />
 } else if (clamped > 0) {
 const angle = (clamped / 100) * 2 * Math.PI
 const endX = cx + radius * Math.sin(angle)
 const endY = cy - radius * Math.cos(angle)
 const largeArc = clamped > 50 ? 1 : 0
 arc = (
 <path
 d={`M ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY}`}
 stroke={tone}
 strokeWidth={stroke}
 strokeLinecap="round"
 fill="none"
 />
 )
 }

 return (
 <span
 className="inline-flex shrink-0 items-center"
 title={ariaLabel}
 aria-label={ariaLabel}
 role="img"
 >
 <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
 <circle cx={cx} cy={cy} r={radius} stroke={trackTone} strokeWidth={stroke} fill="none" />
 {arc}
 <circle cx={cx} cy={cy} r={Math.max(0.8, size / 14)} fill={tone} />
 </svg>
 </span>
 )
}

function getArtifactConfidencePct(
 artifact: SprintEngineArtifact,
 task: SprintEngineTask | undefined
): number | null {
 const feedback = task?.feedback
 if (!feedback) return null
 if (feedback.agentId !== artifact.createdBy) return null
 const value = feedback.scores?.confidencePct
 return typeof value === 'number' ? value : null
}

function SprintEngineArtifactList({
 artifacts,
 tasksById,
 actions,
 title = 'Review Artifacts',
 emptyLabel,
 hideHeader = false,
 onSelectTask,
 onOpenArtifact,
 onApproveArtifact,
 onRequestArtifactChanges,
}: {
 artifacts: SprintEngineArtifact[]
 tasksById: Record<string, SprintEngineTask | undefined>
 actions: Record<string, ArtifactActionState>
 title?: string
 emptyLabel: string
 hideHeader?: boolean
 onSelectTask: (taskId: string) => void
 onOpenArtifact: (artifact: SprintEngineArtifact) => void
 onApproveArtifact: (artifact: SprintEngineArtifact) => void
 onRequestArtifactChanges: (artifact: SprintEngineArtifact) => void
}) {
 return (
 <div>
 {hideHeader ? null : (
 <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
 <div className="text-[10px] font-bold text-[color:var(--text-disabled)]">
 {title}
 </div>
 {artifacts.length > 0 ? (
 <span className="text-[11px] font-semibold text-[color:var(--text-disabled)]">
 {formatArtifactSummary(artifacts)}
 </span>
 ) : null}
 </div>
 )}

 {artifacts.length > 0 ? (
 <ol className="divide-y divide-[color:var(--border-default)]">
 {artifacts.map((artifact) => {
 const task = tasksById[artifact.taskId]
 const action = actions[artifact.id]
 const pending = action?.status === 'pending'
 const readyForReview = artifact.status === 'ready_for_review'
 const canOpenArtifact = Boolean(artifact.path.trim()) && artifact.status !== 'draft'
 const autoApprovalEligibility = getSprintEngineArtifactAutoApprovalEligibility(artifact)
 const mobileDecision = getMobileArtifactDecision(artifact)
 const confidencePct = getArtifactConfidencePct(artifact, task)
 const isSourceHandoff = artifact.id === SOURCE_HANDOFF_ARTIFACT_ID
 const timestamp = artifact.createdAt ?? artifact.updatedAt
 const absoluteTimestamp = timestamp ? new Date(timestamp).toLocaleString() : null
 const relativeTimestamp = timestamp ? formatRelativeTime(timestamp) : 'No timestamp'

 return (
 <li key={artifact.id} className="grid gap-3 px-3 py-2.5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
 <div className="min-w-0 space-y-0.5">
 <div className="flex min-w-0 items-baseline gap-2">
 <span className="shrink-0 font-mono tabular-nums text-[11px] text-[color:var(--text-muted)]">{artifact.id}</span>
 <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--text-strong)]">{artifact.title}</span>
 {confidencePct !== null ? (
 <ConfidenceDial value={confidencePct} label="Agent confidence" />
 ) : null}
 <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${artifactStatusTone(artifact.status)}`}>
 {isSourceHandoff ? 'Source' : sprintEngineArtifactStatusLabels[artifact.status]}
 </span>
 </div>
 <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--text-subtle)]">
 <span>{isSourceHandoff ? 'Handover' : sprintEngineArtifactKindLabels[artifact.kind]}</span>
 {isSourceHandoff ? null : (
 <button
 type="button"
 onClick={() => onSelectTask(artifact.taskId)}
 disabled={!task}
 className="font-mono text-[color:var(--text-muted)] interactive transition-colors hover:text-[color:var(--text-strong)] disabled:text-[color:var(--text-disabled)]"
 >
 {artifact.taskId || 'No task'}
 </button>
 )}
 {task && !isSourceHandoff ? <span className="min-w-0 truncate">{task.title}</span> : null}
 <span
 className="ml-auto shrink-0 tabular-nums"
 title={absoluteTimestamp ?? undefined}
 >
 {relativeTimestamp}
 </span>
 </div>
 <div className="truncate text-[12px] leading-5 text-[color:var(--text-muted)]">
 {artifact.path || 'No file path recorded.'}
 </div>
 {mobileDecision ? (
 <div className="mt-2 border-l border-[color:var(--accent-primary-soft)] pl-2 text-[11px] leading-5 text-[color:var(--accent-primary)]">
 {formatMobileArtifactDecision(mobileDecision)}
 </div>
 ) : null}
 {readyForReview && autoApprovalEligibility.label ? (
 <div className={`mt-2 text-[11px] font-semibold ${
 autoApprovalEligibility.eligible ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--tone-warn)]'
 }`}>
 {autoApprovalEligibility.label}
 </div>
 ) : null}
 {action && action.status !== 'pending' ? (
 <div className={`mt-2 border-l pl-2 text-[12px] leading-5 ${
 action.status === 'error'
 ? 'border-[color:var(--tone-error)] text-[color:var(--tone-error)]'
 : 'border-[color:var(--tone-good-soft)] text-[color:var(--tone-good)]'
 }`}>
 {action.message}
 </div>
 ) : null}
 </div>

 <div className="flex flex-wrap items-center gap-2 lg:justify-end">
 {canOpenArtifact ? (
 <button
 type="button"
 onClick={() => onOpenArtifact(artifact)}
 disabled={pending}
 className="rounded-md px-3 py-1.5 text-sm font-semibold text-[color:var(--text-default)] interactive transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-default)]"
 >
 {pending && action?.kind === 'open' ? 'Opening...' : 'Open'}
 </button>
 ) : null}
 {readyForReview ? (
 <>
 <button
 type="button"
 onClick={() => onApproveArtifact(artifact)}
 disabled={pending}
 className="rounded-md bg-[color:var(--accent-primary-soft)] px-3 py-1.5 text-sm font-semibold text-[color:var(--accent-primary)] interactive transition-colors hover:bg-[color:var(--accent-primary-soft)] disabled:opacity-45 disabled:hover:bg-[color:var(--accent-primary-soft)]"
 >
 {pending && action?.kind === 'approve' ? 'Approving...' : 'Approve'}
 </button>
 <button
 type="button"
 onClick={() => onRequestArtifactChanges(artifact)}
 disabled={pending}
 className="rounded-md px-3 py-1.5 text-sm font-semibold text-[color:var(--text-default)] interactive transition-colors hover:bg-[color:var(--tone-error)] hover:text-[color:var(--tone-error)] disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-default)]"
 >
 {pending && action?.kind === 'requestChanges'
 ? 'Requesting changes...'
 : 'Request changes'}
 </button>
 </>
 ) : null}
 </div>
 </li>
 )
 })}
 </ol>
 ) : (
 <div className={hideHeader ? 'px-3 py-6 text-[12px] leading-5 text-[color:var(--text-subtle)]' : 'text-[12px] text-[color:var(--text-disabled)]'}>
 {emptyLabel}
 </div>
 )}
 </div>
 )
}

function ArtifactBlockerList({
 blockers,
}: {
 blockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
}) {
 return (
 <div className="border-l border-[color:var(--tone-warn-soft)] pl-3 text-sm text-[color:var(--tone-warn)]">
 <div className="text-[10px] font-bold text-[color:var(--tone-warn)]">
 Artifact Gate
 </div>
 <div className="mt-2 space-y-2">
 {blockers.map((blocker) => (
 <div key={blocker.taskId}>
 <div className="font-semibold text-[color:var(--tone-warn)]">
 {blocker.taskId}: {blocker.title}
 </div>
 <div className="mt-1 flex flex-wrap gap-1.5">
 {blocker.artifacts.map((artifact) => (
 <span key={artifact.id} className="rounded bg-[color:var(--bg-hover)] px-1.5 py-0.5 text-[11px] text-[color:var(--text-default)]">
 {artifact.title} - {sprintEngineArtifactStatusLabels[artifact.status]}
 </span>
 ))}
 </div>
 </div>
 ))}
 </div>
 </div>
 )
}

function formatTimestamp(value: string | null): string {
 if (!value) return 'Not started'
 return new Date(value).toLocaleString()
}

function formatTaskSourceLabel(task: SprintEngineTask): string {
 if (!task.source) return 'Local'
 if (task.source.type === 'github') {
 return task.source.externalId ? `GitHub #${task.source.externalId}` : 'GitHub'
 }
 return task.source.type.charAt(0).toUpperCase() + task.source.type.slice(1)
}

function formatTaskSyncStatusLabel(task: SprintEngineTask): string | null {
 switch (task.source?.syncStatus) {
 case 'local_changed':
 return 'Local edits'
 case 'remote_changed':
 return 'Remote changed'
 case 'conflict':
 return 'Sync conflict'
 default:
 return null
 }
}

function formatTaskSyncStatusDescription(task: SprintEngineTask): string {
 switch (task.source?.syncStatus) {
 case 'local_changed':
 return 'Local execution details differ from the last synced GitHub issue.'
 case 'remote_changed':
 return 'GitHub changed since the previous sync; this task was refreshed because local details were unchanged.'
 case 'conflict':
 return 'GitHub and local execution details both changed. Review the issue before starting work.'
 default:
 return ''
 }
}

function emptyKanbanColumnLabel(column: SprintEngineTaskBoardColumn): string {
 switch (column) {
 case 'ready':
 return 'No ready work. Waiting on dependencies or active workers.'
 case 'in_progress':
 return 'No workers are actively claiming tasks.'
 case 'needs_input':
 return 'No blocked tasks or worker questions.'
 case 'done':
 return 'Completed work will collect here.'
 default:
 return 'Planned tasks that are waiting on dependencies appear here.'
 }
}

function SprintEngineTaskStatusIcon({
 column,
 className,
}: {
 column: SprintEngineTaskBoardColumn
 className?: string
}) {
 const label = columnMeta.find((item) => item.key === column)?.label ?? column

 if (column === 'done') {
 return (
 <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
 <title>{label}</title>
 <circle cx="12" cy="12" r="6.4" fill="var(--tone-good)" />
 <path d="M9.25 12L11.25 14L14.75 10.25" stroke="var(--tone-good-soft)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
 </svg>
 )
 }

 if (column === 'needs_input') {
 return (
 <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
 <title>{label}</title>
 <circle cx="12" cy="12" r="6.4" stroke="var(--tone-warn)" strokeWidth="1.7" strokeDasharray="2 1.6" />
 <path d="M12 7.6V12.4" stroke="var(--tone-warn)" strokeWidth="1.7" strokeLinecap="round" />
 <circle cx="12" cy="15.4" r="0.95" fill="var(--tone-warn)" />
 </svg>
 )
 }

 if (column === 'ready') {
 return (
 <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
 <title>{label}</title>
 <circle cx="12" cy="12" r="6.4" stroke="var(--tone-good)" strokeWidth="1.7" />
 <circle cx="12" cy="12" r="2" fill="var(--tone-good)" />
 </svg>
 )
 }

 if (column === 'in_progress') {
 const radius = 5.4
 const cx = 12
 const cy = 12
 const sweep = 0.5
 const angle = sweep * 2 * Math.PI
 const endX = cx + radius * Math.sin(angle)
 const endY = cy - radius * Math.cos(angle)
 const wedgePath = `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 0 1 ${endX.toFixed(2)} ${endY.toFixed(2)} Z`

 return (
 <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
 <title>{label}</title>
 <circle cx={cx} cy={cy} r="6.4" stroke="var(--tone-warn)" strokeWidth="1.7" />
 <path d={wedgePath} fill="var(--tone-warn)" opacity="0.85" />
 </svg>
 )
 }

 return (
 <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
 <title>{label}</title>
 <circle cx="12" cy="12" r="6.4" stroke="currentColor" strokeWidth="1.7" />
 </svg>
 )
}

function formatArtifactSummary(artifacts: SprintEngineArtifact[]): string {
 const pendingCount = artifacts.filter((artifact) =>
 artifact.status !== 'approved' && artifact.status !== 'superseded'
 ).length
 const approvedCount = artifacts.filter((artifact) => artifact.status === 'approved').length

 if (pendingCount > 0 && approvedCount > 0) {
 return `${pendingCount} pending, ${approvedCount} approved`
 }
 if (pendingCount > 0) {
 return `${pendingCount} pending ${pendingCount === 1 ? 'artifact' : 'artifacts'}`
 }
 return `${approvedCount} approved ${approvedCount === 1 ? 'artifact' : 'artifacts'}`
}

function artifactTimestampMs(artifact: SprintEngineArtifact): number {
 const timestamp = artifact.updatedAt ?? artifact.createdAt
 if (!timestamp) return 0
 const parsed = Date.parse(timestamp)
 return Number.isFinite(parsed) ? parsed : 0
}

const SOURCE_HANDOFF_ARTIFACT_ID = 'source-handoff'

function getSprintEngineInboxArtifacts(artifacts: SprintEngineArtifact[]): SprintEngineArtifact[] {
 return [...artifacts].sort((a, b) => {
 const aIsHandoff = a.id === SOURCE_HANDOFF_ARTIFACT_ID
 const bIsHandoff = b.id === SOURCE_HANDOFF_ARTIFACT_ID
 if (aIsHandoff !== bIsHandoff) return aIsHandoff ? -1 : 1
 const timestampDelta = artifactTimestampMs(b) - artifactTimestampMs(a)
 if (timestampDelta !== 0) return timestampDelta
 return a.title.localeCompare(b.title)
 })
}

type MobileArtifactDecision = {
 action: string
 actor: string
 timestamp: string | null
 note?: string
}

function getMobileArtifactDecision(artifact: SprintEngineArtifact): MobileArtifactDecision | null {
 const mobileHistory = [...artifact.reviewHistory]
 .reverse()
 .find((entry) => isMobileActor(entry.actor))

 if (mobileHistory) {
 return {
 action: mobileHistory.action,
 actor: mobileHistory.actor,
 timestamp: mobileHistory.timestamp,
 note: mobileHistory.note,
 }
 }

 if (artifact.approvedBy && isMobileActor(artifact.approvedBy)) {
 return {
 action: 'approved',
 actor: artifact.approvedBy,
 timestamp: artifact.approvedAt ?? null,
 }
 }

 if (artifact.changesRequestedBy && isMobileActor(artifact.changesRequestedBy)) {
 return {
 action: 'changes_requested',
 actor: artifact.changesRequestedBy,
 timestamp: artifact.changesRequestedAt ?? null,
 }
 }

 return null
}

function formatMobileArtifactDecision(decision: MobileArtifactDecision): string {
 const parts = [
 `Mobile ${mobileActionLabel(decision.action)} by ${formatMobileActor(decision.actor)}`,
 decision.timestamp ? formatTimestamp(decision.timestamp) : null,
 decision.note,
 ].filter(Boolean)

 return parts.join(' - ')
}

function isMobileActor(actor: string): boolean {
 return actor.trim().toLowerCase().startsWith('mobile:')
}

function formatMobileActor(actor: string): string {
 return actor.replace(/^mobile:/i, '').replace(/[_-]+/g, ' ') || 'mobile device'
}

function mobileActionLabel(action: string): string {
 switch (action) {
 case 'approve':
 case 'approved':
 return 'approved'
 case 'request_changes':
 case 'requestChanges':
 case 'changes_requested':
 return 'requested changes'
 default:
 return action.replace(/[_-]+/g, ' ')
 }
}

function formatArtifactBlockerSummary(
 blockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>
): string {
 const artifactCount = blockers.reduce((total, blocker) => total + blocker.artifacts.length, 0)
 const taskIds = blockers.map((blocker) => blocker.taskId).join(', ')
 return `${artifactCount} ${artifactCount === 1 ? 'artifact' : 'artifacts'} from ${taskIds}`
}

function artifactStatusTone(status: SprintEngineArtifact['status']): string {
 switch (status) {
 case 'approved':
 return 'bg-[color:var(--tone-good-soft)] text-[color:var(--tone-good)]'
 case 'ready_for_review':
 return 'bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
 case 'changes_requested':
 return 'bg-[color:var(--tone-warn-soft)] text-[color:var(--tone-warn)]'
 case 'superseded':
 return 'bg-[color:var(--bg-hover)] text-[color:var(--text-disabled)]'
 default:
 return 'bg-[color:var(--bg-hover)] text-[color:var(--text-muted)]'
 }
}

function taskGraphNodeStyle(
 task: SprintEngineTask,
 ownerRole: SprintEngineRole | null,
 focused: boolean,
 selected: boolean
): React.CSSProperties {
 const roleAccent = sprintEngineRoleAccent[ownerRole ?? task.role]
 const statusAccent =
 task.status === 'done'
 ? 'var(--tone-good)'
 : task.status === 'needs_input'
 ? 'var(--tone-warn)'
 : roleAccent

 return {
 borderColor: selected || focused ? hexToRgba(statusAccent, 0.82) : 'var(--border-strong)',
 backgroundColor: 'var(--bg-surface-raised)',
 boxShadow: selected ? `0 0 0 3px ${hexToRgba(statusAccent, 0.14)}` : undefined,
 }
}

function taskGraphStatusTone(taskStatus: SprintEngineTaskStatus, boardColumn: SprintEngineTaskBoardColumn): string {
 if (boardColumn === 'ready') return 'text-[color:var(--tone-good)]'

 switch (taskStatus) {
 case 'done':
 return 'text-[color:var(--tone-good)]'
 case 'needs_input':
 return 'text-[color:var(--tone-warn)]'
 case 'in_progress':
 return 'text-[color:var(--tone-warn)]'
 default:
 return 'text-[color:var(--text-muted)]'
 }
}

function hexToRgba(hex: string, alpha: number): string {
 const value = hex.replace('#', '')
 const red = parseInt(value.slice(0, 2), 16)
 const green = parseInt(value.slice(2, 4), 16)
 const blue = parseInt(value.slice(4, 6), 16)
 return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function runtimeStatusLabel(status: string): string {
 switch (status) {
 case 'needs_input':
 return 'Needs Input'
 case 'running':
 return 'Running'
 case 'planning':
 return 'Planning'
 case 'complete':
 return 'Complete'
 case 'exited':
 return 'Exited'
 case 'error':
 return 'Error'
 default:
 return 'Idle'
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

function formatSprintEngineGoalPreview(goal: string): string {
 const formatted = formatSprintEngineGoal(goal)
 if (formatted === 'Untitled sprintengine run') return formatted

 const firstLine = goal
 .split(/\r?\n/)
 .map((line) => line.trim())
 .find(Boolean)

 if (!firstLine) return formatted

 const firstSentence = firstLine.match(/^(.+?[.!?])(?:\s|$)/)?.[1]?.trim()
 return firstSentence || firstLine
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
 'Do not implement work yourself. Do not create tasks for unrelated roles. Do not edit state.yaml directly.',
 ].join('\n')
}
