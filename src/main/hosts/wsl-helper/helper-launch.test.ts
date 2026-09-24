// The WSL helper's launch-side pieces, as plain Node on macOS and Linux: the
// private directory each launch's startup script is written into, the MCP
// channel's launch token, the agent-state byte cap, ending every session on
// quit, and stdin for a git the helper runs.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import {
  loadHelperModule,
  type ProcModule,
  type RelayModule,
  type RelaySocketLike,
  type RunModule,
  type SessionsModule,
} from '../../../../tests/wsl-helper-modules'

let temp = ''
let sessions: SessionsModule
let relay: RelayModule
let proc: ProcModule
let run: RunModule

// A socket path must stay short (about 100 bytes), so the fixture lives in /tmp.
function shortTemp(prefix: string): string {
  return mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), prefix))
}

beforeAll(async () => {
  temp = shortTemp('se-launch-')
  sessions = await loadHelperModule<SessionsModule>('lib/sessions.mjs')
  relay = await loadHelperModule<RelayModule>('lib/relay.mjs')
  proc = await loadHelperModule<ProcModule>('lib/proc.mjs')
  run = await loadHelperModule<RunModule>('lib/run.mjs')
})

afterAll(() => rmSync(temp, { recursive: true, force: true }))

const uid = process.getuid?.()
const mode = (path: string) => statSync(path).mode & 0o777

// ── Launch files ────────────────────────────────────────────────────────────

test('the launch directory is private at every level the helper makes, and a loose one is narrowed', () => {
  const home = join(temp, 'home-a')
  mkdirSync(join(home, '.local', 'share', 'sprintengine-studio'), { recursive: true })
  // Made by something with a looser umask: it is ours, so it is narrowed.
  mkdirSync(join(home, '.local', 'share', 'sprintengine-studio', 'sessions'), { mode: 0o755 })
  chmodSync(join(home, '.local', 'share', 'sprintengine-studio', 'sessions'), 0o755)
  const dir = sessions.ensureSessionDir({ home, uid, profile: 'abc123def456' })
  assert.equal(dir, join(home, '.local', 'share', 'sprintengine-studio', 'sessions', 'abc123def456'))
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(join(dir, '..')), 0o700)
})

test('a launch directory that is a link, or is not ours, is refused', () => {
  const home = join(temp, 'home-b')
  const base = join(home, '.local', 'share', 'sprintengine-studio')
  mkdirSync(base, { recursive: true })
  const elsewhere = join(temp, 'elsewhere')
  mkdirSync(elsewhere, { mode: 0o700 })
  symlinkSync(elsewhere, join(base, 'sessions'))
  assert.throws(() => sessions.ensureSessionDir({ home, uid, profile: 'p1' }), /not a directory owned by this user/u)
  const home2 = join(temp, 'home-c')
  mkdirSync(join(home2, '.local', 'share', 'sprintengine-studio'), { recursive: true })
  assert.throws(
    () => sessions.ensureSessionDir({ home: home2, uid: (uid ?? 0) + 1, profile: 'p1' }),
    /not a directory owned by this user/u,
  )
})

test('launch files land whole and 0600, nested ones too, and nothing leaves the directory', () => {
  const dir = sessions.ensureSessionDir({ home: join(temp, 'home-d'), uid, profile: 'p1' })
  const paths = sessions.writeSessionFiles(dir, [
    { path: 'sid-1-17.sh', b64: Buffer.from("export T='secret'\n").toString('base64') },
    { path: 'host-context-sid-1/rules/host-context.mdc', b64: Buffer.from('rule').toString('base64') },
  ])
  assert.deepEqual(paths, [join(dir, 'sid-1-17.sh'), join(dir, 'host-context-sid-1/rules/host-context.mdc')])
  assert.equal(readFileSync(paths[0], 'utf8'), "export T='secret'\n")
  assert.equal(mode(paths[0]), 0o600)
  assert.equal(mode(paths[1]), 0o600)
  assert.equal(mode(join(dir, 'host-context-sid-1')), 0o700)
  for (const path of ['../escape.sh', '/etc/profile', 'a/../../b', '', 'bad name/x']) {
    assert.throws(
      () => sessions.writeSessionFiles(dir, [{ path, b64: '' }]),
      /Refusing the launch file path/u,
      JSON.stringify(path),
    )
  }
  assert.throws(() => sessions.writeSessionFiles(dir, []), /non-empty/u)
  assert.throws(
    () => sessions.writeSessionFiles(dir, [{ path: 'big.sh', b64: 'A'.repeat(sessions.MAX_SESSION_WRITE_BYTES + 4) }]),
    /larger than/u,
  )
  sessions.removeSessionEntries(dir, ['host-context-sid-1', '../..', 42])
  assert.equal(existsSync(join(dir, 'host-context-sid-1')), false)
  assert.equal(existsSync(paths[0]), true)
  sessions.clearSessionDir(dir)
  assert.equal(existsSync(paths[0]), false)
  assert.equal(existsSync(dir), true, 'the directory itself stays')
})

