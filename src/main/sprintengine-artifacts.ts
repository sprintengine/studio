import { existsSync } from 'fs'
import { mkdir, readFile, stat } from 'fs/promises'
import { spawn } from 'child_process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineDispatchReadInput,
  SprintEngineMcpReadResult,
  SprintEngineProjectionReadResult,
  SprintEngineRegistryRoleReadInput,
  SprintEngineRegistryRolesReadInput,
  SprintEngineRosterReplenishInput,
  SprintEngineRunnerSetInput,
  SprintEngineStateInitializeInput,
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
  SprintEngineTaskMutationRole,
  SprintEngineTaskUpdateInput,
} from '../shared/electron-api'
import type {
  SprintEngineArtifactOpenPayload,
  SprintEngineArtifactReviewAction,
  SprintEngineArtifactReviewMode,
  SprintEngineArtifactReviewPayload,
  SprintEngineProjectionReadPayload,
  SprintEngineTaskReadyPayload,
} from './ipc/sprintengine-ipc'
import { findSprintEngineRuntimeRoot } from './mcp-config-service'
import { getPluginSprintEngineRegistryRoots } from './plugin-registry-instance'
import { defaultUserRoleRegistryRoot } from './sprintengine-role-registry'

type SprintEngineArtifactDependencies = {
  getAuthenticatedUserId(): string | null
  openExternal(url: string): Promise<void>
  runMcpTool?: SprintEngineMcpToolRunner
}

type SprintEngineMcpActorContext = {
  id: string
  role: 'user' | 'renderer'
  authenticated: true
  mcpAuthorized: true
}

type SprintEngineMcpToolResponse =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error?: { code?: string; message?: string } }

type SprintEngineMcpRunnerContext = {
  workspaceRoot: string
  allowedRoots?: string[]
}

type SprintEngineMcpToolRunner = (
  context: SprintEngineMcpRunnerContext,
  tool: string,
  payload: Record<string, unknown>,
  actor: SprintEngineMcpActorContext
) => Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
  response: SprintEngineMcpToolResponse | null
}>

type SprintEngineArtifactRecord = {
  id: string
  kind: string
  title: string
  path: string
  status: string
  createdBy: string
  taskId: string
}

type SprintEngineTaskRecord = {
  id: string
  status: string
  ownerAgentId: string
}

const validTaskRoles = new Set<SprintEngineTaskMutationRole>([
  'architect',
  'product',
  'developer',
  'frontend',
  'tester',
  'security',
  'code_reviewer',
  'spec_reviewer',
  'performance',
])

type ValidSprintEngineStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
}

type SerializableSprintEngineStatePayload = {
  name: string
  goal: string
  agents: Record<string, unknown>
  tasks: unknown[]
  events: unknown[]
  artifacts: unknown[]
}

type SprintEngineEventMetadata = {
  id?: string
  type?: string
  timestamp?: string
  actor?: string
  message?: string
}

const autoApprovableArtifactKinds = new Set([
  'architect_plan',
  'product_strategy',
  'requirements',
  'html_mockup',
  'design_notes',
  'branding',
  'security_review',
  'code_review',
  'spec_review',
  'performance_review',
  'validation_report',
])

function validateSprintEngineStatePath(input: unknown): ValidSprintEngineStatePath {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A Sprint Engine run path is required.')
  }

  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new Error('Sprint Engine run path must be absolute.')
  }

  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const sprintEngineDirectory = dirname(teamDirectory)
  const multiCodeDirectory = dirname(sprintEngineDirectory)
  const workspaceRoot = dirname(multiCodeDirectory)

  if (
    basename(statePath) !== 'run.yaml'
    || basename(sprintEngineDirectory) !== 'sprintengine'
    || basename(multiCodeDirectory) !== '.multi-code'
    || workspaceRoot === multiCodeDirectory
  ) {
    throw new Error('Sprint Engine run path must point to .multi-code/sprintengine/<team>/run.yaml.')
  }

  return { statePath, teamDirectory, workspaceRoot }
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(targetPath))
  return (
    relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..'))
  )
}

