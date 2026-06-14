import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import {
  OverflowMenu,
  PanelHeader,
  Popover,
  PrimaryButton,
  type OverflowMenuItem,
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
  AgentCliModelSelection,
  MultiloopArtifact,
  MultiloopMilestone,
  MultiloopState,
  MultiloopTask,
  AgentCli,
  SprintEngineRole,
  SprintEngineState,
  WorkspaceId,
} from '../../types/workspace'
import { resolveCliModel } from '../workspace/newWorkspace/cliRuntimeOptions'
import { buildSprintEngineStartupPrompt, getSprintEngineStartupCommandMode, prependAgentIdentifier } from '../../utils/agentPrompt'

const EMPTY_MULTILOOP_ROLE_MODEL_DEFAULTS: Partial<Record<MultiloopRole, AgentCliModelSelection>> = {}
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
import { buildSprintEngineAgentRosterForState, buildSprintEngineRosterCommandArgs, normalizeSprintEngineProjection, sprintEngineRoleLabels } from '../../utils/sprintengine'
import { CampaignSummary } from './MultiloopBoardPanel/CampaignSummary'
import { CampaignTimeline } from './MultiloopBoardPanel/CampaignTimeline'
import { BlockersPanel, TaskBoard } from './MultiloopBoardPanel/TaskBoard'
import { ExecutionUnavailable, SprintConsole } from './MultiloopBoardPanel/SprintConsole'
import { MultiloopSettingsPopover } from './MultiloopBoardPanel/MultiloopSettingsPopover'
import { ReassessmentColumn } from './MultiloopBoardPanel/ReassessmentColumn'
import { StateMessage } from './MultiloopBoardPanel/StateMessage'
import { getOwnershipLabel, readinessLabel, readinessTone, type LinkedExecutionReadState, type ReadState, type RoleLaunchState } from './MultiloopBoardPanel/helpers'
import {
  getEffectiveKeybindingLabel,
  platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'

type Props = {
  workspaceId: WorkspaceId
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

type LinkedSprintEngineRole = Extract<SprintEngineRole, MultiloopRole>

function isSprintEngineRole(role: MultiloopRole): role is LinkedSprintEngineRole {
  return role !== 'coordinator'
}

function getLinkedSprintEngineAgentId(role: LinkedSprintEngineRole, linkedState: SprintEngineState | null): string {
  return buildSprintEngineAgentRosterForState(linkedState).find((agent) => agent.role === role)?.id ?? role
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
  const lastSelectedCli = useWorkspaceStore((state) => state.appSettings.lastSelectedCli)
  const multiloopRoleCliDefaults = useWorkspaceStore((state) => state.appSettings.multiloopRoleCliDefaults)
  const multiloopRoleModelDefaults = useWorkspaceStore((state) => state.appSettings.multiloopRoleModelDefaults ?? EMPTY_MULTILOOP_ROLE_MODEL_DEFAULTS)
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const shortcutFor = useCallback((commandId: string): string | undefined => (
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform) ?? undefined
  ), [keybindingPlatform, keybindingSettings])
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
    const selectedCli: AgentCli = multiloopRoleCliDefaults[role] ?? lastSelectedCli
    const selectedCliModel = resolveCliModel(selectedCli, multiloopRoleModelDefaults[role])
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
        // Multiloop only launches bundled Sprint Engine workers (the role list
        // is constrained at the caller via `isSprintEngineRole`). Indexing the
        // bundled label map here is intentional bundled-role compatibility.
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
          cli: existingAgent?.cli ?? selectedCli,
          cliModel: existingAgent?.cliModel ?? selectedCliModel,
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
        cli: existingAgent?.cli ?? selectedCli,
        cliModel: existingAgent?.cliModel ?? selectedCliModel,
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
    void window.api.readSprintEngineProjection(resolvedStatePath)
      .then((projection) => {
        if (cancelled()) return
        if (!projection.ok) throw new Error(projection.message)
        const parsed = normalizeSprintEngineProjection(projection.data, link.teamSlug)
        if (!parsed) throw new Error('Sprint Engine projection was malformed.')
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
  useEffect(() => {
    const onCommand = (event: Event) => {
      commandHandlerRef.current((event as CustomEvent).detail)
    }
    window.addEventListener('multicode:panel-command', onCommand)
    return () => {
      window.removeEventListener('multicode:panel-command', onCommand)
    }
  }, [])

  const openLinkedStateFile = async (link: NonNullable<MultiloopMilestone['sprintEngine']>) => {
    const path = resolveProjectPath(link.statePath, workspaceRoot)
    const content = await window.api.readfile(path)
    openFile(workspaceId, path, link.statePath.split(/[\\/]/u).pop() || 'run.yaml', content)
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
      shortcut: shortcutFor('multiloop.open.settings'),
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
          <Popover
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            ariaLabel="Multiloop settings"
            popupRole="dialog"
            placement="bottom-end"
            renderTrigger={() => (
              <OverflowMenu ariaLabel="Multiloop overflow" items={overflowItems} />
            )}
          >
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
          </Popover>
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
// LABELS, HELPERS
// ===========================================================================
