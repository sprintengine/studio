import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes } from 'crypto'
import http from 'http'
import { resolve } from 'path'
import { findSprintEngineRuntimeRoot } from './mcp-config-service'
import { getManagedPython, managedPythonSpawnEnv } from './managed-runtime'
import { STUDIO_PRODUCT_NAME } from '../shared/product-identity'

export type SprintEngineMcpHubInfo = {
  url: string
  adminToken: string
  pid?: number
}

export type SprintEngineMcpHubStatus = {
  state: 'stopped' | 'starting' | 'ready' | 'failed'
  url?: string
  port?: number
  pid?: number
  activeRunCount: number
  lastError?: string
}

export type SprintEngineMcpRunRegistrationInput = {
  workspaceRoot: string
  statePath: string
  allowedRoots: string[]
  registryRoots: string[]
  userRoot?: string
  actorId: string
  workspaceId?: string
  // When set, the registration is agent-scoped: the returned token binds the
  // MCP session to this agent's role, so tools/list and tool authorization
  // are filtered to that role's capability surface. Without these the
  // registration stays run-scoped (operator surface).
  agentId?: string
  role?: string
  // The declared repo this session works in (MC-1610), derived from the worktree
  // it launches into. The returned token binds the session's claim queue to that
  // repo, so it never claims work living in another project's tree. Absent keeps
  // the session repo-unbound (single-repo runs, operator surface).
  repo?: string
  // The one task this session may work (MC-2136): set when it launches into that
  // task's own worktree under per-task isolation. The returned token binds the
  // claim queue to that task alone, so the session cannot end up editing one
  // task's tree while owning another. Absent on runs that share one worktree.
  taskId?: string
  // The workspace's configured Knowledge Graph root ('' when unset). Sent so
  // the server can gate the workspace_knowledge prompt layer at compose time
  // instead of paying its tokens on every join.
  knowledgeRoot?: string
}

export type SprintEngineMcpRunRegistration = {
  runId: string
  runToken: string
  reused?: boolean
}

export type SprintEngineMcpToolCallInput = {
  runId: string
  toolName: string
  arguments?: Record<string, unknown>
}

export type SprintEngineMcpHubService = {
  ensureStarted(): Promise<SprintEngineMcpHubInfo>
  ensureRunRegistered(input: SprintEngineMcpRunRegistrationInput): Promise<SprintEngineMcpRunRegistration>
  callRunTool(input: SprintEngineMcpToolCallInput): Promise<unknown>
  unregisterRun(runId: string): Promise<void>
  stop(): Promise<void>
  status(): SprintEngineMcpHubStatus
}

export type SprintEngineMcpHubOptions = {
  runtimeRoot?: () => string | null
  pythonCommand?: (runtimeRoot: string) => string
  logMainPerfEvent?: (scope: string, event: string, payload: Record<string, unknown>) => void
  spawnProcess?: typeof spawn
}

