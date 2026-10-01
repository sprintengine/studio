import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'vitest'

import { parseStudioServerDiscovery } from '../../../packages/studio-protocol/src/public'
import { ensurePrivateDirectory, probeStudioSocket, resolveStudioSocketPath } from './studio-rpc-listener'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

const posix = process.platform !== 'win32'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test.runIf(posix)('the socket, its directory and the discovery file are the owner’s alone', async () => {
  const started = await startTestServer()
  cleanups.push(() => started.dispose())
  const runDir = join(started.dataDir, 'run')
  assert.equal(statSync(runDir).mode & 0o777, 0o700)
  assert.equal(statSync(started.path).mode & 0o777, 0o600)
  assert.equal(statSync(dirname(started.path)).mode & 0o077, 0)
  const discovery = parseStudioServerDiscovery(JSON.parse(readFileSync(join(runDir, 'server.json'), 'utf8')))
  assert.equal(statSync(join(runDir, 'server.json')).mode & 0o777, 0o600)
  assert.deepEqual(discovery && [discovery.socketPath, discovery.pid, discovery.transport, discovery.framing], [
    started.path,
    process.pid,
    'unix-socket',
    'ndjson',
  ])
  // Nothing secret is written beside the socket.
  assert.doesNotMatch(readFileSync(join(runDir, 'server.json'), 'utf8'), /token/i)
})

test.runIf(posix)('stopping tells each client why, then removes the socket and the discovery file', async () => {
  const started = await startTestServer()
  const client = await connectLineClient(started.path)
  cleanups.push(() => client.close())
  client.send(hello({ token: OWNER_TOKEN }))
  await client.next((frame) => frame.t === 'welcome')
  await started.dispose()
  const bye = await client.next((frame) => frame.t === 'bye')
  assert.deepEqual(bye.t === 'bye' && [bye.code, bye.retryAfterMs], ['shutting_down', 1_000])
  assert.equal(existsSync(started.path), false)
  assert.equal(existsSync(join(started.dataDir, 'run', 'server.json')), false)
})

test.runIf(posix)('a socket a crashed run left behind is replaced; a live one is never taken over', async () => {
  const first = await startTestServer()
  cleanups.push(() => first.dispose())
  assert.equal(await probeStudioSocket(first.path), 'live')
  const { createStudioRpcServer } = await import('./studio-rpc-server')
  const second = createStudioRpcServer({
    dataDir: first.dataDir,
    version: 'second',
    environmentId: 'env',
    backend: first.backend,
    authenticator: first.auth,
  })
  await assert.rejects(second.start(), /Another Studio is already serving/)
  // The first is untouched by the attempt.
  assert.equal(await probeStudioSocket(first.path), 'live')

  const dataDir = await mkdtemp(join(tmpdir(), 'studio-rpc-stale-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const path = resolveStudioSocketPath(dataDir)
  ensurePrivateDirectory(dirname(path))
  // A crash: a process that was listening is killed, and its socket file stays.
  const crashed = spawn(
    process.execPath,
    ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  await new Promise<void>((resolve) => crashed.stdout!.once('data', () => resolve()))
  crashed.kill('SIGKILL')
  await new Promise<void>((resolve) => crashed.once('exit', () => resolve()))
  assert.equal(existsSync(path), true)
  assert.equal(await probeStudioSocket(path), 'stale')
  const recovered = createStudioRpcServer({
    dataDir,
    version: 'recovered',
    environmentId: 'env',
    backend: first.backend,
    authenticator: first.auth,
  })
  await recovered.start()
  cleanups.push(() => recovered.stop())
  assert.equal(await probeStudioSocket(path), 'live')
})

test.runIf(posix)('a run directory that is a symlink, or open to others, is not listened in as it is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-rpc-private-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'elsewhere'))
  await symlink(join(root, 'elsewhere'), join(root, 'linked'))
  assert.throws(() => ensurePrivateDirectory(join(root, 'linked')), /not a directory Studio can keep private/)
  await mkdir(join(root, 'open'), { mode: 0o755 })
  ensurePrivateDirectory(join(root, 'open'))
  assert.equal(statSync(join(root, 'open')).mode & 0o777, 0o700)
})

test('a long data directory falls back to a private directory in temp; Windows gets an unguessable pipe', () => {
  const long = `/Users/dev/${'nested/'.repeat(20)}profile`
  const fallback = resolveStudioSocketPath(long, 'darwin', '/tmp/t')
  assert.match(fallback, /^\/tmp\/t\/sprintengine-studio-[^/]+-[0-9a-f]{12}-[0-9a-f]{12}\/studio\.sock$/)
  // Not predictable: another account cannot prepare it in advance.
  assert.notEqual(fallback, resolveStudioSocketPath(long, 'darwin', '/tmp/t'))
  assert.equal(resolveStudioSocketPath('/Users/dev/app-data', 'linux'), '/Users/dev/app-data/run/studio.sock')
  const pipe = resolveStudioSocketPath('C:\\Users\\dev\\AppData', 'win32')
  assert.match(pipe, /^\\\\\.\\pipe\\sprintengine-studio-[0-9a-f]{12}-[0-9a-f]{16}$/)
  assert.notEqual(pipe, resolveStudioSocketPath('C:\\Users\\dev\\AppData', 'win32'))
})

test.runIf(posix)('one app cannot hold more than its share of connections', async () => {
  const started = await startTestServer({ maxConnectionsPerClient: 2 })
  cleanups.push(() => started.dispose())
  const token = pairFakeClient(started.auth, 'greedy', ['conversation:read'])
  for (let index = 0; index < 2; index++) {
    const held = await connectLineClient(started.path)
    cleanups.push(() => held.close())
    held.send(hello({ token }))
    await held.next((frame) => frame.t === 'welcome')
  }
  const third = await connectLineClient(started.path)
  cleanups.push(() => third.close())
  third.send(hello({ token }))
  const bye = await third.next((frame) => frame.t === 'bye')
  assert.equal(bye.t === 'bye' && bye.code, 'too_many_connections')
  // Another app is not affected by this one's share.
  const other = await connectLineClient(started.path)
  cleanups.push(() => other.close())
  other.send(hello({ token: OWNER_TOKEN }))
  assert.equal((await other.next((frame) => frame.t === 'welcome' || frame.t === 'bye')).t, 'welcome')
})

test.runIf(posix)('connections past the cap are told so and closed', async () => {
  const started = await startTestServer({ maxConnections: 1 })
  cleanups.push(() => started.dispose())
  const first = await connectLineClient(started.path)
  cleanups.push(() => first.close())
  first.send(hello({ token: OWNER_TOKEN }))
  await first.next((frame) => frame.t === 'welcome')
  const second = await connectLineClient(started.path)
  cleanups.push(() => second.close())
  const bye = await second.next((frame) => frame.t === 'bye')
  assert.equal(bye.t === 'bye' && bye.code, 'too_many_connections')
})
