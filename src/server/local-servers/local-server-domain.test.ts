import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { StudioLocalServer } from '../../../packages/studio-protocol/src/public'
import { createLocalServerDomain, type LocalServerDomainOptions, type LocalServersChanged } from './local-server-domain'
import { createTcpProbe } from './local-server-probe'
import { localServerStorePath } from './local-server-record'
import { createLocalServerRunner } from './local-server-runner'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const A = { workspaceId: 'ws-1', agentId: 'agent-a' }
const B = { workspaceId: 'ws-1', agentId: 'agent-b' }
const posix = process.platform !== 'win32'

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'local-server-domain-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function domainOver(options: Partial<LocalServerDomainOptions> = {}) {
  const dir = await tempDir()
  const changes: LocalServersChanged[] = []
  const domain = createLocalServerDomain({
    dataDir: dir,
    conversationFolder: () => dir,
    log: () => undefined,
    ...options,
    timing: { activeMs: 20, idleMs: 20, startingMs: 25, stopGraceMs: 2_000, disposeGraceMs: 500, ...options.timing },
  })
  domain.onChanged((change) => changes.push(change))
  cleanups.push(() => domain.dispose())
  return { domain, changes, dir }
}

async function serversOf(domain: Awaited<ReturnType<typeof domainOver>>['domain'], key = A) {
  const listed = await domain.list({ conversations: [key] })
  return listed.conversations[0]?.servers ?? []
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return typeof address === 'object' && address ? address.port : 0
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A runner for the tests: a plain sh and this process's environment, so no login shell is asked. */
const testRunner = () =>
  createLocalServerRunner({ shell: () => '/bin/sh', env: async () => ({ ...process.env }) as Record<string, string> })

test('a link is checked before it is answered, with the unspecified address recorded as localhost', async () => {
  const { domain, changes, dir } = await domainOver({ probe: async () => true })
  const linked = await domain.linkForAgent(A, { url: 'http://0.0.0.0:5173/', command: 'npm run dev' })
  assert.equal(linked.ok, true)
  const server = linked.ok ? linked.server : null
  assert.equal(server?.url, 'http://localhost:5173/')
  assert.equal(server?.title, 'localhost:5173')
  assert.equal(server?.state, 'running')
  // A command without a folder runs where the conversation works.
  assert.equal(server?.cwd, dir)
  assert.deepEqual(changes, [{ workspaceIds: ['ws-1'], conversations: [A] }])
  const refused = await domain.linkForAgent(A, { url: 'mailto:dev@example.com' })
  assert.equal(refused.ok, false)
})

test('a state change is published once, and a check that finds the same is not published', async () => {
  let open = false
  const { domain, changes } = await domainOver({ probe: async () => open })
  const linked = await domain.linkForAgent(A, { url: 'http://localhost:5173/' })
  assert.equal(linked.ok && linked.server.state, 'stopped')
  changes.length = 0
  const firstStateAt = (await serversOf(domain))[0]!.stateAt
  open = true
  await until(
    () => serversOf(domain),
    (servers) => servers[0]?.state === 'running',
    'running',
  )
  await sleep(150)
  const servers = await serversOf(domain)
  // Checked many times since, and told once.
  assert.ok(servers[0]!.stateAt > firstStateAt)
  assert.deepEqual(changes, [{ workspaceIds: ['ws-1'], conversations: [A] }])
})

test('another conversation linking the same port takes it over, and both are told', async () => {
  const { domain, changes } = await domainOver({ probe: async () => true })
  await domain.linkForAgent(A, { url: 'http://localhost:5173/' })
  changes.length = 0
  await domain.linkForAgent(B, { url: 'http://127.0.0.1:5173/' })
  assert.deepEqual(changes, [{ workspaceIds: ['ws-1'], conversations: [B, A] }])
  assert.deepEqual(await serversOf(domain, A), [])
  assert.equal((await serversOf(domain, B)).length, 1)
  // A workspace's list says whose each server is, so a client can name it to run, stop or remove.
  const listed = await domain.list({ workspaceIds: ['ws-1'] })
  assert.deepEqual(
    listed.workspaces['ws-1']?.map((server) => server.agentId),
    ['agent-b'],
  )
  assert.equal((await serversOf(domain, B))[0]?.agentId, 'agent-b')
})

test('a list waits for the stored record to be read and checked', async () => {
  const dir = await tempDir()
  const path = localServerStorePath(dir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      servers: [
        { id: 'k1', workspaceId: 'ws-1', agentId: 'agent-a', url: 'http://localhost:5173/', title: 'Web', linkedAt: 5 },
      ],
    }),
  )
  let answer: (open: boolean) => void = () => undefined
  const asked = new Promise<boolean>((resolve) => {
    answer = resolve
  })
  let probes = 0
  const { domain, changes } = await domainOver({
    dataDir: dir,
    probe: () => {
      probes += 1
      return probes === 1 ? asked : Promise.resolve(true)
    },
  })
  let answered = false
  const listing = domain.list({ workspaceIds: ['ws-1'] }).then((result) => {
    answered = true
    return result
  })
  await sleep(50)
  assert.equal(answered, false, 'no list before the first check')
  answer(true)
  const listed = await listing
  assert.equal(listed.workspaces['ws-1']?.[0]?.state, 'running')
  assert.equal(listed.workspaces['ws-1']?.[0]?.title, 'Web')
  // Nobody drew it before that check, so it is not a change.
  assert.deepEqual(changes, [])
})

