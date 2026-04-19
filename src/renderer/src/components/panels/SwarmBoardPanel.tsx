import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type {
  SwarmRole,
  SwarmState,
  SwarmTask,
  SwarmTaskBoardColumn,
  SwarmTaskStatus,
} from '../../types/workspace'
import {
  buildSwarmAgentRoster,
  getSwarmTaskBoardColumn,
  swarmRoleAccent,
  swarmRoleLabels,
} from '../../utils/swarm'
import { renderMarkdown } from '../../utils/markdown'
import TerminalView from './TerminalView'
import {
  getSwarmDirectoryPath,
  getSwarmMailboxMessageFilePath,
  getSwarmMailboxRootPath,
  getSwarmPlanFilePath,
  getSwarmRootDirectoryPath,
  getSwarmTasksSchemaFilePath,
  getSwarmTasksTemplateFilePath,
  getSwarmStateFilePath,
  parseSwarmStateFile,
  serializeSwarmPlanMarkdown,
  serializeSwarmStateFile,
  serializeSwarmTasksSchema,
  serializeSwarmTasksTemplate,
  slugifySwarmName,
} from '../../utils/swarmStateFile'
import { focusOrAddComponentTab } from '../../utils/modelRegistry'

const columnMeta: { key: SwarmTaskBoardColumn; label: string; tint: string }[] = [
  { key: 'todo', label: 'Todo', tint: 'bg-zinc-900/80 text-zinc-400' },
  { key: 'ready', label: 'Ready', tint: 'bg-sky-950/50 text-sky-300' },
  { key: 'in_progress', label: 'In Progress', tint: 'bg-amber-950/50 text-amber-300' },
  { key: 'needs_input', label: 'Needs Input', tint: 'bg-rose-950/50 text-rose-300' },
  { key: 'done', label: 'Done', tint: 'bg-zinc-800/80 text-zinc-200' },
]

const phaseTone: Record<string, string> = {
  planning: 'border-[#3a4150] bg-[#171a20] text-zinc-300',
  awaiting_approval: 'border-[#5f4b2d] bg-[#1d1813] text-amber-200',
  executing: 'border-[#324558] bg-[#151a22] text-sky-200',
  completed: 'border-[#335245] bg-[#141b18] text-emerald-200',
}

const taskStateLabel: Record<SwarmTaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  needs_input: 'Needs Input',
  done: 'Done',
}

interface Props {
  workspaceId: string
}

type SyncState = {
  status: 'idle' | 'syncing' | 'live' | 'error'
  message: string
}

type PlanReviewState = {
  open: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  content: string
  error: string | null
  mode: 'preview' | 'source'
}

type SwarmView = 'map' | 'kanban' | 'terminals'

