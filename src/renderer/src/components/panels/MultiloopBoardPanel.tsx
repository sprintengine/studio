import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { nanoid } from 'nanoid'
import { SpecialistActionIcon } from '../AppIcons'
import {
  DefinitionList,
  GhostButton,
  IconButton,
  InboxRow,
  OverflowMenu,
  PanelHeader,
  PrimaryButton,
  Section,
  Select,
  StatusDot,
  Switch,
  type DefinitionItem,
  type OverflowMenuItem,
  type Tone,
} from '../ui'
import {
  MULTILOOP_STATE_SYNC_EVENT,
  getMultiloopStateSyncSnapshot,
  type MultiloopStateSyncEventDetail,
} from '../workspace/MultiloopStateSynchronizer'
import {
  getMultiloopRole,
  loadMultiloopPrompt,
  type MultiloopRole,
} from '../../specialists/specialistActions'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  AgentState,
  MultiloopArtifact,
  MultiloopBlocker,
  MultiloopDecision,
  MultiloopMilestone,
  MultiloopMilestoneReviewVerdict,
  MultiloopMilestoneStatus,
  MultiloopState,
  MultiloopStateDisplayError,
  MultiloopTask,
  MultiloopTaskStatus,
  SprintEngineCliPermissionPreset,
  SprintEngineRole,
  SprintEngineState,
  WorkspaceId,
} from '../../types/workspace'
import { buildSprintEngineStartupPrompt, getSprintEngineStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
import { focusOrAddAgentTab } from '../../utils/modelRegistry'
import {
  buildMultiloopLaunchContextLines,
  getActiveMultiloopBlockers,
  getActiveMultiloopMilestone,
  getLatestExecutionEvidenceTasks,
  getMilestoneExecutionReadiness,
  getMilestoneExecutionArtifacts,
  getMilestoneExecutionTasks,
  getMultiloopTasksForMilestone,
  getPrimaryNextAction,
  type MultiloopExecutionReadiness,
  type MultiloopPrimaryNextAction,
} from '../../utils/multiloop'
import { autoRunReasonToLabel, selectMultiloopAutoRunCandidates, type MultiloopAutoRunSelection } from '../../utils/multiloopAutoRun'
import { parseMultiloopStateFile } from '../../utils/multiloopStateFile'
import { parseSprintEngineStateFile } from '../../utils/sprintengineStateFile'
import { buildSprintEngineAgentRosterForState, buildSprintEngineRosterCommandArgs, sprintEngineRoleLabels } from '../../utils/sprintengine'

type Props = {
  workspaceId: WorkspaceId
}

type ReadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: MultiloopStateDisplayError }

type RoleLaunchState =
  | { status: 'idle' }
  | { status: 'loading'; role: MultiloopRole }
  | { status: 'error'; role: MultiloopRole; message: string }

type LinkedExecutionReadState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'error'; path: string; message: string }

type TaskGroupKey = MultiloopTaskStatus

type TaskGroup = {
  key: TaskGroupKey
  label: string
  tone: Tone
}

const TASK_GROUPS: TaskGroup[] = [
  { key: 'in_progress', label: 'In progress', tone: 'accent' },
  { key: 'ready', label: 'Ready', tone: 'good' },
  { key: 'needs_input', label: 'Needs input', tone: 'warn' },
  { key: 'blocked', label: 'Blocked', tone: 'warn' },
  { key: 'todo', label: 'Todo', tone: 'neutral' },
  { key: 'done', label: 'Done', tone: 'neutral' },
]

const milestoneStatusLabels: Record<MultiloopMilestoneStatus, string> = {
  accepted: 'Accepted',
  active: 'Active',
  blocked: 'Blocked',
  planned: 'Planned',
}

const milestoneStatusTone: Record<MultiloopMilestoneStatus, Tone> = {
  accepted: 'good',
  active: 'accent',
  blocked: 'warn',
  planned: 'neutral',
}

const taskStatusLabels: Record<MultiloopTaskStatus, string> = {
  blocked: 'Blocked',
  done: 'Done',
  in_progress: 'In progress',
  needs_input: 'Needs input',
  ready: 'Ready',
  todo: 'Todo',
}

const taskStatusTone: Record<MultiloopTaskStatus, Tone> = {
  blocked: 'warn',
  done: 'good',
  in_progress: 'accent',
  needs_input: 'warn',
  ready: 'good',
  todo: 'neutral',
}

const verdictTone: Record<MultiloopMilestoneReviewVerdict['verdict'], Tone> = {
  accepted: 'good',
  needs_follow_up: 'warn',
  blocked: 'error',
  revise_scope: 'accent',
}

