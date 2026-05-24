import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebContents } from 'electron'
import type { McpSettings } from '../shared/electron-api'

type RuntimeModule = typeof import('./terminal-runtime')
type SyncMcpConfig = NonNullable<Parameters<typeof import('./terminal-runtime')['createTerminalRuntime']>[0]['syncMcpConfig']>
type SyncInput = Parameters<SyncMcpConfig>[0]
type SyncResult = Awaited<ReturnType<SyncMcpConfig>>

type SentEvent = {
  channel: string
  payload: unknown
}

type MockPtyProcess = {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(callback: (data: string) => void): { dispose(): void }
  onExit(callback: (event: { exitCode: number, signal?: number }) => void): { dispose(): void }
  writes: string[]
  killed: boolean
}

type SpawnCall = {
  command: string
  args: string[]
  options: Record<string, unknown>
  process: MockPtyProcess
}

const mockPty = {
  spawnCalls: [] as SpawnCall[],
  spawn(command: string, args: string[], options: Record<string, unknown>): MockPtyProcess {
    const process = createMockPtyProcess()
    mockPty.spawnCalls.push({ command, args, options, process })
    return process
  },
}

const mockSender = createMockWebContents()
const mockElectron = {
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => join(tmpdir(), 'multicode-terminal-runtime-test-user-data'),
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: mockSender,
      },
    ],
  },
}

const moduleWithLoad = Module as typeof Module & {
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown
}
const originalLoad = moduleWithLoad._load

moduleWithLoad._load = function loadWithMainProcessMocks(
  request: string,
  parent: NodeModule | null,
  isMain: boolean
): unknown {
  if (request === 'electron') return mockElectron
  if (request === 'node-pty') return mockPty
  return originalLoad.call(this, request, parent, isMain)
}

async function main(): Promise<void> {
  try {
    const runtimeModule = require('./terminal-runtime') as RuntimeModule
    await assertSprintEngineSpawnSyncsManagedMcpBeforePtySpawn(runtimeModule)
    await assertSprintEngineSpawnReportsSyncFailureWithoutPtySpawn(runtimeModule)
  } finally {
    moduleWithLoad._load = originalLoad
  }
}

async function assertSprintEngineSpawnSyncsManagedMcpBeforePtySpawn(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-success-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const order: string[] = []
  const syncInputs: SyncInput[] = []
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (input): Promise<SyncResult> => {
      order.push('sync')
      syncInputs.push(input)
      return { ok: true }
    },
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_success',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: true, servers: {} } satisfies McpSettings,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(order, ['sync'], JSON.stringify({ result, spawnCalls: mockPty.spawnCalls.length, sent: mockSender.sent }))
    assert.equal(mockPty.spawnCalls.length, 1)
    assert.equal(syncInputs.length, 1)
    assert.deepEqual(syncInputs[0]?.clients, ['codex'])
    assert.equal(syncInputs[0]?.workspaceRoot, workspaceRoot)
    assert.equal(syncInputs[0]?.managedSprintEngine?.statePath, sprintEngineStatePath)
    assert.equal(syncInputs[0]?.managedSprintEngine?.workspaceRoot, workspaceRoot)
    assert.deepEqual(syncInputs[0]?.managedSprintEngine?.allowedRoots, [workspaceRoot])
    assert.equal(runtime.ipcHandlers.getTerminalStatus('session_success').processAlive, true)
  } finally {
    await runtime.shutdown()
  }
}

async function assertSprintEngineSpawnReportsSyncFailureWithoutPtySpawn(runtimeModule: RuntimeModule): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-terminal-runtime-failure-'))
  const sprintEngineStatePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'run.yaml')
  const failureMessage = 'MCP sync writer for format "generic" is not implemented yet; cannot launch a Sprint Engine agent.'
  mockPty.spawnCalls = []
  mockSender.sent = []

  const runtime = runtimeModule.createTerminalRuntime({
    diagnosticsEnabled: false,
    requireAuthenticatedUser: () => undefined,
    logMainPerfEvent: () => undefined,
    syncMcpConfig: async (): Promise<SyncResult> => ({ ok: false, message: failureMessage }),
  })

  try {
    const result = await runtime.ipcHandlers.spawnTerminal(mockSender as unknown as WebContents, {
      sessionId: 'session_failure',
      cols: 120,
      rows: 30,
      cwd: workspaceRoot,
      sprintEngineStatePath,
      cli: 'codex',
      kind: 'agent',
      shellOnly: false,
      mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
    })
    const failedSnapshot = runtime.ipcHandlers.listTerminals().find((session) => session.sessionId === 'session_failure')

    assert.deepEqual(result, {
      ok: false,
      sessionId: 'session_failure',
      message: failureMessage,
      exitCode: 1,
    })
    assert.equal(mockPty.spawnCalls.length, 0)
    assert.equal(failedSnapshot?.processAlive, false)
    assert.deepEqual(failedSnapshot?.activity, {
      kind: 'failed',
      at: failedSnapshot?.activity.kind === 'failed' ? failedSnapshot.activity.at : undefined,
      exitCode: 1,
      message: failureMessage,
    })
    assert.deepEqual(
      mockSender.sent.filter((event) => event.channel.startsWith('terminal:error:') || event.channel.startsWith('terminal:exit:')),
      [
        { channel: 'terminal:error:session_failure', payload: failureMessage },
        { channel: 'terminal:exit:session_failure', payload: 1 },
      ]
    )
  } finally {
    await runtime.shutdown()
  }
}

function createMockWebContents(): { isDestroyed(): boolean, send(channel: string, payload: unknown): void, sent: SentEvent[] } {
  return {
    sent: [],
    isDestroyed: () => false,
    send(channel: string, payload: unknown): void {
      this.sent.push({ channel, payload })
    },
  }
}

function createMockPtyProcess(): MockPtyProcess {
  return {
    writes: [],
    killed: false,
    write(data: string): void {
      this.writes.push(data)
    },
    resize: () => undefined,
    kill(): void {
      this.killed = true
    },
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
