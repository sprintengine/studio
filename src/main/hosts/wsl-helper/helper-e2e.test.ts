// The WSL helper end to end, on this machine: main's real client starts the
// real helper through a real `sh -s` (standing in for `wsl.exe --exec sh -s`),
// the app's real hook reporter and real MCP bridge talk to it over its real
// Unix sockets, and a stub automation server stands where main's own sits.
// Everything the helper does is plain Node on Linux, so only `wsl.exe` itself
// and /proc (macOS has none) are not exercised here.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { HELPER_ENTRY } from '../../../../tests/wsl-helper-modules'
import { parseAgentStateFrame } from '../../agent-state'
import {
  createWslHelperClient,
  type HelperProcess,
  type WslHelperClient,
  type WslHelperEvent,
} from '../wsl-helper-client'

const REPORTER = join(process.cwd(), 'resources', 'hooks', 'sprintengine-agent-state.mjs')
const BRIDGE = join(process.cwd(), 'resources', 'automation', 'mcp-stdio-bridge.mjs')

let temp = ''
let automation: Server
let automationPath = ''
const automationLines: string[] = []
const events: WslHelperEvent[] = []
let client: WslHelperClient

// A socket path must stay short (about 100 bytes), so the fixture lives in /tmp.
function shortTemp(prefix: string): string {
  return mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), prefix))
}