export default function SwarmBoardPanel({ workspaceId }: Props) {
  const workspace = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId) ?? null
  )
  const setSwarmState = useWorkspaceStore((s) => s.setSwarmState)
  const approveSwarmPlan = useWorkspaceStore((s) => s.approveSwarmPlan)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<SwarmView>('map')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [terminalsMounted, setTerminalsMounted] = useState(false)
  const [showRunSummary, setShowRunSummary] = useState(false)
  const [planReview, setPlanReview] = useState<PlanReviewState>({
    open: false,
    status: 'idle',
    content: '',
    error: null,
    mode: 'preview',
  })
  const [, setSyncState] = useState<SyncState>({
    status: 'idle',
    message: 'Waiting for a swarm workspace folder.',
  })
  const lastSyncedContentRef = useRef<string | null>(null)
  const externalReadTimerRef = useRef<number | null>(null)

  const swarmState = workspace?.swarmState ?? null
  const folderPath = workspace?.folderPath ?? null
  const agents = workspace?.agents ?? {}
  const swarmName = swarmState?.name ?? workspace?.name ?? 'Swarm Team'

  const serializedState = useMemo(() => {
    if (!swarmState || !folderPath || !workspace) return null
    return serializeSwarmStateFile({
      workspaceId,
      workspacePath: folderPath,
      swarmState,
      agents,
    })
  }, [agents, folderPath, swarmState, workspace, workspaceId])

  useEffect(() => {
    if (!swarmState || !folderPath || !serializedState) {
      setSyncState({
        status: 'idle',
        message: 'Choose a workspace folder to enable shared swarm state.',
      })
      return
    }

    let cancelled = false

    const writeStateFile = async () => {
      try {
        const swarmRootDirectory = getSwarmRootDirectoryPath(folderPath)
        const swarmDirectory = getSwarmDirectoryPath(folderPath, swarmName)
        const mailboxRootPath = getSwarmMailboxRootPath(folderPath, swarmName)
        const stateFilePath = getSwarmStateFilePath(folderPath, swarmName)
        const planFilePath = getSwarmPlanFilePath(folderPath, swarmName)
        const tasksTemplateFilePath = getSwarmTasksTemplateFilePath(folderPath, swarmName)
        const tasksSchemaFilePath = getSwarmTasksSchemaFilePath(folderPath, swarmName)
        setSyncState({ status: 'syncing', message: 'Writing swarm state to disk...' })

        try {
          const entries = await window.api.readdir(folderPath)
          if (!entries.some((entry) => entry.isDir && entry.name === 'swarm')) {
            await window.api.createDir(folderPath, 'swarm')
          }
        } catch {
          await window.api.createDir(folderPath, 'swarm').catch(() => {})
        }
        await window.api.createDir(swarmRootDirectory, slugifySwarmName(swarmName)).catch(() => {})
        await window.api.createDir(swarmDirectory, 'mailboxes').catch(() => {})
        for (const rosterAgent of buildSwarmAgentRoster(swarmState.roleCounts)) {
          await window.api.createDir(mailboxRootPath, rosterAgent.id).catch(() => {})
        }

        if (cancelled) return
        if (lastSyncedContentRef.current === serializedState) {
          setSyncState({ status: 'live', message: `Shared state live at ${stateFilePath}` })
          return
        }

        await window.api.writefile(stateFilePath, serializedState)
        try {
          await window.api.readfile(planFilePath)
        } catch {
          await window.api.writefile(planFilePath, serializeSwarmPlanMarkdown(swarmState))
        }
        try {
          await window.api.readfile(tasksTemplateFilePath)
        } catch {
          await window.api.writefile(tasksTemplateFilePath, serializeSwarmTasksTemplate())
        }
        try {
          await window.api.readfile(tasksSchemaFilePath)
        } catch {
          await window.api.writefile(tasksSchemaFilePath, serializeSwarmTasksSchema())
        }
        if (cancelled) return
        lastSyncedContentRef.current = serializedState
        setSyncState({ status: 'live', message: `Shared state live at ${swarmDirectory}` })
      } catch (error) {
        if (cancelled) return
        setSyncState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to write swarm state.',
        })
      }
    }

    void writeStateFile()

    return () => {
      cancelled = true
    }
  }, [folderPath, serializedState, swarmName, swarmState, workspaceId])

  useEffect(() => {
    if (!swarmState || !folderPath) return

    let disposed = false
    let stopWatching: (() => Promise<void>) | null = null
    const swarmRootDirectory = getSwarmRootDirectoryPath(folderPath)
    const swarmDirectory = getSwarmDirectoryPath(folderPath, swarmName)
    const stateFilePath = getSwarmStateFilePath(folderPath, swarmName)

    const readExternalState = async () => {
      try {
        const content = await window.api.readfile(stateFilePath)
        if (disposed || content === lastSyncedContentRef.current) return
        const parsed = parseSwarmStateFile(content)
        lastSyncedContentRef.current = content
        setSwarmState(workspaceId, parsed)
        setSyncState({ status: 'live', message: `Loaded external swarm update from ${stateFilePath}` })
      } catch (error) {
        if (disposed) return
        setSyncState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to read shared swarm state.',
        })
      }
    }

    const scheduleExternalRead = () => {
      if (externalReadTimerRef.current !== null) {
        window.clearTimeout(externalReadTimerRef.current)
      }

      externalReadTimerRef.current = window.setTimeout(() => {
        void readExternalState()
      }, 120)
    }

    const startWatching = async () => {
      try {
        const entries = await window.api.readdir(folderPath)
        if (!entries.some((entry) => entry.isDir && entry.name === 'swarm')) {
          await window.api.createDir(folderPath, 'swarm')
        }
        await window.api.createDir(swarmRootDirectory, slugifySwarmName(swarmName)).catch(() => {})

        stopWatching = await window.api.watchPath(swarmDirectory, (event) => {
          if (event.path && !event.path.endsWith('state.yaml')) return
          scheduleExternalRead()
        })
      } catch (error) {
        if (disposed) return
        setSyncState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to watch swarm directory.',
        })
      }
    }

    void startWatching().catch((error) => {
      if (disposed) return
      setSyncState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to watch swarm directory.',
      })
    })

    return () => {
      disposed = true
      if (externalReadTimerRef.current !== null) {
        window.clearTimeout(externalReadTimerRef.current)
        externalReadTimerRef.current = null
      }
      if (stopWatching) {
        void stopWatching()
      }
    }
  }, [folderPath, setSwarmState, swarmName, swarmState, workspaceId])

  const roster = useMemo(
    () => buildSwarmAgentRoster(swarmState?.roleCounts ?? swarmState?.agentCount ?? 4),
    [swarmState?.roleCounts, swarmState?.agentCount]
  )

  const rosterById = useMemo(
    () => Object.fromEntries(roster.map((agent) => [agent.id, agent])),
    [roster]
  )

  const runtimeAgents = useMemo(
    () =>
      Object.entries(swarmState?.swarmAgents ?? {}).map(([agentId, runtime]) => ({
        agentId,
        ...runtime,
      })),
    [swarmState?.swarmAgents]
  )

  const boardColumns = useMemo(() => {
    if (!swarmState) return []

    return columnMeta.map((column) => ({
      ...column,
      cards: swarmState.tasks.filter(
        (task) => getSwarmTaskBoardColumn(task, swarmState.tasks, swarmState.planApproved) === column.key
      ),
    }))
  }, [swarmState])

  const selectedTask = swarmState?.tasks.find((task) => task.id === selectedTaskId) ?? null

  if (!swarmState) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0f1012] text-sm text-zinc-500">
        Swarm workspace data is missing.
      </div>
    )
  }

  const doneCount = swarmState.tasks.filter((task) => task.status === 'done').length
  const activeCount = runtimeAgents.filter((agent) => agent.status === 'running').length
  const needsInputCount = runtimeAgents.filter((agent) => agent.status === 'needs_input').length
  const allTasksDone = swarmState.tasks.length > 0 && doneCount === swarmState.tasks.length
  const runSummary = buildRunSummary(swarmState.tasks)
  const architectAgentId = roster.find((agent) => agent.role === 'architect')?.id ?? null
  const planFilePath = folderPath ? getSwarmPlanFilePath(folderPath, swarmName) : null
  const planReadiness = getPlanReadiness(swarmState)
  const resolvedSelectedAgentId = selectedAgentId ?? architectAgentId ?? roster[0]?.id ?? null

  const activateView = (view: SwarmView) => {
    setActiveView(view)
    if (view === 'terminals') {
      setTerminalsMounted(true)
    }
  }

  const openAgentTerminal = (agentId: string) => {
    setSelectedAgentId(agentId)
    setTerminalsMounted(true)
    setActiveView('terminals')
  }

  const loadPlanReview = async () => {
    if (!swarmState || !folderPath) {
      setPlanReview((current) => ({
        ...current,
        open: true,
        status: 'error',
        error: 'Choose a workspace folder before reviewing the swarm plan.',
      }))
      return
    }

    const swarmRootDirectory = getSwarmRootDirectoryPath(folderPath)
    const swarmDirectory = getSwarmDirectoryPath(folderPath, swarmName)
    const nextPlanFilePath = getSwarmPlanFilePath(folderPath, swarmName)
    setPlanReview((current) => ({
      ...current,
      open: true,
      status: 'loading',
      error: null,
    }))

    try {
      try {
        const entries = await window.api.readdir(folderPath)
        if (!entries.some((entry) => entry.isDir && entry.name === 'swarm')) {
          await window.api.createDir(folderPath, 'swarm')
        }
      } catch {
        await window.api.createDir(folderPath, 'swarm').catch(() => {})
      }
      await window.api.createDir(swarmRootDirectory, slugifySwarmName(swarmName)).catch(() => {})

      let content = ''
      try {
        content = await window.api.readfile(nextPlanFilePath)
      } catch {
        content = serializeSwarmPlanMarkdown(swarmState)
        await window.api.writefile(nextPlanFilePath, content)
      }

      setPlanReview((current) => ({
        ...current,
        open: true,
        status: 'ready',
        content,
        error: null,
      }))
    } catch (error) {
      setPlanReview((current) => ({
        ...current,
        open: true,
        status: 'error',
        content: '',
        error: error instanceof Error ? error.message : `Failed to load plan from ${swarmDirectory}.`,
      }))
    }
  }

  const openPlanInEditor = async () => {
    if (!planFilePath) return
    const content = planReview.content || await window.api.readfile(planFilePath)
    openFile(workspaceId, planFilePath, 'plan.md', content)
    focusOrAddComponentTab(workspaceId, 'editor', 'Editor')
    setPlanReview((current) => ({ ...current, open: false }))
  }

  const writePlanApprovedMailboxes = async () => {
    if (!folderPath) return
    const swarmDirectory = getSwarmDirectoryPath(folderPath, swarmName)
    const mailboxRootPath = getSwarmMailboxRootPath(folderPath, swarmName)

    await window.api.createDir(swarmDirectory, 'mailboxes').catch(() => {})

    await Promise.all(roster
      .filter((agent) => agent.role !== 'architect')
      .map(async (agent) => {
        await window.api.createDir(mailboxRootPath, agent.id).catch(() => {})

        const messageId = `${Date.now()}-plan-approved-${agent.id}`
        const roleInstruction = agent.role === 'product'
          ? `Review your mailbox, then run \`swarm claim-next-task --role product --agent-id ${agent.id}\` if a product research, competitor analysis, audience, positioning, or adoption-risk task is ready.`
          : `Review your mailbox, then run \`swarm claim-next-task --role ${agent.role} --agent-id ${agent.id}\` to pick up approved work for your specialty.`
        const payload = {
          id: messageId,
          from: 'architect',
          to: agent.id,
          subject: 'Plan approved',
          createdAt: new Date().toISOString(),
          body: [
            `The swarm plan for "${swarmState.name}" has been approved.`,
            roleInstruction,
            'Continue polling your mailbox about every 30 seconds with `swarm get-mailbox --agent-id <your-agent-id> --consume` while you are active.',
            'Do not manually edit swarm/state.yaml; use the swarm tool for task claiming, notes, evidence, and status updates.',
          ].join('\n\n'),
        }

        await window.api.writefile(
          getSwarmMailboxMessageFilePath(folderPath, swarmName, agent.id, messageId),
          `${JSON.stringify(payload, null, 2)}\n`
        )
      }))
  }

  const approveFromPlanReview = async () => {
    if (!swarmState.planReady) return
    await writePlanApprovedMailboxes()
    approveSwarmPlan(workspaceId)
    setTerminalsMounted(true)
    setActiveView('terminals')
    setPlanReview((current) => ({ ...current, open: false }))
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#0f1012] text-zinc-100">
      <div className="border-b border-[#23262d] bg-[#121419] px-5 py-4">
        {!swarmState.planApproved ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#5f4b2d] bg-[#1d1813] px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-300">
                {planReadiness.label}
              </div>
              <div className="mt-1 text-sm font-medium text-amber-100">
                {planReadiness.message}
              </div>
              <div className="mt-1 text-[12px] text-amber-200/80">
                {planReadiness.detail}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {architectAgentId ? (
                <button
                  onClick={() => openAgentTerminal(architectAgentId)}
                  className="rounded-xl border border-amber-300/25 bg-amber-200/10 px-4 py-2 text-sm font-semibold text-amber-100 transition-colors hover:bg-amber-200/15"
                >
                  Open Architect CLI
                </button>
              ) : null}
              <button
                onClick={() => void loadPlanReview()}
                className="rounded-xl border border-amber-300/40 bg-amber-200 px-4 py-2 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-100"
              >
                Review Plan
              </button>
            </div>
          </div>
        ) : null}

        {allTasksDone ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-emerald-400/30 bg-emerald-950/20 px-4 py-3 shadow-[0_0_30px_rgba(16,185,129,0.08)]">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300">
                Run Complete
              </div>
              <div className="mt-1 text-sm font-medium text-emerald-100">
                All tasks are done. Review the uncommitted workspace changes and manually test the feature.
              </div>
              <div className="mt-1 text-[12px] text-emerald-200/80">
                {runSummary.touchedFiles.length} files touched, {runSummary.commandsRan.length} commands recorded, {runSummary.results.length} validation results.
              </div>
            </div>
            <button
              onClick={() => setShowRunSummary(true)}
              className="rounded-xl border border-emerald-300/40 bg-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-100"
            >
              View Run Summary
            </button>
          </div>
        ) : null}

        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[22px] font-semibold tracking-tight text-zinc-100">
              {swarmState.name}
            </h2>
            <p className="mt-1 max-w-4xl truncate text-sm text-zinc-400">{formatSwarmGoal(swarmState.goal)}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {runtimeAgents.map((agent) => (
                <div
                  key={agent.agentId}
                  className="inline-flex items-center gap-2 rounded-full border border-[#2a2e36] bg-[#171a20] px-3 py-1.5 text-[11px] text-zinc-300"
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{
                      backgroundColor: swarmRoleAccent[agent.role],
                      boxShadow: `0 0 10px ${swarmRoleAccent[agent.role]}`,
                    }}
                  />
                  <span className="font-medium text-zinc-200">{rosterById[agent.agentId]?.label ?? agent.agentId}</span>
                  <span className={`rounded-full px-2 py-0.5 ${runtimeTone(agent.status)}`}>
                    {runtimeStatusLabel(agent.status)}
                  </span>
                  {agent.currentTaskId ? (
                    <span className="text-zinc-500">{agent.currentTaskId}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Phase" value={swarmState.phase.replace('_', ' ')} tone={phaseTone[swarmState.phase]} />
            <MetricCard
              label="Plan"
              value={getPlanMetricValue(swarmState)}
              tone={getPlanMetricTone(swarmState)}
            />
            <MetricCard
              label="Done"
              value={`${doneCount}/${swarmState.tasks.length}`}
              tone={allTasksDone ? 'border-emerald-400/30 bg-emerald-950/20 text-emerald-100' : 'border-[#2f3540] bg-[#171b22] text-zinc-100'}
            />
            <MetricCard label="Active" value={`${activeCount} running / ${needsInputCount} waiting`} tone="border-[#2f3540] bg-[#171b22] text-zinc-100" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {([
            { id: 'map' as const, label: 'Map' },
            { id: 'kanban' as const, label: 'Kanban' },
            { id: 'terminals' as const, label: 'Terminals' },
          ]).map((view) => (
            <button
              key={view.id}
              onClick={() => activateView(view.id)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors ${
                activeView === view.id
                  ? 'border-zinc-500 bg-zinc-200 text-zinc-950'
                  : 'border-[#2a2e36] bg-[#171a20] text-zinc-400 hover:bg-[#1b1f26] hover:text-zinc-100'
              }`}
            >
              {view.label}
            </button>
          ))}
        </div>

      </div>

      {activeView === 'map' ? (
        <SwarmMapView
          workspaceId={workspaceId}
          swarmState={swarmState}
          roster={roster}
          rosterById={rosterById}
          runtimeAgents={runtimeAgents}
          selectedAgentId={resolvedSelectedAgentId}
          onSelectAgent={setSelectedAgentId}
          onOpenTerminal={openAgentTerminal}
        />
      ) : null}

      {activeView === 'kanban' ? (
      <div className="grid flex-1 gap-3 overflow-x-auto overflow-y-hidden bg-[#101216] p-4 lg:grid-cols-3 xl:grid-cols-5">
        {swarmState.tasks.length === 0 ? (
          <div className="col-span-full flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-[#2a2d34] bg-[#15171b] p-6 text-center">
            <div className="max-w-xl">
              <div className="text-sm font-semibold text-zinc-100">Waiting for the architect plan</div>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                The board will populate after the architect writes the named team plan, creates swarm/tasks.json, replaces the task graph, and marks it ready for review.
              </p>
            </div>
          </div>
        ) : null}
        {swarmState.tasks.length > 0 ? boardColumns.map((column) => (
          <section
            key={column.key}
            className="flex min-w-[260px] flex-col rounded-2xl border border-[#23262d] bg-[#14161a]"
          >
            <div className="flex items-center justify-between border-b border-[#23262d] px-4 py-3">
              <div className="text-sm font-semibold text-zinc-100">{column.label}</div>
              <span
                className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${column.tint}`}
              >
                {column.cards.length}
              </span>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-3">
              {column.cards.map((task) => {
                const ownerLabel = getTaskOwnerLabel(task, rosterById)
                return (
                  <button
                    key={task.id}
                    onClick={() => setSelectedTaskId(task.id)}
                    className={`w-full rounded-xl border p-3 text-left transition-colors ${taskCardTone(task)}`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-zinc-100">{task.title}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                          {task.id} | {swarmRoleLabels[task.role]}
                      </div>
                    </div>
                      <span className="rounded-full border border-[#303542] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                        {ownerLabel}
                      </span>
                    </div>

                    <p className="text-[12px] leading-5 text-zinc-400">{task.description}</p>

                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                      <span className="rounded-full border border-[#2c313b] px-2 py-1">
                        {task.ownedPaths.length} paths
                      </span>
                      <span className="rounded-full border border-[#2c313b] px-2 py-1">
                        {task.acceptanceCriteria.length} checks
                      </span>
                      {task.questionsForUser.length > 0 ? (
                        <span className="rounded-full border border-rose-900/70 bg-rose-950/40 px-2 py-1 text-rose-200">
                          {task.questionsForUser.length} question{task.questionsForUser.length === 1 ? '' : 's'}
                        </span>
                      ) : null}
                      {task.dependsOn.length > 0 ? (
                        <span className="rounded-full border border-[#2c313b] px-2 py-1">
                          {task.dependsOn.length} deps
                        </span>
                      ) : null}
                      {task.status === 'done' && task.completedAt ? (
                        <span className="rounded-full border border-emerald-400/20 bg-emerald-950/30 px-2 py-1 text-emerald-200">
                          completed {formatTimestampShort(task.completedAt)}
                        </span>
                      ) : null}
                    </div>

                    {task.status === 'done' && task.evidence.summary ? (
                      <div className="mt-3 rounded-lg border border-emerald-400/20 bg-emerald-950/20 px-3 py-2 text-[11px] leading-5 text-emerald-100">
                        {task.evidence.summary}
                      </div>
                    ) : task.notes[0] ? (
                      <div className="mt-3 rounded-lg border border-[#23262d] bg-[#16191d] px-3 py-2 text-[11px] leading-5 text-zinc-400">
                        {task.notes[0]}
                      </div>
                    ) : null}
                  </button>
                )
              })}

              {column.cards.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#2a2d34] bg-[#15171b] px-3 py-4 text-[12px] text-zinc-600">
                  No tasks here yet
                </div>
              ) : null}
            </div>
          </section>
        )) : null}
      </div>
      ) : null}

      {terminalsMounted ? (
        <SwarmTerminalsView
          workspaceId={workspaceId}
          roster={roster}
          active={activeView === 'terminals'}
        />
      ) : activeView === 'terminals' ? (
        <div className="flex flex-1 items-center justify-center bg-[#101216] p-6">
          <div className="max-w-md rounded-2xl border border-[#2a2e36] bg-[#15171b] p-5 text-center">
            <div className="text-sm font-semibold text-zinc-100">Preparing terminals</div>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              Opening the Terminals view starts the visible team CLIs. Use Ctrl-C inside any terminal when you want that process to stop.
            </p>
            <button
              onClick={() => setTerminalsMounted(true)}
              className="mt-4 rounded-xl border border-zinc-500 bg-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white"
            >
              Open Team Terminals
            </button>
          </div>
        </div>
      ) : null}

      {selectedTask && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[900px] overflow-y-auto rounded-2xl border border-[#303542] bg-[#121419] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#23262d] px-5 py-4">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                  Task Detail
                </div>
                <h3 className="text-[20px] font-semibold tracking-tight text-zinc-100">
                  {selectedTask.title}
                </h3>
                <div className="mt-2 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                  <span className="rounded-full border border-[#2a2e36] px-2 py-1">{selectedTask.id}</span>
                  <span className="rounded-full border border-[#2a2e36] px-2 py-1">
                    {swarmRoleLabels[selectedTask.role]}
                  </span>
                  <span className="rounded-full border border-[#2a2e36] px-2 py-1">
                    {taskStateLabel[selectedTask.status]}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedTaskId(null)}
                className="rounded-lg border border-[#2a2e36] bg-[#181b20] px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-[#1c2026] hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <div className="space-y-5 px-5 py-5 text-[13px] leading-6 text-zinc-300">
              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                  Description
                </div>
                <p>{selectedTask.description}</p>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <InfoCard
                  label="Owner"
                  value={getTaskOwnerLabel(selectedTask, rosterById)}
                />
                <InfoCard
                  label="Dependencies"
                  value={selectedTask.dependsOn.join(', ') || 'None'}
                />
                <InfoCard
                  label="Started"
                  value={formatTimestamp(selectedTask.startedAt)}
                />
              </div>

              {selectedTask.ownerAgentId ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#2a2e36] bg-[#171a20] px-4 py-3">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                      Worker CLI
                    </div>
                    <div className="mt-1 text-sm text-zinc-200">
                      Jump straight to {rosterById[selectedTask.ownerAgentId]?.label ?? selectedTask.ownerAgentId} to continue or answer questions there.
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      openAgentTerminal(selectedTask.ownerAgentId!)
                      setSelectedTaskId(null)
                    }}
                    className="rounded-xl border border-[#3b4250] bg-[#1b1f26] px-4 py-2 text-sm font-semibold text-zinc-100 transition-colors hover:bg-[#20252e]"
                  >
                    Open Worker CLI
                  </button>
                </div>
              ) : null}

              <SectionList title="Owned Paths" items={selectedTask.ownedPaths} emptyLabel="No owned paths recorded." />
              <SectionList
                title="Acceptance Criteria"
                items={selectedTask.acceptanceCriteria}
                emptyLabel="No acceptance criteria recorded."
              />
              <SectionList
                title="Implementation Notes"
                items={selectedTask.implementationNotes}
                emptyLabel="No implementation notes recorded."
              />
              <SectionList title="Notes" items={selectedTask.notes} emptyLabel="No notes recorded." />
              <SectionList
                title="Questions For User"
                items={selectedTask.questionsForUser}
                emptyLabel="No outstanding questions."
              />
              {selectedTask.status === 'needs_input' || selectedTask.questionsForUser.length > 0 ? (
                <div className="rounded-2xl border border-amber-900/70 bg-amber-950/20 px-4 py-3 text-sm text-amber-100">
                  Respond in the highlighted CLI for this worker. The terminal stays the single place to unblock the task.
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
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
              </div>

              <SectionList
                title="Touched Files"
                items={selectedTask.evidence.touchedFiles}
                emptyLabel="No touched files recorded."
              />

              <div>
                <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                  Evidence Summary
                </div>
                <div className="rounded-xl border border-[#23262d] bg-[#171a20] px-4 py-3 text-zinc-200">
                  {selectedTask.evidence.summary || 'No completion summary recorded yet.'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRunSummary ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-[980px] overflow-y-auto rounded-2xl border border-emerald-400/30 bg-[#121419] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-[#23262d] px-5 py-4">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300">
                  Run Summary
                </div>
                <h3 className="text-[20px] font-semibold tracking-tight text-zinc-100">
                  {formatSwarmGoal(swarmState.goal)}
                </h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Final evidence collected from completed swarm task cards.
                </p>
              </div>
              <button
                onClick={() => setShowRunSummary(false)}
                className="rounded-lg border border-[#2a2e36] bg-[#181b20] px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-[#1c2026] hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <div className="space-y-5 px-5 py-5 text-[13px] leading-6 text-zinc-300">
              <div className="grid gap-4 md:grid-cols-4">
                <InfoCard label="Tasks Done" value={`${runSummary.completedTasks}/${runSummary.totalTasks}`} />
                <InfoCard label="Files Touched" value={String(runSummary.touchedFiles.length)} />
                <InfoCard label="Commands" value={String(runSummary.commandsRan.length)} />
                <InfoCard label="Results" value={String(runSummary.results.length)} />
              </div>

              <SectionList
                title="Completed Tasks"
                items={runSummary.taskSummaries}
                emptyLabel="No completed tasks recorded."
              />
              <SectionList
                title="Touched Files"
                items={runSummary.touchedFiles}
                emptyLabel="No touched files recorded."
              />
              <SectionList
                title="Commands Run"
                items={runSummary.commandsRan}
                emptyLabel="No commands recorded."
              />
              <SectionList
                title="Validation Results"
                items={runSummary.results}
                emptyLabel="No validation results recorded."
              />
              <SectionList
                title="Remaining Questions"
                items={runSummary.openQuestions}
                emptyLabel="No open questions remain."
              />

              <div className="rounded-2xl border border-amber-400/20 bg-amber-950/10 px-4 py-3 text-sm text-amber-100">
                Next step: manually test the uncommitted changes in the workspace before committing or reverting.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {planReview.open ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl border border-amber-300/30 bg-[#121419] shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#23262d] px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-300">
                  Architect Plan Review
                </div>
                <h3 className="truncate text-[20px] font-semibold tracking-tight text-zinc-100">
                  {planFilePath ?? 'swarm/plan.md'}
                </h3>
                <p className="mt-2 text-sm text-zinc-400">
                  Review the architect-authored low-level design and final task graph before unlocking worker execution.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() =>
                    setPlanReview((current) => ({
                      ...current,
                      mode: current.mode === 'preview' ? 'source' : 'preview',
                    }))
                  }
                  className="rounded-lg border border-[#2a2e36] bg-[#181b20] px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-[#1c2026] hover:text-zinc-100"
                >
                  {planReview.mode === 'preview' ? 'Source' : 'Preview'}
                </button>
                <button
                  onClick={() => void loadPlanReview()}
                  className="rounded-lg border border-[#2a2e36] bg-[#181b20] px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-[#1c2026] hover:text-zinc-100"
                >
                  Refresh
                </button>
                {architectAgentId ? (
                  <button
                    onClick={() => openAgentTerminal(architectAgentId)}
                    className="rounded-lg border border-amber-300/25 bg-amber-200/10 px-3 py-2 text-sm text-amber-100 transition-colors hover:bg-amber-200/15"
                  >
                    Architect CLI
                  </button>
                ) : null}
                <button
                  onClick={() => setPlanReview((current) => ({ ...current, open: false }))}
                  className="rounded-lg border border-[#2a2e36] bg-[#181b20] px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-[#1c2026] hover:text-zinc-100"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className={`mb-5 rounded-2xl border px-4 py-3 ${planReadiness.panelTone}`}>
                <div className="text-[10px] font-bold uppercase tracking-[0.14em]">
                  {planReadiness.label}
                </div>
                <div className="mt-1 text-sm font-medium">{planReadiness.message}</div>
                <div className="mt-1 text-[12px] opacity-80">{planReadiness.detail}</div>
                {swarmState.taskValidation ? (
                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <InfoCard
                      label="Validation"
                      value={swarmState.taskValidation.ok ? 'Passed' : 'Failed'}
                    />
                    <InfoCard
                      label="Warnings"
                      value={String(swarmState.taskValidation.warnings.length)}
                    />
                    <InfoCard
                      label="Checked"
                      value={formatTimestamp(swarmState.taskValidation.checkedAt)}
                    />
                  </div>
                ) : null}
                {swarmState.taskValidation?.errors.length ? (
                  <SectionList
                    title="Validation Errors"
                    items={swarmState.taskValidation.errors}
                    emptyLabel="No validation errors."
                  />
                ) : null}
                {swarmState.taskValidation?.warnings.length ? (
                  <SectionList
                    title="Validation Warnings"
                    items={swarmState.taskValidation.warnings}
                    emptyLabel="No validation warnings."
                  />
                ) : null}
              </div>

              {planReview.status === 'loading' ? (
                <div className="rounded-2xl border border-[#23262d] bg-[#171a20] px-4 py-5 text-sm text-zinc-400">
                  Loading plan...
                </div>
              ) : null}
              {planReview.status === 'error' ? (
                <div className="rounded-2xl border border-rose-400/30 bg-rose-950/20 px-4 py-5 text-sm text-rose-100">
                  {planReview.error ?? 'Failed to load plan.'}
                </div>
              ) : null}
              {planReview.status === 'ready' && planReview.mode === 'preview' ? (
                <div className="mx-auto max-w-4xl">
                  {renderMarkdown(planReview.content || '# Swarm Plan\n\nNo plan content yet.')}
                </div>
              ) : null}
              {planReview.status === 'ready' && planReview.mode === 'source' ? (
                <pre className="min-h-[420px] overflow-x-auto rounded-2xl border border-[#23262d] bg-[#0b0c0e] p-4 text-[13px] leading-6 text-zinc-200">
                  <code>{planReview.content || '# Swarm Plan\n\nNo plan content yet.'}</code>
                </pre>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#23262d] bg-[#101216] px-5 py-4">
              <div className="text-[12px] text-zinc-500">
                {swarmState.planReady
                  ? 'Plan approval starts worker claiming. Confirm this plan and task graph match your intent.'
                  : 'The architect must run `swarm mark-plan-ready --actor architect` before workers can start.'}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {planFilePath ? (
                  <button
                    onClick={() => void openPlanInEditor()}
                    className="rounded-xl border border-[#2a2e36] bg-[#181b20] px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:bg-[#20252e]"
                  >
                    Open in Editor
                  </button>
                ) : null}
                <button
                  onClick={() => void approveFromPlanReview()}
                  disabled={planReview.status !== 'ready' || !swarmState.planReady}
                  className="rounded-xl border border-amber-300/40 bg-amber-200 px-4 py-2 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-100 disabled:opacity-40 disabled:hover:bg-amber-200"
                >
                  {swarmState.planReady ? 'Approve Plan & Start Workers' : 'Waiting for Architect'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

type RosterItem = {
  id: string
  label: string
  role: SwarmRole
}

type RuntimeAgentView = {
  agentId: string
  role: SwarmRole
  status: string
  currentTaskId: string | null
}

function SwarmMapView({
  swarmState,
  roster,
  rosterById,
  runtimeAgents,
  selectedAgentId,
  onSelectAgent,
  onOpenTerminal,
}: {
  workspaceId: string
  swarmState: SwarmState
  roster: RosterItem[]
  rosterById: Record<string, RosterItem | undefined>
  runtimeAgents: RuntimeAgentView[]
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
  onOpenTerminal: (agentId: string) => void
}) {
  const selectedAgent = selectedAgentId ? rosterById[selectedAgentId] : undefined
  const selectedRuntime = selectedAgentId
    ? runtimeAgents.find((agent) => agent.agentId === selectedAgentId)
    : undefined
  const selectedTask = selectedRuntime?.currentTaskId
    ? swarmState.tasks.find((task) => task.id === selectedRuntime.currentTaskId)
    : null
  const positions = buildMapPositions(roster)

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-[#101216] lg:grid-cols-[minmax(0,1fr)_340px]">
      <div
        className="relative min-h-[460px] overflow-hidden"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,255,255,0.06) 0, rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {positions
            .filter((node) => node.agent.role !== 'architect')
            .map((node) => (
              <line
                key={node.agent.id}
                x1="50"
                y1="38"
                x2={node.x}
                y2={node.y}
                stroke={swarmRoleAccent[node.agent.role]}
                strokeWidth="0.18"
                strokeDasharray="1.2 1.8"
                opacity="0.42"
              />
            ))}
        </svg>

        {positions.map((node) => {
          const runtime = runtimeAgents.find((agent) => agent.agentId === node.agent.id)
          const selected = node.agent.id === selectedAgentId
          const task = runtime?.currentTaskId
            ? swarmState.tasks.find((candidate) => candidate.id === runtime.currentTaskId)
            : null

          return (
            <button
              key={node.agent.id}
              onClick={() => onSelectAgent(node.agent.id)}
              className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-center transition-transform hover:scale-[1.03] ${
                selected ? 'z-10 scale-[1.04]' : 'z-0'
              }`}
              style={{ left: `${node.x}%`, top: `${node.y}%` }}
            >
              <span
                className={`relative flex h-20 w-20 items-center justify-center rounded-full border bg-[#15171b] text-lg font-semibold text-zinc-100 ${
                  runtime?.status === 'running' ? 'animate-pulse' : ''
                }`}
                style={{
                  borderColor: swarmRoleAccent[node.agent.role],
                  boxShadow: `0 0 ${selected ? 34 : 18}px ${swarmRoleAccent[node.agent.role]}55`,
                }}
              >
                {node.agent.label.split(/\s+/).map((part) => part[0]).join('').slice(0, 2)}
                <span
                  className="absolute -right-1 top-3 h-3 w-3 rounded-full border border-[#101216]"
                  style={{ backgroundColor: statusColor(runtime?.status ?? 'idle') }}
                />
              </span>
              <span className="max-w-[150px] truncate text-sm font-semibold text-zinc-100">{node.agent.label}</span>
              <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${runtimeTone(runtime?.status ?? 'idle')}`}>
                {runtimeStatusLabel(runtime?.status ?? 'idle')}
              </span>
              {task ? (
                <span className="max-w-[180px] truncate rounded-full border border-[#2a2e36] bg-[#15171b] px-2 py-1 text-[10px] text-zinc-400">
                  {task.id}: {task.title}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <aside className="border-t border-[#23262d] bg-[#121419] p-4 lg:border-l lg:border-t-0">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Selected Specialist</div>
        {selectedAgent ? (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-3">
              <span
                className="flex h-14 w-14 items-center justify-center rounded-full border bg-[#15171b] text-base font-semibold text-zinc-100"
                style={{
                  borderColor: swarmRoleAccent[selectedAgent.role],
                  boxShadow: `0 0 22px ${swarmRoleAccent[selectedAgent.role]}55`,
                }}
              >
                {selectedAgent.label.split(/\s+/).map((part) => part[0]).join('').slice(0, 2)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold text-zinc-100">{selectedAgent.label}</div>
                <div className="mt-1 text-sm text-zinc-400">{swarmRoleLabels[selectedAgent.role]}</div>
              </div>
            </div>

            <InfoCard label="Status" value={runtimeStatusLabel(selectedRuntime?.status ?? 'idle')} />
            <InfoCard label="Current Task" value={selectedTask ? `${selectedTask.id} - ${selectedTask.title}` : 'No active task'} />

            <button
              onClick={() => onOpenTerminal(selectedAgent.id)}
              className="w-full rounded-xl border border-[#3b4250] bg-[#1b1f26] px-4 py-2 text-sm font-semibold text-zinc-100 transition-colors hover:bg-[#20252e]"
            >
              Open Terminal
            </button>

            {selectedAgent.role === 'product' ? (
              <div className="rounded-xl border border-pink-300/20 bg-pink-950/10 px-3 py-3 text-sm leading-6 text-pink-100">
                Product guides market fit, competitor context, audience needs, workflow risk, and prioritization before the plan hardens.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-[#2a2d34] bg-[#15171b] px-3 py-4 text-sm text-zinc-500">
            Select a specialist on the map.
          </div>
        )}
      </aside>
    </div>
  )
}

function SwarmTerminalsView({
  workspaceId,
  roster,
  active,
}: {
  workspaceId: string
  roster: RosterItem[]
  active: boolean
}) {
  return (
    <div className={`min-h-0 flex-1 flex-col bg-[#101216] ${active ? 'flex' : 'hidden'}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#23262d] bg-[#121419] px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-zinc-100">Terminals</div>
          <div className="mt-1 text-xs text-zinc-500">Use Ctrl-C inside a terminal to stop the running command.</div>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-3 xl:grid-cols-2">
        {roster.map((agent) => {
          return (
            <section
              key={agent.id}
              className="flex min-h-[360px] flex-col overflow-hidden rounded-xl border border-[#23262d] bg-[#15171b]"
            >
              <div className="flex h-10 items-center justify-between gap-3 border-b border-[#23262d] bg-[#17191d] px-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: swarmRoleAccent[agent.role], boxShadow: `0 0 12px ${swarmRoleAccent[agent.role]}` }}
                  />
                  <span className="truncate text-sm font-semibold text-zinc-100">{agent.label}</span>
                </div>
                <span className="rounded-md border border-[#2a2e36] bg-[#111318] px-2 py-1 text-xs font-semibold text-zinc-400">
                  Ctrl-C to stop
                </span>
              </div>
              <div className="relative min-h-0 flex-1 bg-[#0b0c0e]">
                <TerminalView workspaceId={workspaceId} agentId={agent.id} />
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function buildMapPositions(roster: RosterItem[]): Array<{ agent: RosterItem; x: number; y: number }> {
  const architect = roster.find((agent) => agent.role === 'architect')
  const others = roster.filter((agent) => agent.role !== 'architect')
  const ordered = [
    ...others.filter((agent) => agent.role === 'product'),
    ...others.filter((agent) => agent.role === 'frontend'),
    ...others.filter((agent) => agent.role === 'developer'),
    ...others.filter((agent) => agent.role === 'tester'),
    ...others.filter((agent) => agent.role === 'security'),
  ]
  const positions: Array<{ agent: RosterItem; x: number; y: number }> = []

  if (architect) {
    positions.push({ agent: architect, x: 50, y: 38 })
  }

  ordered.forEach((agent, index) => {
    const angle = (-105 + (210 / Math.max(1, ordered.length - 1)) * index) * (Math.PI / 180)
    const radiusX = 34
    const radiusY = 30
    positions.push({
      agent,
      x: 50 + Math.cos(angle) * radiusX,
      y: 52 + Math.sin(angle) * radiusY,
    })
  })

  return positions
}

function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return '#38bdf8'
    case 'needs_input':
      return '#fb7185'
    case 'planning':
      return '#fbbf24'
    case 'complete':
      return '#34d399'
    case 'error':
      return '#ef4444'
    default:
      return '#71717a'
  }
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: string
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-right ${tone}`}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className="mt-1 text-[18px] font-semibold capitalize">{value}</div>
    </div>
  )
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#23262d] bg-[#171a20] px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className="mt-2 font-medium text-zinc-100">{value}</div>
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
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">{title}</div>
      {items.length > 0 ? (
        <ul className="space-y-2 text-zinc-300">
          {items.map((item) => (
            <li key={item} className="rounded-lg border border-[#23262d] bg-[#171a20] px-3 py-2">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-[#2a2d34] bg-[#15171b] px-3 py-3 text-[12px] text-zinc-600">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

function formatTimestamp(value: number | null): string {
  if (!value) return 'Not started'
  return new Date(value).toLocaleString()
}

function formatTimestampShort(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function taskCardTone(task: SwarmTask): string {
  switch (task.status) {
    case 'done':
      return 'border-emerald-400/30 bg-emerald-950/15 shadow-[0_0_22px_rgba(16,185,129,0.06)] hover:border-emerald-300/50 hover:bg-emerald-950/25'
    case 'needs_input':
      return 'border-amber-400/40 bg-amber-950/15 shadow-[0_0_22px_rgba(245,158,11,0.08)] hover:border-amber-300/60 hover:bg-amber-950/25'
    case 'in_progress':
      return 'border-sky-400/25 bg-sky-950/10 hover:border-sky-300/40 hover:bg-sky-950/20'
    default:
      return 'border-[#2a2e36] bg-[#181b20] hover:border-[#3a4150] hover:bg-[#1b1f26]'
  }
}

function runtimeTone(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-sky-950/60 text-sky-200'
    case 'needs_input':
      return 'bg-rose-950/60 text-rose-200'
    case 'planning':
      return 'bg-amber-950/60 text-amber-200'
    case 'complete':
      return 'bg-emerald-950/60 text-emerald-200'
    case 'error':
      return 'bg-rose-950/80 text-rose-100'
    default:
      return 'bg-zinc-800 text-zinc-300'
  }
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
    case 'error':
      return 'Error'
    default:
      return 'Idle'
  }
}

function getTaskOwnerLabel(
  task: SwarmTask,
  rosterById: Record<string, { label: string } | undefined>
): string {
  if (task.ownerAgentId) {
    return rosterById[task.ownerAgentId]?.label ?? task.ownerAgentId
  }

  return task.status === 'done' ? swarmRoleLabels[task.role] : 'Unclaimed'
}

function getPlanReadiness(swarmState: SwarmState): {
  label: string
  message: string
  detail: string
  panelTone: string
} {
  if (swarmState.planApproved) {
    return {
      label: 'Plan Approved',
      message: 'Worker execution is unlocked.',
      detail: 'Specialists can claim ready tasks from the approved board.',
      panelTone: 'border-emerald-400/30 bg-emerald-950/20 text-emerald-100',
    }
  }

  if (swarmState.planReady) {
    const warningCount = swarmState.taskValidation?.warnings.length ?? 0
    return {
      label: 'Ready For Approval',
      message: 'The architect marked the plan and task graph ready for review.',
      detail: warningCount > 0
        ? `${warningCount} validation warning${warningCount === 1 ? '' : 's'} remain. Review before approving.`
        : 'Review the plan, then approve to unlock worker claiming.',
      panelTone: 'border-emerald-400/30 bg-emerald-950/20 text-emerald-100',
    }
  }

  if (swarmState.taskValidation && !swarmState.taskValidation.ok) {
    return {
      label: 'Validation Failed',
      message: 'The task graph has errors that must be fixed before approval.',
      detail: 'The architect should fix swarm/tasks.json, validate again, replace tasks, and mark the plan ready.',
      panelTone: 'border-rose-400/30 bg-rose-950/20 text-rose-100',
    }
  }

  if (swarmState.taskGraphReplacedAt) {
    return {
      label: 'Awaiting Ready Signal',
      message: 'The task graph was replaced, but the architect has not marked the plan ready yet.',
      detail: 'The architect should run `swarm mark-plan-ready --actor architect` after final checks.',
      panelTone: 'border-amber-400/30 bg-amber-950/20 text-amber-100',
    }
  }

  return {
    label: 'Waiting For Architect',
    message: 'Architect planning is still gated.',
    detail: 'The architect must create swarm/plan.md, validate/replace tasks, and mark the plan ready before approval.',
    panelTone: 'border-amber-400/30 bg-amber-950/20 text-amber-100',
  }
}

function getPlanMetricValue(swarmState: SwarmState): string {
  if (swarmState.planApproved) return 'Approved'
  if (swarmState.planReady) return 'Ready'
  if (swarmState.taskGraphReplacedAt) return 'Tasked'
  return 'Planning'
}

function getPlanMetricTone(swarmState: SwarmState): string {
  if (swarmState.planApproved || swarmState.planReady) {
    return 'border-[#365149] bg-[#151d1a] text-emerald-200'
  }
  if (swarmState.taskValidation && !swarmState.taskValidation.ok) {
    return 'border-rose-400/30 bg-rose-950/20 text-rose-100'
  }
  return 'border-[#5f4b2d] bg-[#1d1813] text-amber-200'
}

function formatSwarmGoal(goal: string): string {
  const trimmed = goal.trim()
  if (!trimmed || trimmed.toLowerCase() === 'launch swarm mode') {
    return 'Untitled swarm run'
  }

  return trimmed
}

function buildRunSummary(tasks: SwarmTask[]) {
  const completed = tasks.filter((task) => task.status === 'done')
  const touchedFiles = uniqueStrings(completed.flatMap((task) => task.evidence.touchedFiles))
  const commandsRan = uniqueStrings(completed.flatMap((task) => task.evidence.commandsRan))
  const results = completed.flatMap((task) =>
    task.evidence.results.map((result) => `${task.id}: ${result}`)
  )
  const taskSummaries = completed.map((task) => {
    const summary = task.evidence.summary.trim() || 'No completion summary recorded.'
    return `${task.id} - ${task.title}: ${summary}`
  })
  const openQuestions = tasks.flatMap((task) =>
    task.questionsForUser.map((question) => `${task.id}: ${question}`)
  )

  return {
    totalTasks: tasks.length,
    completedTasks: completed.length,
    touchedFiles,
    commandsRan,
    results,
    taskSummaries,
    openQuestions,
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}