export function createSprintEngineMcpHubService(options: SprintEngineMcpHubOptions = {}): SprintEngineMcpHubService {
  const runtimeRoot = options.runtimeRoot ?? findSprintEngineRuntimeRoot
  const pythonCommand = options.pythonCommand ?? defaultPythonCommand
  const logMainPerfEvent = options.logMainPerfEvent
  const spawnProcess = options.spawnProcess ?? spawn

  let state: 'stopped' | 'starting' | 'ready' | 'failed' = 'stopped'
  let child: ChildProcessWithoutNullStreams | null = null
  let info: SprintEngineMcpHubInfo | undefined
  let lastError: string | undefined
  let pending: Promise<SprintEngineMcpHubInfo> | null = null
  let cancelPendingStart: (() => void) | null = null
  let stopping = false
  const activeRunsByKey = new Map<string, SprintEngineMcpRunRegistration>()
  // Keep only the non-secret registration inputs and stable public run ids
  // across a module stop. Disabling Sprint Engine must kill Python, but an
  // already-launched sprint agent should reconnect to the same run id after a
  // live re-enable instead of requiring a terminal relaunch.
  const knownRunsByKey = new Map<string, {
    runId: string
    input: SprintEngineMcpRunRegistrationInput
  }>()
  const pendingRunsByKey = new Map<string, Promise<SprintEngineMcpRunRegistration>>()

  async function ensureStarted(): Promise<SprintEngineMcpHubInfo> {
    if (state === 'ready' && child && !child.killed && info) return info
    if (pending) return pending
    pending = start()
    try {
      return await pending
    } finally {
      pending = null
    }
  }

  async function ensureRunRegistered(input: SprintEngineMcpRunRegistrationInput): Promise<SprintEngineMcpRunRegistration> {
    const hub = await ensureStarted()
    const runKey = runRegistrationKey(input)
    const existing = activeRunsByKey.get(runKey)
    if (existing) return { ...existing, reused: true }
    const pendingRun = pendingRunsByKey.get(runKey)
    if (pendingRun) {
      const registration = await pendingRun
      return { ...registration, reused: true }
    }
    const registrationPromise = registerRun(hub, runKey, input)
    pendingRunsByKey.set(runKey, registrationPromise)
    try {
      return await registrationPromise
    } finally {
      if (pendingRunsByKey.get(runKey) === registrationPromise) {
        pendingRunsByKey.delete(runKey)
      }
    }
  }

  async function registerRun(
    hub: SprintEngineMcpHubInfo,
    runKey: string,
    input: SprintEngineMcpRunRegistrationInput
  ): Promise<SprintEngineMcpRunRegistration> {
    const runId = knownRunsByKey.get(runKey)?.runId ?? randomBytes(32).toString('base64url')
    let response: { runId?: string; runToken?: string }
    try {
      response = await postJson<{ runId?: string; runToken?: string }>(`${hub.url}/runs`, hub.adminToken, {
        runId,
        workspaceRoot: input.workspaceRoot,
        statePath: input.statePath,
        allowedRoots: input.allowedRoots,
        registryRoots: input.registryRoots,
        userRoot: input.userRoot,
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        role: input.role,
        repo: input.repo,
        taskId: input.taskId,
        knowledgeRoot: input.knowledgeRoot ?? '',
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logHubDiagnostic('run-register-failed', {
        workspaceId: input.workspaceId,
        message: lastError,
      })
      throw error
    }
    const registration = {
      runId: response.runId || runId,
      runToken: response.runToken || '',
    }
    if (!registration.runToken) {
      throw new Error('Sprint Engine MCP run registration did not return a run token.')
    }
    activeRunsByKey.set(runKey, registration)
    knownRunsByKey.set(runKey, { runId: registration.runId, input: { ...input } })
    logHubDiagnostic('run-registered', {
      workspaceId: input.workspaceId,
    })
    return registration
  }

  async function unregisterRun(runId: string): Promise<void> {
    let hadRun = false
    for (const [key, registration] of activeRunsByKey) {
      if (registration.runId === runId) {
        activeRunsByKey.delete(key)
        hadRun = true
      }
    }
    for (const [key, known] of knownRunsByKey) {
      if (known.runId === runId) knownRunsByKey.delete(key)
    }
    if (!runId || !info) return
    try {
      await deleteRun(`${info.url}/runs`, info.adminToken, runId)
      if (hadRun) logHubDiagnostic('run-unregistered', {})
    } catch {
      // Run cleanup is best-effort; the hub process also dies on app shutdown.
    }
  }

  async function callRunTool(input: SprintEngineMcpToolCallInput): Promise<unknown> {
    let registration = [...activeRunsByKey.values()].find((candidate) => candidate.runId === input.runId)
    if (!registration) {
      const known = [...knownRunsByKey.values()].find((candidate) => candidate.runId === input.runId)
      if (known) registration = await ensureRunRegistered(known.input)
    }
    if (!info) throw new Error('Sprint Engine MCP hub is not ready.')
    if (!registration) throw new Error(`Sprint Engine MCP run ${input.runId} is not registered.`)

    const initialize = await postMcpJsonRpc(info.url, registration.runToken, {
      jsonrpc: '2.0',
      id: `init-${Date.now()}`,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'multicode-main', version: '1' },
      },
    })
    const sessionId = initialize.sessionId
    if (!sessionId) throw new Error('Sprint Engine MCP initialize did not return a session id.')
    try {
      const called = await postMcpJsonRpc(info.url, registration.runToken, {
        jsonrpc: '2.0',
        id: `call-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: input.toolName,
          arguments: input.arguments ?? {},
        },
      }, sessionId)
      if (called.body && typeof called.body === 'object' && 'error' in called.body) {
        throw new Error(formatJsonRpcFailure(input.toolName, called.body))
      }
      return called.body && typeof called.body === 'object' && 'result' in called.body
        ? (called.body as { result?: unknown }).result
        : called.body
    } finally {
      void deleteMcpSession(info.url, registration.runToken, sessionId).catch(() => {})
    }
  }

  async function start(): Promise<SprintEngineMcpHubInfo> {
    const root = runtimeRoot()
    if (!root) {
      state = 'failed'
      lastError = 'Bundled Sprint Engine MCP runtime was not found.'
      logHubDiagnostic('start-failed', { message: lastError })
      throw new Error(lastError)
    }
    const python = pythonCommand(root)
    const adminToken = randomBytes(32).toString('base64url')
    state = 'starting'
    lastError = undefined
    logHubDiagnostic('starting', {})
    child = spawnProcess(python, ['-m', 'sprintengine_mcp', '--http', '--port', '0'], {
      cwd: root,
      env: managedPythonSpawnEnv({
        ...process.env,
        PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
        SPRINTENGINE_MCP_USER_ID: 'multicode-app',
        SPRINTENGINE_MCP_USER_AUTHORIZED: '1',
        SPRINTENGINE_MCP_HTTP_TOKEN: adminToken,
      }, getManagedPython(root).source),
    })

    return await new Promise<SprintEngineMcpHubInfo>((resolve, reject) => {
      let stderr = ''
      let settled = false
      const timeout = setTimeout(() => {
        fail(new Error('Timed out starting Sprint Engine MCP HTTP hub.'))
      }, 5000)

      const settleStopped = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        child = null
        info = undefined
        activeRunsByKey.clear()
        pendingRunsByKey.clear()
        reject(new Error('Sprint Engine MCP HTTP hub startup was stopped.'))
      }
      cancelPendingStart = settleStopped

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        state = 'failed'
        lastError = error.message
        if (child && !child.killed) child.kill()
        child = null
        info = undefined
        activeRunsByKey.clear()
        pendingRunsByKey.clear()
        logHubDiagnostic('start-failed', { message: lastError })
        reject(error)
      }

      child?.once('error', fail)
      child?.once('exit', (code) => {
        if (stopping) {
          settleStopped()
          return
        }
        if (state !== 'ready') {
          fail(new Error(`Sprint Engine MCP HTTP hub exited before ready with code ${code ?? 'unknown'}.`))
          return
        }
        state = 'failed'
        lastError = `Sprint Engine MCP HTTP hub exited unexpectedly with code ${code ?? 'unknown'}.`
        child = null
        info = undefined
        activeRunsByKey.clear()
        pendingRunsByKey.clear()
        logHubDiagnostic('exited-unexpectedly', { message: lastError })
      })
      child?.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        const line = stderr.split(/\r?\n/).find((candidate) => candidate.trim().startsWith('{'))
        if (!line) return
        try {
          const descriptor = JSON.parse(line) as { host?: string; port?: number; path?: string }
          if (!descriptor.host || typeof descriptor.port !== 'number') return
          clearTimeout(timeout)
          info = {
            url: `http://${descriptor.host}:${descriptor.port}${descriptor.path || '/mcp'}`,
            adminToken,
            pid: child?.pid,
          }
          state = 'ready'
          settled = true
          cancelPendingStart = null
          logHubDiagnostic('ready', {})
          resolve(info)
        } catch {
          // Keep waiting for a JSON startup descriptor.
        }
      })
    })
  }

  async function stop(): Promise<void> {
    const active = child
    const cancelStart = cancelPendingStart
    cancelPendingStart = null
    info = undefined
    child = null
    activeRunsByKey.clear()
    pendingRunsByKey.clear()
    state = 'stopped'
    if (!active || active.killed) {
      cancelStart?.()
      return
    }
    stopping = true
    try {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 1000)
        active.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
        active.kill()
      })
      cancelStart?.()
    } finally {
      stopping = false
      logHubDiagnostic('stopped', {})
    }
  }

  return {
    ensureStarted,
    ensureRunRegistered,
    callRunTool,
    unregisterRun,
    stop,
    status,
  }

  function status(): SprintEngineMcpHubStatus {
    return {
      state,
      url: info?.url,
      port: info ? portFromUrl(info.url) : undefined,
      pid: info?.pid,
      activeRunCount: activeRunsByKey.size,
      lastError,
    }
  }

  function logHubDiagnostic(event: string, payload: Record<string, unknown>): void {
    logMainPerfEvent?.('SprintEngineMcpHub', event, {
      ...status(),
      ...payload,
      adminTokenConfigured: Boolean(info?.adminToken),
    })
  }
}

