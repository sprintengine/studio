import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, test } from 'vitest'

import type { HelperProcess } from '../../main/hosts/wsl-helper-client'
import type { WslListing } from '../../main/hosts/wsl-distro'
import { buildAppPayload, WSL_DATA_REL, type AppPayload } from '../../main/hosts/wsl-install'
import { installTree, wslNodeDigests } from '../../main/hosts/wsl-helper-runtime'
import { WSL_NODE_VERSION } from '../../main/hosts/wsl-node-runtime'
import type { WslRunner } from '../../main/hosts/wsl-runner'
import type { RunOutcome } from '../../main/process-run'
import { connect } from '../../../packages/agent-sdk/src/client'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import {
  createWslEnvironmentManager,
  wsl1Refusal,
  type WslServerConnection,
  type WslServerStatus,
} from './wsl-environment-manager'
import { readTreeBuild } from './desktop-wsl-servers'
import { lineTransport, readTicket, relayShellToolsets } from './wsl-tool-relay'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import type { ConversationBackend } from '../core/conversation-backend'
import { createRoutedConversationBackend } from '../core/routed-conversation-backend'

// The WSL server end to end, with a plain `sh` standing in for `wsl.exe` and
// a temporary home for each distribution: the real server tree is built the
// way `npm run build:server:wsl` builds it, installed through the real launch
// and commit scripts, started with a real envelope, reached through its front
// door over loopback and over the stdio bridge, and asked for its chats.
// What only a Windows PC with WSL 2 can show (forwarding, `wsl --shutdown`
// itself) is on the manual checklist in the phase 7 spec.

const ROOT = join(__dirname, '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

let scratch = ''
let payload: AppPayload
let treeBuild: { builtAt: string } | null = null

beforeAll(() => {
  // Short: the server's sockets live under each fake home.
  scratch = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'se-wsl-'))
  const tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  payload = buildAppPayload([{ dir: tree, into: '' }])
  treeBuild = readTreeBuild(tree)
})

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A distribution's home, with the pinned Node already there (this machine's own node, marked ready). */
function fakeHome(name: string): string {
  const home = join(scratch, name)
  const runtime = join(home, WSL_DATA_REL, 'runtime', `node-${WSL_NODE_VERSION}`)
  mkdirSync(join(runtime, 'bin'), { recursive: true })
  symlinkSync(process.execPath, join(runtime, 'bin', 'node'))
  writeFileSync(join(runtime, '.ready'), wslNodeDigests()[0])
  mkdirSync(join(home, 'repo'))
  return home
}

/**
 * `wsl.exe` as `sh` in a home of the distribution's own. `closeDelayMs` holds
 * back the news that a shell exited, as `wsl.exe` is behind the Linux
 * process it ran: a killed server's wire closes first.
 */
function fakeRunner(homes: Record<string, string>, closeDelayMs = 0): WslRunner & { spawned: number } {
  const env = (distro: string) => ({ PATH: process.env.PATH, HOME: homes[distro], WSL_DISTRO_NAME: distro })
  const asProcess = (child: ReturnType<typeof spawn>): HelperProcess => {
    child.stdin?.on('error', () => undefined)
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      pid: child.pid,
      kill: () => child.kill('SIGKILL'),
      once: (event: 'close' | 'error', listener: (...args: never[]) => void) =>
        child.once(
          event,
          event === 'close' && closeDelayMs > 0
            ? (...args: unknown[]) =>
                setTimeout(() => (listener as (...args: unknown[]) => void)(...args), closeDelayMs)
            : (listener as (...args: unknown[]) => void),
        ),
    } as HelperProcess
  }
  const run = (distro: string, file: string, args: string[], body: Buffer | Readable): Promise<RunOutcome> =>
    new Promise((resolve) => {
      const child = spawn(file, args, { cwd: homes[distro], env: env(distro), stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, timedOut: false }))
      if (Buffer.isBuffer(body)) child.stdin.end(body)
      else body.pipe(child.stdin)
    })
  const runner = {
    spawned: 0,
    spawnShell(distro: string) {
      runner.spawned++
      return asProcess(spawn('sh', ['-s'], { cwd: homes[distro], env: env(distro), stdio: ['pipe', 'pipe', 'pipe'] }))
    },
    runScript: (distro: string, script: string) => run(distro, 'sh', ['-s'], Buffer.from(`${script}\n`)),
    runExec: (distro: string, argv: readonly string[], body: Buffer | Readable) =>
      run(distro, argv[0], argv.slice(1), body),
  }
  return runner
}

