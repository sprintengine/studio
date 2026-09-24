import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  createLoginShellPathResolver,
  findExecutable,
  LOGIN_BASH_PATH_TIMEOUT_MS,
  LOGIN_PATH_SENTINEL,
  loginShellPathDescriptors,
  parseLoginShellPath,
  searchDirectories,
  USER_SHELL_PATH_TIMEOUT_MS,
  userShellProbeSupported,
  type LoginShellPathDescriptor,
  type LoginShellPathOutcome,
} from './login-shell-path'

const answered = (path: string): LoginShellPathOutcome => ({
  code: 0,
  stdout: `\n${LOGIN_PATH_SENTINEL}${path}\n`,
  timedOut: false,
})
const hung: LoginShellPathOutcome = { code: 3, stdout: '', timedOut: true }

test("the person's own zsh is asked first, interactively, with plain login bash behind it", () => {
  const [own, plain] = loginShellPathDescriptors('/bin/zsh')
  assert.equal(own.file, '/bin/zsh')
  assert.equal(own.args[0], '-ilc', '-i so ~/.zshrc is sourced, as a terminal tab sources it')
  assert.match(own.args[1], /"\$PATH"/)
  assert.equal(own.timeoutMs, USER_SHELL_PATH_TIMEOUT_MS)
  assert.equal(plain.file, 'bash')
  assert.equal(plain.args[0], '-lc')
  assert.equal(plain.timeoutMs, LOGIN_BASH_PATH_TIMEOUT_MS)
})

test('a shell that cannot run the POSIX script, or none at all, leaves only login bash', () => {
  for (const shell of ['/opt/homebrew/bin/fish', '', '  ', undefined]) {
    const descriptors = loginShellPathDescriptors(shell)
    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.file),
      ['bash'],
      `${shell ?? 'no shell'}`,
    )
  }
})

test('the user shell is only consulted on a host POSIX target', () => {
  assert.equal(userShellProbeSupported('darwin', '/bin/zsh'), true)
  assert.equal(userShellProbeSupported('linux', '/usr/bin/bash'), true)
  assert.equal(userShellProbeSupported('win32', '/bin/zsh'), false)
  assert.equal(userShellProbeSupported('wsl', '/bin/zsh'), false)
  assert.equal(userShellProbeSupported('darwin', '/usr/bin/fish'), false)
})

test('the PATH is read from its marked line, whatever the rc files printed around it', () => {
  const stdout = [
    'Last login: Mon on ttys001',
    `${LOGIN_PATH_SENTINEL}/decoy/bin`,
    'motd noise',
    `${LOGIN_PATH_SENTINEL}/Users/dev/.nvm/bin:/usr/bin`,
    '',
  ].join('\n')
  assert.equal(parseLoginShellPath(stdout), '/Users/dev/.nvm/bin:/usr/bin', 'the last marked line wins')
  assert.equal(parseLoginShellPath('no marker here\n'), null)
  assert.equal(parseLoginShellPath(`${LOGIN_PATH_SENTINEL}\n`), null, 'an empty PATH is no answer')
})

test('search order is the login PATH, then what only the caller PATH has', () => {
  assert.deepEqual(searchDirectories('/Users/dev/.nvm/bin:/usr/bin::relative/bin:/bin', '/managed/shims:/usr/bin:'), [
    '/Users/dev/.nvm/bin',
    '/usr/bin',
    '/bin',
    '/managed/shims',
  ])
  assert.deepEqual(searchDirectories(null, '/usr/bin:/bin'), ['/usr/bin', '/bin'], 'no login PATH: the caller PATH')
})