export type SprintEngineMcpSpawnObserver = {
  onSpawnFailure(message: string): void
}

export type GatedSprintEngineMcpHubService = SprintEngineMcpHubService & {
  /**
   * Called by the Sprint Engine capability module when it registers its
   * sidecar; transfers spawn ownership to the module. Until claimed, spawn
   * paths fail explicitly — so a disabled Sprint Engine module means the hub
   * process never starts, and callers see why instead of a silent fallback.
   */
  claimOwnership(observer: SprintEngineMcpSpawnObserver): void
  /** Live module toggle: disabling immediately stops Python and closes the spawn gate. */
  setModuleEnabled(enabled: boolean): Promise<void>
}

const HUB_UNCLAIMED_MESSAGE =
  'Sprint Engine MCP hub is unavailable because the Sprint Engine module is disabled. ' +
  `Enable Sprint Engine in Settings → Modules; restart ${STUDIO_PRODUCT_NAME} if it was disabled when this app session started.`

// Spawn-ownership gate around the hub service. Process management stays in
// createSprintEngineMcpHubService; this only decides *whether* spawning is
// allowed (module enabled and registered) and reports spawn failures to the
// owning module so they surface as module-identified notifications.
export function createGatedSprintEngineMcpHub(hub: SprintEngineMcpHubService): GatedSprintEngineMcpHubService {
  let observer: SprintEngineMcpSpawnObserver | null = null
  let moduleEnabled = false

  async function guardSpawn<T>(operation: () => Promise<T>): Promise<T> {
    if (!observer || !moduleEnabled) throw new Error(HUB_UNCLAIMED_MESSAGE)
    try {
      return await operation()
    } catch (error) {
      // Only spawn failures are the module's lifecycle concern; run
      // registration errors surface to their callers unchanged.
      if (hub.status().state === 'failed') {
        observer.onSpawnFailure(hub.status().lastError ?? (error instanceof Error ? error.message : String(error)))
      }
      throw error
    }
  }

  return {
    claimOwnership(spawnObserver) {
      observer = spawnObserver
      moduleEnabled = true
    },
    async setModuleEnabled(enabled) {
      moduleEnabled = enabled && observer !== null
      if (!moduleEnabled) await hub.stop()
    },
    ensureStarted: () => guardSpawn(() => hub.ensureStarted()),
    ensureRunRegistered: (input) => guardSpawn(() => hub.ensureRunRegistered(input)),
    callRunTool: (input) => guardSpawn(() => hub.callRunTool(input)),
    unregisterRun: (runId) => hub.unregisterRun(runId),
    stop: () => hub.stop(),
    status: () => hub.status(),
  }
}

