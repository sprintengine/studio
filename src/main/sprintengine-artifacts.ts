import { existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { spawn } from 'child_process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type {
  SwarmArtifactCommandResult,
  SwarmTaskCreateInput,
  SwarmTaskMutationRole,
  SwarmTaskUpdateInput,
} from '../shared/electron-api'
import type {
  SwarmArtifactOpenPayload,
  SwarmArtifactReviewAction,
  SwarmArtifactReviewMode,
  SwarmArtifactReviewPayload,
  SwarmTaskReadyPayload,
} from './ipc/sprintengine-ipc'

type SprintEngineArtifactDependencies = {
  getAuthenticatedUserId(): string | null
  openExternal(url: string): Promise<void>
}

type SprintEngineMcpActorContext = {
  id: string
  role: 'user'
  authenticated: true
  mcpAuthorized: true
}

type SprintEngineMcpToolResponse =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error?: { code?: string; message?: string } }

type SwarmArtifactRecord = {
  id: string
  kind: string
  title: string
  path: string
  status: string
  createdBy: string
  taskId: string
}

type SwarmTaskRecord = {
  id: string
  status: string
  ownerAgentId: string
}

const validTaskRoles = new Set<SwarmTaskMutationRole>([
  'architect',
  'product',
  'developer',
  'frontend',
  'tester',
  'security',
  'code_reviewer',
  'performance',
])

type ValidSwarmStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
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
  'performance_review',
  'validation_report',
])

function validateSwarmStatePath(input: unknown): ValidSwarmStatePath {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A Sprint Engine state path is required.')
  }

  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new Error('Sprint Engine state path must be absolute.')
  }

  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const swarmDirectory = dirname(teamDirectory)
  const multiCodeDirectory = dirname(swarmDirectory)
  const workspaceRoot = dirname(multiCodeDirectory)

  if (
    basename(statePath) !== 'state.yaml'
    || basename(swarmDirectory) !== 'sprintengine'
    || basename(multiCodeDirectory) !== '.multi-code'
    || workspaceRoot === multiCodeDirectory
  ) {
    throw new Error('Sprint Engine state path must point to .multi-code/sprintengine/<team>/state.yaml.')
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

function resolveArtifactFilePath(state: ValidSwarmStatePath, artifactPathInput: unknown): string {
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

function resolveSwarmArtifactId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Artifact id is required.')
  }
  const artifactId = input.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(artifactId)) {
    throw new Error('Artifact id must be a safe sprintengine identifier.')
  }
  return artifactId
}

function resolveSwarmTaskId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Task id is required.')
  }
  const taskId = input.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(taskId)) {
    throw new Error('Task id must be a safe sprintengine identifier.')
  }
  return taskId
}

function resolveTaskRole(input: unknown): SwarmTaskMutationRole {
  if (typeof input !== 'string' || !validTaskRoles.has(input as SwarmTaskMutationRole)) {
    throw new Error('Task role is invalid.')
  }
  return input as SwarmTaskMutationRole
}

