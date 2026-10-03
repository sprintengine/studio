// A workspace on an SSH machine, its files and git read on that machine: a
// real SshEnvironment (a plain `sh` standing in for ssh, the real server tree
// and relay), a git repository in the machine's home, and the desktop's own
// IPC registrations behind the machine-aware wrapper, asked with paths spelled
// `ssh://<id>/…`. A decoy folder of the same plain path exists on this side
// too, and is never what answers.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../../shared/ssh-environments'
import { machinePath } from '../../../shared/machine-paths'
import { BACKEND_WIRE_VERSION } from '../../../server/wsl/backend-wire'
import { WSL_NODE_VERSION } from '../../hosts/wsl-node-runtime'
import { machineAwareIpc, machineOfArgs, plainArgs, spelledResult } from './machine-ipc'
import { SshEnvironment } from './ssh-environment'
import { serverTreeDigest } from './ssh-install'
import type { SessionProcess } from './ssh-session'

const ROOT = join(__dirname, '..', '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
let scratch = ''
let tree = ''
let digest = ''
const pids: number[] = []

beforeAll(() => {
  // Real path: git answers with one (macOS's temp directory is a symlink).
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'se-ssh-files-')))
  tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  digest = serverTreeDigest(tree)
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

test('machine paths: found in arguments, made plain, spelled again in answers (never file contents)', () => {
  assert.deepEqual(machineOfArgs(['ssh://e1/home/dev/repo', 'src']), { id: 'e1' })
  assert.deepEqual(machineOfArgs([{ rootPath: 'ssh://e1/home/dev/repo', query: '/src' }]), { id: 'e1' })
  assert.equal(machineOfArgs(['/Users/dev/repo']), null)
  assert.deepEqual(machineOfArgs(['ssh://e1/a', 'ssh://e2/b']), { mixed: true })
  assert.deepEqual(machineOfArgs(['ssh://../etc']), { mixed: true }, 'a malformed one is refused, never read here')
  assert.deepEqual(plainArgs([{ rootPath: 'ssh://e1/home/dev/repo' }, ['ssh://e1/x']]), [
    { rootPath: '/home/dev/repo' },
    ['/x'],
  ])
  assert.equal(spelledResult('e1', 'git:get-repo-root', '/home/dev/repo'), 'ssh://e1/home/dev/repo')
  assert.deepEqual(
    spelledResult('e1', 'fs:search-files', {
      ok: true,
      results: [{ path: '/home/dev/repo/a.ts', parentPath: '/home/dev/repo', name: 'a.ts' }],
    }),
    {
      ok: true,
      results: [{ path: 'ssh://e1/home/dev/repo/a.ts', parentPath: 'ssh://e1/home/dev/repo', name: 'a.ts' }],
    },
  )
  assert.equal(
    spelledResult('e1', 'fs:readfile', '/* a file that starts with a slash */'),
    '/* a file that starts with a slash */',
  )
})