function manager(options: {
  homes: Record<string, string>
  listing?: () => WslListing
  transport?: 'auto' | 'stdio'
  statuses?: WslServerStatus[]
  connected?: (connection: WslServerConnection) => void
  treeBuild?: { builtAt: string }
  maxAttempts?: number
  closeDelayMs?: number
  log?: (message: string) => void
  now?: () => number
}) {
  const runner = fakeRunner(options.homes, options.closeDelayMs)
  const listing =
    options.listing ??
    (() => ({
      distros: Object.keys(options.homes).map((name) => ({ name, isDefault: false, state: 'Running', version: 2 })),
      at: Date.now(),
    }))
  const created = createWslEnvironmentManager({
    runner,
    listDistros: async () => listing(),
    app: { version: VERSION, buildStamp: '', channel: 'nightly' },
    profile: { id: '0123456789ab', isDefault: false },
    payload: () => payload,
    treeBuild: () => options.treeBuild ?? treeBuild,
    nodeDigests: wslNodeDigests,
    installNode: async () => assert.fail('Node is already in the fake distribution'),
    install: (distro, input) => installTree(distro, input, VERSION, runner),
    transportFor: () => options.transport ?? 'auto',
    onStatus: (status) => options.statuses?.push(status),
    onConnected: (connection) => options.connected?.(connection),
    ...(options.maxAttempts ? { start: { maxAttempts: options.maxAttempts } } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  cleanups.push(() => created.shutdown({ budgetMs: 5_000 }))
  return { manager: created, runner }
}

test('a first chat installs the server tree, starts it, and reaches it over loopback', async () => {
  const home = fakeHome('loopback')
  const statuses: WslServerStatus[] = []
  const { manager: wsl } = manager({ homes: { 'Ubuntu-24.04': home }, statuses })
  const connection = await wsl.connect('Ubuntu-24.04')
  assert.equal(wsl.status('Ubuntu-24.04').state, 'ready')
  assert.equal(wsl.status('Ubuntu-24.04').transport, 'loopback')
  assert.ok(existsSync(join(home, WSL_DATA_REL, `server-${VERSION}`, '.ready')), 'the tree is installed and marked')
  assert.ok(
    existsSync(join(home, WSL_DATA_REL, 'data-0123456789ab', 'run', 'studio.lock')),
    'the profile has its own data',
  )
  const threads = await connection.backend.listThreads({ workspaceRoot: join(home, 'repo'), workspaceId: 'ws-1' })
  assert.ok(threads.ok, threads.ok ? '' : threads.message)
  assert.equal(await wsl.connect('Ubuntu-24.04'), connection, 'a second connect reuses the running server')
  assert.deepEqual(
    statuses.map((status) => status.state),
    ['starting', 'ready'],
  )
  await wsl.stop('Ubuntu-24.04')
  assert.equal(wsl.status('Ubuntu-24.04').state, 'stopped')
  assert.ok(
    !existsSync(join(home, WSL_DATA_REL, 'data-0123456789ab', 'run', 'studio.lock')),
    'the drain let the lock go',
  )
})

test('a server that is not the build this app ships is refused before it is handed anything', async () => {
  assert.ok(treeBuild, 'the tree says which build it is')
  const home = fakeHome('other-build')
  const { manager: wsl } = manager({
    homes: { Ubuntu: home },
    treeBuild: { builtAt: '2026-01-01T00:00:00.000Z' },
    maxAttempts: 1,
  })
  await assert.rejects(wsl.connect('Ubuntu'), /another build of version/u)
  assert.equal(wsl.status('Ubuntu').state, 'unavailable')
  assert.ok(
    !existsSync(join(home, WSL_DATA_REL, 'data-0123456789ab', 'run', 'studio.lock')),
    'it was given no data directory',
  )
})

test('with the bridge chosen, the server is reached through the stdio relay and no loopback door opens', async () => {
  const home = fakeHome('bridge')
  const { manager: wsl } = manager({ homes: { Debian: home }, transport: 'stdio' })
  const connection = await wsl.connect('Debian')
  assert.equal(wsl.status('Debian').transport, 'stdio')
  const threads = await connection.backend.listThreads({ workspaceRoot: join(home, 'repo'), workspaceId: 'ws-1' })
  assert.ok(threads.ok)
})

test('a lost wire is reconnected once, and a call meanwhile waits for it instead of opening another', async () => {
  const home = fakeHome('reconnect')
  const connections: WslServerConnection[] = []
  const { manager: wsl } = manager({ homes: { Ubuntu: home }, connected: (connection) => connections.push(connection) })
  const first = await wsl.connect('Ubuntu')
  const pid = readServerPid(home)
  first.backend.close()
  const second = await wsl.connect('Ubuntu')
  assert.notEqual(second, first)
  assert.equal(connections.length, 2, 'one reconnect, not a second wire beside it')
  assert.equal(await wsl.connect('Ubuntu'), second)
  assert.equal(readServerPid(home), pid, 'the same server')
  const threads = await second.backend.listThreads({ workspaceRoot: join(home, 'repo'), workspaceId: 'ws-1' })
  assert.ok(threads.ok)
})

test('a WSL 1 distribution is refused with the command that converts it, and nothing is started', async () => {
  const home = fakeHome('wsl1')
  const { manager: wsl, runner } = manager({
    homes: { Legacy: home },
    listing: () => ({ distros: [{ name: 'Legacy', isDefault: true, state: 'Running', version: 1 }], at: Date.now() }),
  })
  await assert.rejects(wsl.connect('Legacy'), (error: Error) => error.message === wsl1Refusal('Legacy'))
  assert.match(wsl1Refusal('Legacy'), /wsl --set-version Legacy 2/u)
  assert.equal(runner.spawned, 0)
  assert.equal(wsl.status('Legacy').state, 'unavailable')
})

test('a distribution that is not installed, or no WSL at all, is said in words', async () => {
  const { manager: none } = manager({ homes: {}, listing: () => ({ distros: null, at: Date.now() }) })
  await assert.rejects(none.connect('Ubuntu'), /wsl --install/u)
  const { manager: other } = manager({
    homes: {},
    listing: () => ({ distros: [{ name: 'Debian', isDefault: true, state: 'Running', version: 2 }], at: Date.now() }),
  })
  await assert.rejects(other.connect('Ubuntu'), /Ubuntu is not installed/u)
})

test('a server killed under a running distribution is a crash; under a stopped one, WSL was shut down', async () => {
  const home = fakeHome('lifetime')
  let state = 'Running'
  const statuses: WslServerStatus[] = []
  const { manager: wsl } = manager({
    homes: { Ubuntu: home },
    listing: () => ({ distros: [{ name: 'Ubuntu', isDefault: true, state, version: 2 }], at: Date.now() }),
    statuses,
  })
  const first = await wsl.connect('Ubuntu')
  const pid = readServerPid(home)
  process.kill(pid, 'SIGKILL')
  await waitFor(() => wsl.status('Ubuntu').state === 'unavailable')
  assert.match(wsl.status('Ubuntu').reason ?? '', /stopped unexpectedly/u)
  assert.equal(first.backend.isOpen(), false)
  await assert.rejects(wsl.connect('Ubuntu'), /tried again in \d+ s/u, 'a crash is not restarted at once')

  const { manager: shutDown } = manager({
    homes: { Ubuntu: fakeHome('lifetime-2') },
    listing: () => ({ distros: [{ name: 'Ubuntu', isDefault: true, state, version: 2 }], at: Date.now() }),
  })
  await shutDown.connect('Ubuntu')
  state = 'Stopped'
  process.kill(readServerPid(join(scratch, 'lifetime-2')), 'SIGKILL')
  await waitFor(() => shutDown.status('Ubuntu').state === 'shut-down')
  assert.match(shutDown.status('Ubuntu').reason ?? '', /WSL was shut down/u)
})

/** The server's pid, from the run lock it holds. */
function readServerPid(home: string): number {
  const lock = JSON.parse(
    readFileSync(join(home, WSL_DATA_REL, 'data-0123456789ab', 'run', 'studio.lock'), 'utf8'),
  ) as { pid: number }
  return lock.pid
}

async function waitFor(condition: () => boolean, ms = 10_000, poll?: () => Promise<void>): Promise<void> {
  const until = Date.now() + ms
  for (;;) {
    await poll?.()
    if (condition()) return
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test("the desktop's toolsets are offered to the WSL server, and a second connection sees them offered", async () => {
  const home = fakeHome('relay')
  const listeners: Array<(connection: WslServerConnection) => void> = []
  // Stands in for the Windows side's registry, with the shell's browser toolset in it.
  const registry = {
    visibleTools: () => [
      {
        toolset: 'browser',
        builtIn: true,
        title: 'Browser',
        tool: { name: 'navigate', description: 'Go to a page.', inputSchema: { type: 'object' } },
        wireName: 'browser.navigate',
        mutates: true,
      },
    ],
    subscribe: () => () => undefined,
    call: async () => ({ result: { content: [{ type: 'text', text: 'done' }] } }),
  } as unknown as ClientToolRegistry
  const relay = relayShellToolsets({ onConnected: (listener) => listeners.push(listener), registry })
  cleanups.push(() => relay.close())
  const { manager: wsl } = manager({
    homes: { Ubuntu: home },
    connected: (connection) => listeners.forEach((listener) => listener(connection)),
  })
  const connection = await wsl.connect('Ubuntu')
  const viewer = await connect({
    transport: async () => {
      const stream = await connection.open('studio')
      return lineTransport(stream, await readTicket(stream))
    },
    client: { name: 'viewer', kind: 'desktop' },
    reconnect: false,
  })
  cleanups.push(() => viewer.close())
  let listing: Awaited<ReturnType<typeof viewer.tools.catalog>> = []
  await waitFor(
    () => listing.some((entry) => entry.name === 'browser'),
    15_000,
    async () => {
      listing = await viewer.tools.catalog()
    },
  )
  const browser = listing.find((entry) => entry.name === 'browser')!
  assert.deepEqual(
    browser.tools.map((tool) => tool.wireName),
    ['browser.navigate'],
  )
  assert.equal(browser.offeredBy[0]?.clientName, 'SprintEngine Studio (Windows)')
})

/**
 * A Windows front door's router over `wsl`, with a workspace in `home/repo`
 * and nothing running in this process, and the chat in it on the mock
 * provider, as the chat view starts and sends it.
 */
function routedChat(wsl: ReturnType<typeof manager>['manager'], home: string) {
  const local = {
    onEvent: () => () => undefined,
    listSessions: () => ({ ok: true, sessions: [] }),
  } as unknown as ConversationBackend
  const folder = `\\\\wsl.localhost\\Ubuntu${join(home, 'repo').replaceAll('/', '\\')}`
  const router = createRoutedConversationBackend({
    local,
    workspace: () => ({ hostId: 'wsl:Ubuntu', folderPath: folder }),
    chatServerOn: () => true,
    servers: wsl,
    platform: 'win32',
  })
  const events: ConversationEvent[] = []
  router.onEvent((event) => events.push(event))
  const key = { workspaceRoot: folder, workspaceId: 'ws-1', agentId: 'agent' }
  return {
    router,
    events,
    key,
    start: () => router.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' }),
    /** A turn that runs to its end; resolves once its `turn_completed` has arrived. */
    async send(sessionId: string) {
      const before = events.filter((event) => event.type === 'turn_completed').length
      const sent = await router.sendTurn({ sessionId, message: '/tools' })
      if (sent.ok) await waitFor(() => events.filter((event) => event.type === 'turn_completed').length > before)
      return sent
    },
  }
}

test('a killed server is not taken for a loopback that failed, says it was killed, and its restart keeps the chat working', async () => {
  const home = fakeHome('killed')
  const logs: string[] = []
  let clock = Date.now()
  const { manager: wsl } = manager({
    homes: { Ubuntu: home },
    // Longer than the loopback deadline, so a reconnect to the dead server
    // would have given up on loopback before its exit was known.
    closeDelayMs: 4_000,
    log: (message) => logs.push(message),
    now: () => clock,
  })
  const chat = routedChat(wsl, home)
  const started = await chat.start()
  assert.ok(started.ok, started.ok ? '' : started.message)
  const first = await chat.send(started.session.sessionId)
  assert.ok(first.ok, first.ok ? '' : first.message)
  assert.equal(wsl.status('Ubuntu').transport, 'loopback')
  // The server keeps its own log in the distribution, where the checklist reads it.
  const logsDir = join(home, '.local', 'state', 'sprintengine-studio', 'logs', 'data-0123456789ab')
  const logFile = readdirSync(logsDir).find((name) => /^server-\d{4}-\d{2}-\d{2}\.log$/u.test(name))
  assert.ok(logFile, 'a server log is written')
  assert.match(readFileSync(join(logsDir, logFile), 'utf8'), /\[studio-server\] ready in \d+ ms/u)

  process.kill(readServerPid(home), 'SIGKILL')
  await waitFor(() => wsl.status('Ubuntu').state === 'unavailable', 15_000)
  assert.equal(
    wsl.status('Ubuntu').reason,
    'The Studio server in Ubuntu stopped unexpectedly (killed). It starts again with the next message.',
  )
  assert.deepEqual(
    logs.filter((line) => /loopback did not work|stdio bridge|reconnecting/u.test(line)),
    [],
    'a dead server is not reconnected to, so nothing is downgraded',
  )

  // The next message, after the crash backoff: the server starts again,
  // reached over loopback, and does not hold the session the chat view kept.
  clock += 60_000
  const stale = await chat.router.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
  assert.equal(stale.ok ? null : stale.code, 'session_not_found')
  assert.equal(wsl.status('Ubuntu').transport, 'loopback', 'a restarted server is reached over loopback again')
  // What the view does then, as after an app restart: start the chat's
  // session again (it resumes from its transcript) and send on that one.
  const restarted = await chat.start()
  assert.ok(restarted.ok, restarted.ok ? '' : restarted.message)
  const again = await chat.send(restarted.session.sessionId)
  assert.ok(again.ok, again.ok ? '' : again.message)
  const transcript = await chat.router.readTranscript(chat.key, { all: true })
  assert.ok(transcript.ok, transcript.ok ? '' : transcript.message)
  assert.equal(
    transcript.events.filter((event) => event.type === 'user_message').length,
    2,
    'one chat, both turns, across the restart',
  )
}, 60_000)

test('WSL shut down under a chat: nothing starts it again until the next message, which starts the server and resumes the chat', async () => {
  const home = fakeHome('shutdown')
  const logs: string[] = []
  const statuses: WslServerStatus[] = []
  let state = 'Running'
  const { manager: wsl, runner } = manager({
    homes: { Ubuntu: home },
    listing: () => ({ distros: [{ name: 'Ubuntu', isDefault: true, state, version: 2 }], at: Date.now() }),
    statuses,
    closeDelayMs: 500,
    log: (message) => logs.push(message),
  })
  const chat = routedChat(wsl, home)
  const started = await chat.start()
  assert.ok(started.ok, started.ok ? '' : started.message)
  assert.ok((await chat.send(started.session.sessionId)).ok)
  const spawned = runner.spawned

  // `wsl --shutdown`: every Linux process ends, and WSL lists the distribution stopped.
  state = 'Stopped'
  process.kill(readServerPid(home), 'SIGKILL')
  await waitFor(() => wsl.status('Ubuntu').state === 'shut-down', 15_000)
  assert.match(wsl.status('Ubuntu').reason ?? '', /^WSL was shut down/u)
  // Long enough for a reconnect, had one been tried, to have reached for the bridge.
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  assert.equal(runner.spawned, spawned, 'no wsl.exe was run, so nothing booted the VM again')
  assert.deepEqual(
    logs.filter((line) => /loopback did not work|stdio bridge|reconnecting/u.test(line)),
    [],
  )
  assert.equal(wsl.current('Ubuntu'), null)

  // The next message starts the VM (here, the shell) and the server, and the chat resumes.
  state = 'Running'
  const stale = await chat.router.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
  assert.equal(stale.ok ? null : stale.code, 'session_not_found')
  const restarted = await chat.start()
  assert.ok(restarted.ok, restarted.ok ? '' : restarted.message)
  const again = await chat.send(restarted.session.sessionId)
  assert.ok(again.ok, again.ok ? '' : again.message)
  assert.equal(wsl.status('Ubuntu').state, 'ready')
}, 60_000)