test('a list that stopped waiting for a slow first check hears what it found', async () => {
  const dir = await tempDir()
  const path = localServerStorePath(dir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      servers: [
        { id: 'k1', workspaceId: 'ws-1', agentId: 'agent-a', url: 'http://localhost:5173/', title: '', linkedAt: 5 },
      ],
    }),
  )
  let answer: (open: boolean) => void = () => undefined
  const asked = new Promise<boolean>((resolve) => {
    answer = resolve
  })
  const { domain, changes } = await domainOver({
    dataDir: dir,
    probe: () => asked,
    timing: { firstCheckWaitMs: 30 },
  })
  const early = await domain.list({ conversations: [A] })
  assert.equal(early.conversations[0]?.servers[0]?.state, 'stopped')
  answer(true)
  await until(
    async () => changes.length,
    (count) => count > 0,
    'a change',
  )
  assert.deepEqual(changes, [{ workspaceIds: ['ws-1'], conversations: [A] }])
})

test.skipIf(!posix)('run again starts the command, reads starting until the port opens, and stop ends it', async () => {
  const port = await freePort()
  const script = `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')`
  const { domain, changes } = await domainOver({ probe: createTcpProbe({ timeoutMs: 200 }), startRun: testRunner() })
  const linked = await domain.linkForAgent(A, {
    url: `http://localhost:${port}/`,
    command: `"${process.execPath}" -e "${script}"`,
  })
  assert.equal(linked.ok && linked.server.state, 'stopped')
  const id = linked.ok ? linked.server.id : ''
  changes.length = 0

  assert.deepEqual(await domain.run({ conversation: A, id }), { ok: true })
  const starting = (await serversOf(domain))[0]!
  assert.equal(starting.state, 'starting')
  assert.equal(starting.startedByStudio, true)
  assert.ok(changes.length >= 1)

  const running = await until(
    () => serversOf(domain),
    (servers) => servers[0]?.state === 'running',
    'running',
  )
  assert.equal(running[0]!.startedByStudio, true)
  const again = await domain.run({ conversation: A, id })
  assert.equal(!again.ok && again.code, 'conflict')

  const stopped = await domain.stop({ conversation: A, id })
  assert.deepEqual(stopped, { ok: true, stopped: true })
  const after = await until(
    () => serversOf(domain),
    (servers) => servers[0]?.state === 'stopped' && servers[0]?.startedByStudio === undefined,
    'stopped',
  )
  // Stopped because the person asked: there is no exit to explain.
  assert.equal(after[0]!.lastExit, undefined)
  assert.equal(await createTcpProbe()('localhost', port), false, 'nothing is left on the port')
})

test.skipIf(!posix)('a run that fails keeps its exit code and the end of what it printed', async () => {
  const port = await freePort()
  const { domain } = await domainOver({ probe: createTcpProbe({ timeoutMs: 200 }), startRun: testRunner() })
  const linked = await domain.linkForAgent(A, {
    url: `http://localhost:${port}/`,
    command: 'echo listening soon; echo "port in use" 1>&2; exit 3',
  })
  const id = linked.ok ? linked.server.id : ''
  assert.deepEqual(await domain.run({ conversation: A, id }), { ok: true })
  const ended = await until(
    () => serversOf(domain),
    (servers) => servers[0]?.lastExit !== undefined,
    'the run to end',
  )
  const server: StudioLocalServer = ended[0]!
  assert.equal(server.state, 'stopped')
  assert.equal(server.startedByStudio, undefined)
  assert.equal(server.lastExit?.code, 3)
  assert.match(server.lastExit?.output ?? '', /listening soon/)
  assert.match(server.lastExit?.output ?? '', /port in use/)
})