// ── The MCP channel's launch token ──────────────────────────────────────────

async function mcpPair(): Promise<{
  frames: Array<Record<string, unknown>>
  mux: ReturnType<RelayModule['createMcpMux']>
  path: string
  server: Server
}> {
  const frames: Array<Record<string, unknown>> = []
  const mux = relay.createMcpMux((frame) => frames.push(frame))
  const path = join(temp, `mcp-${Math.random().toString(16).slice(2, 8)}.sock`)
  const server = createServer({ allowHalfOpen: true }, (socket) => mux.accept(socket as unknown as RelaySocketLike))
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return { frames, mux, path, server }
}

function send(path: string, bytes: string, options: { end?: boolean } = {}): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = connect(path, () => {
      socket.write(bytes)
      if (options.end) socket.end()
      resolve(socket)
    })
    socket.on('error', () => undefined)
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
const TOKEN = 'launch_token-0123456789abcdefABCDEF'

test('an auth line opens a channel carrying its token, and what follows it is relayed', async () => {
  const { frames, mux, path, server } = await mcpPair()
  const request = '{"jsonrpc":"2.0","id":1}\n'
  const socket = await send(path, `{"t":"auth","token":"${TOKEN}"}\n${request}`)
  await settle()
  assert.deepEqual(frames[0], { t: 'ch', ch: 1, op: 'open', token: TOKEN })
  const data = frames
    .filter((frame) => frame.op === 'data')
    .map((frame) => Buffer.from(String(frame.b64), 'base64').toString('utf8'))
    .join('')
  assert.equal(data, request, 'the auth line itself never reaches main as data')
  socket.destroy()
  mux.closeAll()
  server.close()
})

test('a connection without a well-formed auth line never reaches main', async () => {
  const { frames, mux, path, server } = await mcpPair()
  const attempts = [
    '{"jsonrpc":"2.0","method":"sprintengine.studio/connect"}\n', // an old bridge, or anything else
    '{"t":"auth"}\n',
    '{"t":"auth","token":"short"}\n',
    '{"t":"auth","token":"has spaces in it 0123456789"}\n',
    `${'x'.repeat(2_000)}`, // no newline, past the cap
  ]
  const sockets = await Promise.all(attempts.map((bytes) => send(path, bytes)))
  await settle()
  assert.deepEqual(frames, [], 'no channel was opened, nothing was relayed')
  assert.equal(mux.size(), 0)
  for (const socket of sockets) {
    assert.ok(socket.destroyed || socket.readableEnded, 'each is dropped')
    socket.destroy()
  }
  server.close()
})

test('the auth line is read as the relay reads it', () => {
  assert.equal(relay.parseAuthLine(`{"t":"auth","token":"${TOKEN}"}`), TOKEN)
  assert.equal(relay.parseAuthLine('{"t":"auth","token":123}'), null)
  assert.equal(relay.parseAuthLine('{"token":"launch_token-0123456789"}'), null)
  assert.equal(relay.parseAuthLine('not json'), null)
})

// ── Agent state ─────────────────────────────────────────────────────────────

test('one agent-state connection may send many frames, but not without limit', async () => {
  const lines: string[] = []
  const path = join(temp, 'agent.sock')
  const server = createServer((socket) =>
    relay.relayAgentStateConnection(socket as unknown as RelaySocketLike, (line) => lines.push(line)),
  )
  await new Promise<void>((resolve) => server.listen(path, resolve))
  // OpenCode's plugin sends a frame per file a patch touched, on one connection.
  const frames = Array.from({ length: 500 }, (_, index) => `{"event":"file","n":${index}}\n`).join('')
  const socket = await send(path, frames, { end: true })
  await settle()
  assert.equal(lines.length, 500, 'every frame of a large patch arrives')
  socket.destroy()

  // A runaway writer: large frames (each under the line cap) until well past
  // the connection's byte cap. The helper hangs up on it part-way.
  const flood = await send(path, '')
  const closed = new Promise<void>((resolve) => flood.once('close', () => resolve()))
  const frame = `{"x":"${'a'.repeat(60 * 1024)}"}\n`
  const total = Math.ceil((relay.MAX_AGENT_STATE_BYTES_PER_CONNECTION * 1.5) / frame.length)
  for (let index = 0; index < total && !flood.destroyed; index += 1) {
    if (!flood.write(frame)) await new Promise((resolve) => flood.once('drain', resolve).once('close', resolve))
  }
  await closed
  assert.ok(lines.length - 500 < total, 'past the cap the connection is dropped, not relayed to the end')
  assert.ok(lines.length - 500 <= Math.ceil(relay.MAX_AGENT_STATE_BYTES_PER_CONNECTION / frame.length))
  server.close()
})

