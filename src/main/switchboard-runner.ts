import type { WebContents } from 'electron'
import path from 'node:path'
import type { AgentCli } from '../shared/electron-api'
import type {
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardExecutionProviderKind,
  SwitchboardReadResult,
  SwitchboardRunnerExecution,
  SwitchboardRunnerQueue,
  SwitchboardRunnerResult,
  SwitchboardRunnerStartInput,
  SwitchboardRunnerState,
  SwitchboardTaskRecord,
  SwitchboardUpdateTaskInput,
  SwitchboardMutationResult,
  SwitchboardRequeueTaskInput,
} from '../shared/switchboard'
import type { SwitchboardExecutionProvider } from './switchboard-execution-provider'
import {
  DEFAULT_SWITCHBOARD_RUNNER_PROVIDER,
  appendRunnerEvent,
  createDefaultRunnerState,
  normalizeRunnerMaxConcurrency,
  normalizeRunnerQueues,
  nowIso,
  readRunnerState,
  writeRunnerState,
  type SwitchboardRunnerFileState,
} from './switchboard-runner-state'

type SwitchboardRunnerDependencies = {
  claimTask(input: SwitchboardClaimTaskInput): Promise<SwitchboardClaimTaskResult>
  updateTask(input: SwitchboardUpdateTaskInput): Promise<SwitchboardMutationResult>
  requeueTask(input: SwitchboardRequeueTaskInput): Promise<SwitchboardMutationResult>
  readAll(input: { workspaceRoot: string }): Promise<SwitchboardReadResult>
  providers: Record<SwitchboardExecutionProviderKind, SwitchboardExecutionProvider>
}

type RunnerConfig = {
  workspaceRoot: string
  workspaceId?: string
  queues: SwitchboardRunnerQueue[]
  maxConcurrency: number
  cli: AgentCli
  provider: SwitchboardExecutionProviderKind
}

const queueRoles: Record<SwitchboardRunnerQueue, string> = {
  ready: 'developer',
  testing: 'tester',
  review: 'reviewer',
}

const queueClaimedStatus: Record<SwitchboardRunnerQueue, SwitchboardRunnerExecution['claimedStatus']> = {
  ready: 'in_progress',
  testing: 'testing_in_progress',
  review: 'review_in_progress',
}
const STALE_EXECUTION_SECONDS = 5 * 60

function executionId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function nextPublish(queue: SwitchboardRunnerQueue): 'testing' | 'review' | 'done' {
  return queue === 'ready' ? 'testing' : queue === 'testing' ? 'review' : 'done'
}

function buildAgentPrompt(taskId: string, queue: SwitchboardRunnerQueue, workspaceRoot: string, execution: string): string {
  const role = queueRoles[queue]
  return [
    `You are the Switchboard ${role} agent for task ${taskId}.`,
    '',
    `Workspace: ${workspaceRoot}`,
    `Execution ID: ${execution}`,
    `Claimed queue: ${queue}`,
    '',
    'Rules:',
    '- Do not edit Switchboard task JSON files or Lock files directly.',
    '- Use the local Switchboard CLI for task activity.',
    `- Inspect the task with: scripts/switchboard show --workspace . ${taskId}`,
    `- Add progress notes with: scripts/switchboard comment --workspace . ${taskId} --body "..." --author "${role}"`,
    `- Publish only when required evidence is complete: scripts/switchboard publish --workspace . ${taskId} --to ${nextPublish(queue)}`,
    '- If blocked or unable to proceed, add a comment and stop without moving the task.',
  ].join('\n')
}

function activeSessionsFromExecutions(executions: SwitchboardRunnerExecution[]) {
  return executions
    .filter((execution) =>
      execution.status === 'active' &&
      execution.provider === 'desktop-terminal' &&
      typeof execution.providerRef.sessionId === 'string'
    )
    .map((execution) => ({
      taskId: execution.taskId,
      queue: execution.claimedFrom,
      sessionId: String(execution.providerRef.sessionId),
      agentId: `switchboard-${execution.role}`,
      startedAt: execution.startedAt,
    }))
}

