import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  MobileSprintEngineCommandError,
  type MobileSprintEngineFollowUpRequest,
  type MobileSprintEngineFollowUpResult,
  type MobileSprintEngineSessionOrchestrator,
  type MobileSprintEngineSetAutomationModeRequest,
  type MobileSprintEngineSetAutomationModeResult,
  type MobileSprintEngineTaskStartRequest,
  type MobileSprintEngineTaskStartResult,
} from './command'
import type { TerminalSessionSnapshot as CanonicalTerminalSessionSnapshot } from '../../../shared/electron-api'

type AgentCli = string

// The subset of the canonical terminal snapshot the session orchestrator reads.
// Derived via Pick<> from src/shared/electron-api.ts so the field names and their
// unions (kind, executionMode, cli) cannot drift from the source of truth.
type TerminalSessionSnapshot = Pick<
  CanonicalTerminalSessionSnapshot,
  'sessionId' | 'processAlive' | 'kind' | 'agentId' | 'cli' | 'sprintEngineStatePath' | 'executionMode' | 'worktreeId' | 'worktreePath'
>

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

export type SetSprintEngineAutomationModeInput = {
  sprintEngineId: string
  statePath: string
  workspaceRoot: string
  mode: MobileSprintEngineSetAutomationModeRequest['mode']
}

export type SetSprintEngineAutomationModeResult =
  | { ok: true }
  | { ok: false; retryable: boolean; message: string }

export type DesktopMobileSprintEngineSessionAdapters = {
  listTerminals(): Promise<TerminalSessionSnapshot[]>
  spawnAgentTerminal(input: SpawnMobileAgentTerminalInput): Promise<SpawnMobileAgentTerminalResult>
  writeTerminal(sessionId: string, data: string): Promise<void> | void
  // MC-1497: apply a mode change to the renderer-owned automation store. Optional
  // so a desktop build without the renderer wire falls back to a clean rejection.
  setSprintEngineAutomationMode?(input: SetSprintEngineAutomationModeInput): Promise<SetSprintEngineAutomationModeResult>
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
  performance: 'Performance Engineer',
  production_readiness_reviewer: 'Production Readiness Reviewer',
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
      throw new MobileSprintEngineCommandError('task_not_ready', 'Desktop has reached the live sprint terminal limit.', true)
    }

    const state = await readMobileSprintEngineProjection(request.teamDirectory)
    const agentId = chooseAgentId(state, request.role, processAliveSprintEngineSessions)
    if (processAliveSprintEngineSessions.some((session) => session.agentId === agentId)) {
      throw new MobileSprintEngineCommandError('task_not_ready', 'The selected sprint agent already has a live terminal.', false)
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

  async setAutomationMode(
    request: MobileSprintEngineSetAutomationModeRequest,
  ): Promise<MobileSprintEngineSetAutomationModeResult> {
    const apply = this.options.adapters.setSprintEngineAutomationMode
    if (!apply) {
      // No renderer wire (headless): the authoritative mode lives in the desktop
      // store, so refuse rather than write a value the supervisor won't read.
      throw new MobileSprintEngineCommandError(
        'command_not_supported',
        'Setting the automation mode requires the desktop app to be open.',
        false,
      )
    }

    const result = await apply({
      sprintEngineId: request.sprintEngineId,
      statePath: request.statePath,
      workspaceRoot: request.workspaceRoot,
      mode: request.mode,
    })
    if (!result.ok) {
      throw new MobileSprintEngineCommandError('internal_error', result.message, result.retryable)
    }

    return { mode: request.mode, appliedAt: this.now().toISOString() }
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
      `Sprint projection could not be read from projection.json: ${error instanceof Error ? error.message : String(error)}`,
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
  const claimPayload = JSON.stringify({
    role: input.role,
    id: input.agentId,
  }, null, 2)
  void input.goal
  void input.workspaceRoot
  return [
    `${input.label}: ${input.label} - Fetch the canonical Sprint Engine instructions from the managed Sprint Engine MCP server.`,
    `Worker cwd: ${input.executionCwd}`,
    `Shared sprint state: ${input.statePath}`,
    `You are assigned role: ${input.role}. Only claim and work sprint tasks whose role exactly matches ${input.role}, and own each one from claim to done. Sprint work runs through the managed Sprint Engine MCP server in this terminal.`,
    'Register this agent with `sprintengine.agent.join`:',
    ['```json', joinPayload, '```'].join('\n'),
    'Then claim your work with `sprintengine.task.next`:',
    ['```json', claimPayload, '```'].join('\n'),
    'The claim returns your next ready task, or your active one to resume. Work what it returns. If it returns no claim, reply that no work was claimed and stop — the caller/runtime owns later continuation. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role.',
  ].join('\n\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