// ── Ending every session ────────────────────────────────────────────────────

test('ending every session kills each session tree its pid file still names, and drops the files', () => {
  const root = join(temp, 'end-all')
  const procRoot = join(root, 'proc')
  const pidDir = join(root, 'rt', 'sessions')
  mkdirSync(pidDir, { recursive: true })
  const add = (pid: number, ppid: number, started: number, argv: string[]) => {
    mkdirSync(join(procRoot, String(pid)), { recursive: true })
    writeFileSync(
      join(procRoot, String(pid), 'stat'),
      `${pid} (${argv[0]}) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${started} 0 0`,
    )
    writeFileSync(join(procRoot, String(pid), 'cmdline'), `${argv.join('\0')}\0`)
  }
  add(1, 0, 1, ['/init'])
  add(100, 1, 1000, ['bash', '-li'])
  add(101, 100, 1001, ['claude', '--session-id', 'aaaa'])
  add(102, 101, 1002, ['node', 'mcp-stdio-bridge.mjs'])
  add(200, 1, 2222, ['sleep', '1000'])
  add(900, 1, 9000, ['node', 'helper.mjs'])
  writeFileSync(join(pidDir, 'sid-a-1.pid'), '100 1000\n')
  // Reused since: another process has this pid now.
  writeFileSync(join(pidDir, 'sid-b-2.pid'), '200 2000\n')
  writeFileSync(join(pidDir, 'not-a-pid-file.txt'), '1\n')
  const signalled: Array<[number, string]> = []
  const killed = proc.endAllSessions({
    procRoot,
    pidDir,
    uid,
    selfPid: 900,
    kill: (pid, signal) => signalled.push([pid, signal]),
  })
  assert.deepEqual(
    killed.sort((a, b) => a - b),
    [100, 101, 102],
  )
  assert.ok(signalled.every(([, signal]) => signal === 'SIGKILL'))
  assert.equal(existsSync(join(pidDir, 'sid-a-1.pid')), false)
  assert.equal(existsSync(join(pidDir, 'sid-b-2.pid')), false, 'a stale file goes too')
  assert.equal(existsSync(join(pidDir, 'not-a-pid-file.txt')), true)
  assert.deepEqual(proc.endAllSessions({ procRoot, pidDir, uid: (uid ?? 0) + 1, selfPid: 900 }), [], 'not ours: no')
  assert.deepEqual(proc.endAllSessions({ procRoot, pidDir: null, uid, selfPid: 900 }), [])
})

test('ending every session really ends a live process tree', async () => {
  // A real process, described by a stand-in /proc (macOS has none): the pid
  // file names it, and it is gone afterwards.
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('spawn', resolve))
  const pid = child.pid ?? 0
  const root = join(temp, 'end-live')
  const procRoot = join(root, 'proc')
  const pidDir = join(root, 'rt', 'sessions')
  mkdirSync(join(procRoot, String(pid)), { recursive: true })
  mkdirSync(pidDir, { recursive: true })
  writeFileSync(join(procRoot, String(pid), 'stat'), `${pid} (sleep) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 4242 0 0`)
  writeFileSync(join(procRoot, String(pid), 'cmdline'), 'sleep\x0030\x00')
  writeFileSync(join(pidDir, 'sid-live-1.pid'), `${pid} 4242\n`)
  const exited = new Promise<string | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
  assert.deepEqual(proc.endAllSessions({ procRoot, pidDir, uid, selfPid: process.pid }), [pid])
  assert.equal(await exited, 'SIGKILL')
})

// ── stdin for git ───────────────────────────────────────────────────────────

test('a run can be handed stdin, byte for byte, and base64 that is not base64 is refused', async () => {
  const bytes = Buffer.from('a\0b\r\nü\n', 'utf8')
  const answer = await run.runArgv({ argv: ['cat'], timeoutMs: 5_000, stdin: bytes })
  assert.equal(answer.code, 0)
  assert.equal(answer.stdout, bytes.toString('utf8'))
  assert.equal(run.decodeStdin(undefined), undefined)
  assert.equal(run.decodeStdin('not base64!'), null)
  assert.equal(run.decodeStdin(42), null)
  assert.deepEqual(run.decodeStdin(bytes.toString('base64')), bytes)
  // Without stdin, a reader sees end of input at once rather than waiting.
  const closed = await run.runArgv({ argv: ['cat'], timeoutMs: 5_000 })
  assert.equal(closed.stdout, '')
  assert.equal(closed.timedOut, false)
})
