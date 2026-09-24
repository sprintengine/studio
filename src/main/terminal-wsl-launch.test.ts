// A launch on a WSL machine, end to end through the runtime with a stand-in
// helper: the startup script is written inside the distribution before the
// terminal starts and run from there; an agent's MCP bridge gets a token that
// lives exactly as long as its session; a plain terminal waits for the helper
// too and says why when it cannot; and quitting ends what the sessions left
// running inside the distribution.

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import type { WebContents } from 'electron'
import type { McpSettings } from '../shared/electron-api'
import { standIn } from '../../tests/stand-in'
import { STUB_HELPER_INFO, stubWslHelper, type StubHelper } from '../../tests/wsl-helper-stub'
import { WslSetupError } from './hosts/wsl-setup-error'

type MockPty = {
  pid: number
  killed: boolean
  write(data: string): void
  resize(): void
  kill(): void
  onData(callback: (data: string) => void): { dispose(): void }
  onExit(callback: (event: { exitCode: number }) => void): { dispose(): void }
}

type Harness = {
  helper: StubHelper
  spawned: Array<{ command: string; args: string[]; process: MockPty; requestsBefore: number }>
  runtime: ReturnType<(typeof import('./terminal-runtime'))['createTerminalRuntime']>
  spawn(payload: Record<string, unknown>): Promise<{ ok: boolean; message?: string }>
  workspaceRoot: string
}

let restore: (() => void) | null = null

beforeEach(() => {
  restore = null
})

afterEach(() => {
  restore?.()
})

// The runtime keeps the pty module it first imported, so the stand-in is one
// object that records into whichever case is running.
let nextPid = 80_000
let current: { spawned: Harness['spawned']; helper: StubHelper } | null = null
const mockPty = {
  spawn(command: string, args: string[]): MockPty {
    const exits: Array<(event: { exitCode: number }) => void> = []
    const process: MockPty = {
      pid: nextPid++,
      killed: false,
      write: () => undefined,
      resize: () => undefined,
      kill() {
        if (this.killed) return
        this.killed = true
        setImmediate(() => exits.forEach((callback) => callback({ exitCode: 0 })))
      },
      onData: () => ({ dispose: () => undefined }),
      onExit: (callback) => {
        exits.push(callback)
        return { dispose: () => undefined }
      },
    }
    current?.spawned.push({ command, args, process, requestsBefore: current.helper.requests.length })
    return process
  },
}

async function harness(handlers: Record<string, (params: never) => unknown> = {}): Promise<Harness> {
  const spawned: Harness['spawned'] = []
  const helper = stubWslHelper('Ubuntu', {
    home: () => ({ home: '/home/dev' }),
    'files.ensureTree': () => ({ current: true }),
    'session.write': () => ({ paths: [] }),
    'session.remove': () => ({}),
    'proc.killSession': () => ({ killed: [] }),
    ...handlers,
  })
  current = { spawned, helper }
  const sender = { isDestroyed: () => false, send: () => undefined }
  restore = standIn({
    electron: {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => join(tmpdir(), 'sprintengine-wsl-launch-user-data'),
      },
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: sender }] },
    },
    'node-pty': mockPty,
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
  runtimeModule.__setAgentCliPreflightForTest({ platform: 'win32', deps: { listEntries: () => [] } })
  const runtime = runtimeModule.createTerminalRuntime({ diagnosticsEnabled: false, logMainPerfEvent: () => undefined })
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-wsl-launch-'))
  const spawn = async (payload: Record<string, unknown>) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      return await runtime.ipcHandlers.spawnTerminal(
        sender as unknown as WebContents,
        {
          cols: 120,
          rows: 30,
          cwd: workspaceRoot,
          visible: false,
          hostId: 'wsl:Ubuntu',
          ...payload,
        } as never,
      )
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
  }
  return { helper, spawned, runtime, spawn, workspaceRoot }
}

const agent = (sessionId: string) => ({
  sessionId,
  cli: 'claude-code',
  kind: 'agent',
  shellOnly: false,
  workspaceId: `ws-${sessionId}`,
  agentId: sessionId,
  cliRuntimes: { 'claude-code': { command: 'claude' } },
  mcpSettings: { syncEnabled: false, servers: {} } satisfies McpSettings,
})

type SessionWrite = { files: Array<{ path: string; b64: string }> }
const writes = (helper: StubHelper) =>
  helper.requests
    .filter((request) => request.method === 'session.write')
    .map((request) => request.params as SessionWrite)
const decoded = (b64: string) => Buffer.from(b64, 'base64').toString('utf8')

