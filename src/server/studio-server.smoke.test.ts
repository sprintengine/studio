import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, test } from 'vitest'

import { acquireDataDirLock } from './core/data-dir'
import { connectRemoteConversationBackend } from './wsl/backend-wire'
import { connectLoopback } from './wsl/front-door-client'
import { enterFrontDoor, ownerTokenHash } from './wsl/front-door-proof'

// The Studio core under plain Node, end to end: the server is built into its
// bundle the way `npm run build:server` builds it, and that bundle is run by
// the `node` running this suite, with no Electron, no stand-ins and none of the
// suite's module mocking. One process serves the gateway from the bundle's
// own entry; another requires the bundle as a library and runs a chat on the
// built-in mock provider, through a checkpoint and a revert.

const ROOT = join(__dirname, '..', '..')
const FIXTURE = join(__dirname, '__fixtures__', 'drive-mock-chat.cjs')

let scratch = ''
let bundle = ''

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'studio-server-smoke-'))
  // Beside the checkout's node_modules, so its dependencies resolve the way
  // they do for out/server/server.cjs; one copy per run, so parallel runs never
  // share it.
  bundle = join(ROOT, 'node_modules', '.cache', 'sprintengine', `studio-server-smoke-${process.pid}.cjs`)
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--outfile', bundle], {
    cwd: ROOT,
    stdio: 'pipe',
  })
})

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  for (const file of [bundle, `${bundle}.map`]) if (file) rmSync(file, { force: true })
})

