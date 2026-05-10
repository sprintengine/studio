import type { WebContents } from 'electron'
import type {
  AgentCli,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../shared/electron-api'
import type {
  SwitchboardExecutionProviderKind,
  SwitchboardExecutionProviderRef,
  SwitchboardExecutionStatus,
} from '../shared/switchboard'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'

export type SwitchboardExecutionStartInput = {
  executionId: string
  workspaceRoot: string
  workspaceId?: string
  taskId: string
  role: string
  provider: SwitchboardExecutionProviderKind
  prompt: string
  cli: AgentCli
}

export type SwitchboardExecutionHandle = {
  executionId: string
  provider: SwitchboardExecutionProviderKind
  providerRef: SwitchboardExecutionProviderRef
}

export type SwitchboardExecutionSnapshot = SwitchboardExecutionHandle & {
  status: SwitchboardExecutionStatus
  lastSeenAt: string
}

export type SwitchboardExecutionProvider = {
  kind: SwitchboardExecutionProviderKind
  canStart(input: SwitchboardExecutionStartInput): Promise<{ ok: true } | { ok: false; message: string }>
  start(input: SwitchboardExecutionStartInput): Promise<SwitchboardExecutionHandle>
  list(input: { workspaceRoot: string }): Promise<SwitchboardExecutionSnapshot[]>
  getStatus(input: { executionId: string; providerRef: SwitchboardExecutionProviderRef }): Promise<SwitchboardExecutionStatus>
  sendInput?(input: { executionId: string; text: string }): Promise<void>
  stop?(input: { executionId: string }): Promise<void>
}

type DesktopTerminalProviderDependencies = {
  sender: () => WebContents | null
  spawnTerminal(sender: WebContents, payload: TerminalSpawnPayload): Promise<TerminalSpawnResult>
  listTerminals(): TerminalSessionSnapshot[]
  killTerminal?(sessionId: string): void
}

function nowIso(): string {
  return new Date().toISOString()
}

function sessionIdFor(executionId: string, taskId: string): string {
  return `switchboard_${taskId.replace(/-/g, '')}_${executionId.replace(/[^a-zA-Z0-9_-]/g, '')}`
}

export function createDesktopTerminalExecutionProvider(
  deps: DesktopTerminalProviderDependencies
): SwitchboardExecutionProvider {
  const sessionsByExecutionId = new Map<string, string>()
  return {
    kind: 'desktop-terminal',

    async canStart() {
      const sender = deps.sender()
      if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
        return { ok: false, message: 'Desktop terminal provider requires an active Electron renderer.' }
      }
      return { ok: true }
    },

    async start(input) {
      const sender = deps.sender()
      if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
        throw new Error('Desktop terminal provider requires an active Electron renderer.')
      }
      const sessionId = sessionIdFor(input.executionId, input.taskId)
      const spawned = await deps.spawnTerminal(sender, {
        sessionId,
        cols: 120,
        rows: 30,
        cwd: input.workspaceRoot,
        cli: input.cli,
        initialPrompt: input.prompt,
        kind: 'agent',
        workspaceId: input.workspaceId,
        agentId: `switchboard-${input.role}`,
        terminalId: sessionId,
        executionMode: 'current_workspace',
        cliPermissionPreset: 'auto_workspace',
      })
      if (!spawned.ok) throw new Error(spawned.message)
      sessionsByExecutionId.set(input.executionId, spawned.sessionId)
      return {
        executionId: input.executionId,
        provider: 'desktop-terminal',
        providerRef: { sessionId: spawned.sessionId },
      }
    },

    async list() {
      return deps
        .listTerminals()
        .filter((session) => session.sessionId.startsWith('switchboard_'))
        .map((session) => ({
          executionId: executionIdFromSessionId(session.sessionId) ?? session.sessionId,
          provider: 'desktop-terminal' as const,
          providerRef: { sessionId: session.sessionId },
          status: session.running ? 'active' : 'missing',
          lastSeenAt: nowIso(),
        }))
    },

    async getStatus(input) {
      const sessionId = typeof input.providerRef.sessionId === 'string' ? input.providerRef.sessionId : null
      if (!sessionId) return 'missing'
      const session = deps.listTerminals().find((candidate) => candidate.sessionId === sessionId)
      return session?.running ? 'active' : 'missing'
    },

    async stop(input) {
      const sessionId = sessionsByExecutionId.get(input.executionId)
      if (sessionId && deps.killTerminal) deps.killTerminal(sessionId)
      sessionsByExecutionId.delete(input.executionId)
    },
  }
}

function executionIdFromSessionId(sessionId: string): string | null {
  const match = /^switchboard_[0-9a-f]{32}_(.+)$/i.exec(sessionId)
  return match?.[1] ?? null
}

export function createUnavailableExecutionProvider(kind: Exclude<SwitchboardExecutionProviderKind, 'desktop-terminal'>): SwitchboardExecutionProvider {
  return {
    kind,
    async canStart() {
      return { ok: false, message: `${kind} execution provider is defined but not implemented yet.` }
    },
    async start() {
      throw new Error(`${kind} execution provider is defined but not implemented yet.`)
    },
    async list() {
      return []
    },
    async getStatus() {
      return 'missing'
    },
  }
}
