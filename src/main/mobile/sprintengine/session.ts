import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { win32 } from 'path'
import {
  MobileSprintEngineCommandError,
  type MobileSprintEngineFollowUpRequest,
  type MobileSprintEngineFollowUpResult,
  type MobileSprintEngineSessionOrchestrator,
  type MobileSprintEngineTaskStartRequest,
  type MobileSprintEngineTaskStartResult,
} from './command'

type AgentCli = 'codex' | 'claude'

type TerminalSessionSnapshot = {
  sessionId: string
  running: boolean
  kind: 'agent' | 'terminal'
  agentId?: string
  cli?: AgentCli
  sprintEngineStatePath?: string
  executionMode?: 'current_workspace' | 'worktree'
  worktreeId?: string
  worktreePath?: string
}

type SpawnMobileAgentTerminalInput = {
  sessionId: string
  cwd: string
  sprintEngineStatePath: string
  agentId: string
  initialPrompt: string
  cli: AgentCli
  executionMode: 'current_workspace' | 'worktree'
}

type SpawnMobileAgentTerminalResult =
  | { ok: true; sessionId: string }
  | { ok: false; message: string }

export type DesktopMobileSprintEngineSessionAdapters = {
  listTerminals(): Promise<TerminalSessionSnapshot[]>
  spawnAgentTerminal(input: SpawnMobileAgentTerminalInput): Promise<SpawnMobileAgentTerminalResult>
  writeTerminal(sessionId: string, data: string): Promise<void> | void
}

type DesktopMobileSprintEngineSessionOptions = {
  adapters: DesktopMobileSprintEngineSessionAdapters
  maxRunningAgentTerminals?: number
  now?: () => Date
}

type RuntimeAgent = {
  role: string
  status: string
  currentTaskId: string | null
}

type RawSprintEngineState = {
  sprintengine?: {
    goal?: unknown
  }
  tasks?: Array<{
    id?: unknown
    role?: unknown
    status?: unknown
    ownerAgentId?: unknown
  }>
  sprintEngineAgents?: Record<string, RuntimeAgent>
}

const sprintEngineRoleLabels: Record<string, string> = {
  architect: 'Architect',
  product: 'Product Strategist',
  developer: 'Developer',
  frontend: 'Frontend Engineer',
  tester: 'Tester',
  security: 'Security Specialist',
  code_reviewer: 'Code Reviewer',
  spec_reviewer: 'Spec Reviewer',
  performance: 'Performance Engineer',
}

export class DesktopMobileSprintEngineSessionOrchestrator implements MobileSprintEngineSessionOrchestrator {
  private readonly maxRunningAgentTerminals: number
  private readonly now: () => Date

  constructor(private readonly options: DesktopMobileSprintEngineSessionOptions) {
    this.maxRunningAgentTerminals = Math.max(1, options.maxRunningAgentTerminals ?? 8)
    this.now = options.now ?? (() => new Date())
  }

  async startTask(request: MobileSprintEngineTaskStartRequest): Promise<MobileSprintEngineTaskStartResult> {
    const sessions = await this.options.adapters.listTerminals()
    const sprintEngineSessions = sessions.filter((session) =>
      session.running
      && session.kind === 'agent'
      && session.sprintEngineStatePath === request.statePath
    )

    if (sprintEngineSessions.length >= this.maxRunningAgentTerminals) {
      throw new MobileSprintEngineCommandError('task_not_ready', 'Desktop has reached the running Sprint Engine terminal limit.', true)
    }

    const state = await readRawSprintEngineState(request.statePath)
    const agentId = chooseAgentId(state, request.role, sprintEngineSessions)
    if (sprintEngineSessions.some((session) => session.agentId === agentId)) {
      throw new MobileSprintEngineCommandError('task_not_ready', 'The selected Sprint Engine agent already has a running terminal.', false)
    }

    const executionCwd = request.workspaceRoot
    const executionMode: MobileSprintEngineTaskStartResult['executionMode'] = 'current_workspace'

    const sessionId = randomUUID()
    const spawn = await this.options.adapters.spawnAgentTerminal({
      sessionId,
      cwd: executionCwd,
      sprintEngineStatePath: request.statePath,
      agentId,
      cli: 'codex',
      initialPrompt: buildStartupPrompt({
        role: request.role,
        agentId,
        label: sprintEngineRoleLabels[request.role] ?? request.role,
        goal: typeof state.sprintengine?.goal === 'string' ? state.sprintengine.goal : '',
        workspaceRoot: request.workspaceRoot,
        executionCwd,
        statePath: request.statePath,
      }),
      executionMode,
    })

    if (!spawn.ok) {
      throw new MobileSprintEngineCommandError('desktop_unavailable', spawn.message, true)
    }

    return {
      sessionId: spawn.sessionId,
      agentId,
      executionMode,
    }
  }