const multiloopCliPermissionOptions: Array<{
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

const TERMINAL_GROUPS: Array<{ label: string; roles: MultiloopRole[] }> = [
  { label: 'Coordinator', roles: ['coordinator'] },
  { label: 'Workers', roles: ['architect', 'developer', 'frontend'] },
  { label: 'Reviewers', roles: ['product', 'tester', 'security', 'code_reviewer', 'performance'] },
]

function hasEvidence(task: MultiloopTask): boolean {
  return Boolean(
    task.evidence.summary.trim()
    || task.evidence.touchedFiles.length
    || task.evidence.commandsRan.length
    || task.evidence.results.length
  )
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function formatDate(value: string | null): string {
  if (!value) return 'No timestamp'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function formatMultiloopGoal(goal: string): string {
  const trimmed = goal.trim()
  return trimmed || 'No final goal recorded.'
}

function formatMultiloopGoalPreview(goal: string): string {
  const formatted = formatMultiloopGoal(goal)
  if (formatted === 'No final goal recorded.') return formatted

  const firstLine = goal
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)

  if (!firstLine) return formatted

  const firstSentence = firstLine.match(/^(.+?[.!?])(?:\s|$)/u)?.[1]?.trim()
  return firstSentence || firstLine
}

function getRelatedArtifacts(artifacts: MultiloopArtifact[], milestoneId: string | null, tasks: MultiloopTask[]): MultiloopArtifact[] {
  if (!milestoneId) return []
  const taskIds = new Set(tasks.map((task) => task.id))
  return artifacts.filter((artifact) => artifact.milestoneId === milestoneId || (artifact.taskId !== null && taskIds.has(artifact.taskId)))
}

function isModernVerdict(
  verdict: MultiloopMilestone['reviewVerdicts'][number]
): verdict is MultiloopMilestoneReviewVerdict {
  return verdict.role !== 'legacy'
}

function verdictTitle(verdict: MultiloopMilestone['reviewVerdicts'][number]): string {
  return isModernVerdict(verdict) ? verdict.verdict.replace(/_/g, ' ') : 'Legacy verdict'
}

function toProjectRelativePath(path: string | null | undefined, workspaceRoot: string | null | undefined): string {
  if (!path) return 'multiloop/<loop>/state.json'

  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = workspaceRoot?.replace(/\\/g, '/').replace(/\/+$/u, '')
  if (normalizedRoot && (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`))) {
    return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/u, '') || '.'
  }

  const multiloopIndex = normalizedPath.lastIndexOf('/multiloop/')
  if (multiloopIndex >= 0) return normalizedPath.slice(multiloopIndex + 1)
  return 'multiloop/<loop>/state.json'
}

function resolveProjectPath(path: string, workspaceRoot: string | null | undefined): string {
  if (!workspaceRoot || /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('/') || path.startsWith('\\\\')) return path
  const sep = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/'
  return `${workspaceRoot.replace(/[\\/]+$/u, '')}${sep}${path.replace(/^[\\/]+/u, '')}`
}

type LinkedSprintEngineRole = Extract<SprintEngineRole, MultiloopRole>

function isSprintEngineRole(role: MultiloopRole): role is LinkedSprintEngineRole {
  return role !== 'coordinator'
}

function getLinkedSprintEngineAgentId(role: LinkedSprintEngineRole, linkedState: SprintEngineState | null): string {
  return buildSprintEngineAgentRosterForState(linkedState).find((agent) => agent.role === role)?.id ?? role
}

function buildMultiloopStartupPrompt({
  multiloopPrompt,
  role,
  state,
  statePath,
  workspaceRoot,
}: {
  multiloopPrompt: string
  role: MultiloopRole
  state: MultiloopState
  statePath: string | null
  workspaceRoot: string | null
}): string {
  const soul = getMultiloopRole(role)
  const currentMilestone = getActiveMultiloopMilestone(state)
  const stateRelativePath = toProjectRelativePath(statePath, workspaceRoot)
  const readyTaskIdsForRole = currentMilestone && !currentMilestone.sprintEngine
    ? getMultiloopTasksForMilestone(state, currentMilestone.id)
      .filter((task) => task.role === role && task.status === 'ready')
      .map((task) => task.id)
    : []
  const context = buildMultiloopLaunchContextLines({
    roleLabel: soul.label,
    role,
    agentId: `multiloop-${role}`,
    readyTaskIdsForRole,
    loopName: state.loop.displayName,
    finalGoal: state.loop.finalGoal,
    currentMilestone,
    statePath: stateRelativePath,
  })

  return [multiloopPrompt.trim(), ...context].join('\n')
}

function isMultiloopStateSyncEventDetail(input: unknown): input is MultiloopStateSyncEventDetail {
  if (!input || typeof input !== 'object') return false
  const detail = input as Partial<MultiloopStateSyncEventDetail>
  return typeof detail.workspaceId === 'string'
    && typeof detail.statePath === 'string'
    && (detail.status === 'ok' || detail.status === 'error')
}

export default function MultiloopBoardPanel({ workspaceId }: Props) {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === workspaceId))
  const setMultiloopState = useWorkspaceStore((state) => state.setMultiloopState)
  const updateAgent = useWorkspaceStore((state) => state.updateAgent)
  const openFile = useWorkspaceStore((state) => state.openFile)
  const setMultiloopAutoEnabled = useWorkspaceStore((state) => state.setMultiloopAutoEnabled)
  const setMultiloopCliPermissionPreset = useWorkspaceStore((state) => state.setMultiloopCliPermissionPreset)
  const [readState, setReadState] = useState<ReadState>({ status: 'idle' })
  const [roleLaunchState, setRoleLaunchState] = useState<RoleLaunchState>({ status: 'idle' })
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [goalExpanded, setGoalExpanded] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [linkedSprintEngineStatesByPath, setLinkedSprintEngineStatesByPath] = useState<Record<string, SprintEngineState>>({})
  const [linkedExecutionReadStatesByPath, setLinkedExecutionReadStatesByPath] = useState<Record<string, LinkedExecutionReadState>>({})
  const [linkedExecutionReadRevision, setLinkedExecutionReadRevision] = useState(0)
  const timelineRef = useRef<HTMLOListElement | null>(null)
  const titleId = useId()

  const multiloopState = workspace?.multiloopState ?? null
  const statePath = workspace?.multiloopContext?.statePath ?? null
  const workspaceRoot = workspace?.folderPath ?? null
  const multiloopAutoState = workspace?.multiloopAutoState

  useEffect(() => {
    const snapshot = getMultiloopStateSyncSnapshot(workspaceId)
    if (snapshot) {
      setReadState(snapshot.status === 'ok'
        ? { status: 'idle' }
        : { status: 'error', error: snapshot.error })
    }

    const handleStateSync = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isMultiloopStateSyncEventDetail(event.detail)) return
      if (event.detail.workspaceId !== workspaceId) return
      setReadState(event.detail.status === 'ok'
        ? { status: 'idle' }
        : { status: 'error', error: event.detail.error })
    }

    window.addEventListener(MULTILOOP_STATE_SYNC_EVENT, handleStateSync)
    return () => window.removeEventListener(MULTILOOP_STATE_SYNC_EVENT, handleStateSync)
  }, [workspaceId])

  const openRoleAgent = async (role: MultiloopRole) => {
    if (!workspace || !multiloopState) return

    const soul = getMultiloopRole(role)
    setRoleLaunchState({ status: 'loading', role })
    try {
      const currentMilestone = getActiveMultiloopMilestone(multiloopState)
      const sprintEngineLink = currentMilestone?.sprintEngine ?? null
      const linkedState = sprintEngineLink ? linkedSprintEngineStatesByPath[sprintEngineLink.statePath] ?? null : null
      if (sprintEngineLink && isSprintEngineRole(role)) {
        if (!workspaceRoot) throw new Error('Open this Multiloop workspace from a project folder before launching Sprint Engine workers.')
        if (!linkedState) throw new Error(`Linked Sprint Engine state is not readable yet: ${sprintEngineLink.statePath}`)

        const agentId = getLinkedSprintEngineAgentId(role, linkedState)
        const existingAgent = workspace.agents[agentId]
        const tabName = sprintEngineRoleLabels[role]
        const startupPrompt = prependAgentIdentifier(
          buildSprintEngineStartupPrompt(role, agentId, linkedState.goal, {
            executionCwd: workspaceRoot,
            workspaceRoot,
            sprintEngineStatePath: sprintEngineLink.statePath,
            rosterArgs: buildSprintEngineRosterCommandArgs(linkedState),
            commandMode: getSprintEngineStartupCommandMode(role, agentId, linkedState),
          }),
          tabName,
          tabName
        )
        const previousSessionId = existingAgent?.cliSessionId
        if (existingAgent?.cliStartRequested && previousSessionId) {
          void window.api.terminalKill(previousSessionId).catch(() => {})
        }
        updateAgent(workspaceId, agentId, {
          name: tabName,
          cli: existingAgent?.cli ?? 'codex',
          cliPermissionPreset: existingAgent?.cliPermissionPreset ?? 'default',
          kind: 'sprintengine',
          specialistId: undefined,
          multiloopRole: undefined,
          cliStartupPrompt: startupPrompt,
          cliOnboardingPromptSent: false,
          cliStartRequested: true,
          cliHasLaunched: false,
          cliResumeAvailable: false,
          cliSessionId: `sprintengine-${role}-${nanoid(6)}`,
        })
        focusOrAddAgentTab(workspaceId, agentId, tabName)
        setRoleLaunchState({ status: 'idle' })
        return
      }

      const agentId = `multiloop-${role}`
      const existingAgent = workspace.agents[agentId]
      if (workspaceRoot) {
        const repaired = await window.api.initializeMultiloopState({
          workspaceRoot,
          loopName: multiloopState.loop.displayName,
          finalGoal: multiloopState.loop.finalGoal,
        })
        if (!repaired.ok) {
          throw new Error(repaired.message || 'Could not prepare the Multiloop CLI wrapper for this workspace.')
        }
      }
      const multiloopPrompt = await loadMultiloopPrompt(role)
      const startupPrompt = buildMultiloopStartupPrompt({
        multiloopPrompt,
        role,
        state: multiloopState,
        statePath,
        workspaceRoot,
      })
      const tabName = soul.label
      const previousSessionId = existingAgent?.cliSessionId
      if (existingAgent?.cliStartRequested && previousSessionId) {
        void window.api.terminalKill(previousSessionId).catch(() => {})
      }
      updateAgent(workspaceId, agentId, {
        name: tabName,
        cli: existingAgent?.cli ?? 'codex',
        cliPermissionPreset: existingAgent?.cliPermissionPreset ?? 'default',
        kind: 'multiloop',
        specialistId: undefined,
        multiloopRole: soul.role,
        cliStartupPrompt: prependAgentIdentifier(startupPrompt, tabName, `Multiloop ${soul.shortLabel}`),
        cliOnboardingPromptSent: false,
        cliStartRequested: true,
        cliHasLaunched: false,
        cliResumeAvailable: false,
        cliSessionId: `multiloop-${role}-${nanoid(6)}`,
      })
      focusOrAddAgentTab(workspaceId, agentId, tabName)
      setRoleLaunchState({ status: 'idle' })
    } catch (error) {
      setRoleLaunchState({
        status: 'error',
        role,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  useEffect(() => {
    if (multiloopState || !statePath) return

    let cancelled = false
    setReadState({ status: 'loading' })
    void window.api.readfile(statePath)
      .then((content) => {
        if (cancelled) return
        const parsed = parseMultiloopStateFile(content)
        if (parsed.ok) {
          setMultiloopState(workspaceId, parsed.state)
          setReadState({ status: 'idle' })
        } else {
          setReadState({ status: 'error', error: parsed.error })
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setReadState({
          status: 'error',
          error: {
            title: 'Missing Multiloop state',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })

    return () => {
      cancelled = true
    }
  }, [multiloopState, setMultiloopState, statePath, workspaceId])

  const activeMilestone = useMemo(
    () => (multiloopState ? getActiveMultiloopMilestone(multiloopState) : null),
    [multiloopState]
  )

  useEffect(() => {
    if (!multiloopState) return
    setSelectedMilestoneId((current) => {
      if (current && multiloopState.roadmap.some((milestone) => milestone.id === current)) return current
      return activeMilestone?.id ?? multiloopState.roadmap[0]?.id ?? null
    })
  }, [activeMilestone?.id, multiloopState])

  const selectedMilestone = useMemo(
    () => multiloopState?.roadmap.find((milestone) => milestone.id === selectedMilestoneId) ?? activeMilestone,
    [activeMilestone, multiloopState?.roadmap, selectedMilestoneId]
  )

  const readLinkedExecutionState = useCallback((link: NonNullable<MultiloopMilestone['sprintEngine']>, cancelled: () => boolean) => {
    const resolvedStatePath = resolveProjectPath(link.statePath, workspaceRoot)
    setLinkedExecutionReadStatesByPath((current) => ({
      ...current,
      [link.statePath]: { status: 'loading', path: link.statePath },
    }))
    void window.api.readfile(resolvedStatePath)
      .then((content) => {
        if (cancelled()) return
        const parsed = parseSprintEngineStateFile(content, link.teamSlug)
        setLinkedSprintEngineStatesByPath((current) => ({ ...current, [link.statePath]: parsed }))
        setLinkedExecutionReadStatesByPath((current) => ({
          ...current,
          [link.statePath]: { status: 'idle' },
        }))
      })
      .catch((error: unknown) => {
        if (cancelled()) return
        setLinkedSprintEngineStatesByPath((current) => {
          const next = { ...current }
          delete next[link.statePath]
          return next
        })
        setLinkedExecutionReadStatesByPath((current) => ({
          ...current,
          [link.statePath]: {
            status: 'error',
            path: link.statePath,
            message: error instanceof Error ? error.message : String(error),
          },
        }))
      })
  }, [workspaceRoot])

  useEffect(() => {
    const links = (multiloopState?.roadmap ?? [])
      .flatMap((milestone) => milestone.sprintEngine ? [milestone.sprintEngine] : [])
    if (links.length === 0) {
      setLinkedSprintEngineStatesByPath({})
      setLinkedExecutionReadStatesByPath({})
      return
    }

    let cancelled = false

    for (const link of links) {
      readLinkedExecutionState(link, () => cancelled)
    }

    return () => {
      cancelled = true
    }
  }, [linkedExecutionReadRevision, multiloopState?.roadmap, readLinkedExecutionState])

  const selectedLinkedSprintEngineState = selectedMilestone?.sprintEngine
    ? linkedSprintEngineStatesByPath[selectedMilestone.sprintEngine.statePath] ?? null
    : null
  const activeLinkedSprintEngineState = activeMilestone?.sprintEngine
    ? linkedSprintEngineStatesByPath[activeMilestone.sprintEngine.statePath] ?? null
    : null
  const selectedLinkedExecutionReadState = selectedMilestone?.sprintEngine
    ? linkedExecutionReadStatesByPath[selectedMilestone.sprintEngine.statePath] ?? { status: 'idle' }
    : { status: 'idle' } as const
  const activeLinkedExecutionReadState = activeMilestone?.sprintEngine
    ? linkedExecutionReadStatesByPath[activeMilestone.sprintEngine.statePath] ?? { status: 'idle' }
    : { status: 'idle' } as const

  const visibleTasks = useMemo(
    () => (multiloopState ? getMilestoneExecutionTasks(multiloopState, selectedMilestone, selectedLinkedSprintEngineState) : []),
    [multiloopState, selectedLinkedSprintEngineState, selectedMilestone]
  )
  const activeTasks = useMemo(
    () => (multiloopState ? getMilestoneExecutionTasks(multiloopState, activeMilestone, activeLinkedSprintEngineState) : []),
    [activeLinkedSprintEngineState, activeMilestone, multiloopState]
  )
  const activeBlockers = useMemo(
    () => (multiloopState ? getActiveMultiloopBlockers(multiloopState, activeMilestone?.id) : []),
    [activeMilestone?.id, multiloopState]
  )
  const visibleBlockers = useMemo(
    () => (multiloopState ? getActiveMultiloopBlockers(multiloopState, selectedMilestone?.id) : []),
    [multiloopState, selectedMilestone?.id]
  )
  const activeReadiness = useMemo(
    () => (multiloopState
      ? getMilestoneExecutionReadiness({
        state: multiloopState,
        milestone: activeMilestone,
        linkedSprintEngineState: activeLinkedSprintEngineState,
        linkedReadState: activeLinkedExecutionReadState,
        activeBlockers,
      })
      : 'no_active_milestone'),
    [activeBlockers, activeLinkedExecutionReadState, activeLinkedSprintEngineState, activeMilestone, multiloopState]
  )
  const visibleReadiness = useMemo(
    () => (multiloopState
      ? getMilestoneExecutionReadiness({
        state: multiloopState,
        milestone: selectedMilestone,
        linkedSprintEngineState: selectedLinkedSprintEngineState,
        linkedReadState: selectedLinkedExecutionReadState,
        activeBlockers: visibleBlockers,
      })
      : 'no_active_milestone'),
    [multiloopState, selectedLinkedExecutionReadState, selectedLinkedSprintEngineState, selectedMilestone, visibleBlockers]
  )
  const primaryAction = useMemo(
    () => getPrimaryNextAction(activeReadiness, {
      linkedSprintEngineState: activeLinkedSprintEngineState,
      milestone: activeMilestone,
      tasks: activeTasks,
    }),
    [activeLinkedSprintEngineState, activeMilestone, activeReadiness, activeTasks]
  )
  const autoRunSelection = useMemo<MultiloopAutoRunSelection | null>(
    () => (multiloopState
      ? selectMultiloopAutoRunCandidates({
        state: multiloopState,
        limit: multiloopAutoState?.maxConcurrentAgents ?? 1,
        pendingSpawns: multiloopAutoState?.pendingSpawns ?? [],
        coordinatorAutoSpawnKey: multiloopAutoState?.coordinatorAutoSpawnKey ?? null,
        linkedSprintEngineState: activeLinkedSprintEngineState,
      })
      : null),
    [activeLinkedSprintEngineState, multiloopAutoState?.coordinatorAutoSpawnKey, multiloopAutoState?.maxConcurrentAgents, multiloopAutoState?.pendingSpawns, multiloopState]
  )
  const latestEvidenceTasks = useMemo(
    () => (multiloopState ? getLatestExecutionEvidenceTasks(multiloopState, activeLinkedSprintEngineState, 4) : []),
    [activeLinkedSprintEngineState, multiloopState]
  )
  const selectedTask = useMemo(
    () => visibleTasks.find((task) => task.id === selectedTaskId) ?? visibleTasks.find((task) => task.status !== 'done') ?? visibleTasks[0] ?? null,
    [selectedTaskId, visibleTasks]
  )
  const relatedArtifacts = useMemo(
    () => [
      ...getRelatedArtifacts(multiloopState?.artifacts ?? [], selectedMilestone?.id ?? null, visibleTasks),
      ...getMilestoneExecutionArtifacts(selectedMilestone, selectedLinkedSprintEngineState),
    ],
    [multiloopState?.artifacts, selectedLinkedSprintEngineState, selectedMilestone, visibleTasks]
  )
  const fullGoal = formatMultiloopGoal(multiloopState?.loop.finalGoal ?? '')
  const goalPreview = formatMultiloopGoalPreview(multiloopState?.loop.finalGoal ?? '')
  const canExpandGoal = fullGoal !== goalPreview || fullGoal.length > 260
  const autoRunEnabled = Boolean(multiloopAutoState?.enabled)
  const autoRunReasonLabel = autoRunSelection ? autoRunReasonToLabel(autoRunSelection.reason) : 'no active milestone'
  const autoRunPaused = autoRunSelection?.reason === 'blocked' || autoRunSelection?.reason === 'needs-input'
  const runStateLabel = autoRunEnabled
    ? autoRunPaused
      ? `paused (${autoRunReasonLabel})`
      : 'on'
    : 'off'

  const progress = useMemo(() => {
    const total = multiloopState?.roadmap.length ?? 0
    const accepted = multiloopState?.roadmap.filter((m) => m.status === 'accepted').length ?? 0
    const blocked = multiloopState?.roadmap.filter((m) => m.status === 'blocked').length ?? 0
    return { total, accepted, blocked, percent: total === 0 ? 0 : Math.round((accepted / total) * 100) }
  }, [multiloopState?.roadmap])

  const activeMilestoneIndex = useMemo(
    () => (activeMilestone && multiloopState ? multiloopState.roadmap.findIndex((m) => m.id === activeMilestone.id) : -1),
    [activeMilestone, multiloopState]
  )
  const selectedMilestoneIndex = useMemo(
    () => (selectedMilestone && multiloopState ? multiloopState.roadmap.findIndex((m) => m.id === selectedMilestone.id) : -1),
    [selectedMilestone, multiloopState]
  )

  const handlePrimaryAction = () => {
    if (primaryAction.kind === 'open_role') {
      void openRoleAgent(primaryAction.role)
      return
    }
    if (primaryAction.kind === 'open_coordinator' || primaryAction.kind === 'plan_execution') {
      void openRoleAgent('coordinator')
      return
    }
    setLinkedExecutionReadRevision((current) => current + 1)
  }

  // CommandPalette → panel-command bridge. Mirrors the overflow item ids.
  // Listeners are registered once with a latest-handler ref pattern so normal
  // re-renders don't churn global window listeners and so the captured closure
  // (in particular openRoleAgent, which reads multiloopState / workspace /
  // linked Sprint Engine state) stays fresh. Refs are reassigned synchronously
  // each render with the live closures.
  const commandHandlerRef = useRef<(detail: { id: unknown }) => void>(() => {})
  const settingsChordHandlerRef = useRef<(event: globalThis.KeyboardEvent) => void>(() => {})
  commandHandlerRef.current = (detail) => {
    if (!detail || typeof detail.id !== 'string') return
    switch (detail.id) {
      case 'multiloop.toggle.auto-run':
        setMultiloopAutoEnabled(workspaceId, !autoRunEnabled)
        break
      case 'multiloop.open.coordinator':
        void openRoleAgent('coordinator')
        break
      case 'multiloop.open.settings':
      case 'open.settings':
        setSettingsOpen(true)
        break
    }
  }
  settingsChordHandlerRef.current = (event) => {
    const target = event.target
    const isEditable =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    if (isEditable) return
    if ((event.metaKey || event.ctrlKey) && event.key === ',' && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      setSettingsOpen(true)
    }
  }
  useEffect(() => {
    const onCommand = (event: Event) => {
      commandHandlerRef.current((event as CustomEvent).detail)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      settingsChordHandlerRef.current(event)
    }
    window.addEventListener('multicode:panel-command', onCommand)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('multicode:panel-command', onCommand)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const openLinkedStateFile = async (link: NonNullable<MultiloopMilestone['sprintEngine']>) => {
    const path = resolveProjectPath(link.statePath, workspaceRoot)
    const content = await window.api.readfile(path)
    openFile(workspaceId, path, link.statePath.split(/[\\/]/u).pop() || 'state.yaml', content)
  }

  const overflowItems: OverflowMenuItem[] = []
  if (multiloopState) {
    overflowItems.push({
      id: 'multiloop.toggle.auto-run',
      label: autoRunEnabled ? 'Pause auto-run' : 'Resume auto-run',
      onSelect: () => setMultiloopAutoEnabled(workspaceId, !autoRunEnabled),
    })
    overflowItems.push({
      id: 'multiloop.open.coordinator',
      label: 'Open coordinator',
      onSelect: () => void openRoleAgent('coordinator'),
    })
    overflowItems.push({ kind: 'separator', id: 'sep-1' })
    overflowItems.push({
      id: 'multiloop.open.settings',
      label: 'Multiloop settings',
      shortcut: '⌘ ,',
      onSelect: () => setSettingsOpen(true),
    })
  }

  if (!workspace) return null
  if (readState.status === 'loading') return <StateMessage title="Loading Multiloop state" message="Reading the loop state file." tone="loading" />
  if (readState.status === 'error') {
    return (
      <StateMessage
        title={readState.error.title}
        message={readState.error.path ? `${readState.error.path}: ${readState.error.message}` : readState.error.message}
        tone="error"
      />
    )
  }
  if (!multiloopState) {
    return (
      <StateMessage
        title="No Multiloop state loaded"
        message={statePath ? 'The workspace has a state path, but no readable state is available yet.' : 'Open or create a Multiloop workspace with a state.json file.'}
        tone="empty"
      />
    )
  }
  if (multiloopState.roadmap.length === 0) {
    return (
      <StateMessage
        title="Empty roadmap"
        message="This loop has no milestones to display. Open the Coordinator to plan the first milestone."
        tone="empty"
      />
    )
  }

  const ownership = getOwnershipLabel(activeMilestone, activeLinkedExecutionReadState)
  const readinessText = readinessLabel(activeReadiness)
  const primaryLabel = getPrimaryActionLabel(primaryAction, activeReadiness)
  const primaryLoading = roleLaunchState.status === 'loading' && primaryAction.kind === 'open_role' && roleLaunchState.role === primaryAction.role
  const primaryDisabled = activeReadiness === 'loading_execution' || primaryLoading

  return (
    <section
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[color:var(--bg-app)] text-[color:var(--text-default)] [overflow-wrap:anywhere]"
      aria-labelledby={titleId}
    >
      <PanelHeader
        tool="multiloop"
        title="Campaign"
        titleId={titleId}
        subtitle={multiloopState.loop.displayName}
        count={progress.total > 0 ? `${progress.accepted}/${progress.total}` : undefined}
        progress={progress.total > 0 ? {
          value: progress.accepted,
          warnValue: progress.blocked,
          total: progress.total,
          ariaLabel: `${progress.accepted} of ${progress.total} milestones accepted, ${progress.blocked} blocked`,
        } : undefined}
        primaryAction={(
          <PrimaryButton
            type="button"
            onClick={handlePrimaryAction}
            disabled={primaryDisabled}
            aria-label={primaryLoading ? 'Opening agent' : primaryLabel}
          >
            {primaryLoading ? 'Opening…' : primaryLabel}
          </PrimaryButton>
        )}
        overflow={(
          <div className="relative inline-flex">
            <OverflowMenu ariaLabel="Multiloop overflow" items={overflowItems} />
            {settingsOpen ? (
              <MultiloopSettingsPopover
                autoRunEnabled={autoRunEnabled}
                runStateLabel={runStateLabel}
                autoRunReasonLabel={autoRunReasonLabel}
                cliPermissionPreset={multiloopAutoState?.cliPermissionPreset ?? 'default'}
                agents={workspace.agents}
                launchState={roleLaunchState}
                hasSprintEngineLink={Boolean(activeMilestone?.sprintEngine)}
                linkedSprintEngineState={activeLinkedSprintEngineState}
                linkedExecutionReadState={activeLinkedExecutionReadState}
                onToggleAutoRun={() => setMultiloopAutoEnabled(workspaceId, !autoRunEnabled)}
                onPermissionPresetChange={(preset) => setMultiloopCliPermissionPreset(workspaceId, preset)}
                onOpenRole={(role) => void openRoleAgent(role)}
                onClose={() => setSettingsOpen(false)}
              />
            ) : null}
          </div>
        )}
      />

      <CampaignSummary
        iteration={multiloopState.loop.iteration}
        activeMilestone={activeMilestone}
        activeMilestoneIndex={activeMilestoneIndex}
        ownership={ownership}
        readiness={readinessText}
        readinessTone={readinessTone(activeReadiness)}
        blockersCount={activeBlockers.length}
        autoRunLabel={runStateLabel}
        autoRunPaused={autoRunPaused}
        fullGoal={fullGoal}
        goalPreview={goalPreview}
        canExpandGoal={canExpandGoal}
        goalExpanded={goalExpanded}
        onToggleGoal={() => setGoalExpanded((current) => !current)}
        launchError={roleLaunchState.status === 'error' ? roleLaunchState : null}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="min-h-0 min-w-0 overflow-y-auto">
          <div className="flex flex-col gap-2 py-2">
            <SprintConsole
              milestone={selectedMilestone}
              milestoneIndex={selectedMilestoneIndex}
              activeMilestoneId={activeMilestone?.id ?? null}
              readiness={visibleReadiness}
              blockersCount={visibleBlockers.length}
              linkedSprintEngineState={selectedLinkedSprintEngineState}
              linkedExecutionReadState={selectedLinkedExecutionReadState}
              workspaceRoot={workspaceRoot}
              onOpenStateFile={(link) => void openLinkedStateFile(link)}
            />
            {visibleReadiness === 'execution_unavailable' && selectedMilestone?.sprintEngine && selectedLinkedExecutionReadState.status === 'error' ? (
              <ExecutionUnavailable
                link={selectedMilestone.sprintEngine}
                readState={selectedLinkedExecutionReadState}
                workspaceRoot={workspaceRoot}
                onRetry={() => setLinkedExecutionReadRevision((current) => current + 1)}
                onOpenStateFile={() => void openLinkedStateFile(selectedMilestone.sprintEngine!)}
                onOpenCoordinator={() => void openRoleAgent('coordinator')}
              />
            ) : (
              <TaskBoard
                tasks={visibleTasks}
                selectedTaskId={selectedTask?.id ?? null}
                onSelectTask={setSelectedTaskId}
                source={selectedMilestone?.sprintEngine ? 'sprintengine' : 'multiloop'}
                readiness={visibleReadiness}
                onPlanExecution={() => void openRoleAgent('coordinator')}
              />
            )}
            <BlockersPanel blockers={visibleBlockers} />
          </div>
        </main>

        <aside
          className="min-h-0 overflow-y-auto border-t border-[color:var(--border-default)] xl:border-l xl:border-t-0"
          aria-label="Loop timeline and reassessment"
        >
          <CampaignTimeline
            ref={timelineRef}
            milestones={multiloopState.roadmap}
            activeMilestoneId={activeMilestone?.id ?? null}
            selectedMilestoneId={selectedMilestone?.id ?? null}
            onSelect={(id) => {
              setSelectedMilestoneId(id)
              setSelectedTaskId(null)
            }}
          />
          <ReassessmentColumn
            milestone={selectedMilestone}
            iteration={multiloopState.loop.iteration}
            decisions={multiloopState.decisions}
            evidenceTasks={latestEvidenceTasks}
            artifacts={relatedArtifacts}
            selectedTask={selectedTask}
            onClearTaskSelection={() => setSelectedTaskId(null)}
          />
        </aside>
      </div>
    </section>
  )
}

// ===========================================================================
// CAMPAIGN SUMMARY — one-line meta crumb under PanelHeader with on-demand
// details disclosure. The crumb keeps first content (TaskBoard) close to the
// top; the full DefinitionList only renders when the user opens it or expands
// the goal.
// ===========================================================================

function CampaignSummary({
  iteration,
  activeMilestone,
  activeMilestoneIndex,
  ownership,
  readiness,
  readinessTone: readinessToneValue,
  blockersCount,
  autoRunLabel,
  autoRunPaused,
  fullGoal,
  goalPreview,
  canExpandGoal,
  goalExpanded,
  onToggleGoal,
  launchError,
}: {
  iteration: number
  activeMilestone: MultiloopMilestone | null
  activeMilestoneIndex: number
  ownership: string
  readiness: string
  readinessTone: Tone
  blockersCount: number
  autoRunLabel: string
  autoRunPaused: boolean
  fullGoal: string
  goalPreview: string
  canExpandGoal: boolean
  goalExpanded: boolean
  onToggleGoal: () => void
  launchError: { role: MultiloopRole; message: string } | null
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const sprintLabel = activeMilestone
    ? `M${activeMilestoneIndex + 1} · ${activeMilestone.title}`
    : 'No active sprint'

  const items: DefinitionItem[] = [
    {
      term: 'Active sprint',
      description: activeMilestone
        ? `M${activeMilestoneIndex + 1} · ${activeMilestone.title}`
        : 'None',
    },
    { term: 'Iteration', description: String(iteration) },
    { term: 'Owner', description: ownership },
    {
      term: 'Readiness',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={readinessToneValue} />
          <span>{readiness}</span>
        </span>
      ),
    },
    {
      term: 'Blockers',
      description: blockersCount > 0
        ? (
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone="warn" />
            <span>{formatCount(blockersCount, 'blocker')}</span>
          </span>
        )
        : 'None',
    },
    {
      term: 'Auto-run',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={autoRunPaused ? 'warn' : autoRunLabel === 'on' ? 'accent' : 'neutral'} />
          <span>{autoRunLabel}</span>
        </span>
      ),
    },
  ]

  return (
    <div className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-[color:var(--text-muted)]">
        <span className="truncate text-[color:var(--text-default)]">{sprintLabel}</span>
        <span aria-hidden="true">·</span>
        <span>Iteration {iteration}</span>
        <span aria-hidden="true">·</span>
        <span>Owner {ownership}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <StatusDot tone={readinessToneValue} />
          <span>{readiness}</span>
        </span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <StatusDot tone={blockersCount > 0 ? 'warn' : 'neutral'} />
          <span>{blockersCount > 0 ? formatCount(blockersCount, 'blocker') : 'No blockers'}</span>
        </span>
        <button
          type="button"
          onClick={() => setDetailsOpen((current) => !current)}
          aria-expanded={detailsOpen}
          className="ml-auto text-[11px] text-[color:var(--accent-primary)] underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
        >
          {detailsOpen ? 'Hide details' : 'Show details'}
        </button>
      </div>
      {detailsOpen ? (
        <div className="mt-2 max-w-3xl">
          <DefinitionList items={items} />
          <div className="mt-2">
            <p
              className={`text-[12px] leading-[1.5] text-[color:var(--text-default)] ${
                goalExpanded ? 'whitespace-pre-wrap' : 'line-clamp-2'
              }`}
            >
              <span className="text-[color:var(--text-muted)]">Final goal: </span>
              {goalExpanded ? fullGoal : goalPreview}
            </p>
            {canExpandGoal ? (
              <button
                type="button"
                onClick={onToggleGoal}
                aria-expanded={goalExpanded}
                className="mt-1 text-[12px] text-[color:var(--accent-primary)] underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
              >
                {goalExpanded ? 'Show less' : 'Show more'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {launchError ? (
        <p className="mt-2 text-[12px] text-[color:var(--tone-error)]" role="status">
          {getMultiloopRole(launchError.role).label}: {launchError.message}
        </p>
      ) : null}
    </div>
  )
}

// ===========================================================================
// CAMPAIGN TIMELINE — horizontal milestone stations on a hairline rail.
// ===========================================================================

type CampaignTimelineProps = {
  milestones: MultiloopMilestone[]
  activeMilestoneId: string | null
  selectedMilestoneId: string | null
  onSelect: (milestoneId: string) => void
}

function CampaignTimelineImpl(
  { milestones, activeMilestoneId, selectedMilestoneId, onSelect }: CampaignTimelineProps,
  ref: React.ForwardedRef<HTMLOListElement>
) {
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    let nextIndex = index
    if (event.key === 'ArrowRight') nextIndex = Math.min(milestones.length - 1, index + 1)
    if (event.key === 'ArrowLeft') nextIndex = Math.max(0, index - 1)
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = milestones.length - 1
    const target = milestones[nextIndex]
    if (!target) return
    onSelect(target.id)
    window.requestAnimationFrame(() => buttonRefs.current[target.id]?.focus())
  }

  return (
    <nav
      aria-label="Campaign timeline"
      className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-app)] px-3 py-2"
    >
      <ol
        ref={ref}
        className="flex min-w-0 items-stretch gap-0 overflow-x-auto scroll-smooth"
      >
        {milestones.map((milestone, index) => {
          const isSelected = milestone.id === selectedMilestoneId
          const isActive = milestone.id === activeMilestoneId
          return (
            <Fragment key={milestone.id}>
              {index > 0 ? (
                <TimelineConnector
                  fromStatus={milestones[index - 1].status}
                  toStatus={milestone.status}
                />
              ) : null}
              <li className="flex min-w-[10rem] max-w-[14rem] flex-1 flex-col">
                <TimelineStation
                  ref={(node) => {
                    buttonRefs.current[milestone.id] = node
                  }}
                  milestone={milestone}
                  index={index}
                  isSelected={isSelected}
                  isActive={isActive}
                  onSelect={() => onSelect(milestone.id)}
                  onKeyDown={(event) => handleKeyDown(event, index)}
                />
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}

const CampaignTimeline = forwardRef<HTMLOListElement, CampaignTimelineProps>(CampaignTimelineImpl)
CampaignTimeline.displayName = 'CampaignTimeline'

function TimelineConnector({ fromStatus, toStatus }: { fromStatus: MultiloopMilestoneStatus; toStatus: MultiloopMilestoneStatus }) {
  const colorVar = fromStatus === 'accepted' || toStatus === 'accepted'
    ? 'var(--accent-primary)'
    : fromStatus === 'blocked' || toStatus === 'blocked'
      ? 'var(--tone-warn)'
      : 'var(--border-default)'
  return (
    <div aria-hidden="true" className="relative flex min-w-[1.25rem] flex-1 items-center px-1">
      <div className="h-px w-full" style={{ backgroundColor: colorVar }} />
    </div>
  )
}

type TimelineStationProps = {
  milestone: MultiloopMilestone
  index: number
  isSelected: boolean
  isActive: boolean
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

function TimelineStationImpl(
  { milestone, index, isSelected, isActive, onSelect, onKeyDown }: TimelineStationProps,
  ref: React.ForwardedRef<HTMLButtonElement>
) {
  const tone: Tone = milestoneStatusTone[milestone.status]
  const containerClass = isSelected
    ? 'bg-[color:var(--accent-primary-soft)] border-l-2 border-[color:var(--accent-primary)]'
    : 'border-l-2 border-transparent hover:bg-[color:var(--bg-hover)]'

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      aria-pressed={isSelected}
      aria-current={isActive ? 'step' : undefined}
      className={`group flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] ${containerClass}`}
    >
      <StatusDot tone={tone} pulse={isActive} className="mt-1" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--text-muted)]">
          <span className="tabular-nums">M{index + 1}</span>
          <span>·</span>
          <span>{milestoneStatusLabels[milestone.status]}</span>
          {milestone.sprintEngine ? (
            <>
              <span>·</span>
              <span>Sprint Engine</span>
            </>
          ) : null}
        </div>
        <div className="line-clamp-2 text-[12px] font-medium leading-[1.3] text-[color:var(--text-strong)]">
          {milestone.title}
        </div>
      </div>
    </button>
  )
}

const TimelineStation = forwardRef<HTMLButtonElement, TimelineStationProps>(TimelineStationImpl)
TimelineStation.displayName = 'TimelineStation'

// ===========================================================================
// SPRINT CONSOLE — selected milestone summary + execution source strip.
// ===========================================================================

function SprintConsole({
  milestone,
  milestoneIndex,
  activeMilestoneId,
  readiness,
  blockersCount,
  linkedSprintEngineState,
  linkedExecutionReadState,
  workspaceRoot,
  onOpenStateFile,
}: {
  milestone: MultiloopMilestone | null
  milestoneIndex: number
  activeMilestoneId: string | null
  readiness: MultiloopExecutionReadiness
  blockersCount: number
  linkedSprintEngineState: SprintEngineState | null
  linkedExecutionReadState: LinkedExecutionReadState
  workspaceRoot: string | null
  onOpenStateFile: (link: NonNullable<MultiloopMilestone['sprintEngine']>) => void
}) {
  if (!milestone) {
    return (
      <Section title="Sprint">
        <p className="text-[12px] text-[color:var(--text-muted)]">
          No milestone selected. Pick a station from the timeline.
        </p>
      </Section>
    )
  }

  const isActive = milestone.id === activeMilestoneId
  const tone = readinessTone(readiness)
  const sprintLabel = `${isActive ? 'Active sprint' : 'Sprint'} M${milestoneIndex + 1}`
  const sourceLabel = milestone.sprintEngine ? 'Sprint Engine' : 'Multiloop'
  const linkedRelativePath = milestone.sprintEngine
    ? toProjectRelativePath(milestone.sprintEngine.statePath, workspaceRoot)
    : null

  const details: DefinitionItem[] = [
    { term: 'Sprint', description: sprintLabel },
    {
      term: 'Status',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={milestoneStatusTone[milestone.status]} />
          <span>{milestoneStatusLabels[milestone.status]}</span>
        </span>
      ),
    },
    {
      term: 'Readiness',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={tone} />
          <span>{readinessLabel(readiness)}</span>
        </span>
      ),
    },
    { term: 'Source', description: sourceLabel },
  ]
  if (blockersCount > 0) {
    details.push({
      term: 'Blockers',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone="warn" />
          <span>{formatCount(blockersCount, 'blocker')}</span>
        </span>
      ),
    })
  }

  return (
    <Section title={milestone.title} headingId={`sprint-${milestone.id}`}>
      <DefinitionList items={details} />
      {milestone.goal ? (
        <p className="mt-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
          {milestone.goal}
        </p>
      ) : null}
      {linkedRelativePath && milestone.sprintEngine ? (
        <p className="mt-2 text-[12px] text-[color:var(--text-muted)]">
          <span>{linkedSprintEngineState?.name || milestone.sprintEngine.teamSlug}</span>
          <span aria-hidden="true" className="mx-1.5">·</span>
          <button
            type="button"
            onClick={() => onOpenStateFile(milestone.sprintEngine!)}
            className="break-all font-mono text-[11px] text-[color:var(--accent-primary)] underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
          >
            {linkedRelativePath}
          </button>
          {linkedExecutionReadState.status === 'loading' ? (
            <>
              <span aria-hidden="true" className="mx-1.5">·</span>
              <span>Reading state…</span>
            </>
          ) : null}
        </p>
      ) : null}
      {(milestone.entryCriteria.length > 0 || milestone.acceptanceCriteria.length > 0) ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <ListBlock title="Entry criteria" items={milestone.entryCriteria} />
          <ListBlock title="Acceptance criteria" items={milestone.acceptanceCriteria} />
        </div>
      ) : null}
      {milestone.finalGoalContribution ? (
        <div className="mt-3">
          <div className="text-[11px] text-[color:var(--text-muted)]">Final goal contribution</div>
          <p className="mt-1 text-[12px] leading-[1.5] text-[color:var(--text-default)]">{milestone.finalGoalContribution}</p>
        </div>
      ) : null}
    </Section>
  )
}

function ExecutionUnavailable({
  link,
  readState,
  workspaceRoot,
  onRetry,
  onOpenStateFile,
  onOpenCoordinator,
}: {
  link: NonNullable<MultiloopMilestone['sprintEngine']>
  readState: Extract<LinkedExecutionReadState, { status: 'error' }>
  workspaceRoot: string | null
  onRetry: () => void
  onOpenStateFile: () => void
  onOpenCoordinator: () => void
}) {
  return (
    <Section title="Execution unavailable">
      <div className="flex items-start gap-2">
        <StatusDot tone="error" className="mt-1" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] leading-[1.5] text-[color:var(--text-default)]">
            Sprint Engine state for {link.teamSlug} is not readable.
          </p>
          <p className="mt-1 break-all font-mono text-[11px] leading-[1.4] text-[color:var(--tone-error)]">
            {toProjectRelativePath(readState.path || link.statePath, workspaceRoot)}
          </p>
          <p className="mt-1 text-[12px] leading-[1.5] text-[color:var(--text-muted)]">
            {readState.message}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <PrimaryButton type="button" onClick={onRetry}>Retry</PrimaryButton>
            <GhostButton type="button" onClick={onOpenStateFile}>Open state file</GhostButton>
            <GhostButton type="button" onClick={onOpenCoordinator}>Open coordinator</GhostButton>
          </div>
        </div>
      </div>
    </Section>
  )
}

// ===========================================================================
// TASK BOARD — grouped by status using InboxRow primitives.
// ===========================================================================

function TaskBoard({
  tasks,
  selectedTaskId,
  onSelectTask,
  source,
  readiness,
  onPlanExecution,
}: {
  tasks: MultiloopTask[]
  selectedTaskId: string | null
  onSelectTask: (taskId: string) => void
  source: 'sprintengine' | 'multiloop'
  readiness: MultiloopExecutionReadiness
  onPlanExecution: () => void
}) {
  const sourceLabel = source === 'sprintengine' ? 'Sprint Engine' : 'Multiloop'

  if (tasks.length === 0) {
    return (
      <Section title="Sprint tasks" action={<span className="text-[11px] text-[color:var(--text-muted)]">Source: {sourceLabel}</span>}>
        <p className="text-[12px] text-[color:var(--text-muted)]">{readinessLabel(readiness)}.</p>
        <div className="mt-2">
          <PrimaryButton type="button" onClick={onPlanExecution}>Plan execution</PrimaryButton>
        </div>
      </Section>
    )
  }

  const groups = TASK_GROUPS.map((group) => ({
    ...group,
    tasks: tasks.filter((task) => task.status === group.key),
  })).filter((group) => group.tasks.length > 0)

  return (
    <Section
      title="Sprint tasks"
      count={tasks.length}
      action={<span className="text-[11px] text-[color:var(--text-muted)]">Source: {sourceLabel}</span>}
      inset={false}
    >
      <div className="flex flex-col">
        {groups.map((group) => (
          <div key={group.key}>
            <div className="flex items-baseline justify-between gap-2 px-3 pt-2 pb-1">
              <div className="flex items-baseline gap-1.5">
                <h4 className="text-[11px] font-semibold text-[color:var(--text-muted)]">{group.label}</h4>
                <span className="tabular-nums text-[11px] text-[color:var(--text-disabled)]">
                  {group.tasks.length}
                </span>
              </div>
            </div>
            <div className="flex flex-col">
              {group.tasks.map((task) => {
                const selected = selectedTaskId === task.id
                const owner = task.ownerAgentId
                const supporting = (
                  <span className="inline-flex items-center gap-1.5">
                    <span>{task.role}</span>
                    {owner ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{owner}</span>
                      </>
                    ) : null}
                    {hasEvidence(task) ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Evidence</span>
                      </>
                    ) : null}
                  </span>
                )
                return (
                  <InboxRow
                    key={task.id}
                    tone={taskStatusTone[task.status]}
                    title={task.title || task.id}
                    supporting={supporting}
                    trailing={<span className="font-mono">{task.id}</span>}
                    selected={selected}
                    onSelect={() => onSelectTask(task.id)}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

function BlockersPanel({ blockers }: { blockers: MultiloopBlocker[] }) {
  if (blockers.length === 0) return null
  return (
    <Section title="Active blockers" count={blockers.length} inset={false}>
      <div className="flex flex-col">
        {blockers.map((blocker) => (
          <InboxRow
            key={blocker.id}
            tone="warn"
            title={blocker.summary}
            supporting={blocker.detail || undefined}
            trailing={<span>{blocker.scope}</span>}
          />
        ))}
      </div>
    </Section>
  )
}

// ===========================================================================
// REASSESSMENT COLUMN — loop-closing context: verdicts, recommendation,
// learned facts, decisions, evidence, artifacts, optional task detail.
// ===========================================================================

function ReassessmentColumn({
  milestone,
  iteration,
  decisions,
  evidenceTasks,
  artifacts,
  selectedTask,
  onClearTaskSelection,
}: {
  milestone: MultiloopMilestone | null
  iteration: number
  decisions: MultiloopDecision[]
  evidenceTasks: MultiloopTask[]
  artifacts: MultiloopArtifact[]
  selectedTask: MultiloopTask | null
  onClearTaskSelection: () => void
}) {
  const verdicts = useMemo(() => {
    return (milestone?.reviewVerdicts ?? [])
      .filter(isModernVerdict)
      .slice(-3)
      .reverse()
  }, [milestone?.reviewVerdicts])

  const latestRecommendation = verdicts.find((v) => v.nextRecommendation.trim())?.nextRecommendation ?? ''
  const learnedFacts = milestone?.learnedFacts ?? []
  const recentDecisions = decisions.slice(-3).reverse()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-[12px] text-[color:var(--text-muted)]">
          <span className="font-semibold text-[color:var(--text-strong)]">Reassessment</span>
          <span>Iteration {iteration}</span>
        </div>
        {latestRecommendation ? (
          <>
            <div className="mt-2 text-[11px] text-[color:var(--text-muted)]">Next recommendation</div>
            <p className="mt-1 text-[12px] leading-[1.5] text-[color:var(--text-default)]">{latestRecommendation}</p>
          </>
        ) : (
          <p className="mt-2 text-[12px] leading-[1.5] text-[color:var(--text-muted)]">
            The loop is waiting for the next reassessment. After a sprint completes, reviewers post verdicts that shape the next milestone.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selectedTask ? (
          <SelectedTaskCard task={selectedTask} onClear={onClearTaskSelection} />
        ) : null}

        <ReassessSection title="Latest verdicts" emptyText="No reviewer verdicts yet for this milestone.">
          {verdicts.length === 0 ? null : (
            <div className="flex flex-col">
              {verdicts.map((verdict) => (
                <InboxRow
                  key={verdict.id}
                  tone={verdictTone[verdict.verdict]}
                  title={verdictTitle(verdict)}
                  supporting={verdict.nextRecommendation || verdict.finalGoalImplications[0] || undefined}
                  trailing={<span>{verdict.role}</span>}
                />
              ))}
            </div>
          )}
        </ReassessSection>

        <ReassessSection title="Learned facts" emptyText="No facts learned yet — they accumulate as sprints complete.">
          {learnedFacts.length === 0 ? null : (
            <ul className="space-y-1 px-3 pb-2">
              {learnedFacts.map((fact) => (
                <li key={fact} className="flex gap-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
                  <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[color:var(--accent-primary)]" />
                  <span>{fact}</span>
                </li>
              ))}
            </ul>
          )}
        </ReassessSection>

        <ReassessSection title="Recent evidence" emptyText="No task evidence captured yet.">
          {evidenceTasks.length === 0 ? null : (
            <div className="flex flex-col">
              {evidenceTasks.map((task) => (
                <InboxRow
                  key={task.id}
                  tone={taskStatusTone[task.status]}
                  title={task.title || task.id}
                  supporting={task.evidence.summary || task.evidence.results[0] || undefined}
                  trailing={<span>{formatDate(task.updatedAt ?? task.completedAt ?? task.startedAt ?? task.createdAt)}</span>}
                />
              ))}
            </div>
          )}
        </ReassessSection>

        <ReassessSection title="Decisions" emptyText="No decisions recorded.">
          {recentDecisions.length === 0 ? null : (
            <ul className="space-y-1 px-3 pb-2">
              {recentDecisions.map((decision) => (
                <li key={decision.id} className="text-[12px] leading-[1.5] text-[color:var(--text-default)]">
                  {decision.summary || 'Decision recorded without summary.'}
                </li>
              ))}
            </ul>
          )}
        </ReassessSection>

        <ReassessSection title="Artifacts" emptyText="No artifacts linked to this milestone yet.">
          {artifacts.length === 0 ? null : (
            <div className="flex flex-col">
              {artifacts.map((artifact) => (
                <InboxRow
                  key={artifact.id}
                  tone="neutral"
                  title={artifact.title}
                  supporting={artifact.path ? <span className="break-all font-mono text-[11px]">{artifact.path}</span> : undefined}
                  trailing={<span>{artifact.kind || 'artifact'}</span>}
                />
              ))}
            </div>
          )}
        </ReassessSection>
      </div>
    </div>
  )
}

function ReassessSection({ title, emptyText, children }: { title: string; emptyText: string; children: ReactNode }) {
  const hasChildren = Boolean(children) && (Array.isArray(children) ? children.some(Boolean) : true)
  return (
    <Section title={title} inset={false}>
      {hasChildren ? children : (
        <p className="px-3 pb-2 text-[12px] leading-[1.5] text-[color:var(--text-muted)]">{emptyText}</p>
      )}
    </Section>
  )
}

function SelectedTaskCard({ task, onClear }: { task: MultiloopTask; onClear: () => void }) {
  const items: DefinitionItem[] = [
    {
      term: 'Status',
      description: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={taskStatusTone[task.status]} />
          <span>{taskStatusLabels[task.status]}</span>
        </span>
      ),
    },
    { term: 'Role', description: task.role },
  ]
  if (task.ownerAgentId) items.push({ term: 'Owner', description: task.ownerAgentId })

  return (
    <Section
      title={task.title || task.id}
      action={(
        <IconButton
          aria-label="Clear task selection"
          onClick={onClear}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path
              d="M3 3L9 9M9 3L3 9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </IconButton>
      )}
    >
      <DefinitionList items={items} />
      {task.description ? (
        <p className="mt-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">{task.description}</p>
      ) : null}
      {task.acceptanceCriteria.length ? (
        <div className="mt-3">
          <div className="text-[11px] text-[color:var(--text-muted)]">Acceptance</div>
          <ul className="mt-1 space-y-1">
            {task.acceptanceCriteria.map((item) => (
              <li key={item} className="flex gap-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
                <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[color:var(--accent-primary)]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {task.blockers.length ? (
        <div className="mt-3">
          <div className="text-[11px] text-[color:var(--tone-warn)]">Blockers</div>
          <ul className="mt-1 space-y-1">
            {task.blockers.map((item) => (
              <li key={item} className="flex gap-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
                <StatusDot tone="warn" className="mt-1.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  )
}

// ===========================================================================
// SETTINGS POPOVER — combines Run settings (auto-run + permission preset) and
// Terminals (per-role agent launchers) into one popover surface anchored to
// the panel header overflow trigger.
// ===========================================================================

function MultiloopSettingsPopover({
  autoRunEnabled,
  runStateLabel,
  autoRunReasonLabel,
  cliPermissionPreset,
  agents,
  launchState,
  hasSprintEngineLink,
  linkedSprintEngineState,
  linkedExecutionReadState,
  onToggleAutoRun,
  onPermissionPresetChange,
  onOpenRole,
  onClose,
}: {
  autoRunEnabled: boolean
  runStateLabel: string
  autoRunReasonLabel: string
  cliPermissionPreset: SprintEngineCliPermissionPreset
  agents: Record<string, AgentState>
  launchState: RoleLaunchState
  hasSprintEngineLink: boolean
  linkedSprintEngineState: SprintEngineState | null
  linkedExecutionReadState: LinkedExecutionReadState
  onToggleAutoRun: () => void
  onPermissionPresetChange: (preset: SprintEngineCliPermissionPreset) => void
  onOpenRole: (role: MultiloopRole) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const labelId = useId()
  const restoreFocusElementRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreFocusElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    window.requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
      ;(first ?? panelRef.current)?.focus()
    })
    return () => {
      const trigger = document.querySelector<HTMLElement>('[aria-label="Multiloop overflow"]')
      ;(trigger ?? restoreFocusElementRef.current)?.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointer)
    }
  }, [onClose])

  const onPanelKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
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

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelId}
      tabIndex={-1}
      onKeyDown={onPanelKey}
      // design-tokens-allow: settings popover elevation reuses the canonical shadow.
      className="popover-enter absolute right-0 top-full z-30 mt-1 w-80 rounded-[7px] border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--border-default)] px-3 py-2">
        <h3 id={labelId} className="text-[13px] font-semibold text-[color:var(--text-strong)]">
          Multiloop settings
        </h3>
        <IconButton aria-label="Close settings" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </IconButton>
      </div>

      <Section title="Run" level={4}>
        <div className="flex items-center justify-between gap-3 text-[12px] text-[color:var(--text-default)]">
          <span id="multiloop-settings-auto-label">Autonomous loop</span>
          <Switch
            checked={autoRunEnabled}
            onChange={onToggleAutoRun}
            ariaLabelledBy="multiloop-settings-auto-label"
          />
        </div>
        <p className="mt-1.5 text-[11px] leading-[1.5] text-[color:var(--text-muted)]">
          When on, Multiloop spawns the next role agent as soon as a sprint task is ready.
          Current: {runStateLabel}. Engine reason: {autoRunReasonLabel}.
        </p>
        <div className="mt-3 flex flex-col gap-1">
          <span className="text-[11px] text-[color:var(--text-muted)]">CLI permission preset</span>
          <Select<SprintEngineCliPermissionPreset>
            ariaLabel="CLI permission preset"
            items={multiloopCliPermissionOptions.map(({ value, label }) => ({ value, label }))}
            value={cliPermissionPreset}
            onChange={onPermissionPresetChange}
            className="w-full"
          />
        </div>
      </Section>

      <Section title="Terminals" level={4}>
        <div className="flex flex-col gap-3">
          {TERMINAL_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1 text-[11px] text-[color:var(--text-muted)]">{group.label}</div>
              <div className="flex flex-col">
                {group.roles.map((role) => {
                  const soul = getMultiloopRole(role)
                  const isLinkedWorker = hasSprintEngineLink && isSprintEngineRole(role)
                  const agentId = isLinkedWorker && linkedSprintEngineState
                    ? getLinkedSprintEngineAgentId(role, linkedSprintEngineState)
                    : `multiloop-${role}`
                  const exists = Boolean(agents[agentId])
                  const loading = launchState.status === 'loading' && launchState.role === role
                  const disabledReason = isLinkedWorker && !linkedSprintEngineState
                    ? linkedExecutionReadState.status === 'error'
                      ? 'Sprint Engine state is unreadable.'
                      : 'Sprint Engine state is still loading.'
                    : null
                  const terminalKind = isLinkedWorker ? 'Sprint Engine' : 'Multiloop'
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => {
                        if (disabledReason) return
                        onOpenRole(role)
                      }}
                      disabled={loading || Boolean(disabledReason)}
                      className="interactive flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12px] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)] disabled:cursor-not-allowed disabled:opacity-45"
                      title={disabledReason ?? `${exists ? 'Focus' : 'Create'} ${terminalKind} ${soul.label} role terminal`}
                    >
                      <SpecialistActionIcon icon={soul.icon} className="h-4 w-4 shrink-0 text-[color:var(--text-muted)]" />
                      <span className="min-w-0 flex-1 truncate">
                        {loading ? 'Opening…' : `${soul.label} (${terminalKind})`}
                      </span>
                      {exists ? <StatusDot tone="accent" label="Created" /> : null}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

// ===========================================================================
// LABELS, HELPERS
// ===========================================================================

function readinessLabel(readiness: MultiloopExecutionReadiness): string {
  switch (readiness) {
    case 'ready':
      return 'Ready'
    case 'blocked':
      return 'Blocked'
    case 'needs_input':
      return 'Needs input'
    case 'all_done':
      return 'All done'
    case 'loading_execution':
      return 'Sprint Engine loading'
    case 'execution_unavailable':
      return 'Execution unavailable'
    case 'no_tasks':
      return 'Sprint Engine no tasks'
    case 'multiloop_no_tasks':
      return 'Multiloop no tasks'
    case 'no_active_milestone':
      return 'No active milestone'
  }
}

function readinessTone(readiness: MultiloopExecutionReadiness): Tone {
  if (readiness === 'ready' || readiness === 'all_done') return 'good'
  if (readiness === 'blocked' || readiness === 'needs_input') return 'warn'
  if (readiness === 'execution_unavailable') return 'error'
  return 'neutral'
}

function getOwnershipLabel(milestone: MultiloopMilestone | null, linkedExecutionReadState: LinkedExecutionReadState): string {
  if (!milestone?.sprintEngine) return 'Multiloop'
  if (linkedExecutionReadState.status === 'loading') return 'Sprint Engine (loading)'
  if (linkedExecutionReadState.status === 'error') return 'Sprint Engine (unavailable)'
  return 'Sprint Engine'
}

function getPrimaryActionLabel(action: MultiloopPrimaryNextAction, readiness: MultiloopExecutionReadiness): string {
  if (action.kind === 'retry_execution_read') return 'Retry execution read'
  if (action.kind === 'plan_execution') return 'Plan execution'
  if (action.kind === 'open_coordinator') {
    if (readiness === 'blocked') return 'Resolve blocker'
    if (readiness === 'all_done') return 'Reassess loop'
    if (readiness === 'no_tasks' || readiness === 'multiloop_no_tasks') return 'Plan execution'
    return 'Open coordinator'
  }
  return `Open ${getMultiloopRole(action.role).label}`
}

function StateMessage({ title, message, tone }: { title: string; message: string; tone: 'empty' | 'error' | 'loading' }) {
  const dotTone: Tone = tone === 'error' ? 'error' : tone === 'loading' ? 'accent' : 'neutral'
  return (
    <section
      className="flex h-full min-w-0 items-center justify-center bg-[color:var(--bg-app)] px-6 text-center text-[color:var(--text-default)] [overflow-wrap:anywhere]"
      role={tone === 'loading' ? 'status' : 'region'}
      aria-live="polite"
    >
      <div className="min-w-0 max-w-md rounded-[7px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-4">
        <div className="flex items-center justify-center gap-2">
          <StatusDot tone={dotTone} pulse={tone === 'loading'} />
          <h1 className="text-[13px] font-semibold text-[color:var(--text-strong)]">{title}</h1>
        </div>
        <p className="mt-2 text-[12px] leading-[1.5] text-[color:var(--text-muted)]">{message}</p>
      </div>
    </section>
  )
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-[11px] text-[color:var(--text-muted)]">{title}</div>
      {items.length === 0 ? (
        <p className="mt-1 text-[12px] text-[color:var(--text-muted)]">None recorded.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((item) => (
            <li key={item} className="flex gap-2 text-[12px] leading-[1.5] text-[color:var(--text-default)]">
              <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[color:var(--accent-primary)]" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
