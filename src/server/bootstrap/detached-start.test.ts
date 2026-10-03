// An SSH machine's managed server, without SSH: the real server tree is
// built as `npm run build:server:wsl` builds it, started with
// `server.cjs start --detach` in a temporary home, and reached through the
// real relay (`bridge.mjs --mux`) over its stdio, exactly as an SSH session
// carries it. The SSH session itself is in the environment's own suites.

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterAll, afterEach, beforeAll, test } from 'vitest'

import { attachRelay, type AttachedRelay } from '../../main/environments/ssh/relay-client'
import { connectRemoteConversationBackend } from '../wsl/backend-wire'
import { READY_MARKER } from './detached-start'

const ROOT = join(__dirname, '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

let scratch = ''
let tree = ''
beforeAll(() => {
  // Short: the front door's socket lives under each home's run directory.
  scratch = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'se-det-'))
  tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
})

const pids = new Set<number>()
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
})
afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone.
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

function homeOf(name: string) {
  const home = join(scratch, name)
  mkdirSync(home, { recursive: true })
  const dataDir = join(home, '.local', 'share', 'sprintengine-studio', 'data')
  return { home, dataDir, runDir: join(dataDir, 'run') }
}

type Started = { attached: boolean; record: { pid: number; version: string; socketPath: string; origin: string } }