test('a workspace on an SSH machine: the explorer, search, git status, diffs, staging and a commit, all on the machine', async () => {
  const home = join(scratch, 'home')
  const repo = join(home, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const answer = 41\n')
  writeFileSync(join(repo, '.gitignore'), 'dist\n')
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], {
      encoding: 'utf8',
    })
  git('init', '-q', '-b', 'main')
  // The machine's own identity for commits, as a person's ~/.gitconfig there would give.
  git('config', 'user.name', 'Dev')
  git('config', 'user.email', 'dev@example.com')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const answer = 42\n')
  writeFileSync(join(repo, 'src', 'new.ts'), 'export {}\n')

  const fakeNode = Buffer.from(
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${WSL_NODE_VERSION}; exit 0; fi\nexec '${process.execPath}' "$@"\n`,
  )
  const machine = new SshEnvironment({
    id: 'e1',
    label: () => 'build-box',
    settings: () => ({ ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }),
    spawn: () =>
      spawn('sh', ['-s'], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as SessionProcess,
    app: { version: VERSION, channel: 'latest', backendWire: BACKEND_WIRE_VERSION },
    dataName: 'data',
    startedBy: 'Studio on dev-macbook-air',
    serverTree: () => ({ dir: tree, digest }),
    nodeBinary: async () => ({ binary: fakeNode }),
    onChange: () => undefined,
  })
  const connection = await machine.connect({ interactive: false })
  pids.push(
    (
      JSON.parse(
        readFileSync(join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run', 'server.json'), 'utf8'),
      ) as {
        pid: number
      }
    ).pid,
  )

  // The desktop's channels, as main registers them, behind the wrapper.
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const localCalls: string[] = []
  const fakeIpcMain = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, listener),
  }
  const ipc = machineAwareIpc(fakeIpcMain as never, {
    call: (id, channel, args) => {
      assert.equal(id, 'e1')
      return connection.backend.machine(channel, args)
    },
  })
  for (const channel of [
    'fs:readdir',
    'fs:readfile',
    'fs:search-files',
    'git:get-repo-root',
    'git:get-status',
    'git:get-file-base',
    'git:stage',
    'git:commit',
    'fs:watch-start',
    'fs:write-file',
    'terminal:create',
  ])
    ipc.handle(channel, (_event: unknown, ...args: unknown[]) => {
      localCalls.push(`${channel} ${JSON.stringify(args)}`)
      return 'answered on this computer'
    })
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!({ sender: { id: 1 } }, ...args))
  const root = machinePath('e1', repo)

  // A local path is this computer's, as before.
  assert.equal(await invoke('fs:readdir', '/Users/dev/somewhere'), 'answered on this computer')

  const listing = (await invoke('fs:readdir', `${root}/src`)) as Array<{ name: string; isDir: boolean }>
  assert.deepEqual(listing.map((entry) => entry.name).sort(), ['app.ts', 'new.ts'])
  assert.equal(await invoke('fs:readfile', `${root}/src/app.ts`), 'export const answer = 42\n')
  const found = (await invoke('fs:search-files', { rootPath: root, query: 'new', purpose: 'mention', limit: 10 })) as {
    ok: boolean
    results: Array<{ path: string }>
  }
  assert.ok(found.ok)
  assert.ok(
    found.results.some((entry) => entry.path === `${root}/src/new.ts`),
    JSON.stringify(found),
  )

  assert.equal(await invoke('git:get-repo-root', `${root}/src`), root)
  const status = (await invoke('git:get-status', root)) as { repoRoot: string; files: Record<string, unknown> }
  assert.equal(status.repoRoot, root)
  assert.deepEqual(Object.keys(status.files).sort(), [`${root}/src/app.ts`, `${root}/src/new.ts`])
  assert.deepEqual(await invoke('git:get-file-base', root, `${root}/src/app.ts`), {
    ok: true,
    content: 'export const answer = 41\n',
  })

  await invoke('git:stage', root, [`${root}/src/app.ts`, `${root}/src/new.ts`])
  const committed = (await invoke('git:commit', root, 'Answer correctly')) as { ok: boolean; message?: string }
  assert.ok(committed.ok, JSON.stringify(committed))
  assert.match(git('log', '--oneline', '-1'), /Answer correctly/u)

  // No watch for a machine's folder; a refusal in words for anything else.
  assert.equal(await invoke('fs:watch-start', `${root}/src`), null)
  await assert.rejects(
    invoke('fs:write-file', `${root}/src/app.ts`, 'x'),
    /Not available for SSH machines yet \(fs:write-file\)/u,
  )
  await assert.rejects(invoke('terminal:create', { cwd: root }), /Not available for SSH machines yet/u)
  assert.deepEqual(localCalls, ['fs:readdir ["/Users/dev/somewhere"]'], 'nothing about the machine was answered here')
  machine.disconnect()
})
