import { Fragment, forwardRef, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { nanoid } from 'nanoid'
import { SpecialistActionIcon } from '../AppIcons'
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

type TaskColumn = {
  key: MultiloopTaskStatus
  label: string
  hint: string
}

const taskColumns: TaskColumn[] = [
  { key: 'ready', label: 'Ready', hint: 'Can start' },
  { key: 'in_progress', label: 'In Progress', hint: 'Owned now' },
  { key: 'needs_input', label: 'Needs Input', hint: 'Waiting' },
  { key: 'blocked', label: 'Blocked', hint: 'Stopped' },
  { key: 'todo', label: 'Todo', hint: 'Queued' },
  { key: 'done', label: 'Done', hint: 'Accepted' },
]

const milestoneStatusLabels: Record<MultiloopMilestoneStatus, string> = {
  accepted: 'Accepted',
  active: 'Active',
  blocked: 'Blocked',
  planned: 'Planned',
}

const taskStatusLabels: Record<MultiloopTaskStatus, string> = {
  blocked: 'Blocked',
  done: 'Done',
  in_progress: 'In Progress',
  needs_input: 'Needs Input',
  ready: 'Ready',
  todo: 'Todo',
}

const milestoneStatusClass: Record<MultiloopMilestoneStatus, string> = {
  accepted: 'border-[#2f5f3f] bg-[#112318] text-[#bff7ce]',
  active: 'border-[#3b62cc] bg-[#101a36] text-[#cdd9ff]',
  blocked: 'border-[#755337] bg-[#271a10] text-[#ffd39a]',
  planned: 'border-[#32343b] bg-[#101116] text-[#b6b7bf]',
}

const taskStatusClass: Record<MultiloopTaskStatus, string> = {
  blocked: 'bg-[#3a2415] text-[#ffd39a]',
  done: 'bg-[#14321f] text-[#c8f7d2]',
  in_progress: 'bg-[#172342] text-[#c5d4ff]',
  needs_input: 'bg-[#3a3115] text-[#ffe19b]',
  ready: 'bg-[#163021] text-[#c6f5d2]',
  todo: 'bg-[#191a20] text-[#b6b7bf]',
}

const verdictClass: Record<MultiloopMilestoneReviewVerdict['verdict'], string> = {
  accepted: 'border-[#2f5f3f] bg-[#112318] text-[#bff7ce]',
  needs_follow_up: 'border-[#755337] bg-[#271a10] text-[#ffd39a]',
  blocked: 'border-[#6f3131] bg-[#1d1012] text-[#ffb5b8]',
  revise_scope: 'border-[#3b62cc] bg-[#101a36] text-[#cdd9ff]',
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

function isSprintEngineRole(role: MultiloopRole): role is SprintEngineRole {
  return role !== 'coordinator'
}

function getLinkedSprintEngineAgentId(role: SprintEngineRole, linkedState: SprintEngineState | null): string {
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
  const [linkedSprintEngineStatesByPath, setLinkedSprintEngineStatesByPath] = useState<Record<string, SprintEngineState>>({})
  const [linkedExecutionReadStatesByPath, setLinkedExecutionReadStatesByPath] = useState<Record<string, LinkedExecutionReadState>>({})
  const [linkedExecutionReadRevision, setLinkedExecutionReadRevision] = useState(0)
  const timelineRef = useRef<HTMLOListElement | null>(null)

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
  const runStateLabel = autoRunEnabled
    ? autoRunSelection?.reason === 'blocked' || autoRunSelection?.reason === 'needs-input'
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

  const openLinkedStateFile = async (link: NonNullable<MultiloopMilestone['sprintEngine']>) => {
    const path = resolveProjectPath(link.statePath, workspaceRoot)
    const content = await window.api.readfile(path)
    openFile(workspaceId, path, link.statePath.split(/[\\/]/u).pop() || 'state.yaml', content)
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

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#08090b] text-[#ececee] [overflow-wrap:anywhere]" aria-label="Multiloop campaign board">
      <CampaignHero
        loopName={multiloopState.loop.displayName}
        iteration={multiloopState.loop.iteration}
        fullGoal={fullGoal}
        goalPreview={goalPreview}
        canExpandGoal={canExpandGoal}
        goalExpanded={goalExpanded}
        onToggleGoal={() => setGoalExpanded((current) => !current)}
        progress={progress}
        activeMilestone={activeMilestone}
        activeMilestoneIndex={activeMilestoneIndex}
        readiness={activeReadiness}
        blockersCount={activeBlockers.length}
        runStateLabel={runStateLabel}
        autoRunEnabled={autoRunEnabled}
        autoRunReasonLabel={autoRunReasonLabel}
        cliPermissionPreset={multiloopAutoState?.cliPermissionPreset ?? 'default'}
        primaryAction={primaryAction}
        primaryActionDisabled={activeReadiness === 'loading_execution'}
        launchState={roleLaunchState}
        agents={workspace.agents}
        linkedSprintEngineState={activeLinkedSprintEngineState}
        linkedExecutionReadState={activeLinkedExecutionReadState}
        onToggleAutoRun={() => setMultiloopAutoEnabled(workspaceId, !autoRunEnabled)}
        onPermissionPresetChange={(preset) => setMultiloopCliPermissionPreset(workspaceId, preset)}
        onOpenRole={(role) => void openRoleAgent(role)}
        onPrimaryAction={handlePrimaryAction}
      />

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

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="min-h-0 min-w-0 overflow-y-auto px-5 py-4">
          <div className="space-y-4">
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

        <aside className="min-h-0 overflow-y-auto border-t border-[#202127] xl:border-l xl:border-t-0" aria-label="Loop reassessment">
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
// CAMPAIGN HERO — surfaces mission, goal, progress, and the primary action.
// ===========================================================================

function CampaignHero({
  loopName,
  iteration,
  fullGoal,
  goalPreview,
  canExpandGoal,
  goalExpanded,
  onToggleGoal,
  progress,
  activeMilestone,
  activeMilestoneIndex,
  readiness,
  blockersCount,
  runStateLabel,
  autoRunEnabled,
  autoRunReasonLabel,
  cliPermissionPreset,
  primaryAction,
  primaryActionDisabled,
  launchState,
  agents,
  linkedSprintEngineState,
  linkedExecutionReadState,
  onToggleAutoRun,
  onPermissionPresetChange,
  onOpenRole,
  onPrimaryAction,
}: {
  loopName: string
  iteration: number
  fullGoal: string
  goalPreview: string
  canExpandGoal: boolean
  goalExpanded: boolean
  onToggleGoal: () => void
  progress: { accepted: number; total: number; blocked: number; percent: number }
  activeMilestone: MultiloopMilestone | null
  activeMilestoneIndex: number
  readiness: MultiloopExecutionReadiness
  blockersCount: number
  runStateLabel: string
  autoRunEnabled: boolean
  autoRunReasonLabel: string
  cliPermissionPreset: SprintEngineCliPermissionPreset
  primaryAction: MultiloopPrimaryNextAction
  primaryActionDisabled: boolean
  launchState: RoleLaunchState
  agents: Record<string, AgentState>
  linkedSprintEngineState: SprintEngineState | null
  linkedExecutionReadState: LinkedExecutionReadState
  onToggleAutoRun: () => void
  onPermissionPresetChange: (preset: SprintEngineCliPermissionPreset) => void
  onOpenRole: (role: MultiloopRole) => void
  onPrimaryAction: () => void
}) {
  const primaryLabel = getPrimaryActionLabel(primaryAction, readiness)
  const primaryLoading = launchState.status === 'loading' && primaryAction.kind === 'open_role' && launchState.role === primaryAction.role
  const ownership = getOwnershipLabel(activeMilestone, linkedExecutionReadState)
  const tone = readinessTone(readiness)

  return (
    <header
      className="relative shrink-0 overflow-hidden border-b border-[#202127] px-5 pb-4 pt-5"
      style={{
        background:
          'radial-gradient(1100px 240px at 12% -40%, rgba(92,124,255,0.18), transparent 70%), radial-gradient(900px 220px at 88% -50%, rgba(92,124,255,0.10), transparent 75%), #08090b',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7e93d1]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#5c7cff] shadow-[0_0_10px_rgba(92,124,255,0.7)]" aria-hidden="true" />
              Multiloop campaign
            </span>
            <span className="text-[#41435a]">·</span>
            <span className="text-[#9aa6cd]">Iteration {iteration}</span>
            <span className="text-[#41435a]">·</span>
            <span className="text-[#9aa6cd]">{progress.accepted} / {progress.total} milestones accepted</span>
            {progress.blocked > 0 ? (
              <>
                <span className="text-[#41435a]">·</span>
                <span className="text-[#ffd39a]">{progress.blocked} blocked</span>
              </>
            ) : null}
          </div>
          <h1 className="mt-1.5 truncate text-[22px] font-semibold leading-7 text-[#f5f5f6]">{loopName}</h1>
          <div className="mt-2 max-w-4xl">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#5d6f9a]">Final goal</div>
            <p className={`mt-1 text-[15px] leading-6 text-[#cfd5e8] ${goalExpanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
              {goalExpanded ? fullGoal : goalPreview}
            </p>
            {canExpandGoal ? (
              <button
                type="button"
                onClick={onToggleGoal}
                aria-expanded={goalExpanded}
                className="mt-1 rounded-[4px] text-[12px] font-semibold text-[#9fb4ff] underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
              >
                {goalExpanded ? 'Collapse goal' : 'Expand goal'}
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <RunSettingsPopover
            autoRunEnabled={autoRunEnabled}
            runStateLabel={runStateLabel}
            autoRunReasonLabel={autoRunReasonLabel}
            cliPermissionPreset={cliPermissionPreset}
            onToggleAutoRun={onToggleAutoRun}
            onPermissionPresetChange={onPermissionPresetChange}
          />
          <MoreTerminalsPopover
            agents={agents}
            launchState={launchState}
            hasSprintEngineLink={Boolean(activeMilestone?.sprintEngine)}
            linkedSprintEngineState={linkedSprintEngineState}
            linkedExecutionReadState={linkedExecutionReadState}
            onOpenRole={onOpenRole}
          />
          <button
            type="button"
            onClick={onPrimaryAction}
            disabled={primaryActionDisabled || primaryLoading}
            className="inline-flex h-9 items-center rounded-[7px] bg-[#4f6bff] px-4 text-[12.5px] font-semibold text-white shadow-[0_8px_24px_-10px_rgba(92,124,255,0.65),inset_0_1px_0_rgba(255,255,255,0.18)] transition hover:bg-[#5e7bff] focus:outline-none focus:ring-2 focus:ring-[#9fb4ff] disabled:cursor-default disabled:opacity-55"
          >
            {primaryLoading ? 'Opening…' : primaryLabel}
          </button>
        </div>
      </div>

      <ProgressBar accepted={progress.accepted} total={progress.total} blocked={progress.blocked} />

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <HeroStat
          label={activeMilestone ? `Active sprint M${activeMilestoneIndex + 1}` : 'Active sprint'}
          value={activeMilestone?.title ?? 'None'}
        />
        <HeroStat
          label="Owned by"
          value={ownership}
          tone={activeMilestone?.sprintEngine ? 'sprintengine' : 'multiloop'}
        />
        <HeroStat
          label="Readiness"
          value={readinessLabel(readiness)}
          tone={tone}
        />
        <HeroStat
          label="Blockers"
          value={String(blockersCount)}
          tone={blockersCount > 0 ? 'warn' : 'normal'}
        />
      </div>

      {launchState.status === 'error' ? (
        <p className="mt-3 truncate text-[12px] text-[#ffb5b8]" role="status">
          {getMultiloopRole(launchState.role).label}: {launchState.message}
        </p>
      ) : null}
    </header>
  )
}

function ProgressBar({ accepted, total, blocked }: { accepted: number; total: number; blocked: number }) {
  if (total === 0) return null
  const acceptedPct = (accepted / total) * 100
  const blockedPct = (blocked / total) * 100
  return (
    <div className="mt-4" aria-hidden="true">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-[#16171c]">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#3b62cc] to-[#5c7cff] shadow-[0_0_18px_rgba(92,124,255,0.55)] transition-[width] duration-500"
          style={{ width: `${acceptedPct}%` }}
        />
        {blockedPct > 0 ? (
          <div
            className="absolute inset-y-0 rounded-full bg-[#a76b3a]/70 transition-[width,left] duration-500"
            style={{ left: `${acceptedPct}%`, width: `${blockedPct}%` }}
          />
        ) : null}
      </div>
    </div>
  )
}

function HeroStat({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'warn' | 'error' | 'good' | 'multiloop' | 'sprintengine' }) {
  const valueClass = tone === 'warn'
    ? 'text-[#ffd39a]'
    : tone === 'error'
      ? 'text-[#ffb5b8]'
      : tone === 'good'
        ? 'text-[#bff7ce]'
        : tone === 'sprintengine'
          ? 'text-[#b8ccff]'
          : 'text-[#ececee]'
  const accent = tone === 'sprintengine' ? 'before:bg-[#3b62cc]' : 'before:bg-[#2a2c34]'
  return (
    <div className={`relative rounded-[7px] border border-[#1d1e25] bg-[#0e0f14] px-3 py-2 before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:rounded-r-full ${accent}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#65677a]">{label}</div>
      <div className={`mt-0.5 truncate text-[13px] font-semibold ${valueClass}`}>{value}</div>
    </div>
  )
}

// ===========================================================================
// CAMPAIGN TIMELINE — horizontal milestone stations connected by progress lines.
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
      className="shrink-0 border-b border-[#202127] bg-[#0a0b0f] px-5 py-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#5d6f9a]">Roadmap</span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-[#4d4f5e]">← Past · Now · Next →</span>
      </div>
      <ol
        ref={ref}
        className="flex min-w-0 items-stretch gap-0 overflow-x-auto scroll-smooth pb-1"
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
              <li className="flex min-w-[10.5rem] max-w-[14rem] flex-1 flex-col">
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
  const lineClass = fromStatus === 'accepted'
    ? 'bg-gradient-to-r from-[#3b8a4f] to-[#3b62cc]'
    : fromStatus === 'active' || toStatus === 'active'
      ? 'bg-gradient-to-r from-[#3b62cc] to-[#2a2c34]'
      : fromStatus === 'blocked'
        ? 'bg-gradient-to-r from-[#a76b3a] to-[#2a2c34]'
        : 'bg-[#22232c]'
  return (
    <div aria-hidden="true" className="relative flex min-w-[1.25rem] flex-1 items-center">
      <div className={`h-px w-full ${lineClass}`} />
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
  const dotInner = (() => {
    if (milestone.status === 'accepted') return 'bg-[#3b8a4f] shadow-[0_0_0_2px_#0a0b0f,0_0_0_3px_#3b8a4f]'
    if (isActive) return 'bg-[#5c7cff] shadow-[0_0_0_2px_#0a0b0f,0_0_0_3px_#5c7cff,0_0_22px_rgba(92,124,255,0.7)]'
    if (milestone.status === 'blocked') return 'bg-[#a76b3a] shadow-[0_0_0_2px_#0a0b0f,0_0_0_3px_#a76b3a]'
    return 'bg-[#3a3c45] shadow-[0_0_0_2px_#0a0b0f,0_0_0_3px_#3a3c45]'
  })()

  const ringClass = isSelected
    ? 'border-[#5c7cff] bg-[#0f1530]'
    : isActive
      ? 'border-[#3b62cc] bg-[#0c1024]'
      : milestone.status === 'accepted'
        ? 'border-[#1d2c20] bg-[#0c1310]'
        : milestone.status === 'blocked'
          ? 'border-[#3a2820] bg-[#15100c]'
          : 'border-[#22232c] bg-[#0c0d12] hover:border-[#3a3c45]'

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      aria-pressed={isSelected}
      aria-current={isActive ? 'step' : undefined}
      className={`group relative flex w-full flex-col items-stretch gap-1.5 rounded-[8px] border px-2.5 py-2 text-left transition focus:outline-none focus:ring-2 focus:ring-[#5c7cff] ${ringClass}`}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
          {isActive ? (
            <span aria-hidden="true" className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-[#5c7cff]/45 motion-reduce:hidden" />
          ) : null}
          <span className={`relative h-2 w-2 rounded-full ${dotInner}`} />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7c8090]">M{index + 1}</span>
        {milestone.sprintEngine ? (
          <span className="ml-auto rounded-[4px] border border-[#3b62cc] bg-[#101a36] px-1 py-0 text-[9px] font-semibold tracking-[0.08em] text-[#cdd9ff]" title="Sprint Engine execution linked">SE</span>
        ) : null}
      </div>
      <div className="line-clamp-2 text-[12.5px] font-medium leading-[1.25] text-[#e7e7ea]">{milestone.title}</div>
      <div className="text-[10px] uppercase tracking-[0.12em] text-[#65677a]">{milestoneStatusLabels[milestone.status]}</div>
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
      <section className="rounded-[10px] border border-[#1d1e25] bg-[#0d0e12] p-5" aria-label="Sprint console">
        <p className="text-sm text-[#8e8f98]">No milestone selected. Pick a station from the timeline.</p>
      </section>
    )
  }

  const isActive = milestone.id === activeMilestoneId
  const accentBorder = isActive ? 'border-[#3b62cc]' : 'border-[#1d1e25]'
  const accentBg = isActive ? 'bg-[#0c1024]' : 'bg-[#0d0e12]'
  const tone = readinessTone(readiness)

  return (
    <section
      aria-label={`Sprint M${milestoneIndex + 1} ${milestone.title}`}
      className={`relative overflow-hidden rounded-[10px] border ${accentBorder} ${accentBg}`}
    >
      {isActive ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#5c7cff]/80 to-transparent"
        />
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]">
            <span className={isActive ? 'text-[#9fb4ff]' : 'text-[#65677a]'}>
              {isActive ? 'Active sprint' : 'Sprint'} M{milestoneIndex + 1}
            </span>
            <StatusPill label={milestoneStatusLabels[milestone.status]} className={milestoneStatusClass[milestone.status]} />
            <span className={`rounded-[999px] border px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] ${tone === 'warn' ? 'border-[#755337] bg-[#271a10] text-[#ffd39a]' : tone === 'error' ? 'border-[#6f3131] bg-[#1d1012] text-[#ffb5b8]' : tone === 'good' ? 'border-[#2f5f3f] bg-[#112318] text-[#bff7ce]' : 'border-[#22232c] bg-[#0e0f14] text-[#9aa0b3]'}`}>
              {readinessLabel(readiness)}
            </span>
            {blockersCount > 0 ? (
              <span className="rounded-[999px] border border-[#755337] bg-[#271a10] px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] text-[#ffd39a]">
                {formatCount(blockersCount, 'blocker')}
              </span>
            ) : null}
          </div>
          <h2 className="mt-2 text-[18px] font-semibold leading-7 text-[#f4f4f5]">{milestone.title}</h2>
          <p className="mt-1 text-[13.5px] leading-[1.55] text-[#b8b9c1]">{milestone.goal || 'No milestone goal recorded.'}</p>
        </div>
      </div>

      <ExecutionSourceStrip
        milestone={milestone}
        linkedSprintEngineState={linkedSprintEngineState}
        linkedExecutionReadState={linkedExecutionReadState}
        workspaceRoot={workspaceRoot}
        onOpenStateFile={onOpenStateFile}
      />

      <div className="grid gap-3 border-t border-[#1d1e25] p-4 md:grid-cols-2">
        <ListBlock title="Entry criteria" items={milestone.entryCriteria} />
        <ListBlock title="Acceptance criteria" items={milestone.acceptanceCriteria} />
      </div>

      {milestone.finalGoalContribution ? (
        <div className="border-t border-[#1d1e25] px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#5d6f9a]">Final goal contribution</div>
          <p className="mt-1 text-[13.5px] leading-[1.55] text-[#cfd5e8]">{milestone.finalGoalContribution}</p>
        </div>
      ) : null}
    </section>
  )
}

function ExecutionSourceStrip({
  milestone,
  linkedSprintEngineState,
  linkedExecutionReadState,
  workspaceRoot,
  onOpenStateFile,
}: {
  milestone: MultiloopMilestone
  linkedSprintEngineState: SprintEngineState | null
  linkedExecutionReadState: LinkedExecutionReadState
  workspaceRoot: string | null
  onOpenStateFile: (link: NonNullable<MultiloopMilestone['sprintEngine']>) => void
}) {
  if (!milestone.sprintEngine) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-[#1d1e25] px-4 py-2.5 text-[12.5px] leading-5 text-[#9a9ba4]">
        <span className="rounded-[4px] border border-[#22232c] bg-[#0e0f14] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9aa6cd]">Multiloop</span>
        <span>Coordinated and executed by Multiloop.</span>
      </div>
    )
  }

  const relativePath = toProjectRelativePath(milestone.sprintEngine.statePath, workspaceRoot)
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[#1d1e25] border-l-2 border-l-[#3b62cc] bg-[#0a0d18] px-4 py-2.5 text-[12.5px] leading-5 text-[#b8b9c1]">
      <span className="rounded-[4px] border border-[#3b62cc] bg-[#101a36] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#cdd9ff]">Sprint Engine</span>
      <span className="font-medium text-[#cdd9ff]">{linkedSprintEngineState?.name || milestone.sprintEngine.teamSlug}</span>
      <span className="text-[#41435a]">·</span>
      <button
        type="button"
        onClick={() => onOpenStateFile(milestone.sprintEngine!)}
        className="break-all font-mono text-[11px] text-[#9fb4ff] underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
      >
        {relativePath}
      </button>
      {linkedExecutionReadState.status === 'loading' ? <span className="text-[11px] text-[#8e8f98]">Reading state…</span> : null}
    </div>
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
    <section className="rounded-[10px] border border-[#6f3131] bg-[#130d0f] p-4" aria-label="Execution unavailable">
      <h2 className="text-base font-semibold text-[#f2f2f4]">Execution unavailable</h2>
      <p className="mt-2 text-sm leading-6 text-[#d6b5b8]">Sprint Engine state for {link.teamSlug} is not readable.</p>
      <p className="mt-2 break-all font-mono text-[11px] leading-5 text-[#ffb5b8]">{toProjectRelativePath(readState.path || link.statePath, workspaceRoot)}</p>
      <p className="mt-2 text-sm leading-6 text-[#c9a5a8]">{readState.message}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className="h-8 rounded-[6px] bg-[#4f6bff] px-3 text-[12px] font-semibold text-white transition hover:bg-[#5e7bff] focus:outline-none focus:ring-2 focus:ring-[#9fb4ff]">Retry</button>
        <button type="button" onClick={onOpenStateFile} className="h-8 rounded-[6px] border border-[#303139] bg-[#111216] px-3 text-[12px] font-semibold text-[#d7d7dc] transition hover:border-[#444751] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]">Open state file</button>
        <button type="button" onClick={onOpenCoordinator} className="h-8 rounded-[6px] border border-[#303139] bg-[#111216] px-3 text-[12px] font-semibold text-[#d7d7dc] transition hover:border-[#444751] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]">Open Coordinator</button>
      </div>
    </section>
  )
}

// ===========================================================================
// TASK BOARD
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
  if (tasks.length === 0) {
    return (
      <section className={`rounded-[10px] border border-[#1d1e25] bg-[#0d0e12] p-4 ${source === 'sprintengine' ? 'border-l-2 border-l-[#3b62cc]' : ''}`} aria-label="Sprint task board">
        <h2 className="text-[13px] font-semibold text-[#f0f0f2]">Sprint tasks</h2>
        <p className="mt-2 text-sm leading-6 text-[#8e8f98]">{readinessLabel(readiness)}.</p>
        <button type="button" onClick={onPlanExecution} className="mt-3 h-8 rounded-[6px] bg-[#4f6bff] px-3 text-[12px] font-semibold text-white transition hover:bg-[#5e7bff] focus:outline-none focus:ring-2 focus:ring-[#9fb4ff]">Plan execution</button>
      </section>
    )
  }

  return (
    <section className={`rounded-[10px] border border-[#1d1e25] bg-[#0d0e12] p-4 ${source === 'sprintengine' ? 'border-l-2 border-l-[#3b62cc]' : ''}`} aria-label="Sprint task board">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-[#f0f0f2]">Sprint tasks</h2>
          <p className="mt-0.5 text-[11px] text-[#65677a]">Source: {source === 'sprintengine' ? 'Sprint Engine' : 'Multiloop'}</p>
        </div>
        <span className="text-[11px] text-[#65677a]">{formatCount(tasks.length, 'task')}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3">
        {taskColumns.map((column) => {
          const columnTasks = tasks.filter((task) => task.status === column.key)
          const emphasized = (readiness === 'blocked' && column.key === 'blocked') || (readiness === 'needs_input' && column.key === 'needs_input')
          return (
            <div key={column.key} className={`min-h-[9rem] rounded-[8px] bg-[#0a0b10] p-3 ring-1 ring-inset ${emphasized ? 'ring-[#755337]' : 'ring-[#16171c]'}`}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-[#ececee]">{column.label}</h3>
                  <p className="text-[11px] text-[#65677a]">{column.hint}</p>
                </div>
                <span className="text-[11px] font-semibold text-[#9a9ba4]">{columnTasks.length}</span>
              </div>
              <div className="space-y-2">
                {columnTasks.length === 0 ? <p className="text-xs text-[#52535f]">—</p> : columnTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className={`w-full rounded-[7px] border p-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-[#5c7cff] ${selectedTaskId === task.id ? 'border-[#5c7cff] bg-[#10162d]' : 'border-[#1f2028] bg-[#0a0b10] hover:border-[#3d3f48]'}`}
                    aria-pressed={selectedTaskId === task.id}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-sm font-medium leading-5 text-[#e7e7ea]">{task.title}</span>
                      <span className="shrink-0 text-[10px] text-[#52535f]">{task.id}</span>
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-[#7c8090]">
                      <span className="rounded-[3px] bg-[#16171c] px-1.5 py-0.5">{task.role}</span>
                      {task.ownerAgentId ? <span className="text-[#9aa0b3]">{task.ownerAgentId}</span> : null}
                      {hasEvidence(task) ? <span className="text-[#9fb4ff]">● Evidence</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function BlockersPanel({ blockers }: { blockers: MultiloopBlocker[] }) {
  if (blockers.length === 0) return null
  return (
    <section className="rounded-[10px] border border-[#3a2820] bg-[#150d0a] p-4" aria-label="Active blockers">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#caa07a]">
        <span aria-hidden="true">⚠</span>
        Active blockers
        <span className="ml-auto text-[#a07854]">{formatCount(blockers.length, 'blocker')}</span>
      </div>
      <div className="space-y-2">
        {blockers.map((blocker) => (
          <div key={blocker.id} className="rounded-[7px] bg-[#0d0905] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-[#ffd39a]">{blocker.summary}</span>
              <span className="shrink-0 text-[11px] uppercase tracking-[0.1em] text-[#b99568]">{blocker.scope}</span>
            </div>
            {blocker.detail ? <p className="mt-1 text-sm leading-5 text-[#d7c2a4]">{blocker.detail}</p> : null}
          </div>
        ))}
      </div>
    </section>
  )
}

// ===========================================================================
// REASSESSMENT COLUMN — the loop-closing panel: verdicts, recommendation,
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
      <div
        className="relative shrink-0 overflow-hidden border-b border-[#202127] px-4 py-3"
        style={{ background: 'linear-gradient(180deg, rgba(92,124,255,0.08), transparent 75%), #0a0b0f' }}
      >
        <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7e93d1]">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[#5c7cff] shadow-[0_0_10px_rgba(92,124,255,0.7)]" aria-hidden="true" />
            Reassessment
          </span>
          <span className="text-[#5d6f9a]">Iteration {iteration}</span>
        </div>
        {latestRecommendation ? (
          <>
            <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5d6f9a]">Next recommendation</div>
            <p className="mt-1 text-[13.5px] leading-[1.55] text-[#dfe6ff]">{latestRecommendation}</p>
          </>
        ) : (
          <p className="mt-2 text-[12.5px] leading-5 text-[#7c8090]">
            The loop is waiting for the next reassessment. After a sprint completes, reviewers post verdicts that shape the next milestone.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {selectedTask ? (
          <SelectedTaskCard task={selectedTask} onClear={onClearTaskSelection} />
        ) : null}

        <ReassessSection title="Latest verdicts" emptyText="No reviewer verdicts yet for this milestone.">
          {verdicts.length === 0 ? null : verdicts.map((verdict) => (
            <article key={verdict.id} className="rounded-[7px] border border-[#1d1e25] bg-[#0d0e12] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={`inline-flex items-center rounded-[999px] border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${verdictClass[verdict.verdict]}`}>
                  {verdictTitle(verdict)}
                </span>
                <span className="text-[10px] uppercase tracking-[0.12em] text-[#5d6f9a]">{verdict.role}</span>
              </div>
              {verdict.nextRecommendation ? (
                <p className="mt-2 text-[12.5px] leading-[1.5] text-[#cfd5e8]">{verdict.nextRecommendation}</p>
              ) : null}
              {verdict.finalGoalImplications.length ? (
                <p className="mt-1.5 text-[11px] leading-5 text-[#9aa0b3]">
                  Implication: {verdict.finalGoalImplications[0]}
                </p>
              ) : null}
            </article>
          ))}
        </ReassessSection>

        <ReassessSection title="Learned facts" emptyText="No facts learned yet — they accumulate as sprints complete.">
          {learnedFacts.length === 0 ? null : (
            <ul className="space-y-1.5">
              {learnedFacts.map((fact) => (
                <li key={fact} className="flex gap-2 text-[12.5px] leading-[1.5] text-[#cfd5e8]">
                  <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#5c7cff]" />
                  <span>{fact}</span>
                </li>
              ))}
            </ul>
          )}
        </ReassessSection>

        <ReassessSection title="Recent evidence" emptyText="No task evidence captured yet.">
          {evidenceTasks.length === 0 ? null : evidenceTasks.map((task) => (
            <div key={task.id} className="border-b border-[#1d1e25] pb-2.5 last:border-b-0 last:pb-0">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12.5px] font-medium text-[#e7e7ea]">{task.title || task.id}</span>
                <span className="shrink-0 text-[10px] text-[#5d6f9a]">{formatDate(task.updatedAt ?? task.completedAt ?? task.startedAt ?? task.createdAt)}</span>
              </div>
              {task.evidence.summary ? <p className="mt-1 text-[12px] leading-[1.5] text-[#9aa0b3]">{task.evidence.summary}</p> : null}
              {task.evidence.results.length ? <p className="mt-1 text-[11px] leading-5 text-[#7e93d1]">{task.evidence.results[0]}</p> : null}
            </div>
          ))}
        </ReassessSection>

        <ReassessSection title="Decisions" emptyText="No decisions recorded.">
          {recentDecisions.length === 0 ? null : (
            <ul className="space-y-1.5">
              {recentDecisions.map((decision) => (
                <li key={decision.id} className="text-[12.5px] leading-[1.5] text-[#cfd5e8]">
                  {decision.summary || 'Decision recorded without summary.'}
                </li>
              ))}
            </ul>
          )}
        </ReassessSection>

        <ReassessSection title="Artifacts" emptyText="No artifacts linked to this milestone yet.">
          {artifacts.length === 0 ? null : (
            <div className="space-y-2">
              {artifacts.map((artifact) => (
                <div key={artifact.id} className="border-b border-[#1d1e25] pb-2 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-[#e7e7ea]">{artifact.title}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-[#5d6f9a]">{artifact.kind || 'artifact'}</span>
                  </div>
                  {artifact.path ? <p className="mt-1 break-all font-mono text-[10.5px] text-[#7e93d1]">{artifact.path}</p> : null}
                </div>
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
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#5d6f9a]">{title}</h3>
      <div className="mt-2 space-y-2">
        {hasChildren ? children : <p className="text-[12px] leading-[1.5] text-[#65677a]">{emptyText}</p>}
      </div>
    </section>
  )
}

function SelectedTaskCard({ task, onClear }: { task: MultiloopTask; onClear: () => void }) {
  return (
    <section
      aria-label={`Task ${task.id}`}
      className="relative overflow-hidden rounded-[10px] border border-[#3b62cc] bg-[#0c1024] p-4"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#5c7cff]/80 to-transparent"
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={taskStatusLabels[task.status]} className={`border-transparent ${taskStatusClass[task.status]}`} />
            <span className="text-[10px] uppercase tracking-[0.12em] text-[#5d6f9a]">{task.id}</span>
          </div>
          <h3 className="mt-1.5 text-[14px] font-semibold leading-5 text-[#ededf0]">{task.title}</h3>
          {task.description ? <p className="mt-1 text-[12.5px] leading-[1.5] text-[#b9bac2]">{task.description}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear task selection"
          className="rounded-[4px] px-1.5 py-0.5 text-[11px] text-[#7c8090] transition hover:bg-[#10162d] hover:text-[#cfd5e8] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
        >
          Clear
        </button>
      </div>
      {task.acceptanceCriteria.length ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5d6f9a]">Acceptance</div>
          <ul className="mt-1 space-y-1">
            {task.acceptanceCriteria.map((item) => (
              <li key={item} className="flex gap-2 text-[12.5px] leading-[1.5] text-[#cfd5e8]">
                <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#5c7cff]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {task.blockers.length ? (
        <div className="mt-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#caa07a]">Blockers</div>
          <ul className="mt-1 space-y-1">
            {task.blockers.map((item) => (
              <li key={item} className="text-[12.5px] leading-[1.5] text-[#ffd39a]">{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

// ===========================================================================
// POPOVERS — Run settings (auto-run + permission preset) and More terminals.
// ===========================================================================

function RunSettingsPopover({
  autoRunEnabled,
  runStateLabel,
  autoRunReasonLabel,
  cliPermissionPreset,
  onToggleAutoRun,
  onPermissionPresetChange,
}: {
  autoRunEnabled: boolean
  runStateLabel: string
  autoRunReasonLabel: string
  cliPermissionPreset: SprintEngineCliPermissionPreset
  onToggleAutoRun: () => void
  onPermissionPresetChange: (preset: SprintEngineCliPermissionPreset) => void
}) {
  const popover = usePopoverFocus('multiloop-run-popover')
  return (
    <div className="relative">
      <button
        ref={popover.triggerRef}
        type="button"
        onClick={popover.toggle}
        aria-haspopup="menu"
        aria-expanded={popover.open}
        aria-controls={popover.id}
        className={`inline-flex h-9 items-center rounded-[7px] border px-3 text-[12px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-[#5c7cff] ${autoRunEnabled ? 'border-[#3b62cc] bg-[#101a36] text-[#cdd9ff]' : 'border-[#26272f] bg-[#0e0f14] text-[#c8c9d0] hover:border-[#3a3c45]'}`}
      >
        <span aria-hidden="true" className={`mr-2 h-1.5 w-1.5 rounded-full ${autoRunEnabled ? 'bg-[#5c7cff] shadow-[0_0_10px_rgba(92,124,255,0.7)]' : 'bg-[#3a3c45]'}`} />
        Run: {runStateLabel}
      </button>
      {popover.open ? (
        <div
          ref={popover.panelRef}
          id={popover.id}
          role="menu"
          tabIndex={-1}
          onKeyDown={popover.onKeyDown}
          className="absolute right-0 top-11 z-40 w-72 rounded-[8px] border border-[#26272f] bg-[#0d0e12] p-3 shadow-[0_24px_64px_-20px_rgba(0,0,0,0.85)]"
        >
          <label className="flex items-center justify-between gap-3 text-sm text-[#ececee]">
            <span>Autonomous loop</span>
            <input type="checkbox" checked={autoRunEnabled} onChange={onToggleAutoRun} className="h-4 w-4 accent-[#5c7cff] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]" />
          </label>
          <p className="mt-2 text-[11.5px] leading-[1.5] text-[#9a9ba4]">When on, Multiloop spawns the next role agent as soon as a sprint task is ready. Engine reason: {autoRunReasonLabel}.</p>
          <label className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5d6f9a]">
            CLI permission preset
            <select
              value={cliPermissionPreset}
              onChange={(event) => onPermissionPresetChange(event.currentTarget.value as SprintEngineCliPermissionPreset)}
              title={multiloopCliPermissionOptions.find((option) => option.value === cliPermissionPreset)?.title}
              className="mt-2 h-8 w-full rounded-[6px] border border-[#26272f] bg-[#0a0b10] px-2 text-[12px] font-medium text-[#d7d7dc] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
            >
              {multiloopCliPermissionOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
    </div>
  )
}

function MoreTerminalsPopover({
  agents,
  launchState,
  hasSprintEngineLink,
  linkedSprintEngineState,
  linkedExecutionReadState,
  onOpenRole,
}: {
  agents: Record<string, AgentState>
  launchState: RoleLaunchState
  hasSprintEngineLink: boolean
  linkedSprintEngineState: SprintEngineState | null
  linkedExecutionReadState: LinkedExecutionReadState
  onOpenRole: (role: MultiloopRole) => void
}) {
  const popover = usePopoverFocus('multiloop-terminals-popover')
  const groups: Array<{ label: string; roles: MultiloopRole[] }> = [
    { label: 'Coordinator', roles: ['coordinator'] },
    { label: 'Workers', roles: ['architect', 'developer', 'frontend'] },
    { label: 'Reviewers', roles: ['product', 'tester', 'security', 'code_reviewer', 'performance'] },
  ]
  return (
    <div className="relative">
      <button
        ref={popover.triggerRef}
        type="button"
        onClick={popover.toggle}
        aria-haspopup="menu"
        aria-expanded={popover.open}
        aria-controls={popover.id}
        className="inline-flex h-9 items-center rounded-[7px] border border-[#26272f] bg-[#0e0f14] px-3 text-[12px] font-semibold text-[#d7d7dc] transition hover:border-[#3a3c45] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
      >
        Open agent
      </button>
      {popover.open ? (
        <div
          ref={popover.panelRef}
          id={popover.id}
          role="menu"
          tabIndex={-1}
          onKeyDown={popover.onKeyDown}
          className="absolute right-0 top-11 z-40 w-80 rounded-[8px] border border-[#26272f] bg-[#0d0e12] p-2 shadow-[0_24px_64px_-20px_rgba(0,0,0,0.85)]"
        >
          {groups.map((group) => (
            <div key={group.label} className="py-1">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5d6f9a]">{group.label}</div>
              {group.roles.map((role) => {
                const soul = getMultiloopRole(role)
                const isLinkedWorker = hasSprintEngineLink && isSprintEngineRole(role)
                const agentId = isLinkedWorker && linkedSprintEngineState ? getLinkedSprintEngineAgentId(role, linkedSprintEngineState) : `multiloop-${role}`
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
                    role="menuitem"
                    onClick={() => {
                      if (disabledReason) return
                      popover.close()
                      onOpenRole(role)
                    }}
                    disabled={loading || Boolean(disabledReason)}
                    className="flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-[12px] text-[#d7d7dc] transition hover:bg-[#10162d] hover:text-[#ececee] focus:outline-none focus:ring-2 focus:ring-[#5c7cff] disabled:cursor-default disabled:opacity-55"
                    title={disabledReason ?? `${exists ? 'Focus' : 'Create'} ${terminalKind} ${soul.label} role terminal`}
                  >
                    <SpecialistActionIcon icon={soul.icon} className="h-4 w-4 shrink-0 text-[#9a9aa2]" />
                    <span className="min-w-0 flex-1 truncate">{loading ? 'Opening…' : `${soul.label} (${terminalKind})`}</span>
                    {exists ? <span className="h-1.5 w-1.5 rounded-full bg-[#5c7cff]" aria-label="Created" /> : null}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function usePopoverFocus(id: string) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => {
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!open) return
    window.requestAnimationFrame(() => {
      const focusable = getFocusable(panelRef.current)
      ;(focusable[0] ?? panelRef.current)?.focus()
    })
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = getFocusable(panelRef.current)
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return {
    id,
    open,
    triggerRef,
    panelRef,
    toggle: () => setOpen((current) => !current),
    close,
    onKeyDown,
  }
}

function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
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

function readinessTone(readiness: MultiloopExecutionReadiness): 'normal' | 'warn' | 'error' | 'good' {
  if (readiness === 'ready' || readiness === 'all_done') return 'good'
  if (readiness === 'blocked' || readiness === 'needs_input') return 'warn'
  if (readiness === 'execution_unavailable') return 'error'
  return 'normal'
}

function getOwnershipLabel(milestone: MultiloopMilestone | null, linkedExecutionReadState: LinkedExecutionReadState): string {
  if (!milestone?.sprintEngine) return 'Multiloop'
  if (linkedExecutionReadState.status === 'loading') return 'Sprint Engine loading'
  if (linkedExecutionReadState.status === 'error') return 'Sprint Engine unavailable'
  return 'Sprint Engine'
}

function getPrimaryActionLabel(action: MultiloopPrimaryNextAction, readiness: MultiloopExecutionReadiness): string {
  if (action.kind === 'retry_execution_read') return 'Retry execution read'
  if (action.kind === 'plan_execution') return 'Plan execution'
  if (action.kind === 'open_coordinator') {
    if (readiness === 'blocked') return 'Resolve blocker'
    if (readiness === 'all_done') return 'Reassess loop'
    if (readiness === 'no_tasks' || readiness === 'multiloop_no_tasks') return 'Plan execution'
    return 'Open Coordinator'
  }
  return `Open ${getMultiloopRole(action.role).label}`
}

function StateMessage({ title, message, tone }: { title: string; message: string; tone: 'empty' | 'error' | 'loading' }) {
  const toneClass = tone === 'error' ? 'border-[#6f3131] text-[#ffb5b8]' : 'border-[#1d1e25] text-[#b9bac2]'
  return (
    <section className="flex h-full min-w-0 items-center justify-center bg-[#08090b] px-6 text-center text-[#ececee] [overflow-wrap:anywhere]" role={tone === 'loading' ? 'status' : 'region'} aria-live="polite">
      <div className={`min-w-0 max-w-md rounded-[10px] border ${toneClass} bg-[#0d0e12] p-5`}>
        <h1 className="text-base font-semibold text-[#f2f2f4]">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-[#a9aab2]">{message}</p>
      </div>
    </section>
  )
}

function StatusPill({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-[999px] border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${className}`}>
      {label}
    </span>
  )
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#5d6f9a]">{title}</div>
      {items.length === 0 ? (
        <p className="mt-1.5 text-[12.5px] text-[#65677a]">None recorded.</p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {items.map((item) => (
            <li key={item} className="flex gap-2 text-[12.5px] leading-[1.5] text-[#cfd5e8]">
              <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#5c7cff]" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
