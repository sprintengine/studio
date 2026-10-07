import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import type { WorktreeDependencyInstallView } from '../../shared/ipc/worktree-pool'
import {
  createDependencyInstaller,
  DEPENDENCY_INSTALL_RECORD,
  inferInstallCommand,
  runInstallCommand,
  worktreeGitDir,
  type InstallCommandRunner,
  type InstallRunOutcome,
} from './dependency-install'
import { normalizePoolSettings } from './pool-store'

let scratch = ''
let slot = ''
let adminDir = ''

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-dependency-install-')))
  slot = join(scratch, 'pool-01')
  adminDir = join(scratch, 'repo', '.git', 'worktrees', 'pool-01')
  await mkdir(slot, { recursive: true })
  await mkdir(adminDir, { recursive: true })
  await writeFile(join(slot, '.git'), `gitdir: ${adminDir}\n`)
  await writeFile(join(slot, 'package.json'), '{"name":"app"}\n')
  await writeFile(join(slot, 'package-lock.json'), '{"lockfileVersion":3}\n')
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/** A runner that stands in for the package manager: it records the call and "installs" `node_modules`. */
function fakeRunner(outcome: Partial<InstallRunOutcome> = {}) {
  const calls: Array<{ command: string; cwd: string }> = []
  const run: InstallCommandRunner = async ({ command, cwd, onOutput }) => {
    calls.push({ command, cwd })
    onOutput('added 12 packages\n')
    if ((outcome.code ?? 0) === 0) await mkdir(join(cwd, 'node_modules'), { recursive: true })
    return { code: 0, timedOut: false, cancelled: false, ...outcome }
  }
  return { run, calls }
}

function installer(run: InstallCommandRunner, views: WorktreeDependencyInstallView[] = []) {
  return createDependencyInstaller({
    env: async () => ({ PATH: '/usr/bin:/bin' }),
    run,
    onChange: (view) => views.push(view),
    log: () => {},
  })
}

const ON = { enabled: true, command: null }
const lease = (setting: { enabled: boolean; command: string | null } | null = ON) => ({
  repoRoot: join(scratch, 'repo'),
  path: slot,
  branch: 'agent/fix-login',
  setting,
})

test('each lockfile implies its own frozen install', () => {
  const infer = (files: string[], packageManager?: string) =>
    inferInstallCommand({ files: new Set(files), packageManager })?.command ?? null
  assert.equal(infer(['package-lock.json']), 'npm ci')
  assert.equal(infer(['pnpm-lock.yaml']), 'pnpm install --frozen-lockfile')
  assert.equal(infer(['yarn.lock']), 'yarn install --frozen-lockfile')
  assert.equal(infer(['yarn.lock', '.yarnrc.yml']), 'yarn install --immutable', 'a .yarnrc.yml is Yarn 2 or later')
  assert.equal(infer(['yarn.lock'], 'yarn@4.5.0'), 'yarn install --immutable')
  assert.equal(infer(['yarn.lock', '.yarnrc.yml'], 'yarn@1.22.22'), 'yarn install --frozen-lockfile')
  assert.equal(infer(['bun.lock']), 'bun install --frozen-lockfile')
  assert.equal(infer(['bun.lockb']), 'bun install --frozen-lockfile')
  assert.equal(infer(['Cargo.lock', 'package.json']), null, 'nothing is inferred outside JavaScript')
  assert.equal(infer([]), null)
})

test('packageManager settles which of several lockfiles is the one in use', () => {
  const both = new Set(['package-lock.json', 'yarn.lock'])
  assert.equal(inferInstallCommand({ files: both })?.command, 'yarn install --frozen-lockfile', 'by order alone')
  assert.equal(inferInstallCommand({ files: both, packageManager: 'npm@10.8.0' })?.command, 'npm ci')
  assert.equal(
    inferInstallCommand({ files: both, packageManager: 'pnpm@9.0.0' })?.command,
    'yarn install --frozen-lockfile',
    'a declared manager whose lockfile is not there is not taken',
  )
})

