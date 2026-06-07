import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  MobileSprintEngineCommandError,
  type MobileSprintEngineFollowUpRequest,
  type MobileSprintEngineFollowUpResult,
  type MobileSprintEngineSessionOrchestrator,
  type MobileSprintEngineTaskStartRequest,
  type MobileSprintEngineTaskStartResult,
} from './command'

type AgentCli = string

type TerminalSessionSnapshot = {
  sessionId: string
  processAlive: boolean
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
  role: string
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
  maxProcessAliveAgentTerminals?: number
  now?: () => Date
}

type RuntimeAgent = {
  role: string
  status: string
  currentTaskId: string | null
}

type ProjectionState = {
  goal: string
  sprintEngineAgents: Record<string, RuntimeAgent>
}

// Bundled-role display labels used for the mobile startup prompt. This map is
// a humanization fallback only — unknown registry-keyed role ids resolve via
// `humanizeMobileSprintEngineRoleId` so custom Sprint Engine roles
// (e.g. `marketer`, `growth-engineer`) get a sensible title-cased label
// instead of indexing this bundled-role table directly.
const bundledSprintEngineRoleLabels: Record<string, string> = {
  architect: 'Architect',
  product: 'Product Strategist',
  developer: 'Developer',
  frontend: 'Frontend Engineer',
  ui_ux_reviewer: 'UI/UX Reviewer',
  tester: 'Tester',
  security: 'Security Specialist',
  code_reviewer: 'Code Reviewer',
  spec_reviewer: 'Spec Reviewer',
  performance: 'Performance Engineer',
}

function mobileSprintEngineRoleLabel(role: string): string {
  const bundled = bundledSprintEngineRoleLabels[role]
  if (bundled) return bundled
  const cleaned = role.trim().replace(/[_-]+/g, ' ').trim()
  if (!cleaned) return role
  return cleaned
    .split(/\s+/u)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export class DesktopMobileSprintEngineSessionOrchestrator implements MobileSprintEngineSessionOrchestrator {
  private readonly maxProcessAliveAgentTerminals: number
  private readonly now: () => Date

  constructor(private readonly options: DesktopMobileSprintEngineSessionOptions) {
    this.maxProcessAliveAgentTerminals = Math.max(1, options.maxProcessAliveAgentTerminals ?? 8)
    this.now = options.now ?? (() => new Date())
  }

  async startTask(request: MobileSprintEngineTaskStartRequest): Promise<MobileSprintEngineTaskStartResult> {
    const sessions = await this.options.adapters.listTerminals()
    const processAliveSprintEngineSessions = sessions.filter((session) =>
      session.processAlive
      && session.kind === 'agent'
      && session.sprintEngineStatePath === request.statePath
    )

    if (processAliveSprintEngineSessions.length >= this.maxProcessAliveAgentTerminals) {
      throw new MobileSprintEngineCommandError('task_not_ready', 'Desktop has reached the live Sprint Engine terminal limit.', true)
    }

    const state = await readMobileSprintEngineProjection(request.teamDirectory)
    const agentId = chooseAgentId(state, request.role, processAliveSprintEngineSessions)
    if (processAliveSprintEngineSessions.some((session) => session.agentId === agentId)) {
      throw new MobileSprintEngineCommandError('task_not_ready', 'The selected Sprint Engine agent already has a live terminal.', false)
    }

    const executionCwd = request.workspaceRoot
    const executionMode: MobileSprintEngineTaskStartResult['executionMode'] = 'current_workspace'

    const sessionId = randomUUID()
    const spawn = await this.options.adapters.spawnAgentTerminal({
      sessionId,
      cwd: executionCwd,
      sprintEngineStatePath: request.statePath,
      agentId,
      role: request.role,
      cli: 'codex',
      initialPrompt: buildStartupPrompt({
        role: request.role,
        agentId,
        label: mobileSprintEngineRoleLabel(request.role),
        goal: state.goal,
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
      candidate.processAlive
      && candidate.kind === 'agent'
      && candidate.sprintEngineStatePath === request.statePath
      && candidate.agentId === request.agentId
    )

    if (!session) {
      throw new MobileSprintEngineCommandError('task_not_ready', 'Follow-up target agent does not have a live desktop terminal.', true)
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

async function readMobileSprintEngineProjection(teamDirectory: string): Promise<ProjectionState> {
  // Sprint Engine's canonical UI/MCP read is `projection.json`. The mobile
  // startup prompt only needs the goal string and per-agent roster shape —
  // anything richer flows through MCP, not run-store internals.
  const projectionPath = join(teamDirectory, 'projection.json')
  let projection: Record<string, unknown>
  try {
    projection = JSON.parse(await readFile(projectionPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new MobileSprintEngineCommandError(
      'internal_error',
      `Sprint Engine projection could not be read from projection.json: ${error instanceof Error ? error.message : String(error)}`,
      false
    )
  }

  const run = projection.run && typeof projection.run === 'object' && !Array.isArray(projection.run)
    ? projection.run as Record<string, unknown>
    : {}
  const roster = projection.roster && typeof projection.roster === 'object' && !Array.isArray(projection.roster)
    ? projection.roster as Record<string, unknown>
    : {}
  const sprintEngineAgents: Record<string, RuntimeAgent> = {}
  for (const [agentId, raw] of Object.entries(roster)) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    sprintEngineAgents[agentId] = {
      role: typeof record.role === 'string' ? record.role : '',
      status: typeof record.status === 'string' ? record.status : '',
      currentTaskId: typeof record.currentTaskId === 'string' ? record.currentTaskId : null,
    }
  }

  return {
    goal: typeof run.goal === 'string' ? run.goal : '',
    sprintEngineAgents,
  }
}

function chooseAgentId(
  state: ProjectionState,
  role: string,
  processAliveSessions: TerminalSessionSnapshot[]
): string {
  const processAliveAgentIds = new Set(processAliveSessions.flatMap((session) => session.agentId ? [session.agentId] : []))
  const agents = state.sprintEngineAgents
  const idleAgent = Object.entries(agents)
    .sort(([first], [second]) => agentIdSortValue(first, role) - agentIdSortValue(second, role))
    .find(([agentId, agent]) =>
      agent.role === role
      && agent.status !== 'done'
      && !processAliveAgentIds.has(agentId)
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
  const joinPayload = JSON.stringify({
    role: input.role,
    agentId: input.agentId,
  }, null, 2)
  const directivePayload = JSON.stringify({
    role: input.role,
    agentId: input.agentId,
  }, null, 2)
  void input.goal
  void input.workspaceRoot
  return [
    `${input.label}: ${input.label} - Fetch the canonical Sprint Engine instructions from the managed Sprint Engine MCP server.`,
    `Worker cwd: ${input.executionCwd}`,
    `Shared Sprint Engine state: ${input.statePath}`,
    `You are assigned role: ${input.role}. Only claim and work Sprint Engine tasks or quality gates whose role exactly matches ${input.role}. Sprint Engine work runs through the managed Sprint Engine MCP server in this terminal.`,
    'Register this agent with `sprintengine.agent.join`:',
    ['```json', joinPayload, '```'].join('\n'),
    'Then request your structured directive with `sprintengine.agent.next_directive`:',
    ['```json', directivePayload, '```'].join('\n'),
    'The directive returns `directiveType` (`task_work` | `resume` | `gate_work` | `needs_input_triage` | `idle` | `complete` | `blocked` | `error`), `nextMcpToolName`, and `nextMcpArguments`. If `nextMcpToolName` is present, invoke it once with `nextMcpArguments` verbatim to claim or resume. The caller/runtime owns later continuation. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role.',
  ].join('\n\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