function start(home: string, dataDir: string, extra: string[] = []): { started: Started | null; out: string } {
  const result = spawnSync(
    process.execPath,
    [join(tree, 'server.cjs'), 'start', '--detach', '--data-dir', dataDir, ...extra],
    {
      env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith(`${READY_MARKER} `))
  const started = line ? (JSON.parse(line.slice(READY_MARKER.length + 1)) as Started) : null
  if (started?.record?.pid) pids.add(started.record.pid)
  return { started, out: `${result.stdout}${result.stderr}` }
}

async function relay(home: string, runDir: string): Promise<AttachedRelay & { child: ChildProcess }> {
  const child = spawn(process.execPath, [join(tree, 'bridge.mjs'), '--mux', runDir], {
    env: { PATH: process.env.PATH, HOME: home, SSH_CONNECTION: '203.0.113.7 51000 198.51.100.2 22' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  // What a chatty login profile prints before the relay does.
  return { ...(await attachRelay(child.stdout!, child.stdin!)), child }
}

const readLine = (stream: Duplex): Promise<string> =>
  new Promise((resolve) => {
    let text = ''
    const onData = (chunk: Buffer) => {
      text += chunk.toString('utf8')
      const newline = text.indexOf('\n')
      if (newline === -1) return
      stream.off('data', onData)
      resolve(text.slice(0, newline))
    }
    stream.on('data', onData)
  })

test('a detached start: one server, its token private, reached through the relay, outliving it', async () => {
  const { home, dataDir, runDir } = homeOf('one')
  const first = start(home, dataDir, [
    '--started-by-b64',
    Buffer.from('Studio on dev-macbook-air').toString('base64url'),
  ])
  assert.ok(first.started, first.out)
  assert.equal(first.started.attached, false)
  const record = first.started.record
  assert.equal(record.version, VERSION)
  assert.equal(record.origin, 'bootstrap')
  assert.ok(alive(record.pid))

  // Private: the run directory 0700, the token and the record 0600, and the
  // token in no process's command line.
  assert.equal(statSync(runDir).mode & 0o777, 0o700)
  assert.equal(statSync(join(runDir, 'owner-token')).mode & 0o777, 0o600)
  assert.equal(statSync(join(runDir, 'server.json')).mode & 0o777, 0o600)
  const token = readFileSync(join(runDir, 'owner-token'), 'utf8').trim()
  assert.ok(token.length >= 40)
  const ps = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout
  assert.ok(!ps.includes(token), 'the owner token is in no command line')
  assert.ok(!readFileSync(join(runDir, 'server.json'), 'utf8').includes(token), 'nor in the record')

  // The relay names the server it found, then carries the backend.
  const attached = await relay(home, runDir)
  assert.equal(attached.ready.server?.version, VERSION)
  assert.equal(attached.ready.server?.pid, record.pid)
  const stream = await attached.endpoint.open({ kind: 'owner', purpose: 'backend' })
  const backend = connectRemoteConversationBackend(stream)
  await backend.refresh()
  const listed = backend.listSessions()
  assert.ok(listed.ok)

  // The shell role's connection says its ticket first.
  const studio = await attached.endpoint.open({ kind: 'owner', purpose: 'studio' })
  assert.match(await readLine(studio), /"t":"ticket"/u)

  // The audit line names the relay and the SSH client, never what was said.
  const log = readFileSync(
    join(
      home,
      '.local',
      'state',
      'sprintengine-studio',
      'logs',
      'data',
      `server-${new Date().toISOString().slice(0, 10)}.log`,
    ),
    'utf8',
  )
  assert.match(log, /Admitted a backend connection on the bridge door via ssh-relay from 203\.0\.113\.7/u)

  // A second start finds it, and does not start another.
  const again = start(home, dataDir)
  assert.equal(again.started?.attached, true, again.out)
  assert.equal(again.started?.record.pid, record.pid)

  // The session ends: the server does not.
  backend.close()
  attached.child.kill('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.ok(alive(record.pid), 'the server outlives the relay')

  // A relay with a token that is not the server's is refused, and learns nothing.
  writeFileSync(join(runDir, 'owner-token'), 'not-the-token\n', { mode: 0o600 })
  const impostor = await relay(home, runDir)
  await assert.rejects(impostor.endpoint.open({ kind: 'owner', purpose: 'backend' }), { code: 'refused' })
  writeFileSync(join(runDir, 'owner-token'), `${token}\n`, { mode: 0o600 })

  // An upgrade replaces it: the old one drains and goes, a new one with a new token starts.
  const replaced = start(home, dataDir, ['--replace'])
  assert.equal(replaced.started?.attached, false, replaced.out)
  assert.notEqual(replaced.started?.record.pid, record.pid)
  assert.ok(await until(() => !alive(record.pid), 5_000), 'the old server has gone')
  assert.notEqual(readFileSync(join(runDir, 'owner-token'), 'utf8').trim(), token)
  const next = await relay(home, runDir)
  const reached = connectRemoteConversationBackend(await next.endpoint.open({ kind: 'owner', purpose: 'backend' }))
  await reached.refresh()
  reached.close()

  // Asked to stop, it drains and removes its record.
  process.kill(replaced.started!.record.pid, 'SIGTERM')
  assert.ok(await until(() => !alive(replaced.started!.record.pid), 15_000))
  assert.ok(!existsSync(join(runDir, 'server.json')), 'the record goes with the server')
  const none = await relay(home, runDir)
  assert.equal(none.ready.server, null)
  await assert.rejects(none.endpoint.open({ kind: 'owner', purpose: 'backend' }), { code: 'no-server' })
})

test('a managed server with nobody connected and no chat working idles out', async () => {
  const { home, dataDir, runDir } = homeOf('idle')
  const { started, out } = start(home, dataDir, ['--idle-ms', '1500'])
  assert.ok(started, out)
  const attached = await relay(home, runDir)
  const stream = await attached.endpoint.open({ kind: 'owner', purpose: 'backend' })
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  assert.ok(alive(started.record.pid), 'a client is connected: it stays')
  stream.destroy()
  attached.child.kill('SIGKILL')
  assert.ok(await until(() => !alive(started.record.pid), 15_000), 'idle, so it stopped')
  assert.ok(!existsSync(join(runDir, 'server.json')))
})

test('a run lock that names another machine is refused in words, its pid never signalled', () => {
  const { home, dataDir, runDir } = homeOf('nfs')
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(runDir, 'studio.lock'),
    JSON.stringify({ role: 'server', pid: process.pid, hostname: 'build-box-2', startedAt: '', token: 'x' }),
  )
  writeFileSync(join(runDir, 'server.json'), JSON.stringify({ v: 1, pid: process.pid, hostId: 'host:build-box-2' }))
  const result = spawnSync(process.execPath, [join(tree, 'server.cjs'), 'start', '--detach', '--data-dir', dataDir], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: 'utf8',
  })
  assert.match(
    result.stdout,
    /@@SPRINTENGINE_FAIL other-host A Studio server is already running for this home on build-box-2/u,
  )
})
