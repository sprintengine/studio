import type { WebContents } from 'electron'
import type {
  AgentCli,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type {
  SwitchboardClaimTaskInput,
  SwitchboardClaimTaskResult,
  SwitchboardRunnerQueue,
  SwitchboardRunnerResult,
  SwitchboardRunnerStartInput,
  SwitchboardRunnerState,
  SwitchboardRunnerTaskSession,
} from '../shared/switchboard'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'

type SwitchboardRunnerDependencies = {
  claimTask(input: SwitchboardClaimTaskInput): Promise<SwitchboardClaimTaskResult>
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  listTerminals(): TerminalSessionSnapshot[]
}

type RunnerConfig = {
  workspaceRoot: string
  workspaceId?: string
  queues: SwitchboardRunnerQueue[]
  maxConcurrency: number
  cli: AgentCli
}

type RunnerState = {
  config: RunnerConfig | null
  running: boolean
  paused: boolean
  activeSessions: SwitchboardRunnerTaskSession[]
  lastError: string | null
  updatedAt: string | null
}

const defaultQueues: SwitchboardRunnerQueue[] = ['ready', 'testing', 'review']
const queueRoles: Record<SwitchboardRunnerQueue, string> = {
  ready: 'developer',
  testing: 'tester',
  review: 'reviewer',
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeQueues(input: SwitchboardRunnerStartInput['queues']): SwitchboardRunnerQueue[] {
  const queues = input?.length ? input : defaultQueues
  return [...new Set(queues.filter((queue): queue is SwitchboardRunnerQueue => defaultQueues.includes(queue as SwitchboardRunnerQueue)))]
}

function normalizeMaxConcurrency(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return 1
  return Math.max(1, Math.min(8, Math.floor(input)))
}

function sessionIdFor(taskId: string): string {
  return `switchboard_${taskId.replace(/-/g, '')}_${Date.now()}`
}

function buildAgentPrompt(taskId: string, queue: SwitchboardRunnerQueue, workspaceRoot: string): string {
  const role = queueRoles[queue]
  const nextPublish = queue === 'ready' ? 'testing' : queue === 'testing' ? 'review' : 'done'
  return [
    `You are the Switchboard ${role} agent for task ${taskId}.`,
    '',
    `Workspace: ${workspaceRoot}`,
    `Claimed queue: ${queue}`,
    '',
    'Rules:',
    '- Do not edit Switchboard task JSON files or Lock files directly.',
    '- Use the local Switchboard CLI for task activity.',
    `- Inspect the task with: scripts/switchboard show --workspace . ${taskId}`,
    `- Add progress notes with: scripts/switchboard comment --workspace . ${taskId} --body "..." --author "${role}"`,
    `- Publish only when the required evidence is complete: scripts/switchboard publish --workspace . ${taskId} --to ${nextPublish}`,
    '- If blocked or unable to proceed, add a comment and stop without moving the task.',
  ].join('\n')
}

export function createSwitchboardRunner(deps: SwitchboardRunnerDependencies) {
  const state: RunnerState = {
    config: null,
    running: false,
    paused: true,
    activeSessions: [],
    lastError: null,
    updatedAt: null,
  }
  let tickInProgress = false
  let runnerSender: WebContents | null = null
  let tickTimer: NodeJS.Timeout | null = null

  function stopTimer(): void {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
  }

  function startTimer(): void {
    if (tickTimer || !runnerSender) return
    tickTimer = setInterval(() => {
      if (runnerSender && (typeof runnerSender.isDestroyed !== 'function' || !runnerSender.isDestroyed())) {
        void tick(runnerSender)
      }
    }, 5000)
    tickTimer.unref()
  }

  function publicState(workspaceRoot?: string): SwitchboardRunnerState {
    const activeTerminalIds = new Set(deps.listTerminals().filter((session) => session.running).map((session) => session.sessionId))
    state.activeSessions = state.activeSessions.filter((session) => activeTerminalIds.has(session.sessionId))
    if (state.activeSessions.length === 0 && state.running && state.paused) {
      state.running = false
    }
    return {
      ok: true,
      workspaceRoot: state.config?.workspaceRoot ?? workspaceRoot ?? null,
      running: state.running,
      paused: state.paused,
      maxConcurrency: state.config?.maxConcurrency ?? 1,
      queues: state.config?.queues ?? defaultQueues,
      activeSessions: state.activeSessions,
      lastError: state.lastError,
      updatedAt: state.updatedAt,
    }
  }

  async function claimAndLaunch(sender: WebContents, config: RunnerConfig): Promise<boolean> {
    for (const queue of config.queues) {
      const agentId = `switchboard-${queueRoles[queue]}`
      const claimed = await deps.claimTask({
        workspaceRoot: config.workspaceRoot,
        from: queue,
        owner: agentId,
      })
      if (!claimed.ok) {
        if (!/No eligible task/i.test(claimed.message)) state.lastError = claimed.message
        continue
      }

      const taskId = claimed.record.task.id
      const sessionId = sessionIdFor(taskId)
      const prompt = buildAgentPrompt(taskId, queue, config.workspaceRoot)
      const spawned = await deps.spawnTerminal(sender, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: config.workspaceRoot,
        cli: config.cli,
        initialPrompt: prompt,
        kind: 'agent',
        workspaceId: config.workspaceId,
        agentId,
        terminalId: sessionId,
        executionMode: 'current_workspace',
        cliPermissionPreset: 'auto_workspace',
      })

      if (!spawned.ok) {
        state.lastError = spawned.message
        return false
      }

      state.activeSessions.push({
        taskId,
        queue,
        sessionId,
        agentId,
        startedAt: nowIso(),
      })
      state.updatedAt = nowIso()
      return true
    }
    return false
  }

  async function tick(sender: WebContents): Promise<void> {
    if (tickInProgress || !state.config || state.paused) return
    tickInProgress = true
    try {
      publicState()
      while (state.activeSessions.length < state.config.maxConcurrency && !state.paused) {
        const launched = await claimAndLaunch(sender, state.config)
        if (!launched) break
      }
      state.updatedAt = nowIso()
    } finally {
      tickInProgress = false
    }
  }

  return {
    async start(sender: WebContents, input: SwitchboardRunnerStartInput): Promise<SwitchboardRunnerResult> {
      const workspaceRoot = input.workspaceRoot?.trim()
      if (!workspaceRoot) return { ok: false, message: 'workspaceRoot is required.' }
      const queues = normalizeQueues(input.queues)
      if (queues.length === 0) return { ok: false, message: 'At least one Switchboard runner queue is required.' }
      state.config = {
        workspaceRoot,
        workspaceId: input.workspaceId,
        queues,
        maxConcurrency: normalizeMaxConcurrency(input.maxConcurrency),
        cli: input.cli ?? 'codex',
      }
      state.running = true
      state.paused = false
      runnerSender = sender
      state.lastError = null
      state.updatedAt = nowIso()
      await tick(sender)
      startTimer()
      return publicState(workspaceRoot)
    },

    async pause(workspaceRoot: string): Promise<SwitchboardRunnerResult> {
      if (state.config && workspaceRoot && state.config.workspaceRoot !== workspaceRoot) {
        return { ok: false, message: 'Switchboard runner is active for a different workspace.' }
      }
      state.paused = true
      state.running = state.activeSessions.length > 0
      stopTimer()
      state.updatedAt = nowIso()
      return publicState(workspaceRoot)
    },

    async getState(workspaceRoot?: string): Promise<SwitchboardRunnerResult> {
      return publicState(workspaceRoot)
    },
  }
}