function runRegistrationKey(input: SprintEngineMcpRunRegistrationInput): string {
  // Agent-scoped registrations get their own token per agent; run-scoped
  // registrations keep sharing one token per state path. The repo is part of the
  // key (MC-1610) because the token BINDS it: an agent id that later launches in
  // another declared repo's worktree — a persistent planning id following its
  // work across projects — must get a token bound to the repo it is actually in,
  // not the cached one from its first launch.
  const agentSuffix = input.agentId
    ? `::agent::${input.agentId}::${input.role ?? ''}${input.repo ? `::repo::${input.repo}` : ''}`
      + (input.taskId ? `::task::${input.taskId}` : '')
    : ''
  return `${resolve(input.statePath)}${agentSuffix}`
}

function defaultPythonCommand(runtimeRoot: string): string {
  // Bundled CPython first, then the runtime root's `.venv` (dev), then system.
  return getManagedPython(runtimeRoot).command
}

function postJson<T>(url: string, authToken: string, payload: Record<string, unknown>): Promise<T> {
  const body = JSON.stringify(payload)
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        raw += chunk
      })
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(formatHttpFailure('Sprint Engine MCP run registration', response.statusCode, raw)))
          return
        }
        try {
          resolve(JSON.parse(raw) as T)
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

function postMcpJsonRpc(
  url: string,
  runToken: string,
  payload: Record<string, unknown>,
  sessionId?: string
): Promise<{ body: unknown; sessionId?: string }> {
  const body = JSON.stringify(payload)
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runToken}`,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        raw += chunk
      })
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(formatHttpFailure('Sprint Engine MCP JSON-RPC call', response.statusCode, raw)))
          return
        }
        try {
          resolve({
            body: raw ? JSON.parse(raw) : null,
            sessionId: response.headers['mcp-session-id']?.toString(),
          })
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

function deleteMcpSession(url: string, runToken: string, sessionId: string): Promise<void> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${runToken}`,
        'Mcp-Session-Id': sessionId,
      },
    }, (response) => {
      response.resume()
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(`Sprint Engine MCP session cleanup failed with HTTP ${response.statusCode ?? 'unknown'}.`))
          return
        }
        resolve()
      })
    })
    request.on('error', reject)
    request.end()
  })
}

