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
import type { RunOutcome } from './process-run'
import type { SubtreeProbeDeps } from './terminal-subtree-probe'
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

    // The distribution's answer: the first session's Claude runs a dev server
    // holding a port; the second's has nothing under it but an MCP helper.
    const distroOutput = [
      '@@SPRINTENGINE_PIDS',
      `${server.key} 100`,
      `${quiet.key} 200`,
      '@@SPRINTENGINE_PS',
      '1 0 0.0 /init',
      '100 1 0.0 bash -li startup.sh',
      '101 100 0.5 claude --session-id wsl-dev-server',
      '102 101 0.2 node vite',
      '200 1 0.0 bash -li startup.sh',
      '201 200 0.1 claude --session-id wsl-quiet',
      '202 201 0.0 node mcp-server.js',
      '@@SPRINTENGINE_LISTEN',
      'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=102,fd=20))',
      '@@SPRINTENGINE_END',
    ].join('\n')
    const probe = (outcome: RunOutcome): SubtreeProbeDeps => ({
      platform: 'win32',
      resolveWslDistro: async () => 'Ubuntu',
      runWslScript: async () => outcome,
    })
    const wellPastIdle = Date.now() + 60 * 60 * 1000

    // A read that fails holds both.
    const failed = await runtimeModule.runGuardedTerminalReapSweeps(wellPastIdle, {
      subtree: probe({ code: 1, stdout: '', stderr: 'wsl: error', timedOut: false }),
    })
    assert.deepEqual(failed.idleReaped, [], 'a failed read never reaps')
    assert.equal(quiet.pty.killed, false)

    const read = await runtimeModule.runGuardedTerminalReapSweeps(wellPastIdle + 1_000, {
      subtree: probe({ code: 0, stdout: distroOutput, stderr: '', timedOut: false }),
    })
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