function publicState(state: SwitchboardRunnerFileState): SwitchboardRunnerState {
  return {
    ok: true,
    workspaceRoot: state.workspaceRoot,
    enabled: state.enabled,
    running: state.enabled && !state.paused,
    paused: state.paused,
    provider: state.provider,
    cli: state.cli,
    maxConcurrency: state.maxConcurrency,
    queues: state.queues,
    activeExecutions: state.activeExecutions,
    activeSessions: activeSessionsFromExecutions(state.activeExecutions),
    lastError: state.lastError,
    updatedAt: state.updatedAt,
  }
}

function taskRecordsById(result: SwitchboardReadResult): Map<string, SwitchboardTaskRecord> {
  if (!result.ok) return new Map()
  return new Map(result.tasks.map((record) => [record.task.id, record]))
}

function isClaimedTaskStillOwned(record: SwitchboardTaskRecord | undefined, execution: SwitchboardRunnerExecution): boolean {
  return Boolean(record && record.location.folderStatus === execution.claimedStatus && record.task.claim?.owner === `switchboard-${execution.role}`)
}

function executionIsStale(execution: SwitchboardRunnerExecution): boolean {
  const parsed = Date.parse(execution.lastSeenAt)
  return Number.isFinite(parsed) && Date.now() - parsed > STALE_EXECUTION_SECONDS * 1000
}

async function persistTaskExecutionLink(
  deps: SwitchboardRunnerDependencies,
  config: RunnerConfig,
  record: SwitchboardTaskRecord,
  execution: SwitchboardRunnerExecution
): Promise<void> {
  const currentExecution = record.task.execution ?? { attempts: [], worktreePath: null, activeSessionId: null }
  const updated = await deps.updateTask({
    workspaceRoot: config.workspaceRoot,
    id: record.task.id,
    updates: {
      execution: {
        ...currentExecution,
        attempts: [
          ...(Array.isArray(currentExecution.attempts) ? currentExecution.attempts : []),
          {
            id: execution.executionId,
            agentId: `switchboard-${execution.role}`,
            startedAt: execution.startedAt,
            summary: `Started by Switchboard runner via ${execution.provider}.`,
          },
        ],
        activeExecutionId: execution.executionId,
        activeProvider: execution.provider,
        activeSessionId: typeof execution.providerRef.sessionId === 'string' ? execution.providerRef.sessionId : currentExecution.activeSessionId,
        providerRef: execution.providerRef,
      },
    },
  })
  if (!updated.ok) throw new Error(updated.message)
}

async function requeueClaimedTask(
  deps: SwitchboardRunnerDependencies,
  workspaceRoot: string,
  taskId: string,
  reason: string
): Promise<void> {
  const requeued = await deps.requeueTask({ workspaceRoot, id: taskId, reason })
  if (!requeued.ok) throw new Error(`Requeue failed after runner error: ${requeued.message}`)
}