test('how a run ended is shown only beside the state read after it ended', async () => {
  let ended: (exit: { code: number | null }) => void = () => undefined
  let holdProbe = false
  let releaseProbe: () => void = () => undefined
  const { domain } = await domainOver({
    probe: () =>
      holdProbe ? new Promise<boolean>((resolve) => (releaseProbe = () => resolve(false))) : Promise.resolve(false),
    startRun: () => ({
      output: () => 'port in use',
      exited: new Promise((resolve) => (ended = resolve)),
      alive: () => true,
      terminate: () => undefined,
      kill: () => undefined,
    }),
    timing: { activeMs: 60_000, idleMs: 60_000, startingMs: 60_000 },
  })
  const linked = await domain.linkForAgent(A, { url: 'http://localhost:4000/', command: 'npm run dev' })
  const id = linked.ok ? linked.server.id : ''
  assert.deepEqual(await domain.run({ conversation: A, id }), { ok: true })
  await until(
    () => serversOf(domain),
    (servers) => servers[0]?.state === 'starting',
    'the run to read as starting',
  )
  holdProbe = true
  ended({ code: 3 })
  await sleep(20)
  // The port is still being read: no exit is shown beside "starting".
  assert.equal((await serversOf(domain))[0]?.lastExit, undefined)
  releaseProbe()
  const after = await until(
    () => serversOf(domain),
    (servers) => servers[0]?.lastExit !== undefined,
    'the exit to be kept',
  )
  assert.equal(after[0]?.state, 'stopped')
  assert.equal(after[0]?.lastExit?.code, 3)
})

test('run, stop and remove refuse what they cannot do', async () => {
  let open = false
  const started: string[] = []
  const { domain, dir } = await domainOver({
    probe: async () => open,
    startRun: ({ command }) => {
      started.push(command)
      return {
        output: () => '',
        exited: new Promise(() => undefined),
        alive: () => true,
        terminate: () => undefined,
        kill: () => undefined,
      }
    },
  })
  const bare = await domain.linkForAgent(A, { url: 'http://localhost:4000/' })
  const bareId = bare.ok ? bare.server.id : ''
  const noCommand = await domain.run({ conversation: A, id: bareId })
  assert.equal(!noCommand.ok && noCommand.code, 'invalid_params')

  const gone = await domain.linkForAgent(A, {
    url: 'http://localhost:4001/',
    command: 'npm run dev',
    cwd: join(dir, 'not-here'),
  })
  const goneRun = await domain.run({ conversation: A, id: gone.ok ? gone.server.id : '' })
  assert.equal(!goneRun.ok && goneRun.code, 'invalid_params')
  assert.match(!goneRun.ok ? goneRun.message : '', /not-here/)

  const agents = await domain.linkForAgent(A, { url: 'http://localhost:4002/', command: 'npm run dev' })
  const agentsId = agents.ok ? agents.server.id : ''
  open = true
  const busy = await domain.run({ conversation: A, id: agentsId })
  assert.equal(!busy.ok && busy.code, 'conflict')
  // An agent's own server is the agent's to stop.
  const notOurs = await domain.stop({ conversation: A, id: agentsId })
  assert.equal(!notOurs.ok && notOurs.code, 'conflict')

  const otherConversation = await domain.run({ conversation: B, id: agentsId })
  assert.equal(!otherConversation.ok && otherConversation.code, 'not_found')
  assert.deepEqual(await domain.remove({ conversation: B, id: agentsId }), { removed: false })
  assert.deepEqual(await domain.remove({ conversation: A, id: agentsId }), { removed: true })
  assert.deepEqual(await domain.remove({ conversation: A, id: agentsId }), { removed: false })
  assert.deepEqual(started, [])
})

test('the domain ending stops the runs the Studio started', async () => {
  const signals: string[] = []
  let end: (exit: { code: number | null }) => void = () => undefined
  const exited = new Promise<{ code: number | null }>((resolve) => {
    end = resolve
  })
  let alive = true
  const { domain } = await domainOver({
    probe: async () => false,
    startRun: () => ({
      output: () => '',
      exited,
      alive: () => alive,
      terminate: () => {
        signals.push('terminate')
        alive = false
        end({ code: null })
      },
      kill: () => signals.push('kill'),
    }),
  })
  const linked = await domain.linkForAgent(A, { url: 'http://localhost:4100/', command: 'npm run dev' })
  assert.deepEqual(await domain.run({ conversation: A, id: linked.ok ? linked.server.id : '' }), { ok: true })
  await domain.dispose()
  assert.deepEqual(signals, ['terminate'])
})

