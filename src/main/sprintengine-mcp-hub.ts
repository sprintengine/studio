import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import http from 'http'
import { join } from 'path'
import { findSprintEngineRuntimeRoot } from './mcp-config-service'

export type SprintEngineMcpHubInfo = {
  url: string
  authTokenEnvVar: string
  authToken: string
  pid?: number
}

export type SprintEngineMcpHubStatus = {
  state: 'stopped' | 'starting' | 'ready' | 'failed'
  url?: string
  port?: number
  pid?: number
  activeSessionCount: number
  lastError?: string
}

export type SprintEngineMcpSessionRegistrationInput = {
  workspaceRoot: string
  statePath: string
  allowedRoots: string[]
  registryRoots: string[]
  userRoot?: string
  actorId: string
  workspaceId?: string
  agentId: string
  role: string
  cli: string
}

export type SprintEngineMcpSessionRegistration = {
  sessionId: string
  headerName: string
  headers: Record<string, string>
}

export type SprintEngineMcpHubService = {
  ensureStarted(): Promise<SprintEngineMcpHubInfo>
  registerSession(input: SprintEngineMcpSessionRegistrationInput): Promise<SprintEngineMcpSessionRegistration>
  unregisterSession(sessionId: string): Promise<void>
  stop(): Promise<void>
  status(): SprintEngineMcpHubStatus
}

export type SprintEngineMcpHubOptions = {
  runtimeRoot?: () => string | null
  pythonCommand?: (runtimeRoot: string) => string
  authTokenEnvVar?: string
  logMainPerfEvent?: (scope: string, event: string, payload: Record<string, unknown>) => void
  spawnProcess?: typeof spawn
}

const DEFAULT_AUTH_TOKEN_ENV_VAR = 'MULTICODE_SPRINTENGINE_MCP_TOKEN'

export function createSprintEngineMcpHubService(options: SprintEngineMcpHubOptions = {}): SprintEngineMcpHubService {
  const runtimeRoot = options.runtimeRoot ?? findSprintEngineRuntimeRoot
  const pythonCommand = options.pythonCommand ?? defaultPythonCommand
  const authTokenEnvVar = options.authTokenEnvVar ?? DEFAULT_AUTH_TOKEN_ENV_VAR
  const logMainPerfEvent = options.logMainPerfEvent
  const spawnProcess = options.spawnProcess ?? spawn

  let state: 'stopped' | 'starting' | 'ready' | 'failed' = 'stopped'
  let child: ChildProcessWithoutNullStreams | null = null
  let info: SprintEngineMcpHubInfo | undefined
  let lastError: string | undefined
  let pending: Promise<SprintEngineMcpHubInfo> | null = null
  let cancelPendingStart: (() => void) | null = null
  let stopping = false
  const activeSessionIds = new Set<string>()

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

  async function registerSession(input: SprintEngineMcpSessionRegistrationInput): Promise<SprintEngineMcpSessionRegistration> {
    const hub = await ensureStarted()
    const sessionId = randomBytes(32).toString('base64url')
    let response: { sessionId?: string; headerName?: string }
    try {
      response = await postJson<{ sessionId?: string; headerName?: string }>(`${hub.url}/sessions`, hub.authToken, {
        sessionId,
        workspaceRoot: input.workspaceRoot,
        statePath: input.statePath,
        allowedRoots: input.allowedRoots,
        registryRoots: input.registryRoots,
        userRoot: input.userRoot,
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        role: input.role,
        cli: input.cli,
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logHubDiagnostic('session-register-failed', {
        cli: input.cli,
        role: input.role,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        message: lastError,
      })
      throw error
    }
    const headerName = response.headerName || 'X-Multicode-Session-Id'
    const registeredSessionId = response.sessionId || sessionId
    activeSessionIds.add(registeredSessionId)
    logHubDiagnostic('session-registered', {
      cli: input.cli,
      role: input.role,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    })
    return {
      sessionId: registeredSessionId,
      headerName,
      headers: { [headerName]: registeredSessionId },
    }
  }

  async function unregisterSession(sessionId: string): Promise<void> {
    const hadSession = activeSessionIds.delete(sessionId)
    if (!sessionId || !info) return
    try {
      await deleteSession(`${info.url}/sessions`, info.authToken, sessionId)
      if (hadSession) logHubDiagnostic('session-unregistered', {})
    } catch {
      // Session cleanup is best-effort; the hub process also dies on app shutdown.
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
    const authToken = randomBytes(32).toString('base64url')
    state = 'starting'
    lastError = undefined
    logHubDiagnostic('starting', {})
    child = spawnProcess(python, ['-m', 'sprintengine_mcp', '--http', '--port', '0'], {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
        SPRINTENGINE_MCP_USER_ID: 'multicode-app',
        SPRINTENGINE_MCP_USER_AUTHORIZED: '1',
        SPRINTENGINE_MCP_HTTP_TOKEN: authToken,
        [authTokenEnvVar]: authToken,
      },
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
        activeSessionIds.clear()
        if (process.env[authTokenEnvVar] === authToken) delete process.env[authTokenEnvVar]
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
        activeSessionIds.clear()
        if (process.env[authTokenEnvVar] === authToken) delete process.env[authTokenEnvVar]
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
        activeSessionIds.clear()
        if (process.env[authTokenEnvVar] === authToken) delete process.env[authTokenEnvVar]
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
            authTokenEnvVar,
            authToken,
            pid: child?.pid,
          }
          process.env[authTokenEnvVar] = authToken
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
    const activeToken = info?.authToken
    const cancelStart = cancelPendingStart
    cancelPendingStart = null
    info = undefined
    child = null
    activeSessionIds.clear()
    state = 'stopped'
    if (activeToken && process.env[authTokenEnvVar] === activeToken) delete process.env[authTokenEnvVar]
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
    registerSession,
    unregisterSession,
    stop,
    status,
  }

  function status(): SprintEngineMcpHubStatus {
    return {
      state,
      url: info?.url,
      port: info ? portFromUrl(info.url) : undefined,
      pid: info?.pid,
      activeSessionCount: activeSessionIds.size,
      lastError,
    }
  }

  function logHubDiagnostic(event: string, payload: Record<string, unknown>): void {
    logMainPerfEvent?.('SprintEngineMcpHub', event, {
      ...status(),
      ...payload,
      authTokenConfigured: Boolean(info?.authTokenEnvVar),
    })
  }
}

function defaultPythonCommand(runtimeRoot: string): string {
  const venvPython = process.platform === 'win32'
    ? join(runtimeRoot, '.venv', 'Scripts', 'python.exe')
    : join(runtimeRoot, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  return process.platform === 'win32' ? 'python' : 'python3'
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
          reject(new Error(formatHttpFailure('Sprint Engine MCP session registration', response.statusCode, raw)))
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

function deleteSession(url: string, authToken: string, sessionId: string): Promise<void> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'X-Multicode-Session-Id': sessionId,
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
