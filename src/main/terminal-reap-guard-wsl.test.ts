// The idle reaper on Windows, end to end through the runtime: before this, a
// Windows session's subtree could not be read at all, so every one was held
// forever and no agent there was ever suspended. A WSL session is read inside
// its distribution, keyed by the pid file its startup script writes; a read
// that fails still holds.

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { WebContents } from 'electron'
import type { McpSettings } from '../shared/electron-api'
import { standIn } from '../../tests/stand-in'
import { stubWslHelper } from '../../tests/wsl-helper-stub'
import type { SubtreeLiveReason } from './terminal-subtree-probe'
import { wslSessionPidKey } from './hosts/wsl-distro'

type MockPty = {
  pid: number
  killed: boolean
  write(data: string): void
  resize(): void
  kill(): void
  onData(callback: (data: string) => void): { dispose(): void }
  onExit(callback: (event: { exitCode: number }) => void): { dispose(): void }
}

test('an idle WSL agent is suspended once its distribution says it is at rest, and held otherwise', async () => {
  let nextPid = 70_000
  const spawned: Array<{ command: string; args: string[]; process: MockPty }> = []
  const mockPty = {
    spawn(command: string, args: string[]): MockPty {
      const process: MockPty = {
        pid: nextPid++,
        killed: false,
        write: () => undefined,
        resize: () => undefined,
        kill() {
          this.killed = true
        },
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
      }
      spawned.push({ command, args, process })
      return process
    },
  }
  const sender = { isDestroyed: () => false, send: () => undefined }
  const restore = standIn({
    electron: {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => join(tmpdir(), 'sprintengine-reap-guard-wsl-user-data'),
      },
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: sender }] },
    },
    'node-pty': mockPty,
  })
  try {
    // The distribution's helper, standing in: its /proc read answers from
    // `verdicts`, and a read can be made to fail.
    let verdicts: Record<string, SubtreeLiveReason | null> | null = null
    const helper = stubWslHelper('Ubuntu', {
      home: () => ({ home: '/home/dev' }),
      'files.ensureTree': () => ({ current: true }),
      'proc.snapshot': (params: { keys: string[] }) => {
        if (!verdicts) throw new Error('the read failed')
        const answer: Record<string, SubtreeLiveReason | null> = {}
        for (const key of params.keys) if (key in verdicts) answer[key] = verdicts[key]
        return { verdicts: answer }
      },
      'proc.killSession': () => ({ killed: [] }),
      'session.write': () => ({ paths: [] }),
      'session.remove': () => ({}),
    })
    const registryModule = await import('./hosts/host-registry')
    registryModule.installHostRegistry(
      registryModule.createHostRegistry({
        platform: 'win32',
        readHostSettings: () => ({}),
        createWslHelper: () => helper,
      }),
    )
    const runtimeModule = await import('./terminal-runtime')
    runtimeModule.setKeepRecentTerminalsAlive(0)
    runtimeModule.__setAgentCliPreflightForTest({ platform: 'win32', deps: { listEntries: () => [] } })
    const runtime = runtimeModule.createTerminalRuntime({
      diagnosticsEnabled: false,
      logMainPerfEvent: () => undefined,
    })
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-reap-guard-wsl-'))

    const spawnWslAgent = async (sessionId: string): Promise<{ key: string; pty: MockPty }> => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const result = await runtime.ipcHandlers.spawnTerminal(sender as unknown as WebContents, {
          sessionId,
          cols: 120,
          rows: 30,
          cwd: workspaceRoot,
          cli: 'claude-code',
          kind: 'agent',
          shellOnly: false,
          workspaceId: `ws-${sessionId}`,
          agentId: sessionId,
          visible: false,
          cliRuntimes: { 'claude-code': { command: 'claude' } },
          hostId: 'wsl:Ubuntu',
          mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
        })
        assert.equal(result.ok, true, JSON.stringify(result))
      } finally {
        if (platform) Object.defineProperty(process, 'platform', platform)
      }
      const call = spawned[spawned.length - 1]
      assert.equal(call.command, 'wsl.exe')
      const key = wslSessionPidKey(call.args.at(-1))
      assert.ok(key, 'the launch names a startup script whose name keys the pid file')
      runtime.ingestAgentStateFrame({
        type: 'agent_state',
        agentId: sessionId,
        workspaceId: `ws-${sessionId}`,
        sessionId: null,
        event: 'Stop',
        ts: Date.now(),
      })
      return { key, pty: call.process }
    }

    const server = await spawnWslAgent('wsl-dev-server')
    const quiet = await spawnWslAgent('wsl-quiet')

    assert.equal(helper.retained.size, 2, 'each live WSL session holds the helper')
    const wellPastIdle = Date.now() + 60 * 60 * 1000

    // A read that fails holds both.
    const failed = await runtimeModule.runGuardedTerminalReapSweeps(wellPastIdle)
    assert.deepEqual(failed.idleReaped, [], 'a failed read never reaps')
    assert.equal(quiet.pty.killed, false)

    // The distribution's answer: the first session's Claude runs a dev server
    // holding a port; the second's has nothing under it but an MCP helper.
    verdicts = { [server.key]: 'listening_port', [quiet.key]: null }
    const read = await runtimeModule.runGuardedTerminalReapSweeps(wellPastIdle + 1_000)
    const snapshot = helper.requests.filter((request) => request.method === 'proc.snapshot').at(-1)
    assert.deepEqual(
      (snapshot?.params as { keys: string[] }).keys.sort(),
      [server.key, quiet.key].sort(),
      'one read for the distribution, keyed by the pid files the startup scripts write',
    )
    assert.ok(!read.idleReaped.includes('wsl-dev-server'), 'the session with a listening child is held')
    assert.equal(server.pty.killed, false)
    assert.ok(read.idleReaped.includes('wsl-quiet'), 'the session at rest is suspended')
    assert.equal(quiet.pty.killed, true)

    runtime.ipcHandlers.killTerminal('wsl-dev-server')
    runtime.ipcHandlers.killTerminal('wsl-quiet')
    await runtime.shutdown()
  } finally {
    restore()
  }
})