/** A home of its own, so nothing the server does reaches the real one. */
function isolatedEnv(name: string): NodeJS.ProcessEnv {
  const home = join(scratch, name, 'home')
  mkdirSync(home, { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
  env.XDG_DATA_HOME = join(home, '.local', 'share')
  env.XDG_STATE_HOME = join(home, '.local', 'state')
  for (const key of Object.keys(env)) if (key.startsWith('SPRINTENGINE_')) delete env[key]
  return env
}

type Served = {
  child: ChildProcessWithoutNullStreams
  lines: AsyncIterator<string>
  stderr: () => string
  exited: Promise<number | null>
}

function serve(args: string[], env: NodeJS.ProcessEnv): Served {
  const child = spawn(process.execPath, [bundle, 'serve', '--app-root', ROOT, '--stdio', ...args], {
    env,
    cwd: tmpdir(),
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return {
    child,
    lines: createInterface({ input: child.stdout })[Symbol.asyncIterator](),
    stderr: () => stderr,
    exited,
  }
}

async function firstLine(served: Served): Promise<Record<string, any>> {
  const next = await served.lines.next()
  assert.equal(next.done, false, `the server wrote nothing on stdout; stderr:\n${served.stderr()}`)
  return JSON.parse(next.value) as Record<string, any>
}

/** One newline-delimited JSON-RPC exchange per call, on one connection. */
async function mcpSession(socketPath: string) {
  const socket = connect(socketPath)
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject))
  const replies = createInterface({ input: socket })[Symbol.asyncIterator]()
  let id = 0
  return {
    async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`)
      for (;;) {
        const next = await replies.next()
        assert.equal(next.done, false, 'the gateway closed the connection')
        const message = JSON.parse(next.value) as Record<string, any>
        if (message.id === id) return message
      }
    },
    close: () => socket.end(),
  }
}

test('the bundle carries nothing of Electron and serves the gateway under plain Node', async () => {
  const source = readFileSync(bundle, 'utf8')
  assert.doesNotMatch(source, /require\(["'](electron|electron-updater|node-pty)["']\)/)

  const env = isolatedEnv('serve')
  const dataDir = join(scratch, 'serve', 'data')
  const served = serve(['--data-dir', dataDir, '--logs-dir', join(scratch, 'serve', 'logs')], env)
  const { ready } = await firstLine(served)
  assert.ok(ready, `expected a ready line; stderr:\n${served.stderr()}`)
  assert.equal(ready.dataDir, dataDir)
  assert.equal(ready.secrets, true)
  assert.equal(typeof ready.gatewaySocket, 'string')
  // The Studio RPC's owner socket, beside the gateway, as in the desktop.
  assert.equal(typeof ready.rpcSocket, 'string', served.stderr())
  assert.ok(existsSync(join(dataDir, 'run', 'studio.lock')))
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'studio-data-dir.json'), 'utf8')).secrets, 'server-key')
  // Discovery for agents the server starts, and for the MCP bridge.
  assert.equal(
    JSON.parse(readFileSync(join(dataDir, 'sprintengine-studio-mcp-info.json'), 'utf8')).socketPath,
    ready.gatewaySocket,
  )

  // A second server on the same directory is refused, and says by whom.
  const second = serve(['--data-dir', dataDir, '--logs-dir', join(scratch, 'serve', 'logs-2')], env)
  const { fatal } = await firstLine(second)
  assert.equal(fatal?.code, 66)
  assert.match(fatal.message, new RegExp(`A Studio server \\(pid ${ready.pid}`))
  assert.equal(await second.exited, 66)

  // The gateway answers MCP, lists the core's tool, and runs it against the
  // core's launch service and registry.
  const mcp = await mcpSession(ready.gatewaySocket)
  const initialized = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  assert.equal(initialized.result?.serverInfo?.name, 'sprintengine-studio')
  const listed = await mcp.call('tools/list')
  const names = (listed.result?.tools as Array<{ name: string }>).map((tool) => tool.name)
  assert.ok(names.includes('conversation.create'), names.join(', '))
  const created = await mcp.call('tools/call', { name: 'conversation.create', arguments: { workspaceId: 'missing' } })
  assert.equal(created.result?.isError, true)
  assert.match(JSON.stringify(created.result), /workspace/i)
  mcp.close()

  served.child.stdin.write('{"t":"shutdown"}\n')
  assert.equal(await served.exited, 0, served.stderr())
  assert.equal(existsSync(join(dataDir, 'run', 'studio.lock')), false, 'the run lock is let go')
  assert.equal(existsSync(join(dataDir, 'sprintengine-studio-mcp-info.json')), false, 'discovery is taken down')
})

test('a bundle copied away from its node_modules says so at start, not at the first chat', async () => {
  const away = join(scratch, 'away')
  mkdirSync(away, { recursive: true })
  const copy = join(away, 'server.cjs')
  writeFileSync(copy, readFileSync(bundle))
  const env = isolatedEnv('away')
  delete env.NODE_PATH
  const child = spawn(process.execPath, [copy, 'serve', '--data-dir', join(away, 'data'), '--app-root', ROOT], {
    env,
    cwd: away,
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const { fatal } = JSON.parse((await lines.next()).value as string) as { fatal?: { code: number; message: string } }
  assert.equal(fatal?.code, 70)
  assert.match(fatal!.message, /@anthropic-ai\/claude-agent-sdk and @agentclientprotocol\/sdk cannot be found/)
  assert.equal(await exited, 70)
  assert.equal(existsSync(join(away, 'data', 'run', 'studio.lock')), false, 'nothing is taken before the check')
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  "a data directory whose run/ cannot be made is the directory's problem: 65, not 70",
  async () => {
    const dataDir = join(scratch, 'readonly', 'data')
    mkdirSync(dataDir, { recursive: true })
    chmodSync(dataDir, 0o500)
    try {
      const served = serve(
        ['--data-dir', dataDir, '--logs-dir', join(scratch, 'readonly', 'logs')],
        isolatedEnv('readonly'),
      )
      const { fatal } = await firstLine(served)
      assert.equal(fatal?.code, 65, served.stderr())
      assert.equal(await served.exited, 65)
    } finally {
      chmodSync(dataDir, 0o700)
    }
  },
)

test('a server stops when the parent that drives it goes away', async () => {
  const served = serve(['--data-dir', join(scratch, 'orphan', 'data')], isolatedEnv('orphan'))
  assert.ok((await firstLine(served)).ready, served.stderr())
  served.child.stdin.end()
  assert.equal(await served.exited, 0, served.stderr())
})

test('a server stops when the desktop app takes its data directory, and leaves the app its files', async () => {
  const dataDir = join(scratch, 'displaced', 'data')
  const served = serve(['--data-dir', dataDir], isolatedEnv('displaced'))
  const { ready } = await firstLine(served)
  assert.ok(ready, served.stderr())
  // What the desktop does as it starts on this directory: it takes the lock over.
  const desktop = acquireDataDirLock(dataDir, 'desktop', { takeOver: () => true })
  assert.ok(desktop.ok && desktop.displaced?.pid === ready.pid)
  assert.equal(await served.exited, 66, served.stderr())
  assert.match(served.stderr(), /SprintEngine Studio opened this data directory/)
  assert.equal(desktop.lock.isHeld(), true, "the server's stop leaves the desktop's lock alone")
  assert.equal(existsSync(join(dataDir, 'sprintengine-studio-mcp-info.json')), false)
  desktop.lock.release()
})

test("a desktop's data directory is refused, or shared with the server's secrets off", async () => {
  const env = isolatedEnv('desktop')
  const dataDir = join(scratch, 'desktop', 'data')
  mkdirSync(dataDir, { recursive: true, mode: 0o755 })
  // What every Electron profile directory holds.
  writeFileSync(join(dataDir, 'Local State'), '{}')

  const refused = serve(['--data-dir', dataDir], env)
  const { fatal } = await firstLine(refused)
  assert.equal(fatal?.code, 65)
  assert.match(fatal.message, /desktop app's data directory/)
  assert.equal(await refused.exited, 65)

  const shared = serve(['--data-dir', dataDir, '--share-desktop-data-dir'], env)
  const { ready } = await firstLine(shared)
  assert.equal(ready?.secrets, false, shared.stderr())
  if (process.platform !== 'win32') assert.equal(statSync(dataDir).mode & 0o777, 0o700, 'narrowed to its owner')
  assert.equal(existsSync(join(dataDir, 'run', 'secret-key')), false, 'no key of its own is minted there')
  shared.child.stdin.write('{"t":"shutdown"}\n')
  assert.equal(await shared.exited, 0)
})

test('a chat runs on the mock provider, with a checkpoint and a revert, in the bundle under plain Node', () => {
  const repository = join(scratch, 'chat', 'repository')
  mkdirSync(repository, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'Developer')
  git('config', 'user.email', 'dev@example.com')
  writeFileSync(join(repository, 'existing.txt'), 'original\n')
  writeFileSync(join(repository, '.gitignore'), '.sprintengine/\n')
  git('add', '.')
  git('commit', '-qm', 'Initial files')

  const output = execFileSync(process.execPath, [FIXTURE, bundle, join(scratch, 'chat', 'data'), repository, ROOT], {
    env: isolatedEnv('chat'),
    cwd: tmpdir(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const report = JSON.parse(output.trim().split('\n').at(-1)!) as Record<string, any>
  assert.equal(report.electron, false)
  assert.equal(report.workspaceListed, true)
  assert.deepEqual(report.checkpoint, { files: 1, addedLines: 1, removedLines: 1 })
  assert.deepEqual(report.revertedFiles, ['existing.txt'])
  assert.equal(report.fileAfterRevert, 'original\n')
  assert.equal(report.turnsCompleted, 2)
  assert.match(report.replies.at(-1), /^Mock response for: Files were reverted[\s\S]*hello$/)
})

test('a server started with a bootstrap envelope on stdin says ready, answers pings and drains on shutdown', async () => {
  const env = isolatedEnv('bootstrap')
  const dataDir = join(scratch, 'bootstrap', 'data')
  const child = spawn(process.execPath, [bundle, '--bootstrap', 'stdio'], { env, cwd: tmpdir() })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const next = async (): Promise<Record<string, any>> => {
    const line = await lines.next()
    assert.equal(line.done, false, `the server wrote nothing more on stdout; stderr:\n${stderr}`)
    return JSON.parse(line.value) as Record<string, any>
  }
  child.stdin.write(
    `${JSON.stringify({
      v: 1,
      role: 'headless',
      dataDir,
      logsDir: join(scratch, 'bootstrap', 'logs'),
      runDir: join(dataDir, 'run'),
      tempDir: tmpdir(),
      paths: { resourcesDir: null, appPath: ROOT, isPackaged: false, appExecPath: process.execPath },
      app: { version: '0.0.0-test', buildStamp: '', channel: 'nightly' },
      owner: {},
      listeners: { gateway: true, tailnet: 'off' },
      secrets: { kind: 'key-file' },
      flags: {},
    })}\n`,
  )
  const boot = await next()
  assert.equal(boot.t, 'boot', 'the server says who it is before it reads anything')
  assert.equal(boot.pid, child.pid)
  assert.equal(boot.home, env.HOME)
  const ready = await next()
  assert.equal(ready.t, 'ready', stderr)
  assert.equal(ready.pid, child.pid)
  assert.match(ready.environmentId, /^[0-9a-f-]{36}$/)
  assert.equal(typeof ready.gateway.socketPath, 'string')
  assert.ok(existsSync(join(dataDir, 'run', 'studio.lock')))

  child.stdin.write(`${JSON.stringify({ t: 'ping', seq: 3 })}\n`)
  const pong = await next()
  assert.equal(pong.t, 'pong')
  assert.equal(pong.seq, 3)

  child.stdin.write(`${JSON.stringify({ t: 'shutdown', drain: true, budgetMs: 8000 })}\n`)
  const legs: string[] = []
  for (let frame = await next(); frame.t === 'shutdown-progress'; frame = await next().catch(() => ({ t: 'end' }))) {
    legs.push(frame.leg)
    if (frame.done === frame.total) break
  }
  assert.deepEqual(legs, ['studio-rpc', 'gateway', 'core'])
  assert.equal(await exited, 0, stderr)
  assert.equal(existsSync(join(dataDir, 'run', 'studio.lock')), false, 'the run lock is let go')
})

test('a server with a front door lets in only a proven front door, and serves it the backend and the shell role', async () => {
  const env = isolatedEnv('front-door')
  // A short data directory: the bridge socket lives in its run directory.
  const dataDir = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'se-fdd-'))
  const token = 'seown_front-door-smoke-token'
  const child = spawn(process.execPath, [bundle, '--bootstrap', 'stdio'], { env, cwd: tmpdir() })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const next = async (): Promise<Record<string, any>> => {
    const line = await lines.next()
    assert.equal(line.done, false, `the server wrote nothing more on stdout; stderr:\n${stderr}`)
    return JSON.parse(line.value) as Record<string, any>
  }
  assert.equal((await next()).t, 'boot')
  child.stdin.write(
    `${JSON.stringify({
      v: 1,
      role: 'headless',
      dataDir,
      logsDir: join(dataDir, 'logs'),
      runDir: join(dataDir, 'run'),
      tempDir: tmpdir(),
      paths: { resourcesDir: null, appPath: ROOT, isPackaged: false, appExecPath: process.execPath },
      app: { version: '0.0.0-test', buildStamp: '', channel: 'nightly' },
      owner: { tokenHash: ownerTokenHash(token) },
      listeners: { gateway: true, tailnet: 'off', frontDoor: { loopback: true } },
      secrets: { kind: 'key-file' },
      flags: {},
      wsl: { distro: 'Ubuntu-24.04' },
    })}\n`,
  )
  const ready = await next()
  assert.equal(ready.t, 'ready', stderr)
  assert.ok(ready.frontDoor.port > 0)
  assert.equal(ready.frontDoor.socketPath, join(dataDir, 'run', 'front-door.sock'))

  const socket = await connectLoopback(ready.frontDoor.port)
  const backend = connectRemoteConversationBackend(await enterFrontDoor(socket, { token, purpose: 'backend' }))
  await backend.refresh()
  const listed = backend.listSessions()
  assert.ok(listed.ok && listed.sessions.length === 0)
  const threads = await backend.listThreads({ workspaceRoot: dataDir, workspaceId: 'ws-1' })
  assert.ok(threads.ok, 'a call crosses to the core and back')
  backend.close()

  const shell = await enterFrontDoor(connect(ready.frontDoor.socketPath), { token, purpose: 'studio' })
  const ticketLine = await new Promise<string>((resolve) => {
    let text = ''
    shell.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      if (text.includes('\n')) resolve(text.slice(0, text.indexOf('\n')))
    })
  })
  assert.match(JSON.parse(ticketLine).ticket, /\S{20,}/u)
  shell.destroy()

  await assert.rejects(
    enterFrontDoor(await connectLoopback(ready.frontDoor.port), { token: 'seown_not-it', purpose: 'backend' }),
    /could not prove/u,
  )

  child.stdin.write(`${JSON.stringify({ t: 'shutdown', drain: true, budgetMs: 8000 })}\n`)
  assert.equal(await exited, 0, stderr)
  rmSync(dataDir, { recursive: true, force: true })
})

test('a bootstrap envelope that is not one exits 64 and says why on stdout', async () => {
  const child = spawn(process.execPath, [bundle, '--bootstrap', 'stdio'], { env: isolatedEnv('bad-envelope') })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  child.stdin.write('{"v":1,"role":"headless"}\n')
  assert.equal(JSON.parse((await lines.next()).value as string).t, 'boot')
  const fatal = JSON.parse((await lines.next()).value as string) as { t: string; code: number; message: string }
  assert.equal(fatal.t, 'fatal')
  assert.equal(fatal.code, 64)
  assert.match(fatal.message, /dataDir/)
  assert.equal(await exited, 64)
})

test('a server killed mid-turn leaves a directory the next one takes over: the lock, the socket and the turn, closed', async () => {
  const repository = join(scratch, 'killed', 'repository')
  const dataDir = join(scratch, 'killed', 'data')
  mkdirSync(repository, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'Developer')
  git('config', 'user.email', 'dev@example.com')
  writeFileSync(join(repository, 'existing.txt'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'Initial files')
  const KILL_FIXTURE = join(__dirname, '__fixtures__', 'kill-mid-turn.cjs')
  const env = isolatedEnv('killed')

  const first = spawn(process.execPath, [KILL_FIXTURE, bundle, 'start', dataDir, repository, ROOT], {
    env,
    cwd: tmpdir(),
  })
  let firstErr = ''
  first.stderr.on('data', (chunk: Buffer) => (firstErr += chunk.toString('utf8')))
  const waiting = createInterface({ input: first.stdout })[Symbol.asyncIterator]()
  const said = await waiting.next()
  assert.equal(said.done, false, firstErr)
  assert.equal(JSON.parse(said.value).waiting, true)
  const firstPid = first.pid
  const gone = new Promise((resolve) => first.on('exit', resolve))
  first.kill('SIGKILL')
  await gone

  const resumed = execFileSync(process.execPath, [KILL_FIXTURE, bundle, 'resume', dataDir, repository, ROOT], {
    env,
    cwd: tmpdir(),
    encoding: 'utf8',
  })
  const report = JSON.parse(resumed.trim().split('\n').at(-1)!) as Record<string, any>
  // The dead holder's lock was taken over by the new process.
  assert.notEqual(report.lock.pid, firstPid)
  assert.equal(report.lock.pid, report.ready.pid)
  // The socket the dead server left was removed and bound again.
  assert.equal(typeof report.ready.gatewaySocket, 'string')
  // The turn the kill cut short reads as interrupted, and nothing is duplicated.
  assert.equal(report.messages, 1)
  assert.deepEqual(report.ends, [{ type: 'turn_failed', reason: 'interrupted' }])
})