test('a binary is found in PATH order, and only as an executable regular file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'login-shell-path-'))
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    // The first directory holds a non-executable `claude` and a directory named
    // `codex`; the only real binary is the second directory's `claude`.
    await writeFile(join(first, 'claude'), '#!/bin/sh\n')
    await chmod(join(first, 'claude'), 0o644)
    await mkdir(join(first, 'codex'))
    await writeFile(join(second, 'claude'), '#!/bin/sh\n')
    await chmod(join(second, 'claude'), 0o755)

    assert.equal(await findExecutable('claude', [first, second]), join(second, 'claude'))
    assert.equal(await findExecutable('codex', [first, second]), null, 'a directory is not a binary')
    assert.equal(await findExecutable('missing', [first, second]), null)
    assert.equal(await findExecutable('  ', [first, second]), null)
    // A command override that is already a path is checked where it points,
    // never looked up on PATH.
    assert.equal(await findExecutable(join(second, 'claude'), []), join(second, 'claude'))
    assert.equal(await findExecutable(join(first, 'claude'), [second]), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent callers share one shell, and the answer is kept for the session', async () => {
  const runs: LoginShellPathDescriptor[] = []
  let release: (outcome: LoginShellPathOutcome) => void = () => undefined
  const resolver = createLoginShellPathResolver({
    shell: () => '/bin/zsh',
    run: (descriptor) => {
      runs.push(descriptor)
      return new Promise((resolve) => (release = resolve))
    },
  })
  const pending = Array.from({ length: 10 }, () => resolver.resolve({}))
  release(answered('/Users/dev/.nvm/bin:/usr/bin'))
  const answers = await Promise.all(pending)
  assert.deepEqual(new Set(answers), new Set(['/Users/dev/.nvm/bin:/usr/bin']))
  assert.equal(await resolver.resolve({}), '/Users/dev/.nvm/bin:/usr/bin')
  assert.equal(runs.length, 1, 'ten CLIs, later refreshes: one shell')
})

test('a hung interactive shell falls through to login bash', async () => {
  const files: string[] = []
  const resolver = createLoginShellPathResolver({
    shell: () => '/bin/zsh',
    run: async (descriptor) => {
      files.push(descriptor.file)
      return descriptor.file === '/bin/zsh' ? hung : answered('/usr/local/bin:/usr/bin')
    },
  })
  assert.equal(await resolver.resolve({}), '/usr/local/bin:/usr/bin')
  assert.deepEqual(files, ['/bin/zsh', 'bash'])
})

test('a resolution no shell answered is not kept, so the next caller asks again', async () => {
  let runs = 0
  let broken = true
  const resolver = createLoginShellPathResolver({
    shell: () => undefined,
    run: async () => {
      runs += 1
      if (broken) throw new Error('spawn bash ENOENT')
      return answered('/usr/bin')
    },
  })
  assert.equal(await resolver.resolve({}), null)
  broken = false
  assert.equal(await resolver.resolve({}), '/usr/bin')
  assert.equal(runs, 2)
})

test('invalidate makes the next caller ask a shell again', async () => {
  let path = '/usr/bin'
  let runs = 0
  const resolver = createLoginShellPathResolver({
    shell: () => undefined,
    run: async () => {
      runs += 1
      return answered(path)
    },
  })
  assert.equal(await resolver.resolve({}), '/usr/bin')
  // An installer appended a directory to the shell config.
  path = '/Users/dev/.local/bin:/usr/bin'
  assert.equal(await resolver.resolve({}), '/usr/bin', 'still the session answer')
  resolver.invalidate()
  assert.equal(await resolver.resolve({}), '/Users/dev/.local/bin:/usr/bin')
  assert.equal(runs, 2)
})

test('the shell is handed the caller environment', async () => {
  const seen: NodeJS.ProcessEnv[] = []
  const resolver = createLoginShellPathResolver({
    shell: () => undefined,
    run: async (_descriptor, env) => {
      seen.push(env)
      return answered('/usr/bin')
    },
  })
  await resolver.resolve({ PATH: '/managed/shims:/usr/bin' })
  assert.equal(seen[0]?.PATH, '/managed/shims:/usr/bin', 'the managed shims reach the shell it extends')
})