function resolveOptionalTaskRole(input: unknown): SwarmTaskMutationRole | undefined {
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

function getSprintEngineMcpPythonExecutable(workspaceRoot: string): string {
  const venvPython = process.platform === 'win32'
    ? join(workspaceRoot, '.venv', 'Scripts', 'python.exe')
    : join(workspaceRoot, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  return process.platform === 'win32' ? 'python' : 'python3'
}

function runSprintEngineMcpTool(
  state: ValidSwarmStatePath,
  tool: string,
  payload: Record<string, unknown>,
  actor: SprintEngineMcpActorContext
): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
  response: SprintEngineMcpToolResponse | null
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(getSprintEngineMcpPythonExecutable(state.workspaceRoot), ['-m', 'sprintengine_mcp', '--allowed-root', state.workspaceRoot], {
      cwd: state.workspaceRoot,
      env: {
        ...process.env,
        PYTHONPATH: [state.workspaceRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
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

function parseSwarmStateForArtifactReview(content: string): {
  tasks: SwarmTaskRecord[]
  artifacts: SwarmArtifactRecord[]
} {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).flatMap((task): SwarmTaskRecord[] => {
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
  const artifacts = (Array.isArray(parsed.artifacts) ? parsed.artifacts : []).flatMap((artifact): SwarmArtifactRecord[] => {
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
  artifact: SwarmArtifactRecord,
  tasks: SwarmTaskRecord[],
  artifacts: SwarmArtifactRecord[]
): string | null {
  if (artifact.status === 'approved') return 'Artifact is already approved.'
  if (artifact.status === 'superseded') return 'Superseded artifacts are obsolete and cannot receive auto-approval intent.'
  if (!['draft', 'ready_for_review', 'changes_requested'].includes(artifact.status)) {
    return 'Artifact status is not eligible for auto-approval intent.'
  }
  if (!artifact.path.trim()) return 'Artifact file path is missing.'
  if (!autoApprovableArtifactKinds.has(artifact.kind)) return 'Artifact kind is not eligible for auto-approval intent.'

  const task = tasks.find((candidate) => candidate.id === artifact.taskId)
  if (!task) return 'Artifact task was not found.'
  if (!artifact.createdBy.trim() && !task.ownerAgentId.trim()) {
    return 'Artifact task has no responsible agent to receive auto-approval intent.'
  }

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

async function assertAutoApprovalAllowed(state: ValidSwarmStatePath, artifactId: string): Promise<SwarmArtifactRecord> {
  const stateContent = await readFile(state.statePath, 'utf8')
  const { tasks, artifacts } = parseSwarmStateForArtifactReview(stateContent)
  const artifact = artifacts.find((candidate) => candidate.id === artifactId)
  if (!artifact) throw new Error('Requested artifact was not found in the Sprint Engine state.')

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
  openArtifact(payload: SwarmArtifactOpenPayload): Promise<SwarmArtifactCommandResult>
  reviewArtifact(
    payload: SwarmArtifactReviewPayload,
    action: SwarmArtifactReviewAction,
    mode: SwarmArtifactReviewMode
  ): Promise<SwarmArtifactCommandResult>
  readyTask(payload: SwarmTaskReadyPayload): Promise<SwarmArtifactCommandResult>
  updateTask(payload: SwarmTaskUpdateInput): Promise<SwarmArtifactCommandResult>
  createTask(payload: SwarmTaskCreateInput): Promise<SwarmArtifactCommandResult>
} {
  return {
    async openArtifact(payload) {
      try {
        const state = validateSwarmStatePath(payload?.statePath)
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
        const state = validateSwarmStatePath(payload?.statePath)
        const artifactId = resolveSwarmArtifactId(payload?.artifactId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        let feedback: string | undefined

        if (action === 'request-changes') {
          feedback = typeof payload?.feedback === 'string' ? payload.feedback.trim() : ''
          if (!feedback) return { ok: false, message: 'Artifact change requests require feedback.' }
        }
        if (mode === 'auto-run') {
          if (action !== 'approve') throw new Error('Auto-run can only approve eligible artifacts.')
          const artifact = await assertAutoApprovalAllowed(state, artifactId)
          const stateContent = await readFile(state.statePath, 'utf8')
          return {
            ok: true,
            data: {
              action: 'approve-intent',
              actor: 'auto-run',
              authorizedUserId: actor.id,
              artifactId,
              artifact,
              stateContent,
            },
          }
        }

        const reviewPayload = {
          statePath: state.statePath,
          artifactId,
          id: actor.id,
          ...(feedback ? { feedback } : {}),
        }
        const toolName = action === 'approve' ? 'sprintengine.artifact.approve' : 'sprintengine.artifact.request_changes'

        const toolResult = await runSprintEngineMcpTool(state, toolName, reviewPayload, actor)
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

        const stateContent = await readFile(state.statePath, 'utf8')
        return {
          ok: true,
          data: {
            action,
            actor: reviewPayload.id,
            authorizedUserId: actor.id,
            artifactId,
            stateContent,
            tool: toolResult.response.result,
          },
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async readyTask(payload) {
      try {
        const state = validateSwarmStatePath(payload?.statePath)
        const taskId = resolveSwarmTaskId(payload?.taskId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const toolResult = await runSprintEngineMcpTool(
          state,
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

        const stateContent = await readFile(state.statePath, 'utf8')
        return {
          ok: true,
          data: {
            action: 'ready',
            actor: actor.id,
            taskId,
            stateContent,
            tool: toolResult.response.result,
          },
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async updateTask(payload) {
      try {
        const state = validateSwarmStatePath(payload?.statePath)
        const taskId = resolveSwarmTaskId(payload?.taskId)
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
        const toolResult = await runSprintEngineMcpTool(state, 'sprintengine.plan.update_task', toolPayload, actor)
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

        const stateContent = await readFile(state.statePath, 'utf8')
        return {
          ok: true,
          data: {
            action: 'update-task',
            actor: actor.id,
            taskId,
            stateContent,
            tool: toolResult.response.result,
          },
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async createTask(payload) {
      try {
        const state = validateSwarmStatePath(payload?.statePath)
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
        const toolResult = await runSprintEngineMcpTool(state, 'sprintengine.plan.add_task', toolPayload, actor)
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
        const stateContent = await readFile(state.statePath, 'utf8')
        return {
          ok: true,
          data: {
            action: 'create-task',
            actor: actor.id,
            taskId,
            stateContent,
            tool: toolResult.response.result,
          },
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
