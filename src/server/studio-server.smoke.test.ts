import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, test } from 'vitest'

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

test('a server stops when the parent that drives it goes away', async () => {
  const served = serve(['--data-dir', join(scratch, 'orphan', 'data')], isolatedEnv('orphan'))
  assert.ok((await firstLine(served)).ready, served.stderr())
  served.child.stdin.end()
  assert.equal(await served.exited, 0, served.stderr())
})

test("a desktop's data directory is refused, or shared with the server's secrets off", async () => {
  const env = isolatedEnv('desktop')
  const dataDir = join(scratch, 'desktop', 'data')
  mkdirSync(dataDir, { recursive: true })
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