test('an agent on a WSL machine runs its startup script from inside the distribution, written first', async () => {
  const h = await harness()
  const result = await h.spawn(agent('wsl-a'))
  assert.equal(result.ok, true, JSON.stringify(result))
  const call = h.spawned.at(-1)
  assert.ok(call)
  assert.equal(call.command, 'wsl.exe')
  const script = call.args.at(-1) ?? ''
  assert.ok(script.startsWith(`${STUB_HELPER_INFO.sessionDir}/`), script)
  assert.ok(!call.args.some((arg) => arg.startsWith('/mnt/')), `nothing through a drive mount: ${call.args}`)
  const written = writes(h.helper)
  assert.equal(written.length, 1)
  assert.equal(`${STUB_HELPER_INFO.sessionDir}/${written[0].files[0].path}`, script)
  const writeAt = h.helper.requests.findIndex((request) => request.method === 'session.write')
  assert.ok(writeAt < call.requestsBefore, 'the script was written before the terminal started')
  const text = decoded(written[0].files[0].b64)
  assert.ok(text.includes(`'${STUB_HELPER_INFO.pidDir}'`), "the shell records its pid in the helper's own directory")

  // The launch's MCP token: exported by the script, live while the session is.
  assert.equal(h.helper.tokens.size, 1)
  const [token] = [...h.helper.tokens]
  assert.ok(text.includes(`export SPRINTENGINE_MCP_CHANNEL_TOKEN='${token}'`), text)
  h.runtime.ipcHandlers.killTerminal('wsl-a')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(h.helper.tokens.size, 0, 'revoked with the session')
  assert.ok(
    h.helper.requests.some(
      (request) =>
        request.method === 'session.remove' &&
        (request.params as { names: string[] }).names.includes(script.slice(STUB_HELPER_INFO.sessionDir.length + 1)),
    ),
    'its launch files are removed there',
  )
  await h.runtime.shutdown()
})

test('a plain terminal on a WSL machine waits for the helper and carries no token', async () => {
  const h = await harness()
  const result = await h.spawn({ sessionId: 'wsl-plain', kind: 'terminal', shellOnly: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(h.helper.starts > 0, 'the helper was started for it')
  assert.equal(h.helper.tokens.size, 0)
  const text = decoded(writes(h.helper)[0].files[0].b64)
  assert.ok(!text.includes('SPRINTENGINE_MCP_CHANNEL_TOKEN'))
  await h.runtime.shutdown()
})

test('a WSL launch whose helper cannot start fails with the reason, and nothing is started', async () => {
  const h = await harness()
  h.helper.failWith = new WslSetupError("Couldn't set up WSL: no network to download Node.js", {
    fatal: true,
    code: 'node-download',
  })
  for (const payload of [{ sessionId: 'wsl-down-plain', kind: 'terminal', shellOnly: true }, agent('wsl-down-agent')]) {
    const result = await h.spawn(payload)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /no network to download Node\.js/u)
  }
  assert.equal(h.spawned.length, 0)
  assert.equal(h.helper.tokens.size, 0)
  await h.runtime.shutdown()
})

test('a startup script the helper could not write fails the launch clearly, and its token goes with it', async () => {
  const h = await harness({
    'session.write': () => {
      throw new Error('No space left on device')
    },
  })
  const result = await h.spawn(agent('wsl-nospace'))
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /Couldn't write this terminal's startup script into WSL: Ubuntu: No space left/u)
  assert.equal(h.spawned.length, 0, 'no terminal runs a script that is not there')
  assert.equal(h.helper.tokens.size, 0, 'the token issued for it is revoked')
  await h.runtime.shutdown()
})

test('quitting ends what WSL sessions left running, at once, without starting a stopped helper', async () => {
  const kills: Array<{ cliSessionId: string; key: string }> = []
  const h = await harness({
    'proc.killSession': (params: { cliSessionId: string; key: string }) => {
      kills.push(params)
      return { killed: [4242] }
    },
  })
  assert.equal((await h.spawn(agent('wsl-q1'))).ok, true)
  assert.equal((await h.spawn({ sessionId: 'wsl-q2', kind: 'terminal', shellOnly: true })).ok, true)
  const keys = h.spawned.map((call) => {
    const script = call.args.at(-1) ?? ''
    return script.slice(script.lastIndexOf('/') + 1).replace(/\.sh$/u, '')
  })
  const started = Date.now()
  await h.runtime.shutdown()
  assert.deepEqual(kills.map((kill) => kill.key).sort(), [...keys].sort(), "each session's tree, by its pid file")
  assert.ok(Date.now() - started < 1_800, 'no survivor grace on the way out')

  // With the helper already gone, quitting does not start it again.
  const second = await harness()
  assert.equal((await second.spawn(agent('wsl-q3'))).ok, true)
  await second.helper.shutdown()
  const startsBefore = second.helper.starts
  await second.runtime.shutdown()
  assert.equal(second.helper.starts, startsBefore)
})
