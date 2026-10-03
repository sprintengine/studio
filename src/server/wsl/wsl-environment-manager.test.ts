import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
import { lineTransport, readTicket, relayShellToolsets } from './wsl-tool-relay'

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

beforeAll(() => {
  // Short: the server's sockets live under each fake home.
  scratch = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'se-wsl-'))
  const tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  payload = buildAppPayload([{ dir: tree, into: '' }])
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

/** `wsl.exe` as `sh` in a home of the distribution's own. */
function fakeRunner(homes: Record<string, string>): WslRunner & { spawned: number } {
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
        child.once(event, listener as (...args: unknown[]) => void),
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
}) {
  const runner = fakeRunner(options.homes)
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
    nodeDigests: wslNodeDigests,
    installNode: async () => assert.fail('Node is already in the fake distribution'),
    install: (distro, input) => installTree(distro, input, VERSION, runner),
    transportFor: () => options.transport ?? 'auto',
    onStatus: (status) => options.statuses?.push(status),
    onConnected: (connection) => options.connected?.(connection),
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

test('with the bridge chosen, the server is reached through the stdio relay and no loopback door opens', async () => {
  const home = fakeHome('bridge')
  const { manager: wsl } = manager({ homes: { Debian: home }, transport: 'stdio' })
  const connection = await wsl.connect('Debian')
  assert.equal(wsl.status('Debian').transport, 'stdio')
  const threads = await connection.backend.listThreads({ workspaceRoot: join(home, 'repo'), workspaceId: 'ws-1' })
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