test('off by default: a project that did not opt in never runs anything', async () => {
  const { run, calls } = fakeRunner()
  const views: WorktreeDependencyInstallView[] = []
  assert.equal(await installer(run, views).prepare(lease(null)), null)
  assert.equal(await installer(run, views).prepare(lease({ enabled: false, command: 'make deps' })), null)
  assert.deepEqual(calls, [])
  assert.deepEqual(views, [])
  assert.equal(await exists(join(adminDir, DEPENDENCY_INSTALL_RECORD)), false)
})

test('a first lease installs and records; the next one with the same lockfile skips', async () => {
  const { run, calls } = fakeRunner()
  const views: WorktreeDependencyInstallView[] = []
  const deps = installer(run, views)

  const first = await deps.prepare(lease())
  assert.equal(first?.state, 'succeeded')
  assert.equal(first?.reason, 'first')
  assert.equal(first?.command, 'npm ci')
  assert.deepEqual(calls, [{ command: 'npm ci', cwd: slot }])
  assert.deepEqual(
    views.map((view) => view.state),
    ['running', 'succeeded'],
    'the windows hear it start and end',
  )
  assert.ok(await exists(join(adminDir, DEPENDENCY_INSTALL_RECORD)), 'recorded in the git admin directory')
  assert.equal(await exists(join(slot, DEPENDENCY_INSTALL_RECORD)), false, 'never in the worktree')

  assert.equal(await deps.prepare(lease()), null)
  assert.equal(calls.length, 1, 'unchanged lockfile: no install')
})

test('a changed lockfile installs again and records the new one', async () => {
  const { run, calls } = fakeRunner()
  const deps = installer(run)
  await deps.prepare(lease())
  const before = await readFile(join(adminDir, DEPENDENCY_INSTALL_RECORD), 'utf8')

  await writeFile(join(slot, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"x":{}}}\n')
  const again = await deps.prepare(lease())
  assert.equal(again?.reason, 'changed')
  assert.equal(calls.length, 2)
  assert.notEqual(await readFile(join(adminDir, DEPENDENCY_INSTALL_RECORD), 'utf8'), before)

  assert.equal(await deps.prepare(lease()), null, 'and is quiet after that')
})

test('missing node_modules installs even when the lockfile did not change', async () => {
  const { run, calls } = fakeRunner()
  const deps = installer(run)
  await deps.prepare(lease())
  // "Clear ignored files", or an agent that deleted them.
  await rm(join(slot, 'node_modules'), { recursive: true, force: true })
  const again = await deps.prepare(lease())
  assert.equal(again?.reason, 'missing')
  assert.equal(calls.length, 2)
})

test('a Plug’n’Play project counts as installed without node_modules', async () => {
  await rm(join(slot, 'package-lock.json'))
  await writeFile(join(slot, 'yarn.lock'), '# yarn lockfile v1\n')
  await writeFile(join(slot, '.yarnrc.yml'), 'nodeLinker: pnp\n')
  const calls: string[] = []
  const deps = installer(async ({ command, cwd }) => {
    calls.push(command)
    await writeFile(join(cwd, '.pnp.cjs'), '')
    return { code: 0, timedOut: false, cancelled: false }
  })
  await deps.prepare(lease())
  assert.equal(await deps.prepare(lease()), null)
  assert.deepEqual(calls, ['yarn install --immutable'])
})

test('a failed install is not recorded, says what it printed, and runs again at the next lease', async () => {
  const failing = fakeRunner({ code: 1 })
  const views: WorktreeDependencyInstallView[] = []
  const failed = await installer(failing.run, views).prepare(lease())
  assert.equal(failed?.state, 'failed')
  assert.equal(failed?.exitCode, 1)
  assert.match(failed?.output ?? '', /added 12 packages/)
  assert.equal(await exists(join(adminDir, DEPENDENCY_INSTALL_RECORD)), false)

  const working = fakeRunner()
  const retried = await installer(working.run).prepare(lease())
  assert.equal(retried?.state, 'succeeded')
  assert.equal(working.calls.length, 1, 'tried again')
})