beforeAll(async () => {
  temp = shortTemp('se-e2e-')
  mkdirSync(join(temp, 'home'))
  automationPath = join(temp, 'automation.sock')
  // Stands in for the app's automation server: it records what it is sent and
  // answers each JSON-RPC request with a result of its own.
  automation = createServer((socket: Socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        automationLines.push(line)
        const message = JSON.parse(line) as { id?: number }
        if (message.id !== undefined)
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })}\n`)
        newline = buffer.indexOf('\n')
      }
    })
  })
  await new Promise<void>((resolve) => automation.listen(automationPath, resolve))

  client = createWslHelperClient({
    distro: 'Ubuntu',
    appVersion: '0.4.0',
    profile: 'abc123def456',
    spawnShell: (): HelperProcess =>
      spawn('sh', ['-s'], {
        cwd: join(temp, 'home'),
        env: {
          PATH: process.env.PATH,
          HOME: join(temp, 'home'),
          SPRINTENGINE_HELPER_SOCKET_BASE: join(temp, 'rt'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    // The installed layout is proved by the install tests; here the script
    // execs the helper straight from the source tree.
    launchScript: async () => `exec '${process.execPath}' '${HELPER_ENTRY}' --profile 'abc123def456'`,
    install: async () => assert.fail('nothing to install'),
    prewarm: async () => undefined,
    unready: async () => undefined,
    onEvent: (event) => events.push(event),
    connectAutomation: () => connect({ path: automationPath, allowHalfOpen: true }),
  })
})

afterAll(async () => {
  await client?.shutdown()
  await new Promise<void>((resolve) => automation.close(() => resolve()))
  rmSync(temp, { recursive: true, force: true })
})

function runNode(script: string, args: string[], input: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env } })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', () => resolve(out))
    child.stdin.end(input)
  })
}

async function waitFor<T>(read: () => T | undefined, ms = 5_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('the handshake gives main private sockets and the helper paths', async () => {
  const info = await client.start()
  assert.equal(client.state(), 'ready')
  assert.equal(info.agentSocket, join(temp, 'rt', 'abc123def456', 'agent.sock'))
  assert.equal(info.mcpSocket, join(temp, 'rt', 'abc123def456', 'mcp.sock'))
  assert.equal(statSync(info.agentSocket).mode & 0o777, 0o600)
  assert.equal(statSync(info.mcpSocket).mode & 0o777, 0o600)
  assert.equal(statSync(join(temp, 'rt', 'abc123def456')).mode & 0o777, 0o700)
  assert.equal(info.nodePath, process.execPath)
  assert.equal(await client.start(), info, 'a second start reuses the running helper')
})

test("the app's own hook reporter reaches main through the helper, and main's parser accepts the frame", async () => {
  const info = await client.start()
  await runNode(
    REPORTER,
    ['--socket', '/nonexistent/baked.sock'],
    JSON.stringify({ hook_event_name: 'Stop', session_id: 'cli-1' }),
    {
      SPRINTENGINE_AGENT_ID: 'agent-1',
      SPRINTENGINE_WORKSPACE_ID: 'ws-1',
      // The env wins over the baked argument, as the WSL startup script exports it.
      SPRINTENGINE_AGENT_STATE_SOCKET: info.agentSocket,
    },
  )
  const event = await waitFor(() => events.find((candidate) => candidate.event === 'agentState'))
  assert.equal(event.event, 'agentState')
  const frame = parseAgentStateFrame(JSON.parse(event.event === 'agentState' ? event.line : '{}'), Date.now())
  assert.ok(frame, 'the relayed frame passes the same validation as one from this machine')
  assert.equal(frame.agentId, 'agent-1')
  assert.equal(frame.event, 'Stop')
})

test('garbage and over-long lines on the agent socket never reach main', async () => {
  const info = await client.start()
  const before = events.length
  await new Promise<void>((resolve) => {
    const socket = connect(info.agentSocket, () => {
      socket.write('not json\n[1,2]\n')
      socket.end(`${'x'.repeat(70 * 1024)}\n`)
    })
    socket.on('close', () => resolve())
    socket.on('error', () => resolve())
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(events.length, before)
})

test("the app's own MCP bridge reaches the automation server through a helper channel, both ways", async () => {
  const info = await client.start()
  const request = `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`
  const out = await runNode(BRIDGE, [], request, {
    SPRINTENGINE_USER_DATA_DIR: info.userDataDir,
    SPRINTENGINE_AGENT_ID: 'agent-1',
    SPRINTENGINE_AGENT_CLI: 'claude-code',
  })
  assert.deepEqual(JSON.parse(out.trim()), { jsonrpc: '2.0', id: 7, result: { ok: true } })
  const connectFrame = JSON.parse(automationLines[0]) as { method: string; params: { agentId: string; cliId: string } }
  assert.equal(connectFrame.method, 'sprintengine.studio/connect')
  assert.equal(connectFrame.params.agentId, 'agent-1')
  assert.equal(connectFrame.params.cliId, 'claude-code')
  assert.deepEqual(JSON.parse(automationLines[1]), { jsonrpc: '2.0', id: 7, method: 'tools/list' })
})

test('main asks the helper to run argv and git, and to read processes', async () => {
  const echoed = await client.request<{ code: number; stdout: string }>('run', {
    argv: ['sh', '-c', 'printf "%s" "$1"', 'sh', "a 'quoted' $arg"],
    timeoutMs: 5_000,
  })
  assert.equal(echoed.stdout, "a 'quoted' $arg")
  await assert.rejects(client.request('run', { argv: 'rm -rf /', timeoutMs: 5_000 }), /array/u)
  await assert.rejects(client.request('run', { argv: ['true'], timeoutMs: null }), /deadline/u)
  if (spawnSync('git', ['--version']).status === 0) {
    const repo = join(temp, 'repo')
    mkdirSync(repo)
    spawnSync('git', ['init', '-q', repo])
    const top = await client.request<{ code: number; stdout: string }>('git', {
      cwd: repo,
      args: ['rev-parse', '--is-inside-work-tree'],
      timeoutMs: 10_000,
      env: { LC_ALL: 'C' },
    })
    assert.equal(top.stdout.trim(), 'true')
  }
  // No /proc here: every session is undetermined, never "safe to reap".
  const snapshot = await client.request<{ verdicts: Record<string, unknown> }>('proc.snapshot', { keys: ['sid-a-1'] })
  if (!existsSync('/proc/self')) assert.deepEqual(snapshot.verdicts, {})
})

test('shutdown ends the helper and removes its sockets', async () => {
  const info = await client.start()
  await client.shutdown()
  assert.equal(client.state(), 'stopped')
  await waitFor(() => (existsSync(info.agentSocket) || existsSync(info.mcpSocket) ? undefined : true))
})
