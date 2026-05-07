import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
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
  MultiloopMilestoneStatus,
  MultiloopState,
  MultiloopStateDisplayError,
  MultiloopTask,
  MultiloopTaskStatus,
  SwarmCliPermissionPreset,
  SwarmRole,
  SwarmState,
  WorkspaceId,
} from '../../types/workspace'
import { buildSwarmStartupPrompt, getSwarmStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'
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
import { parseSwarmStateFile } from '../../utils/sprintengineStateFile'
import { buildSwarmAgentRosterForState, buildSwarmRosterCommandArgs, swarmRoleLabels } from '../../utils/sprintengine'

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
  active: 'border-[#355da8] bg-[#111b30] text-[#b8ccff]',
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

const multiloopCliPermissionOptions: Array<{
  value: SwarmCliPermissionPreset
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

function isSwarmRole(role: MultiloopRole): role is SwarmRole {
  return role !== 'coordinator'
}

function getLinkedSprintEngineAgentId(role: SwarmRole, linkedState: SwarmState | null): string {
  return buildSwarmAgentRosterForState(linkedState).find((agent) => agent.role === role)?.id ?? role
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
  const [linkedSwarmStatesByPath, setLinkedSwarmStatesByPath] = useState<Record<string, SwarmState>>({})
  const [linkedExecutionReadStatesByPath, setLinkedExecutionReadStatesByPath] = useState<Record<string, LinkedExecutionReadState>>({})
  const [linkedExecutionReadRevision, setLinkedExecutionReadRevision] = useState(0)
  const roadmapRailRef = useRef<HTMLElement | null>(null)

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
      const linkedState = sprintEngineLink ? linkedSwarmStatesByPath[sprintEngineLink.statePath] ?? null : null
      if (sprintEngineLink && isSwarmRole(role)) {
        if (!workspaceRoot) throw new Error('Open this Multiloop workspace from a project folder before launching Sprint Engine workers.')
        if (!linkedState) throw new Error(`Linked Sprint Engine state is not readable yet: ${sprintEngineLink.statePath}`)

        const agentId = getLinkedSprintEngineAgentId(role, linkedState)
        const existingAgent = workspace.agents[agentId]
        const tabName = swarmRoleLabels[role]
        const startupPrompt = prependAgentIdentifier(
          buildSwarmStartupPrompt(role, agentId, linkedState.goal, {
            executionCwd: workspaceRoot,
            workspaceRoot,
            swarmStatePath: sprintEngineLink.statePath,
            rosterArgs: buildSwarmRosterCommandArgs(linkedState),
            commandMode: getSwarmStartupCommandMode(role, agentId, linkedState),
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
        const parsed = parseSwarmStateFile(content, link.teamSlug)
        setLinkedSwarmStatesByPath((current) => ({ ...current, [link.statePath]: parsed }))
        setLinkedExecutionReadStatesByPath((current) => ({
          ...current,
          [link.statePath]: { status: 'idle' },
        }))
      })
      .catch((error: unknown) => {
        if (cancelled()) return
        setLinkedSwarmStatesByPath((current) => {
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
      setLinkedSwarmStatesByPath({})
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

  const selectedLinkedSwarmState = selectedMilestone?.sprintEngine
    ? linkedSwarmStatesByPath[selectedMilestone.sprintEngine.statePath] ?? null
    : null
  const activeLinkedSwarmState = activeMilestone?.sprintEngine
    ? linkedSwarmStatesByPath[activeMilestone.sprintEngine.statePath] ?? null
    : null
  const selectedLinkedExecutionReadState = selectedMilestone?.sprintEngine
    ? linkedExecutionReadStatesByPath[selectedMilestone.sprintEngine.statePath] ?? { status: 'idle' }
    : { status: 'idle' } as const
  const activeLinkedExecutionReadState = activeMilestone?.sprintEngine
    ? linkedExecutionReadStatesByPath[activeMilestone.sprintEngine.statePath] ?? { status: 'idle' }
    : { status: 'idle' } as const

  const visibleTasks = useMemo(
    () => (multiloopState ? getMilestoneExecutionTasks(multiloopState, selectedMilestone, selectedLinkedSwarmState) : []),
    [multiloopState, selectedLinkedSwarmState, selectedMilestone]
  )
  const activeTasks = useMemo(
    () => (multiloopState ? getMilestoneExecutionTasks(multiloopState, activeMilestone, activeLinkedSwarmState) : []),
    [activeLinkedSwarmState, activeMilestone, multiloopState]
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
        linkedSwarmState: activeLinkedSwarmState,
        linkedReadState: activeLinkedExecutionReadState,
        activeBlockers,
      })
      : 'no_active_milestone'),
    [activeBlockers, activeLinkedExecutionReadState, activeLinkedSwarmState, activeMilestone, multiloopState]
  )
  const visibleReadiness = useMemo(
    () => (multiloopState
      ? getMilestoneExecutionReadiness({
        state: multiloopState,
        milestone: selectedMilestone,
        linkedSwarmState: selectedLinkedSwarmState,
        linkedReadState: selectedLinkedExecutionReadState,
        activeBlockers: visibleBlockers,
      })
      : 'no_active_milestone'),
    [multiloopState, selectedLinkedExecutionReadState, selectedLinkedSwarmState, selectedMilestone, visibleBlockers]
  )
  const primaryAction = useMemo(
    () => getPrimaryNextAction(activeReadiness, {
      linkedSwarmState: activeLinkedSwarmState,
      milestone: activeMilestone,
      tasks: activeTasks,
    }),
    [activeLinkedSwarmState, activeMilestone, activeReadiness, activeTasks]
  )
  const autoRunSelection = useMemo<MultiloopAutoRunSelection | null>(
    () => (multiloopState
      ? selectMultiloopAutoRunCandidates({
        state: multiloopState,
        limit: multiloopAutoState?.maxConcurrentAgents ?? 1,
        pendingSpawns: multiloopAutoState?.pendingSpawns ?? [],
        coordinatorAutoSpawnKey: multiloopAutoState?.coordinatorAutoSpawnKey ?? null,
        linkedSwarmState: activeLinkedSwarmState,
      })
      : null),
    [activeLinkedSwarmState, multiloopAutoState?.coordinatorAutoSpawnKey, multiloopAutoState?.maxConcurrentAgents, multiloopAutoState?.pendingSpawns, multiloopState]
  )
  const latestEvidenceTasks = useMemo(
    () => (multiloopState ? getLatestExecutionEvidenceTasks(multiloopState, activeLinkedSwarmState, 4) : []),
    [activeLinkedSwarmState, multiloopState]
  )
  const selectedTask = useMemo(
    () => visibleTasks.find((task) => task.id === selectedTaskId) ?? visibleTasks.find((task) => task.status !== 'done') ?? visibleTasks[0] ?? null,
    [selectedTaskId, visibleTasks]
  )
  const relatedArtifacts = useMemo(
    () => [
      ...getRelatedArtifacts(multiloopState?.artifacts ?? [], selectedMilestone?.id ?? null, visibleTasks),
      ...getMilestoneExecutionArtifacts(selectedMilestone, selectedLinkedSwarmState),
    ],
    [multiloopState?.artifacts, selectedLinkedSwarmState, selectedMilestone, visibleTasks]
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
        message="This loop has no milestones to display."
        tone="empty"
      />
    )
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#08090b] text-[#ececee] [overflow-wrap:anywhere]" aria-label="Multiloop milestone board">
      <header className="shrink-0 border-b border-[#202127] px-5 py-4">
        <MultiloopHeader
          loopName={multiloopState.loop.displayName}
          iteration={multiloopState.loop.iteration}
          fullGoal={fullGoal}
          goalPreview={goalPreview}
          canExpandGoal={canExpandGoal}
          goalExpanded={goalExpanded}
          onToggleGoal={() => setGoalExpanded((current) => !current)}
        />
        <ExecutionStatusStrip
          agents={workspace.agents}
          milestone={activeMilestone}
          milestoneIndex={activeMilestone ? multiloopState.roadmap.findIndex((milestone) => milestone.id === activeMilestone.id) : -1}
          readiness={activeReadiness}
          blockersCount={activeBlockers.length}
          runStateLabel={runStateLabel}
          autoRunEnabled={autoRunEnabled}
          autoRunReasonLabel={autoRunReasonLabel}
          launchState={roleLaunchState}
          linkedSprintEngineState={activeLinkedSwarmState}
          linkedExecutionReadState={activeLinkedExecutionReadState}
          cliPermissionPreset={multiloopAutoState?.cliPermissionPreset ?? 'default'}
          primaryAction={primaryAction}
          primaryActionDisabled={activeReadiness === 'loading_execution'}
          onMilestoneFocus={() => roadmapRailRef.current?.focus()}
          onToggleAutoRun={() => setMultiloopAutoEnabled(workspaceId, !autoRunEnabled)}
          onPermissionPresetChange={(preset) => setMultiloopCliPermissionPreset(workspaceId, preset)}
          onOpenRole={(role) => void openRoleAgent(role)}
          onPrimaryAction={handlePrimaryAction}
        />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[18rem_minmax(0,1fr)]">
        <aside ref={roadmapRailRef} tabIndex={-1} className="min-h-0 overflow-y-auto border-b border-[#202127] p-4 focus:outline-none lg:border-b-0 lg:border-r" aria-label="Roadmap milestones">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[13px] font-semibold text-[#f0f0f2]">Roadmap</h2>
            <span className="text-[11px] text-[#898a93]">{formatCount(multiloopState.roadmap.length, 'milestone')}</span>
          </div>
          <div className="space-y-2">
            {multiloopState.roadmap.map((milestone, index) => {
              const isSelected = milestone.id === selectedMilestone?.id
              const isActive = milestone.id === activeMilestone?.id
              return (
                <button
                  key={milestone.id}
                  type="button"
                  className={`w-full rounded-[6px] border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-[#5c7cff] ${isSelected ? 'border-[#5c7cff] bg-[#12192b]' : 'border-[#25262d] bg-[#0d0e12] hover:border-[#3a3c45]'}`}
                  aria-pressed={isSelected}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => {
                    setSelectedMilestoneId(milestone.id)
                    setSelectedTaskId(null)
                  }}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-[11px] text-[#858690]">
                        <span>M{index + 1}</span>
                        {milestone.sprintEngine ? (
                          <span className="rounded-[4px] border border-[#355da8] bg-[#111b30] px-1.5 py-0.5 text-[10px] font-semibold text-[#b8ccff]" title="Sprint Engine execution linked" aria-label="Sprint Engine execution linked">SE</span>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-sm font-medium leading-5 text-[#ededf0]">{milestone.title}</span>
                    </span>
                    <StatusPill label={milestoneStatusLabels[milestone.status]} className={milestoneStatusClass[milestone.status]} />
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        <main className="min-h-0 min-w-0 overflow-y-auto">
          <div className="grid gap-4 p-4 2xl:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="min-w-0 space-y-4">
              <MilestoneSummary
                milestone={selectedMilestone}
                activeMilestoneId={activeMilestone?.id ?? null}
              />
              <ExecutionSourceStrip
                milestone={selectedMilestone}
                linkedSwarmState={selectedLinkedSwarmState}
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
              <BlockersAndVerdicts milestone={selectedMilestone} blockers={visibleBlockers} />
            </div>

            <aside className="min-w-0" aria-label="Milestone details">
              <MilestoneInspector
                task={selectedTask}
                evidenceTasks={latestEvidenceTasks}
                milestone={selectedMilestone}
                decisions={multiloopState.decisions}
                artifacts={relatedArtifacts}
              />
            </aside>
          </div>
        </main>
      </div>
    </section>
  )
}

function MultiloopHeader({
  loopName,
  iteration,
  fullGoal,
  goalPreview,
  canExpandGoal,
  goalExpanded,
  onToggleGoal,
}: {
  loopName: string
  iteration: number
  fullGoal: string
  goalPreview: string
  canExpandGoal: boolean
  goalExpanded: boolean
  onToggleGoal: () => void
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#81828c]">Multiloop</p>
          <span className="text-[11px] text-[#777882]">iteration {iteration}</span>
        </div>
        <h1 className="mt-1 truncate text-[20px] font-semibold leading-7 text-[#f5f5f6]">{loopName}</h1>
        <div className="mt-2 max-w-5xl text-sm leading-6 text-[#b7b8bf]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#777882]">Goal</span>{' '}
          <span className={goalExpanded ? 'whitespace-pre-wrap' : 'line-clamp-1 inline'}>{goalExpanded ? fullGoal : goalPreview}</span>
          {canExpandGoal ? (
            <button
              type="button"
              onClick={onToggleGoal}
              aria-expanded={goalExpanded}
              className="ml-2 rounded-[4px] text-[12px] font-semibold text-[#9fb4ff] underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
            >
              {goalExpanded ? 'Collapse' : 'Expand'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ExecutionStatusStrip({
  agents,
  milestone,
  milestoneIndex,
  readiness,
  blockersCount,
  runStateLabel,
  autoRunReasonLabel,
  launchState,
  linkedSprintEngineState,
  linkedExecutionReadState,
  autoRunEnabled,
  cliPermissionPreset,
  primaryAction,
  primaryActionDisabled,
  onMilestoneFocus,
  onToggleAutoRun,
  onPermissionPresetChange,
  onOpenRole,
  onPrimaryAction,
}: {
  agents: Record<string, AgentState>
  milestone: MultiloopMilestone | null
  milestoneIndex: number
  readiness: MultiloopExecutionReadiness
  blockersCount: number
  runStateLabel: string
  autoRunReasonLabel: string
  launchState: RoleLaunchState
  linkedSprintEngineState: SwarmState | null
  linkedExecutionReadState: LinkedExecutionReadState
  autoRunEnabled: boolean
  cliPermissionPreset: SwarmCliPermissionPreset
  primaryAction: MultiloopPrimaryNextAction
  primaryActionDisabled: boolean
  onMilestoneFocus: () => void
  onToggleAutoRun: () => void
  onPermissionPresetChange: (preset: SwarmCliPermissionPreset) => void
  onOpenRole: (role: MultiloopRole) => void
  onPrimaryAction: () => void
}) {
  const ownership = getOwnershipLabel(milestone, linkedExecutionReadState)
  const primaryLabel = getPrimaryActionLabel(primaryAction, readiness)
  return (
    <div className="mt-4 flex min-w-0 flex-wrap items-stretch border border-[#24252c] bg-[#0d0e12]" aria-label="Execution status">
      <StripCell asButton onClick={onMilestoneFocus} label={milestone ? `Milestone M${milestoneIndex + 1}` : 'Milestone'} value={milestone?.title ?? 'None selected'} />
      <StripCell label="Ownership" value={ownership} accent={milestone?.sprintEngine ? 'sprintengine' : 'multiloop'} />
      <StripCell label="Readiness" value={readinessLabel(readiness)} tone={readinessTone(readiness)} />
      <StripCell label="Blockers" value={String(blockersCount)} tone={blockersCount > 0 ? 'warn' : 'normal'} />
      <div className="flex min-w-[9rem] items-center border-t border-[#202127] px-3 py-2 sm:border-l sm:border-t-0">
        <RunSettingsPopover
          autoRunEnabled={autoRunEnabled}
          runStateLabel={runStateLabel}
          autoRunReasonLabel={autoRunReasonLabel}
          cliPermissionPreset={cliPermissionPreset}
          onToggleAutoRun={onToggleAutoRun}
          onPermissionPresetChange={onPermissionPresetChange}
        />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2 border-t border-[#202127] px-3 py-2 sm:border-l sm:border-t-0">
        {launchState.status === 'error' ? (
          <span className="max-w-[22rem] truncate text-[11px] text-[#ffb5b8]">{getMultiloopRole(launchState.role).label}: {launchState.message}</span>
        ) : null}
        <MoreTerminalsPopover
          agents={agents}
          launchState={launchState}
          hasSprintEngineLink={Boolean(milestone?.sprintEngine)}
          linkedSprintEngineState={linkedSprintEngineState}
          linkedExecutionReadState={linkedExecutionReadState}
          onOpenRole={onOpenRole}
        />
        <button
          type="button"
          onClick={onPrimaryAction}
          disabled={primaryActionDisabled || (launchState.status === 'loading' && primaryAction.kind === 'open_role' && launchState.role === primaryAction.role)}
          className="inline-flex h-8 items-center rounded-[6px] bg-[#4f46e5] px-3 text-[12px] font-semibold text-white transition hover:bg-[#6366f1] focus:outline-none focus:ring-2 focus:ring-[#5c7cff] disabled:cursor-default disabled:opacity-55"
        >
          {launchState.status === 'loading' && primaryAction.kind === 'open_role' && launchState.role === primaryAction.role ? 'Opening...' : primaryLabel}
        </button>
      </div>
    </div>
  )
}

function StripCell({ label, value, tone = 'normal', accent = 'multiloop', asButton = false, onClick }: { label: string; value: string; tone?: 'normal' | 'warn' | 'error' | 'good'; accent?: 'multiloop' | 'sprintengine'; asButton?: boolean; onClick?: () => void }) {
  const content = (
    <>
      <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#777882]">{label}</span>
      <span className={`mt-1 block max-w-[16rem] truncate text-[12px] font-semibold ${tone === 'warn' ? 'text-[#ffd39a]' : tone === 'error' ? 'text-[#ffb5b8]' : tone === 'good' ? 'text-[#bff7ce]' : accent === 'sprintengine' ? 'text-[#b8ccff]' : 'text-[#ececee]'}`}>{value}</span>
    </>
  )
  const className = `min-w-[9rem] flex-1 border-t border-[#202127] px-3 py-2 text-left first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0 ${accent === 'sprintengine' ? 'border-l-[#355da8]' : ''}`
  return asButton ? (
    <button type="button" onClick={onClick} className={`${className} transition hover:bg-[#121318] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]`}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

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
  cliPermissionPreset: SwarmCliPermissionPreset
  onToggleAutoRun: () => void
  onPermissionPresetChange: (preset: SwarmCliPermissionPreset) => void
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
        className={`inline-flex h-7 items-center rounded-[999px] border px-2.5 text-[11px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-[#5c7cff] ${autoRunEnabled ? 'border-[#2f5f3f] bg-[#112318] text-[#bff7ce]' : 'border-[#303139] bg-[#111216] text-[#c8c9d0]'}`}
      >
        Run: {runStateLabel}
      </button>
      {popover.open ? (
        <div
          ref={popover.panelRef}
          id={popover.id}
          role="menu"
          tabIndex={-1}
          onKeyDown={popover.onKeyDown}
          className="absolute left-0 top-9 z-40 w-72 rounded-[8px] border border-[#303139] bg-[#0d0e12] p-3 shadow-2xl"
        >
          <label className="flex items-center justify-between gap-3 text-sm text-[#ececee]">
            <span>Auto-run</span>
            <input type="checkbox" checked={autoRunEnabled} onChange={onToggleAutoRun} className="h-4 w-4 accent-[#4f46e5] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]" />
          </label>
          <p className="mt-2 text-xs leading-5 text-[#9a9ba4]">Engine reason: {autoRunReasonLabel}</p>
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#777882]">
            CLI permission preset
            <select
              value={cliPermissionPreset}
              onChange={(event) => onPermissionPresetChange(event.currentTarget.value as SwarmCliPermissionPreset)}
              title={multiloopCliPermissionOptions.find((option) => option.value === cliPermissionPreset)?.title}
              className="mt-2 h-8 w-full rounded-[6px] border border-[#303139] bg-[#0f1014] px-2 text-[12px] font-medium text-[#d7d7dc] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
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
  linkedSprintEngineState: SwarmState | null
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
        className="inline-flex h-8 items-center rounded-[6px] border border-[#303139] bg-[#111216] px-2.5 text-[12px] font-semibold text-[#d7d7dc] transition hover:border-[#444751] hover:bg-[#17181d] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
      >
        More terminals
      </button>
      {popover.open ? (
        <div
          ref={popover.panelRef}
          id={popover.id}
          role="menu"
          tabIndex={-1}
          onKeyDown={popover.onKeyDown}
          className="absolute right-0 top-10 z-40 w-80 rounded-[8px] border border-[#303139] bg-[#0d0e12] p-2 shadow-2xl"
        >
          {groups.map((group) => (
            <div key={group.label} className="py-1">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#777882]">{group.label}</div>
              {group.roles.map((role) => {
                const soul = getMultiloopRole(role)
                const isLinkedWorker = hasSprintEngineLink && isSwarmRole(role)
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
                    className="flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-[12px] text-[#d7d7dc] transition hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus:ring-2 focus:ring-[#5c7cff] disabled:cursor-default disabled:opacity-55"
                    title={disabledReason ?? `${exists ? 'Focus' : 'Create'} ${terminalKind} ${soul.label} role terminal`}
                  >
                    <SpecialistActionIcon icon={soul.icon} className="h-4 w-4 shrink-0 text-[#9a9aa2]" />
                    <span className="min-w-0 flex-1 truncate">{loading ? 'Opening...' : `${soul.label} (${terminalKind})`}</span>
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
  return 'Sprint Engine ok'
}

function getPrimaryActionLabel(action: MultiloopPrimaryNextAction, readiness: MultiloopExecutionReadiness): string {
  if (action.kind === 'retry_execution_read') return 'Retry execution read'
  if (action.kind === 'plan_execution') return 'Plan execution'
  if (action.kind === 'open_coordinator') {
    if (readiness === 'blocked') return 'Resolve blocker'
    if (readiness === 'all_done') return 'Open Coordinator'
    if (readiness === 'no_tasks' || readiness === 'multiloop_no_tasks') return 'Plan execution'
    return 'Open Coordinator'
  }
  return `Open ${getMultiloopRole(action.role).label}`
}

function StateMessage({ title, message, tone }: { title: string; message: string; tone: 'empty' | 'error' | 'loading' }) {
  const toneClass = tone === 'error' ? 'border-[#6f3131] text-[#ffb5b8]' : 'border-[#25262d] text-[#b9bac2]'
  return (
    <section className="flex h-full min-w-0 items-center justify-center bg-[#08090b] px-6 text-center text-[#ececee] [overflow-wrap:anywhere]" role={tone === 'loading' ? 'status' : 'region'} aria-live="polite">
      <div className={`min-w-0 max-w-md rounded-[8px] border ${toneClass} bg-[#0d0e12] p-5`}>
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

function MilestoneSummary({
  milestone,
  activeMilestoneId,
}: {
  milestone: MultiloopMilestone | null
  activeMilestoneId: string | null
}) {
  if (!milestone) {
    return <PanelSection title="Milestone" empty="No milestone selected." />
  }

  const isActive = milestone.id === activeMilestoneId
  const latestVerdict = milestone.reviewVerdicts[milestone.reviewVerdicts.length - 1]
  return (
    <section className="rounded-[8px] border border-[#24252c] bg-[#0d0e12] p-4" aria-label="Selected milestone">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill label={milestoneStatusLabels[milestone.status]} className={milestoneStatusClass[milestone.status]} />
            <span className={`rounded-[999px] px-2 py-0.5 text-[11px] font-semibold ${isActive ? 'bg-[#111b30] text-[#b8ccff]' : 'bg-[#14151a] text-[#858690]'}`}>{isActive ? 'Active' : 'Historical'}</span>
          </div>
          <h2 className="mt-2 text-lg font-semibold leading-7 text-[#f4f4f5]">{milestone.title}</h2>
          <p className="mt-1 text-sm leading-6 text-[#b8b9c1]">{milestone.goal || 'No milestone goal recorded.'}</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ListBlock title="Entry criteria" items={milestone.entryCriteria} />
        <ListBlock title="Acceptance criteria" items={milestone.acceptanceCriteria} />
      </div>
      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777882]">Final goal contribution</div>
        <p className="mt-1 text-sm leading-6 text-[#c7c8cf]">{milestone.finalGoalContribution || 'No contribution recorded.'}</p>
      </div>
      {latestVerdict?.nextRecommendation ? (
        <p className="mt-3 text-sm leading-6 text-[#aeb0ba]">Next recommendation: {latestVerdict.nextRecommendation}</p>
      ) : null}
    </section>
  )
}

function ExecutionSourceStrip({
  milestone,
  linkedSwarmState,
  linkedExecutionReadState,
  workspaceRoot,
  onOpenStateFile,
}: {
  milestone: MultiloopMilestone | null
  linkedSwarmState: SwarmState | null
  linkedExecutionReadState: LinkedExecutionReadState
  workspaceRoot: string | null
  onOpenStateFile: (link: NonNullable<MultiloopMilestone['sprintEngine']>) => void
}) {
  if (!milestone?.sprintEngine) {
    return <div className="text-sm leading-6 text-[#9a9ba4]">Coordinated and executed by Multiloop.</div>
  }

  const relativePath = toProjectRelativePath(milestone.sprintEngine.statePath, workspaceRoot)
  return (
    <div className="flex flex-wrap items-center gap-2 border-l-2 border-[#355da8] bg-[#0d0e12] px-3 py-2 text-sm leading-6 text-[#b8b9c1]">
      <span className="font-semibold text-[#b8ccff]">Sprint Engine</span>
      <span>{linkedSwarmState?.name || milestone.sprintEngine.teamSlug}</span>
      <button
        type="button"
        onClick={() => onOpenStateFile(milestone.sprintEngine!)}
        className="break-all font-mono text-[11px] text-[#9fb4ff] underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-[#5c7cff]"
      >
        {relativePath}
      </button>
      {linkedExecutionReadState.status === 'loading' ? <span className="text-xs text-[#8e8f98]">Reading Sprint Engine state</span> : null}
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
    <section className="rounded-[8px] border border-[#6f3131] bg-[#130d0f] p-4" aria-label="Execution unavailable">
      <h2 className="text-base font-semibold text-[#f2f2f4]">Execution unavailable</h2>
      <p className="mt-2 text-sm leading-6 text-[#d6b5b8]">Sprint Engine state for {link.teamSlug} is not readable.</p>
      <p className="mt-2 break-all font-mono text-[11px] leading-5 text-[#ffb5b8]">{toProjectRelativePath(readState.path || link.statePath, workspaceRoot)}</p>
      <p className="mt-2 text-sm leading-6 text-[#c9a5a8]">{readState.message}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className="h-8 rounded-[6px] bg-[#4f46e5] px-3 text-[12px] font-semibold text-white transition hover:bg-[#6366f1] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]">Retry</button>
        <button type="button" onClick={onOpenStateFile} className="h-8 rounded-[6px] border border-[#303139] bg-[#111216] px-3 text-[12px] font-semibold text-[#d7d7dc] transition hover:border-[#444751] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]">Open state file</button>
        <button type="button" onClick={onOpenCoordinator} className="h-8 rounded-[6px] border border-[#303139] bg-[#111216] px-3 text-[12px] font-semibold text-[#d7d7dc] transition hover:border-[#444751] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]">Open Coordinator</button>
      </div>
    </section>
  )
}

function BlockersAndVerdicts({ milestone, blockers }: { milestone: MultiloopMilestone | null; blockers: MultiloopBlocker[] }) {
  const verdicts = milestone?.reviewVerdicts ?? []
  if (blockers.length === 0 && verdicts.length === 0) return null
  return (
    <section className="grid gap-4 md:grid-cols-2" aria-label="Blockers and verdicts">
      {blockers.length ? (
      <PanelSection title="Blockers">
        {blockers.map((blocker) => (
          <div key={blocker.id} className="rounded-[6px] bg-[#15120f] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-[#ffd39a]">{blocker.summary}</span>
              <span className="shrink-0 text-[11px] uppercase tracking-[0.1em] text-[#b99568]">{blocker.scope}</span>
            </div>
            {blocker.detail ? <p className="mt-1 text-sm leading-5 text-[#d7c2a4]">{blocker.detail}</p> : null}
          </div>
        ))}
      </PanelSection>
      ) : null}
      {verdicts.length ? (
      <PanelSection title="Review verdicts">
        {verdicts.slice(-3).reverse().map((verdict) => (
          <div key={verdict.id} className="rounded-[6px] bg-[#101116] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold capitalize text-[#ececee]">{verdict.verdict.replace(/_/g, ' ')}</span>
              <span className="text-[11px] text-[#8d8e97]">{verdict.role}</span>
            </div>
            <p className="mt-1 text-sm leading-5 text-[#bfc0c8]">{verdict.nextRecommendation}</p>
          </div>
        ))}
      </PanelSection>
      ) : null}
    </section>
  )
}

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
      <section className={`rounded-[8px] border border-[#24252c] bg-[#0d0e12] p-4 ${source === 'sprintengine' ? 'border-l-2 border-l-[#355da8]' : ''}`} aria-label="Milestone task board">
        <h2 className="text-[13px] font-semibold text-[#f0f0f2]">Milestone Tasks</h2>
        <p className="mt-2 text-sm leading-6 text-[#8e8f98]">{readinessLabel(readiness)}.</p>
        <button type="button" onClick={onPlanExecution} className="mt-3 h-8 rounded-[6px] bg-[#4f46e5] px-3 text-[12px] font-semibold text-white transition hover:bg-[#6366f1] focus:outline-none focus:ring-2 focus:ring-[#5c7cff]">Plan execution</button>
      </section>
    )
  }

  return (
    <section className={`rounded-[8px] border border-[#24252c] bg-[#0d0e12] p-4 ${source === 'sprintengine' ? 'border-l-2 border-l-[#355da8]' : ''}`} aria-label="Milestone task board">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-[#f0f0f2]">Milestone Tasks</h2>
          <p className="mt-1 text-[11px] text-[#898a93]">Source: {source === 'sprintengine' ? 'Sprint Engine' : 'Multiloop'}</p>
        </div>
        <span className="text-[11px] text-[#898a93]">{formatCount(tasks.length, 'task')}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3">
        {taskColumns.map((column) => {
          const columnTasks = tasks.filter((task) => task.status === column.key)
          const emphasized = (readiness === 'blocked' && column.key === 'blocked') || (readiness === 'needs_input' && column.key === 'needs_input')
          return (
            <div key={column.key} className={`min-h-[9rem] rounded-[6px] bg-[#101116] p-3 ${emphasized ? 'ring-1 ring-[#ffd39a]' : ''}`}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-[#ececee]">{column.label}</h3>
                  <p className="text-[11px] text-[#777882]">{column.hint}</p>
                </div>
                <span className="text-[11px] font-semibold text-[#9a9ba4]">{columnTasks.length}</span>
              </div>
              <div className="space-y-2">
                {columnTasks.length === 0 ? <p className="text-xs text-[#686972]">No tasks</p> : columnTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className={`w-full rounded-[6px] border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-[#5c7cff] ${selectedTaskId === task.id ? 'border-[#5c7cff] bg-[#151d32]' : 'border-[#292a31] bg-[#0b0c10] hover:border-[#3d3f48]'}`}
                    aria-pressed={selectedTaskId === task.id}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-sm font-medium leading-5 text-[#e7e7ea]">{task.title}</span>
                      <span className="shrink-0 text-[11px] text-[#858690]">{task.id}</span>
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[#8e8f98]">
                      <span>{task.role}</span>
                      {task.ownerAgentId ? <span>{task.ownerAgentId}</span> : null}
                      {hasEvidence(task) ? <span className="text-[#b7d0ff]">Evidence</span> : null}
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

type InspectorTab = 'detail' | 'evidence' | 'facts' | 'artifacts'

function MilestoneInspector({
  task,
  evidenceTasks,
  milestone,
  decisions,
  artifacts,
}: {
  task: MultiloopTask | null
  evidenceTasks: MultiloopTask[]
  milestone: MultiloopMilestone | null
  decisions: MultiloopDecision[]
  artifacts: MultiloopArtifact[]
}) {
  const tabs: Array<{ id: InspectorTab; label: string }> = [
    { id: 'detail', label: 'Detail' },
    { id: 'evidence', label: 'Evidence' },
    { id: 'facts', label: 'Facts' },
    { id: 'artifacts', label: 'Artifacts' },
  ]
  const [activeTab, setActiveTab] = useState<InspectorTab>(task ? 'detail' : 'evidence')
  const tabRefs = useRef<Record<InspectorTab, HTMLButtonElement | null>>({ detail: null, evidence: null, facts: null, artifacts: null })

  useEffect(() => {
    if (!task && activeTab === 'detail') setActiveTab('evidence')
  }, [activeTab, task])

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const nextIndex = event.key === 'ArrowRight'
      ? (index + 1) % tabs.length
      : (index - 1 + tabs.length) % tabs.length
    const nextTab = tabs[nextIndex].id
    setActiveTab(nextTab)
    window.requestAnimationFrame(() => tabRefs.current[nextTab]?.focus())
  }

  return (
    <section className="rounded-[8px] border border-[#24252c] bg-[#0d0e12]" aria-label="Milestone inspector">
      <div role="tablist" aria-label="Milestone inspector tabs" className="flex border-b border-[#202127]">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current[tab.id] = node
            }}
            type="button"
            role="tab"
            id={`multiloop-inspector-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`multiloop-inspector-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            className={`h-9 flex-1 border-b-2 px-2 text-[12px] font-semibold focus:outline-none focus:ring-2 focus:ring-[#5c7cff] ${activeTab === tab.id ? 'border-[#5c7cff] text-[#ececee]' : 'border-transparent text-[#858690] hover:text-[#c8c9d0]'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`multiloop-inspector-panel-${activeTab}`}
        aria-labelledby={`multiloop-inspector-tab-${activeTab}`}
        className="min-h-[18rem] p-4"
      >
        {activeTab === 'detail' ? <InspectorDetail task={task} /> : null}
        {activeTab === 'evidence' ? <InspectorEvidence tasks={evidenceTasks} /> : null}
        {activeTab === 'facts' ? <InspectorFacts milestone={milestone} decisions={decisions} /> : null}
        {activeTab === 'artifacts' ? <InspectorArtifacts artifacts={artifacts} /> : null}
      </div>
    </section>
  )
}

function InspectorDetail({ task }: { task: MultiloopTask | null }) {
  if (!task) return <EmptyInspectorText>Select a task to inspect details.</EmptyInspectorText>
  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label={taskStatusLabels[task.status]} className={`border-transparent ${taskStatusClass[task.status]}`} />
          <span className="text-[11px] text-[#858690]">{task.id}</span>
        </div>
        <h3 className="mt-2 text-sm font-semibold leading-5 text-[#ededf0]">{task.title}</h3>
        {task.description ? <p className="mt-1 text-sm leading-5 text-[#b9bac2]">{task.description}</p> : null}
      </div>
      <ListBlock title="Acceptance" items={task.acceptanceCriteria} />
      <ListBlock title="Blockers" items={task.blockers} />
    </div>
  )
}

function InspectorEvidence({ tasks }: { tasks: MultiloopTask[] }) {
  if (!tasks.length) return <EmptyInspectorText>No task evidence recorded yet.</EmptyInspectorText>
  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <div key={task.id} className="border-b border-[#202127] pb-3 last:border-b-0 last:pb-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-[#ececee]">{task.id}</span>
            <span className="text-[11px] text-[#858690]">{formatDate(task.updatedAt ?? task.completedAt ?? task.startedAt ?? task.createdAt)}</span>
          </div>
          <p className="mt-1 text-sm leading-5 text-[#bfc0c8]">{task.evidence.summary || task.title}</p>
          {task.evidence.results.length ? <p className="mt-1 text-xs text-[#9daedc]">{task.evidence.results[0]}</p> : null}
        </div>
      ))}
    </div>
  )
}

function InspectorFacts({ milestone, decisions }: { milestone: MultiloopMilestone | null; decisions: MultiloopDecision[] }) {
  const learnedFacts = milestone?.learnedFacts ?? []
  const visibleDecisions = decisions.slice(-3).reverse()
  if (learnedFacts.length === 0 && visibleDecisions.length === 0) return <EmptyInspectorText>No learned facts or decisions recorded yet.</EmptyInspectorText>
  return (
    <div className="space-y-3">
      <ListBlock title="Learned facts" items={learnedFacts} />
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777882]">Decisions</div>
        {visibleDecisions.length ? (
          <div className="mt-2 space-y-2">
            {visibleDecisions.map((decision) => (
              <p key={decision.id} className="text-sm leading-5 text-[#c7c8cf]">{decision.summary || 'Decision recorded without summary.'}</p>
            ))}
          </div>
        ) : <p className="mt-1 text-sm text-[#858690]">None recorded.</p>}
      </div>
    </div>
  )
}

function InspectorArtifacts({ artifacts }: { artifacts: MultiloopArtifact[] }) {
  if (!artifacts.length) return <EmptyInspectorText>No artifacts are linked to this milestone.</EmptyInspectorText>
  return (
    <div className="space-y-3">
      {artifacts.map((artifact) => (
        <div key={artifact.id} className="border-b border-[#202127] pb-3 last:border-b-0 last:pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-[#ececee]">{artifact.title}</span>
            <span className="text-[11px] text-[#858690]">{artifact.kind || 'artifact'}</span>
          </div>
          {artifact.path ? <p className="mt-1 break-all font-mono text-[11px] text-[#8f9cc0]">{artifact.path}</p> : null}
        </div>
      ))}
    </div>
  )
}

function EmptyInspectorText({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-6 text-[#8e8f98]">{children}</p>
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777882]">{title}</div>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-[#858690]">None recorded.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => (
            <li key={item} className="text-sm leading-5 text-[#c7c8cf]">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PanelSection({ title, empty, children }: { title: string; empty?: string; children?: React.ReactNode }) {
  const hasChildren = Boolean(children)
  return (
    <section className="rounded-[8px] border border-[#24252c] bg-[#0d0e12] p-4">
      <h2 className="text-[13px] font-semibold text-[#f0f0f2]">{title}</h2>
      {hasChildren ? <div className="mt-3 space-y-2">{children}</div> : <p className="mt-3 text-sm leading-6 text-[#8e8f98]">{empty}</p>}
    </section>
  )
}