test('a failure after a good install clears the record, so a half-done node_modules is not trusted', async () => {
  await installer(fakeRunner().run).prepare(lease())
  await writeFile(join(slot, 'package-lock.json'), '{"lockfileVersion":3,"v":2}\n')
  await installer(fakeRunner({ code: 1 }).run).prepare(lease())
  // node_modules is still there from the first install, and the lockfile is the new one.
  const again = fakeRunner()
  await installer(again.run).prepare(lease())
  assert.equal(again.calls.length, 1)
})

test('a cancelled install ends as cancelled and is not recorded', async () => {
  const views: WorktreeDependencyInstallView[] = []
  const deps = installer(
    ({ signal }) =>
      new Promise((done) => {
        signal.addEventListener('abort', () => done({ code: null, timedOut: false, cancelled: true }))
      }),
    views,
  )
  const pending = deps.prepare(lease())
  await new Promise((resolve) => setTimeout(resolve, 20))
  const [running] = deps.list()
  assert.equal(running?.state, 'running')
  assert.equal(deps.cancel(running!.id), true)
  const ended = await pending
  assert.equal(ended?.state, 'cancelled')
  assert.deepEqual(deps.list(), [])
  assert.equal(deps.cancel(running!.id), false, 'already over')
  assert.equal(await exists(join(adminDir, DEPENDENCY_INSTALL_RECORD)), false)
})

test('a command of the project’s own runs as typed, and changing it, or any lockfile, runs it again', async () => {
  const { run, calls } = fakeRunner()
  const deps = installer(run)
  await writeFile(join(slot, 'Cargo.lock'), 'version = 3\n')
  await deps.prepare(lease({ enabled: true, command: 'npm install --no-audit' }))
  assert.equal(await deps.prepare(lease({ enabled: true, command: 'npm install --no-audit' })), null)
  await deps.prepare(lease({ enabled: true, command: 'pnpm install' }))
  await writeFile(join(slot, 'Cargo.lock'), 'version = 4\n')
  await deps.prepare(lease({ enabled: true, command: 'pnpm install' }))
  assert.deepEqual(
    calls.map((call) => call.command),
    ['npm install --no-audit', 'pnpm install', 'pnpm install'],
  )
})

test('nothing to install: no lockfile and no command of its own', async () => {
  await rm(join(slot, 'package-lock.json'))
  const { run, calls } = fakeRunner()
  assert.equal(await installer(run).prepare(lease()), null)
  assert.deepEqual(calls, [])
})

test('the git admin directory is read from the worktree’s .git file, relative or not', async () => {
  assert.equal(await worktreeGitDir(slot), adminDir)
  await writeFile(join(slot, '.git'), 'gitdir: ../repo/.git/worktrees/pool-01\n')
  assert.equal(await worktreeGitDir(slot), adminDir)
  assert.equal(await worktreeGitDir(join(scratch, 'nowhere')), null)
})

test('the real runner reports the exit code and what was printed, and stops a command at its deadline', async () => {
  const output: string[] = []
  const done = await runInstallCommand({
    command: `"${process.execPath}" -e "console.log('installing'); process.exit(3)"`,
    cwd: slot,
    env: process.env,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    onOutput: (chunk) => output.push(chunk),
  })
  assert.equal(done.code, 3)
  assert.match(output.join(''), /installing/)

  const slow = await runInstallCommand({
    command: `"${process.execPath}" -e "setTimeout(() => {}, 10000)"`,
    cwd: slot,
    env: process.env,
    timeoutMs: 200,
    signal: new AbortController().signal,
    onOutput: () => {},
  })
  assert.equal(slow.timedOut, true)
})

test('the stored choices keep what a project opted into, and drop the default and anything malformed', () => {
  const settings = normalizePoolSettings({
    dependencyInstall: {
      '/Users/dev/app': { enabled: true, command: '  pnpm install  ' },
      '/Users/dev/kept-command': { enabled: false, command: 'make deps' },
      '/Users/dev/off': { enabled: false, command: '' },
      '/Users/dev/odd': 'yes' as never,
    },
  })
  assert.deepEqual(settings.dependencyInstall, {
    '/Users/dev/app': { enabled: true, command: 'pnpm install' },
    '/Users/dev/kept-command': { enabled: false, command: 'make deps' },
  })
  assert.deepEqual(normalizePoolSettings(null).dependencyInstall, {}, 'off for every project by default')
})