  async sendFollowUp(request: MobileSprintEngineFollowUpRequest): Promise<MobileSprintEngineFollowUpResult> {
    const text = normalizeFollowUpTextForTerminal(request.text)
    const sessions = await this.options.adapters.listTerminals()
    const session = sessions.find((candidate) =>
      candidate.running
      && candidate.kind === 'agent'
      && candidate.sprintEngineStatePath === request.statePath
      && candidate.agentId === request.agentId
    )

    if (!session) {
      throw new MobileSprintEngineCommandError('task_not_ready', 'Follow-up target agent does not have a running desktop terminal.', true)
    }

    const message = [
      '',
      `Mobile follow-up from ${request.deviceId}:`,
      text,
      '',
    ].join('\n')
    await this.options.adapters.writeTerminal(session.sessionId, `${message}\r`)

    return {
      sessionId: session.sessionId,
      agentId: request.agentId,
      acceptedAt: this.now().toISOString(),
    }
  }
}

function normalizeFollowUpTextForTerminal(value: string): string {
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new MobileSprintEngineCommandError('invalid_payload', 'Follow-up text must be a single message without terminal control characters.', false)
  }

  const text = value.trim()
  if (!text) {
    throw new MobileSprintEngineCommandError('invalid_payload', 'Follow-up text is required.', false)
  }

  return text
}

async function readRawSprintEngineState(statePath: string): Promise<RawSprintEngineState> {
  return JSON.parse(await readFile(statePath, 'utf8')) as RawSprintEngineState
}

function chooseAgentId(
  state: RawSprintEngineState,
  role: string,
  runningSessions: TerminalSessionSnapshot[]
): string {
  const runningAgentIds = new Set(runningSessions.flatMap((session) => session.agentId ? [session.agentId] : []))
  const agents = state.sprintEngineAgents && typeof state.sprintEngineAgents === 'object' ? state.sprintEngineAgents : {}
  const idleAgent = Object.entries(agents)
    .sort(([first], [second]) => agentIdSortValue(first, role) - agentIdSortValue(second, role))
    .find(([agentId, agent]) =>
      agent.role === role
      && agent.status !== 'done'
      && !runningAgentIds.has(agentId)
    )
  if (idleAgent) return idleAgent[0]

  return nextAgentId(role, Object.keys(agents))
}

function nextAgentId(role: string, usedIds: string[]): string {
  if (role !== 'developer' && !usedIds.includes(role)) return role

  let nextIndex = 1
  for (const agentId of usedIds) {
    const index = agentIdSortValue(agentId, role)
    if (Number.isFinite(index)) nextIndex = Math.max(nextIndex, index + 1)
  }

  let candidate = `${role}-${nextIndex}`
  while (usedIds.includes(candidate)) {
    nextIndex += 1
    candidate = `${role}-${nextIndex}`
  }
  return candidate
}

function agentIdSortValue(agentId: string, role: string): number {
  if (agentId === role) return 1
  const match = agentId.match(new RegExp(`^${escapeRegExp(role)}-(\\d+)$`, 'u'))
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function buildStartupPrompt(input: {
  role: string
  agentId: string
  label: string
  goal: string
  workspaceRoot: string
  executionCwd: string
  statePath: string
}): string {
  const windowsPython = win32.join(input.workspaceRoot, '.venv', 'Scripts', 'python.exe')
  return [
    `${input.label}: ${input.label} - Fetch the canonical Sprint Engine instructions from the Python tool.`,
    `Worker cwd: ${input.executionCwd}`,
    `Shared Sprint Engine state: ${input.statePath}`,
    `You are assigned role: ${input.role}. Only claim and work Sprint Engine tasks whose role exactly matches ${input.role}. Keep picking up ready ${input.role} tasks with this same agent id until no ${input.role} task is ready, you are blocked, you need user input, or your context window is about 70% full. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role.`,
    'Use the repo virtual environment directly on Windows if `sprintengine` or global Python is unreliable:',
    [
      '```powershell',
      `& ${quotePowerShellArg(windowsPython)} .\\scripts\\sprintengine_tool.py join --role ${input.role} --id ${input.agentId}`,
      '```',
    ].join('\n'),
    `Otherwise run \`sprintengine join --role ${input.role} --id ${input.agentId}\` to receive your full prompt and next directive.`,
  ].join('\n\n')
}

function quotePowerShellArg(value: string): string {
  return `"${value.replace(/"/g, '`"')}"`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