export function createSwitchboardRunner(deps: SwitchboardRunnerDependencies) {
  let tickInProgress = false
  let runnerSender: WebContents | null = null
  let tickTimer: NodeJS.Timeout | null = null

  function stopTimer(): void {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
  }

  function startTimer(workspaceRoot: string): void {
    if (tickTimer) return
    tickTimer = setInterval(() => {
      void tick(workspaceRoot)
    }, 5000)
    tickTimer.unref()
  }

  async function saveAndEmit(state: SwitchboardRunnerFileState, type: string, data?: Record<string, unknown>): Promise<void> {
    state.updatedAt = nowIso()
    await writeRunnerState(state)
    await appendRunnerEvent({ type, workspaceRoot: state.workspaceRoot, at: state.updatedAt, data })
  }

  async function reconcile(state: SwitchboardRunnerFileState): Promise<SwitchboardRunnerFileState> {
    const provider = deps.providers[state.provider]
    const providerExecutions = await provider.list({ workspaceRoot: state.workspaceRoot })
    const providerExecutionIds = new Set(providerExecutions.map((execution) => execution.executionId))
    const knownExecutionIds = new Set(state.activeExecutions.map((execution) => execution.executionId))
    for (const providerExecution of providerExecutions) {
      if (!knownExecutionIds.has(providerExecution.executionId)) {
        await appendRunnerEvent({
          type: 'provider_execution_untracked',
          workspaceRoot: state.workspaceRoot,
          at: nowIso(),
          executionId: providerExecution.executionId,
          data: { provider: providerExecution.provider, providerRef: providerExecution.providerRef },
        })
      }
    }
    const tasks = taskRecordsById(await deps.readAll({ workspaceRoot: state.workspaceRoot }))
    const reconciled: SwitchboardRunnerExecution[] = []
    for (const execution of state.activeExecutions) {
      const task = tasks.get(execution.taskId)
      if (task && task.location.folderStatus !== execution.claimedStatus) {
        await appendRunnerEvent({
          type: 'task_published',
          workspaceRoot: state.workspaceRoot,
          at: nowIso(),
          executionId: execution.executionId,
          taskId: execution.taskId,
          data: { folderStatus: task.location.folderStatus },
        })
        continue
      }
      const listedAsActive = providerExecutionIds.has(execution.executionId)
      const status = listedAsActive
        ? providerExecutions.find((providerExecution) => providerExecution.executionId === execution.executionId)?.status ?? 'active'
        : await provider.getStatus({ executionId: execution.executionId, providerRef: execution.providerRef })
      if (status === 'active' && isClaimedTaskStillOwned(task, execution)) {
        reconciled.push({ ...execution, status: 'active', lastSeenAt: nowIso() })
        continue
      }
      const nextStatus = task && task.location.folderStatus === execution.claimedStatus
        ? executionIsStale(execution) ? 'abandoned' : 'stale'
        : status
      reconciled.push({ ...execution, status: nextStatus, lastSeenAt: execution.lastSeenAt })
      await appendRunnerEvent({
        type: nextStatus === 'abandoned' ? 'task_abandoned' : nextStatus === 'stale' ? 'execution_stale' : 'execution_missing',
        workspaceRoot: state.workspaceRoot,
        at: nowIso(),
        executionId: execution.executionId,
        taskId: execution.taskId,
        data: { status: nextStatus },
      })
    }
    return { ...state, activeExecutions: reconciled }
  }

  async function claimAndLaunch(config: RunnerConfig, state: SwitchboardRunnerFileState): Promise<boolean> {
    const provider = deps.providers[config.provider]
    const capability = await provider.canStart({
      executionId: 'capability-check',
      workspaceRoot: config.workspaceRoot,
      workspaceId: config.workspaceId,
      taskId: 'capability-check',
      role: 'developer',
      provider: config.provider,
      prompt: '',
      cli: config.cli,
    })
    if (!capability.ok) {
      state.lastError = capability.message
      await saveAndEmit(state, 'provider_error', { message: capability.message, provider: config.provider })
      return false
    }

    for (const queue of config.queues) {
      const role = queueRoles[queue]
      const claimed = await deps.claimTask({
        workspaceRoot: config.workspaceRoot,
        from: queue,
        owner: `switchboard-${role}`,
      })
      if (!claimed.ok) {
        if (!/No eligible task/i.test(claimed.message)) state.lastError = claimed.message
        continue
      }

      const id = executionId()
      const taskId = claimed.record.task.id
      const startedAt = nowIso()
      let handle: Awaited<ReturnType<SwitchboardExecutionProvider['start']>>
      try {
        handle = await provider.start({
          executionId: id,
          workspaceRoot: config.workspaceRoot,
          workspaceId: config.workspaceId,
          taskId,
          role,
          provider: config.provider,
          prompt: buildAgentPrompt(taskId, queue, config.workspaceRoot, id),
          cli: config.cli,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.lastError = message
        try {
          await requeueClaimedTask(deps, config.workspaceRoot, taskId, `Switchboard runner could not launch ${config.provider}: ${message}`)
        } catch (requeueError) {
          state.lastError = `${message}; ${requeueError instanceof Error ? requeueError.message : String(requeueError)}`
        }
        await saveAndEmit(state, 'provider_error', { executionId: id, taskId, provider: config.provider, message })
        return false
      }
      const execution: SwitchboardRunnerExecution = {
        executionId: id,
        taskId,
        role,
        claimedFrom: queue,
        claimedStatus: queueClaimedStatus[queue],
        provider: handle.provider,
        providerRef: handle.providerRef,
        startedAt,
        lastSeenAt: startedAt,
        status: 'active',
      }
      try {
        await persistTaskExecutionLink(deps, config, claimed.record, execution)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.lastError = message
        try {
          await provider.stop?.({ executionId: id })
        } catch (stopError) {
          state.lastError = `${message}; provider stop failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`
        }
        try {
          await requeueClaimedTask(deps, config.workspaceRoot, taskId, `Switchboard runner could not persist execution metadata: ${message}`)
        } catch (requeueError) {
          state.lastError = `${message}; ${requeueError instanceof Error ? requeueError.message : String(requeueError)}`
        }
        await saveAndEmit(state, 'execution_link_failed', { executionId: id, taskId, provider: config.provider, message })
        return false
      }
      state.activeExecutions.push(execution)
      state.lastError = null
      await saveAndEmit(state, 'launch', { executionId: id, taskId, provider: config.provider })
      return true
    }
    return false
  }

  async function tick(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
    if (tickInProgress) return publicState(await readRunnerState(workspaceRoot))
    tickInProgress = true
    try {
      let state = await reconcile(await readRunnerState(workspaceRoot))
      if (!state.enabled || state.paused) {
        await writeRunnerState(state)
        return publicState(state)
      }
      const config: RunnerConfig = {
        workspaceRoot: state.workspaceRoot,
        queues: state.queues,
        maxConcurrency: state.maxConcurrency,
        cli: state.cli,
        provider: state.provider,
      }
      while (state.activeExecutions.filter((execution) => execution.status === 'active').length < state.maxConcurrency) {
        const launched = await claimAndLaunch(config, state)
        if (!launched) break
        state = await readRunnerState(workspaceRoot)
      }
      state.updatedAt = nowIso()
      await writeRunnerState(state)
      await appendRunnerEvent({ type: 'tick', workspaceRoot: state.workspaceRoot, at: state.updatedAt })
      return publicState(state)
    } finally {
      tickInProgress = false
    }
  }

  return {
    async start(sender: WebContents, input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult> {
      const workspaceRoot = input.workspaceRoot?.trim()
      if (!workspaceRoot) return { ok: false, message: 'workspaceRoot is required.' }
      runnerSender = sender
      const state = {
        ...createDefaultRunnerState(workspaceRoot),
        enabled: true,
        paused: false,
        workspaceRoot: path.resolve(workspaceRoot),
        provider: input.provider ?? DEFAULT_SWITCHBOARD_RUNNER_PROVIDER,
        cli: input.cli ?? 'codex',
        queues: normalizeRunnerQueues(input.queues),
        maxConcurrency: normalizeRunnerMaxConcurrency(input.maxConcurrency),
        activeExecutions: (await readRunnerState(workspaceRoot)).activeExecutions,
        lastError: null,
        updatedAt: nowIso(),
      }
      await saveAndEmit(state, 'start', { provider: state.provider, cli: state.cli, maxConcurrency: state.maxConcurrency, queues: state.queues })
      const result = await tick(workspaceRoot)
      startTimer(workspaceRoot)
      return result
    },

    async pause(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
      const state = await readRunnerState(workspaceRoot)
      state.enabled = true
      state.paused = true
      stopTimer()
      await saveAndEmit(state, 'pause')
      return publicState(state)
    },

    async resume(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
      const state = await readRunnerState(workspaceRoot)
      state.enabled = true
      state.paused = false
      await saveAndEmit(state, 'resume')
      const result = await tick(workspaceRoot)
      startTimer(workspaceRoot)
      return result
    },

    async tick(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
      return tick(workspaceRoot)
    },

    async getState(workspaceRoot?: string): Promise<SwitchboardRunnerResult> {
      if (!workspaceRoot) return { ok: false, message: 'workspaceRoot is required.' }
      const state = await reconcile(await readRunnerState(workspaceRoot))
      await writeRunnerState(state)
      return publicState(state)
    },

    setSender(sender: WebContents | null): void {
      runnerSender = sender
    },

    getSender(): WebContents | null {
      return runnerSender
    },
  }
}