function resolveArtifactFilePath(state: ValidSprintEngineStatePath, artifactPathInput: unknown): string {
  if (typeof artifactPathInput !== 'string' || !artifactPathInput.trim()) {
    throw new Error('Artifact path is required.')
  }

  const artifactPath = artifactPathInput.trim()
  if (/^https?:\/\//i.test(artifactPath)) {
    return artifactPath
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(artifactPath)) {
    throw new Error('Only http, https, or workspace artifact file paths can be opened.')
  }

  const fullPath = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : [
        resolve(state.workspaceRoot, artifactPath),
        resolve(state.teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(state.teamDirectory, candidate))
        ?? resolve(state.workspaceRoot, artifactPath)
  if (!isPathInsideOrEqual(state.teamDirectory, fullPath)) {
    throw new Error('Artifact path must stay inside the Sprint Engine team directory.')
  }

  return fullPath
}

function resolveSprintEngineArtifactId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Artifact id is required.')
  }
  const artifactId = input.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(artifactId)) {
    throw new Error('Artifact id must be a safe sprintengine identifier.')
  }
  return artifactId
}

function resolveSprintEngineTaskId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Task id is required.')
  }
  const taskId = input.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(taskId)) {
    throw new Error('Task id must be a safe sprintengine identifier.')
  }
  return taskId
}

function resolveTaskRole(input: unknown): SprintEngineTaskMutationRole {
  if (typeof input !== 'string' || !validTaskRoles.has(input as SprintEngineTaskMutationRole)) {
    throw new Error('Task role is invalid.')
  }
  return input as SprintEngineTaskMutationRole
}

function resolveOptionalTaskRole(input: unknown): SprintEngineTaskMutationRole | undefined {
  return input === undefined || input === null ? undefined : resolveTaskRole(input)
}

function resolveOptionalString(input: unknown, field: string): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'string') throw new Error(`${field} must be a string.`)
  return input.trim()
}

function resolveRequiredString(input: unknown, field: string): string {
  const value = resolveOptionalString(input, field)
  if (!value) throw new Error(`${field} is required.`)
  return value
}

function resolveStringList(input: unknown, field: string): string[] | undefined {
  if (input === undefined || input === null) return undefined
  if (!Array.isArray(input)) throw new Error(`${field} must be a list.`)
  return input.flatMap((item): string[] => {
    if (typeof item !== 'string') return []
    const value = item.trim()
    return value ? [value] : []
  })
}