function formatJsonRpcFailure(toolName: string, body: object): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } }).error
  const code = typeof error?.code === 'string' ? error.code : 'jsonrpc_error'
  const message = typeof error?.message === 'string' ? error.message : 'Unknown JSON-RPC error.'
  return `${toolName} failed: ${code}: ${message}`
}

function formatHttpFailure(operation: string, statusCode: number | undefined, rawBody: string): string {
  const status = statusCode ?? 'unknown'
  let suffix = ''
  try {
    const parsed = rawBody ? JSON.parse(rawBody) as { error?: unknown; message?: unknown } : null
    const code = typeof parsed?.error === 'string' ? parsed.error : null
    const message = typeof parsed?.message === 'string' ? parsed.message : null
    suffix = [code, message].filter(Boolean).join(': ')
  } catch {
    suffix = rawBody.trim().slice(0, 200)
  }
  return `${operation} failed with HTTP ${status}${suffix ? ` (${suffix})` : ''}.`
}

function portFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url)
    const value = Number.parseInt(parsed.port, 10)
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function deleteRun(url: string, authToken: string, runId: string): Promise<void> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'X-Multicode-Run-Id': runId,
      },
    }, (response) => {
      response.resume()
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(`Sprint Engine MCP run cleanup failed with HTTP ${response.statusCode ?? 'unknown'}.`))
          return
        }
        resolve()
      })
    })
    request.on('error', reject)
    request.end()
  })
}