test('a server removed while Run again checks its port is not started', async () => {
  // Every connect is held from here until the test answers them all.
  const held: Array<(open: boolean) => void> = []
  let holdProbe = false
  const started: string[] = []
  const { domain } = await domainOver({
    probe: () => (holdProbe ? new Promise<boolean>((resolve) => held.push(resolve)) : Promise.resolve(false)),
    startRun: ({ command }) => {
      started.push(command)
      throw new Error('not started in this test')
    },
  })
  const linked = await domain.linkForAgent(A, { url: 'http://localhost:5173/', command: 'npm run dev' })
  assert.ok(linked.ok)
  holdProbe = true
  const running = domain.run({ conversation: A, id: linked.server.id })
  await sleep(50)
  assert.deepEqual(await domain.remove({ conversation: A, id: linked.server.id }), { removed: true })
  holdProbe = false
  for (const answer of held.splice(0)) answer(false)
  const result = await running
  assert.equal(result.ok ? 'started' : result.code, 'not_found')
  assert.deepEqual(started, [])
})

test('a removed workspace’s links are forgotten, its run stopped first, and no longer checked', async () => {
  const removed = new Set<string>()
  const signals: string[] = []
  let end: (exit: { code: number | null }) => void = () => undefined
  const exited = new Promise<{ code: number | null }>((resolve) => {
    end = resolve
  })
  const probed: number[] = []
  const C = { workspaceId: 'ws-2', agentId: 'agent-c' }
  const { domain, changes } = await domainOver({
    workspaceRemoved: (workspaceId) => removed.has(workspaceId),
    probe: async (_host, port) => {
      probed.push(port)
      return false
    },
    startRun: () => ({
      output: () => '',
      exited,
      alive: () => signals.length === 0,
      terminate: () => {
        signals.push('terminate')
        end({ code: null })
      },
      kill: () => signals.push('kill'),
    }),
  })
  const linked = await domain.linkForAgent(A, { url: 'http://localhost:4100/', command: 'npm run dev' })
  await domain.linkForAgent(C, { url: 'http://localhost:4200/' })
  assert.deepEqual(await domain.run({ conversation: A, id: linked.ok ? linked.server.id : '' }), { ok: true })
  changes.length = 0

  // Nothing removed: nothing goes.
  await domain.prune()
  assert.equal(domain.record.all().length, 2)

  removed.add('ws-1')
  await domain.prune()
  assert.deepEqual(signals, ['terminate'])
  assert.deepEqual(
    domain.record.all().map((server) => server.workspaceId),
    ['ws-2'],
  )
  assert.deepEqual(changes, [{ workspaceIds: ['ws-1'], conversations: [A] }])
  const listed = await domain.list({ workspaceIds: ['ws-1', 'ws-2'] })
  assert.equal(listed.workspaces['ws-1'], undefined)
  assert.equal(listed.workspaces['ws-2']?.length, 1)
  probed.length = 0
  await sleep(120)
  assert.ok(!probed.includes(4100), 'the removed workspace’s server is no longer checked')
  assert.ok(probed.includes(4200))
})

test('links of a workspace removed while the Studio was not running are forgotten at start', async () => {
  const dir = await tempDir()
  const path = localServerStorePath(dir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      servers: [
        { id: 'k1', workspaceId: 'ws-gone', agentId: 'agent-a', url: 'http://localhost:5173/', linkedAt: 5 },
        { id: 'k2', workspaceId: 'ws-1', agentId: 'agent-a', url: 'http://localhost:5174/', linkedAt: 6 },
      ],
    }),
  )
  const probed: number[] = []
  const { domain } = await domainOver({
    dataDir: dir,
    workspaceRemoved: (workspaceId) => workspaceId === 'ws-gone',
    probe: async (_host, port) => {
      probed.push(port)
      return true
    },
  })
  const listed = await domain.list({ workspaceIds: ['ws-gone', 'ws-1'] })
  assert.deepEqual(Object.keys(listed.workspaces), ['ws-1'])
  assert.ok(!probed.includes(5173))
})