function resolveRecord(input: unknown, field: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`)
  }
  return input as Record<string, unknown>
}

function resolveArray(input: unknown, field: string): unknown[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error(`${field} must be a list.`)
  return input
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null
}

function eventMetadataFromUnknown(input: unknown): SprintEngineEventMetadata | null {
  const record = asRecord(input)
  if (!record) return null
  const id = typeof record.id === 'string' ? record.id : undefined
  const type = typeof record.type === 'string' ? record.type : undefined
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined
  const actor = typeof record.actor === 'string' ? record.actor : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  if (!id && !type && !timestamp && !actor && !message) return null
  return { id, type, timestamp, actor, message }
}

function collectSprintEngineEvents(toolResult: unknown): SprintEngineEventMetadata[] {
  const record = asRecord(toolResult)
  if (!record) return []
  const events: SprintEngineEventMetadata[] = []
  const add = (candidate: unknown) => {
    const event = eventMetadataFromUnknown(candidate)
    if (event) events.push(event)
  }
  add(record.event)
  add(record.notification)
  if (Array.isArray(record.events)) {
    for (const event of record.events) add(event)
  }
  if (Array.isArray(record.notifications)) {
    for (const event of record.notifications) add(event)
  }
  return events
}

async function readLatestSprintEngineEvent(state: ValidSprintEngineStatePath): Promise<SprintEngineEventMetadata | null> {
  try {
    const content = await readFile(join(state.teamDirectory, 'events.jsonl'), 'utf8')
    const line = content.trim().split(/\r?\n/u).filter(Boolean).at(-1)
    if (!line) return null
    return eventMetadataFromUnknown(JSON.parse(line))
  } catch {
    return null
  }
}

async function buildSprintEngineMutationData(
  state: ValidSprintEngineStatePath,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const projectionContent = await readFile(join(state.teamDirectory, 'projection.json'), 'utf8')
  const toolEvents = collectSprintEngineEvents(data.tool)
  const latestEvent = toolEvents.at(-1) ?? await readLatestSprintEngineEvent(state)
  return {
    ...data,
    projectionContent,
    ...(toolEvents.length > 0 ? { events: toolEvents } : {}),
    ...(latestEvent ? { latestEvent, latestEventId: latestEvent.id } : {}),
  }
}

function parseSprintEngineCliJsonOutput(stdout: string): unknown {
  const responseLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
  if (!responseLine) return null
  try {
    return JSON.parse(responseLine) as unknown
  } catch {
    return null
  }
}

function resolveInitialSprintEngineStatePayload(payload: SprintEngineStateInitializeInput): SerializableSprintEngineStatePayload {
  return {
    name: resolveRequiredString(payload?.name, 'Sprint Engine name'),
    goal: resolveOptionalString(payload?.goal, 'Sprint Engine goal') ?? '',
    agents: resolveRecord(payload?.agents, 'Sprint Engine agents'),
    tasks: resolveArray(payload?.tasks, 'Sprint Engine tasks'),
    events: resolveArray(payload?.events, 'Sprint Engine events'),
    artifacts: resolveArray(payload?.artifacts, 'Sprint Engine artifacts'),
  }
}

function getSprintEngineMcpRuntimeRoot(): string {
  return findSprintEngineRuntimeRoot() ?? process.cwd()
}

function getSprintEngineMcpPythonExecutable(runtimeRoot: string): string {
  const venvPython = process.platform === 'win32'
    ? join(runtimeRoot, '.venv', 'Scripts', 'python.exe')
    : join(runtimeRoot, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  return process.platform === 'win32' ? 'python' : 'python3'
}

function validateWorkspaceRoot(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Workspace root is required.')
  }
  const rawWorkspaceRoot = input.trim()
  if (!isAbsolute(rawWorkspaceRoot)) {
    throw new Error('Workspace root must be absolute.')
  }
  const workspaceRoot = resolve(rawWorkspaceRoot)
  if (!existsSync(workspaceRoot)) {
    throw new Error('Workspace root does not exist.')
  }
  return workspaceRoot
}

function sprintEngineInitArgs(state: ValidSprintEngineStatePath, payload: SerializableSprintEngineStatePayload): string[] {
  const args = [join(getSprintEngineMcpRuntimeRoot(), 'scripts', 'sprintengine_tool.py'), '--state', state.statePath, 'init', '--goal', payload.goal || payload.name]
  for (const [agentId, agent] of Object.entries(payload.agents)) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue
    const role = (agent as Record<string, unknown>).role
    if (typeof role === 'string' && role.trim()) {
      args.push('--agent', `${role.trim()}:${agentId}`)
    }
  }
  return args
}

function runSprintEngineCli(state: ValidSprintEngineStatePath, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const runtimeRoot = getSprintEngineMcpRuntimeRoot()
    const child = spawn(getSprintEngineMcpPythonExecutable(runtimeRoot), args, {
      cwd: state.workspaceRoot,
      env: {
        ...process.env,
        PYTHONPATH: [runtimeRoot, state.workspaceRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      resolvePromise({ exitCode: 1, stdout, stderr: stderr || error.message })
    })
    child.on('close', (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr })
    })
  })
}

function runSprintEngineMcpToolProcess(
  context: SprintEngineMcpRunnerContext,
  tool: string,
  payload: Record<string, unknown>,
  actor: SprintEngineMcpActorContext
): ReturnType<SprintEngineMcpToolRunner> {
  return new Promise((resolvePromise) => {
    const allowedRoots = Array.from(new Set([context.workspaceRoot, ...(context.allowedRoots ?? [])]))
    const args = ['-m', 'sprintengine_mcp']
    for (const root of allowedRoots) {
      args.push('--allowed-root', root)
    }
    const runtimeRoot = getSprintEngineMcpRuntimeRoot()
    const child = spawn(getSprintEngineMcpPythonExecutable(runtimeRoot), args, {
      cwd: context.workspaceRoot,
      env: {
        ...process.env,
        PYTHONPATH: [runtimeRoot, context.workspaceRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
        SPRINTENGINE_MCP_USER_ID: actor.id,
        SPRINTENGINE_MCP_USER_AUTHORIZED: '1',
      },
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolvePromise({ exitCode: 1, stdout, stderr: stderr || error.message, response: null })
    })
    child.on('close', (exitCode) => {
      let response: SprintEngineMcpToolResponse | null = null
      const responseLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
      if (responseLine) {
        try {
          response = JSON.parse(responseLine) as SprintEngineMcpToolResponse
        } catch {
          response = null
        }
      }
      resolvePromise({ exitCode, stdout, stderr, response })
    })
    child.stdin.end(`${JSON.stringify({ tool, payload, actor })}\n`)
  })
}

function rendererMcpActor(): SprintEngineMcpActorContext {
  return {
    id: 'multicode-renderer',
    role: 'renderer',
    authenticated: true,
    mcpAuthorized: true,
  }
}

function sprintEngineRegistryRootsForRead(): Array<{ id: string; root: string }> {
  try {
    const roots = [...getPluginSprintEngineRegistryRoots()]
    // User-global third-party roles: same { roles/, skills/ } shape as plugin
    // souls dirs, so the existing MCP discovery enumerates them once the root is
    // on the search path. Only added when the directory exists.
    const userRoot = defaultUserRoleRegistryRoot()
    if (existsSync(userRoot)) roots.push({ id: 'user-roles', root: userRoot })
    return roots
  } catch {
    return []
  }
}

async function runReadOnlyMcpTool(
  runner: SprintEngineMcpToolRunner,
  context: SprintEngineMcpRunnerContext,
  tool: string,
  payload: Record<string, unknown>
): Promise<SprintEngineMcpReadResult> {
  const toolResult = await runner(context, tool, payload, rendererMcpActor())
  if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
    const message = toolResult.response && !toolResult.response.ok
      ? toolResult.response.error?.message
      : undefined
    return {
      ok: false,
      message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
      stdout: toolResult.stdout,
      stderr: toolResult.stderr,
      exitCode: toolResult.exitCode ?? 'unknown',
    }
  }
  return { ok: true, data: toolResult.response.result }
}

async function requireSprintEngineMcpAuthority(
  deps: SprintEngineArtifactDependencies
): Promise<SprintEngineMcpActorContext> {
  const userId = deps.getAuthenticatedUserId()
  if (!userId) {
    throw new Error('Artifact review requires an authenticated Multicode user.')
  }

  return {
    id: userId,
    role: 'user',
    authenticated: true,
    mcpAuthorized: true,
  }
}

function parseSprintEngineProjectionForArtifactReview(content: string): {
  tasks: SprintEngineTaskRecord[]
  artifacts: SprintEngineArtifactRecord[]
} {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).flatMap((task): SprintEngineTaskRecord[] => {
    if (!task || typeof task !== 'object') return []
    const record = task as Record<string, unknown>
    return typeof record.id === 'string' && typeof record.status === 'string'
      ? [{
          id: record.id,
          status: record.status,
          ownerAgentId: typeof record.ownerAgentId === 'string' ? record.ownerAgentId : '',
        }]
      : []
  })
  const artifacts = (Array.isArray(parsed.artifacts) ? parsed.artifacts : []).flatMap((artifact): SprintEngineArtifactRecord[] => {
    if (!artifact || typeof artifact !== 'object') return []
    const record = artifact as Record<string, unknown>
    if (typeof record.id !== 'string') return []
    return [{
      id: record.id,
      kind: typeof record.kind === 'string' ? record.kind : '',
      title: typeof record.title === 'string' ? record.title : '',
      path: typeof record.path === 'string' ? record.path : '',
      status: typeof record.status === 'string' ? record.status : '',
      createdBy: typeof record.createdBy === 'string' ? record.createdBy : '',
      taskId: typeof record.taskId === 'string' ? record.taskId : '',
    }]
  })
  return { tasks, artifacts }
}

function getArtifactAutoApprovalBlocker(
  artifact: SprintEngineArtifactRecord,
  tasks: SprintEngineTaskRecord[],
  artifacts: SprintEngineArtifactRecord[]
): string | null {
  if (artifact.status === 'approved') return 'Artifact is already approved.'
  if (artifact.status === 'superseded') return 'Superseded artifacts are obsolete and cannot be auto-approved.'
  if (!['draft', 'ready_for_review', 'changes_requested'].includes(artifact.status)) {
    return 'Artifact status is not eligible for auto-approval.'
  }
  if (!artifact.path.trim()) return 'Artifact file path is missing.'
  if (!autoApprovableArtifactKinds.has(artifact.kind)) return 'Artifact kind is not eligible for auto-approval.'

  const task = tasks.find((candidate) => candidate.id === artifact.taskId)
  if (!task) return 'Artifact task was not found.'

  const blockingArtifacts = artifacts.filter((candidate) =>
    candidate.taskId === task.id
    && candidate.status !== 'approved'
    && candidate.status !== 'superseded'
    && autoApprovableArtifactKinds.has(candidate.kind)
  )
  if (blockingArtifacts.length === 0) return 'No blocking review artifact is waiting for approval.'

  const ineligibleBlockingArtifact = blockingArtifacts.find((candidate) =>
    !['draft', 'ready_for_review', 'changes_requested'].includes(candidate.status) || !candidate.path.trim()
  )
  if (ineligibleBlockingArtifact) {
    return `Related artifact ${ineligibleBlockingArtifact.id} is not eligible for auto-approval.`
  }

  return null
}

async function readSprintEngineProjectionForArtifactReview(state: ValidSprintEngineStatePath): Promise<{
  tasks: SprintEngineTaskRecord[]
  artifacts: SprintEngineArtifactRecord[]
}> {
  const projectionContent = await readFile(join(state.teamDirectory, 'projection.json'), 'utf8')
  return parseSprintEngineProjectionForArtifactReview(projectionContent)
}

async function assertAutoApprovalAllowed(state: ValidSprintEngineStatePath, artifactId: string): Promise<SprintEngineArtifactRecord> {
  const { tasks, artifacts } = await readSprintEngineProjectionForArtifactReview(state)
  const artifact = artifacts.find((candidate) => candidate.id === artifactId)
  if (!artifact) throw new Error('Requested artifact was not found in the Sprint Engine projection.')

  const blocker = getArtifactAutoApprovalBlocker(artifact, tasks, artifacts)
  if (blocker) throw new Error(blocker)
  if (/^https?:\/\//i.test(artifact.path)) throw new Error('Remote artifact links cannot be auto-approved.')

  const artifactPath = resolveArtifactFilePath(state, artifact.path)
  const artifactStats = await stat(artifactPath)
  if (!artifactStats.isFile()) throw new Error('Artifact path must be a file.')
  await readFile(artifactPath, 'utf8')
  return artifact
}

export function createSprintEngineArtifactHandlers(deps: SprintEngineArtifactDependencies): {
  openArtifact(payload: SprintEngineArtifactOpenPayload): Promise<SprintEngineArtifactCommandResult>
  reviewArtifact(
    payload: SprintEngineArtifactReviewPayload,
    action: SprintEngineArtifactReviewAction,
    mode: SprintEngineArtifactReviewMode
  ): Promise<SprintEngineArtifactCommandResult>
  readyTask(payload: SprintEngineTaskReadyPayload): Promise<SprintEngineArtifactCommandResult>
  initializeSprintEngineState(payload: SprintEngineStateInitializeInput): Promise<SprintEngineArtifactCommandResult>
  updateTask(payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult>
  createTask(payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult>
  commentTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>
  setRunnerMode(payload: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>
  replenishRoster(payload: SprintEngineRosterReplenishInput): Promise<SprintEngineArtifactCommandResult>
  readProjection(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineProjectionReadResult>
  readRegistryRoles(payload: SprintEngineRegistryRolesReadInput): Promise<SprintEngineMcpReadResult>
  readRegistryRole(payload: SprintEngineRegistryRoleReadInput): Promise<SprintEngineMcpReadResult>
  readDispatch(payload: SprintEngineDispatchReadInput): Promise<SprintEngineMcpReadResult>
} {
  const runMcpTool = deps.runMcpTool ?? runSprintEngineMcpToolProcess
  return {
    async openArtifact(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const targetPath = resolveArtifactFilePath(state, payload?.artifactPath)

        if (/^https?:\/\//i.test(targetPath)) {
          await deps.openExternal(targetPath)
          return { ok: true, data: { path: targetPath } }
        }

        const targetStats = await stat(targetPath)
        if (!targetStats.isFile()) {
          return { ok: false, message: 'Artifact path must be a file.' }
        }

        const content = await readFile(targetPath, 'utf8')
        return { ok: true, data: { path: targetPath, name: basename(targetPath), content } }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async reviewArtifact(payload, action, mode) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const artifactId = resolveSprintEngineArtifactId(payload?.artifactId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        let feedback: string | undefined

        if (action === 'request-changes') {
          feedback = typeof payload?.feedback === 'string' ? payload.feedback.trim() : ''
          if (!feedback) return { ok: false, message: 'Artifact change requests require feedback.' }
        }
        if (mode === 'auto-run') {
          if (action !== 'approve') throw new Error('Auto-run can only approve eligible artifacts.')
          await assertAutoApprovalAllowed(state, artifactId)
        }

        const reviewPayload = {
          statePath: state.statePath,
          artifactId,
          id: actor.id,
          ...(feedback ? { feedback } : {}),
        }
        const toolName = action === 'approve' ? 'sprintengine.artifact.approve' : 'sprintengine.artifact.request_changes'

        const toolResult = await runMcpTool({ workspaceRoot: state.workspaceRoot }, toolName, reviewPayload, actor)
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action,
            actor: reviewPayload.id,
            authorizedUserId: actor.id,
            mode,
            artifactId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async readyTask(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const taskId = resolveSprintEngineTaskId(payload?.taskId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const toolResult = await runMcpTool(
          { workspaceRoot: state.workspaceRoot },
          'sprintengine.task.ready',
          { statePath: state.statePath, taskId, id: actor.id, triagedBy: 'user' },
          actor
        )
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'ready',
            actor: actor.id,
            taskId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async initializeSprintEngineState(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const initialState = resolveInitialSprintEngineStatePayload(payload)
        await mkdir(state.teamDirectory, { recursive: true })
        const toolResult = await runSprintEngineCli(state, sprintEngineInitArgs(state, initialState))
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'The sprintengine init command failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'initialize-state',
            actor: actor.id,
          }),
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
          return { ok: true, data: { action: 'initialize-state', created: false } }
        }
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async updateTask(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const taskId = resolveSprintEngineTaskId(payload?.taskId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const toolPayload = {
          statePath: state.statePath,
          taskId,
          actor: actor.id,
          title: resolveOptionalString(payload?.title, 'Task title'),
          description: resolveOptionalString(payload?.description, 'Task description'),
          role: resolveOptionalTaskRole(payload?.role),
          acceptance: resolveStringList(payload?.acceptanceCriteria, 'Acceptance criteria'),
          note: resolveStringList(payload?.implementationNotes, 'Implementation notes'),
          taskNote: resolveStringList(payload?.notes, 'Task notes'),
          clearAcceptance: Array.isArray(payload?.acceptanceCriteria),
          clearNotes: Array.isArray(payload?.implementationNotes),
          clearTaskNotes: Array.isArray(payload?.notes),
        }
        const toolResult = await runMcpTool({ workspaceRoot: state.workspaceRoot }, 'sprintengine.plan.update_task', toolPayload, actor)
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'update-task',
            actor: actor.id,
            taskId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async createTask(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const toolPayload = {
          statePath: state.statePath,
          actor: actor.id,
          title: resolveRequiredString(payload?.title, 'Task title'),
          description: resolveOptionalString(payload?.description, 'Task description') ?? '',
          role: resolveTaskRole(payload?.role),
          acceptance: resolveStringList(payload?.acceptanceCriteria, 'Acceptance criteria') ?? [],
          note: resolveStringList(payload?.implementationNotes, 'Implementation notes') ?? [],
          taskNote: resolveStringList(payload?.notes, 'Task notes') ?? [],
          manualDispatch: payload?.manualDispatch !== false,
          dispatchStatus: 'todo',
          triagedBy: 'none',
        }
        const toolResult = await runMcpTool({ workspaceRoot: state.workspaceRoot }, 'sprintengine.plan.add_task', toolPayload, actor)
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        const result = toolResult.response.result as { task?: { id?: unknown } }
        const taskId = typeof result.task?.id === 'string' ? result.task.id : null
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'create-task',
            actor: actor.id,
            taskId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async commentTask(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const taskId = resolveSprintEngineTaskId(payload?.taskId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const body = resolveRequiredString(payload?.body, 'Task comment')
        const toolResult = await runMcpTool(
          { workspaceRoot: state.workspaceRoot },
          'sprintengine.task.comment',
          { statePath: state.statePath, taskId, id: actor.id, body, source: 'user' },
          actor
        )
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'comment-task',
            actor: actor.id,
            taskId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async setRunnerMode(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        // Field rename: legacy `mode: 'auto' | 'off'` → `cliWatchPolling:
        // 'enabled' | 'disabled'`. Accept either shape from older callers and
        // translate to the new canonical value. SprintEngineRunnerSetInput in
        // src/shared/electron-api.ts documents this contract.
        const legacyModeAlias = (payload as { mode?: unknown } | undefined)?.mode
        let cliWatchPolling: string | undefined
        if (payload?.cliWatchPolling === 'enabled' || payload?.cliWatchPolling === 'disabled') {
          cliWatchPolling = payload.cliWatchPolling
        } else if (legacyModeAlias === 'auto') {
          cliWatchPolling = 'enabled'
        } else if (legacyModeAlias === 'off') {
          cliWatchPolling = 'disabled'
        }
        if (cliWatchPolling !== 'enabled' && cliWatchPolling !== 'disabled') {
          throw new Error('CLI watch polling must be enabled or disabled (legacy mode: auto|off also accepted).')
        }
        const toolResult = await runSprintEngineCli(state, [
          '--state',
          state.statePath,
          'runner',
          'set',
          '--cli-watch-polling',
          cliWatchPolling,
          '--actor',
          'ui',
        ])
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'The sprintengine runner command failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'runner-set-mode',
            cliWatchPolling,
            tool: parseSprintEngineCliJsonOutput(toolResult.stdout),
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async replenishRoster(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const args = [
          '--state',
          state.statePath,
          'roster',
          'replenish',
          '--actor',
          'runner',
        ]
        if (payload?.role) {
          args.push('--role', resolveTaskRole(payload.role))
        }
        const toolResult = await runSprintEngineCli(state, args)
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'The sprintengine roster command failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        const tool = parseSprintEngineCliJsonOutput(toolResult.stdout)
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'roster-replenish',
            tool,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async readProjection(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const projectionContent = await readFile(join(state.teamDirectory, 'projection.json'), 'utf8')
        return { ok: true, data: JSON.parse(projectionContent) }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async readRegistryRoles(payload) {
      try {
        const workspaceRoot = validateWorkspaceRoot(payload?.workspaceRoot)
        const pluginRegistryRoots = sprintEngineRegistryRootsForRead()
        return runReadOnlyMcpTool(
          runMcpTool,
          { workspaceRoot, allowedRoots: pluginRegistryRoots.map((root) => root.root) },
          'sprintengine.roles.list',
          { workspaceRoot, includeShadowed: payload?.includeShadowed === true, pluginRegistryRoots }
        )
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async readRegistryRole(payload) {
      try {
        const workspaceRoot = validateWorkspaceRoot(payload?.workspaceRoot)
        const roleId = resolveRequiredString(payload?.roleId, 'Role id')
        const pluginRegistryRoots = sprintEngineRegistryRootsForRead()
        return runReadOnlyMcpTool(
          runMcpTool,
          { workspaceRoot, allowedRoots: pluginRegistryRoots.map((root) => root.root) },
          'sprintengine.roles.get',
          { workspaceRoot, roleId, pluginRegistryRoots }
        )
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async readDispatch(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const agentId = resolveRequiredString(payload?.agentId, 'Agent id')
        const lastDispatchId = resolveOptionalString(payload?.lastDispatchId, 'Last dispatch id')
        return runReadOnlyMcpTool(
          runMcpTool,
          { workspaceRoot: state.workspaceRoot },
          'sprintengine.dispatch.next',
          {
            statePath: state.statePath,
            agentId,
            ...(lastDispatchId ? { lastDispatchId } : {}),
          }
        )
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
