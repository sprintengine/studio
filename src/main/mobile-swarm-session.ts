import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import {
  MobileSwarmCommandError,
  type MobileSwarmFollowUpRequest,
  type MobileSwarmFollowUpResult,
  type MobileSwarmSessionOrchestrator,
  type MobileSwarmTaskStartRequest,
  type MobileSwarmTaskStartResult,
} from './mobile-swarm-command'

type AgentCli = 'codex' | 'claude'

type TerminalSessionSnapshot = {
  sessionId: string
  running: boolean
  kind: 'agent' | 'terminal'
  agentId?: string
  cli?: AgentCli
  swarmStatePath?: string
  executionMode?: 'current_workspace' | 'worktree'
  worktreeId?: string
  worktreePath?: string
}

type WorktreeEntry = {
  path: string
  branch: string | null
}

type GitWorktreeListResult =
  | { ok: true; data: { worktrees: WorktreeEntry[] } }
  | { ok: false; message: string }

type GitWorktreeCreateResult =
  | { ok: true; data: { path: string; branch: string | null } }
  | { ok: false; message: string }

type SpawnMobileAgentTerminalInput = {
  sessionId: string
  cwd: string
  swarmStatePath: string
  agentId: string
  initialPrompt: string
  cli: AgentCli
  executionMode: 'current_workspace' | 'worktree'
  worktreeId?: string
  worktreePath?: string
}

type SpawnMobileAgentTerminalResult =
  | { ok: true; sessionId: string }
  | { ok: false; message: string }

export type DesktopMobileSwarmSessionAdapters = {
  listTerminals(): Promise<TerminalSessionSnapshot[]>
  spawnAgentTerminal(input: SpawnMobileAgentTerminalInput): Promise<SpawnMobileAgentTerminalResult>
  writeTerminal(sessionId: string, data: string): Promise<void> | void
  pathExists(path: string): Promise<boolean>
  listGitWorktrees(repoRoot: string): Promise<GitWorktreeListResult>
  createGitWorktree(input: {
    repoRoot: string
    containerPath: string
    destinationPath: string
    branchName: string
    baseRef: string
    copyIncludedFiles: boolean
  }): Promise<GitWorktreeCreateResult>
}

type DesktopMobileSwarmSessionOptions = {
  adapters: DesktopMobileSwarmSessionAdapters
  maxRunningAgentTerminals?: number
  now?: () => Date
}

type RuntimeAgent = {
  role: string
  status: string
  currentTaskId: string | null
}

type RawSwarmState = {
  swarm?: {
    goal?: unknown
  }
  tasks?: Array<{
    id?: unknown
    role?: unknown
    status?: unknown
    ownerAgentId?: unknown
  }>
  swarmAgents?: Record<string, RuntimeAgent>
}

const swarmRoleLabels: Record<string, string> = {
  architect: 'Architect',
  product: 'Product Strategist',
  developer: 'Developer',
  frontend: 'Frontend Engineer',
  tester: 'Tester',
  security: 'Security Specialist',
  code_reviewer: 'Code Reviewer',
}

export class DesktopMobileSwarmSessionOrchestrator implements MobileSwarmSessionOrchestrator {
  private readonly maxRunningAgentTerminals: number
  private readonly now: () => Date

  constructor(private readonly options: DesktopMobileSwarmSessionOptions) {
    this.maxRunningAgentTerminals = Math.max(1, options.maxRunningAgentTerminals ?? 8)
    this.now = options.now ?? (() => new Date())
  }

  async startTask(request: MobileSwarmTaskStartRequest): Promise<MobileSwarmTaskStartResult> {
    const sessions = await this.options.adapters.listTerminals()
    const swarmSessions = sessions.filter((session) =>
      session.running
      && session.kind === 'agent'
      && session.swarmStatePath === request.statePath
    )

    if (swarmSessions.length >= this.maxRunningAgentTerminals) {
      throw new MobileSwarmCommandError('task_not_ready', 'Desktop has reached the running swarm terminal limit.', true)
    }

    const state = await readRawSwarmState(request.statePath)
    const agentId = chooseAgentId(state, request.role, swarmSessions)
    if (swarmSessions.some((session) => session.agentId === agentId)) {
      throw new MobileSwarmCommandError('task_not_ready', 'The selected swarm agent already has a running terminal.', false)
    }

    let executionCwd = request.workspaceRoot
    let executionMode: MobileSwarmTaskStartResult['executionMode'] = 'current_workspace'
    let worktreeId: string | undefined
    let worktreePath: string | undefined

    if (request.worktreeIsolation !== 'disabled') {
      const worktree = await this.prepareWorktree(request, agentId)
      if (worktree.ok) {
        executionCwd = worktree.path
        executionMode = 'worktree'
        worktreeId = worktree.id
        worktreePath = worktree.path
      } else if (request.worktreeIsolation === 'required') {
        throw new MobileSwarmCommandError('task_not_ready', worktree.message, true)
      }
    }

    const sessionId = randomUUID()
    const spawn = await this.options.adapters.spawnAgentTerminal({
      sessionId,
      cwd: executionCwd,
      swarmStatePath: request.statePath,
      agentId,
      cli: 'codex',
      initialPrompt: buildStartupPrompt({
        role: request.role,
        agentId,
        label: swarmRoleLabels[request.role] ?? request.role,
        goal: typeof state.swarm?.goal === 'string' ? state.swarm.goal : '',
        executionCwd,
        statePath: request.statePath,
      }),
      executionMode,
      worktreeId,
      worktreePath,
    })

    if (!spawn.ok) {
      throw new MobileSwarmCommandError('desktop_unavailable', spawn.message, true)
    }

    return {
      sessionId: spawn.sessionId,
      agentId,
      executionMode,
      ...(worktreeId ? { worktreeId } : {}),
      ...(worktreePath ? { worktreePath } : {}),
    }
  }

  async sendFollowUp(request: MobileSwarmFollowUpRequest): Promise<MobileSwarmFollowUpResult> {
    const text = normalizeFollowUpTextForTerminal(request.text)
    const sessions = await this.options.adapters.listTerminals()
    const session = sessions.find((candidate) =>
      candidate.running
      && candidate.kind === 'agent'
      && candidate.swarmStatePath === request.statePath
      && candidate.agentId === request.agentId
    )

    if (!session) {
      throw new MobileSwarmCommandError('task_not_ready', 'Follow-up target agent does not have a running desktop terminal.', true)
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

  private async prepareWorktree(
    request: MobileSwarmTaskStartRequest,
    agentId: string
  ): Promise<{ ok: true; id: string; path: string } | { ok: false; message: string }> {
    const spec = buildWorktreeSpec(request, agentId)
    const listed = await this.options.adapters.listGitWorktrees(request.workspaceRoot)
    if (!listed.ok) return { ok: false, message: listed.message }

    const existing = listed.data.worktrees.find((worktree) =>
      samePath(worktree.path, spec.destinationPath) || worktree.branch === spec.branch
    )
    if (existing) {
      if (!(await this.options.adapters.pathExists(existing.path))) {
        return { ok: false, message: `Worktree path is missing: ${existing.path}` }
      }
      return { ok: true, id: spec.id, path: existing.path }
    }

    if (await this.options.adapters.pathExists(spec.destinationPath)) {
      return { ok: false, message: `Worktree destination already exists: ${spec.destinationPath}` }
    }

    const created = await this.options.adapters.createGitWorktree({
      repoRoot: request.workspaceRoot,
      containerPath: spec.containerPath,
      destinationPath: spec.destinationPath,
      branchName: spec.branch,
      baseRef: 'HEAD',
      copyIncludedFiles: true,
    })
    if (!created.ok) return { ok: false, message: created.message }
    return { ok: true, id: spec.id, path: created.data.path }
  }
}

function normalizeFollowUpTextForTerminal(value: string): string {
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new MobileSwarmCommandError('invalid_payload', 'Follow-up text must be a single message without terminal control characters.', false)
  }

  const text = value.trim()
  if (!text) {
    throw new MobileSwarmCommandError('invalid_payload', 'Follow-up text is required.', false)
  }

  return text
}

async function readRawSwarmState(statePath: string): Promise<RawSwarmState> {
  return JSON.parse(await readFile(statePath, 'utf8')) as RawSwarmState
}

function chooseAgentId(
  state: RawSwarmState,
  role: string,
  runningSessions: TerminalSessionSnapshot[]
): string {
  const runningAgentIds = new Set(runningSessions.flatMap((session) => session.agentId ? [session.agentId] : []))
  const agents = state.swarmAgents && typeof state.swarmAgents === 'object' ? state.swarmAgents : {}
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

function buildWorktreeSpec(request: MobileSwarmTaskStartRequest, agentId: string): {
  id: string
  branch: string
  containerPath: string
  destinationPath: string
} {
  const teamSlug = slugify(basename(request.teamDirectory), 'swarm')
  const taskSlug = slugify(request.taskId, 'task')
  const agentSlug = slugify(agentId, 'agent')
  const name = `${taskSlug}-${agentSlug}`
  const containerPath = join(dirname(request.workspaceRoot), '.multicode-worktrees', basename(request.workspaceRoot))
  return {
    id: `swarm-${teamSlug}-${name}`,
    branch: `multicode/${teamSlug}/${name}`,
    containerPath,
    destinationPath: join(containerPath, name),
  }
}

function buildStartupPrompt(input: {
  role: string
  agentId: string
  label: string
  goal: string
  executionCwd: string
  statePath: string
}): string {
  return [
    `${input.label}: ${input.label} - Fetch the canonical swarm instructions from the Python tool.`,
    `Worker cwd: ${input.executionCwd}`,
    `Shared swarm state: ${input.statePath}`,
    `Run \`swarm join --role ${input.role} --id ${input.agentId}\` to receive your full prompt and next directive.`,
  ].join('\n\n')
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '')
  return slug || fallback
}

function normalizePath(path: string): string {
  const normalized = resolve(path).replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[A-Za-z]:/u.test(normalized) ? normalized.toLowerCase() : normalized
}

function samePath(first: string, second: string): boolean {
  return normalizePath(first) === normalizePath(second)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
