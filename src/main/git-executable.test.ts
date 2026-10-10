import assert from 'node:assert/strict'
import { beforeEach, test } from 'vitest'

import { forgetGitExecutable, resolveGitForWindows, withGitExecutable } from './git-executable'

const files =
  (...paths: string[]) =>
  async (path: string): Promise<boolean> =>
    paths.includes(path)

beforeEach(() => {
  forgetGitExecutable()
})

test("the installer's cmd launcher is swapped for the ucrt64 git it would start", async () => {
  const file = await resolveGitForWindows(
    { PATH: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd' },
    {
      isFile: files(
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\ucrt64\\bin\\git.exe',
        'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
      ),
    },
  )
  assert.equal(file, 'C:\\Program Files\\Git\\ucrt64\\bin\\git.exe')
})

test("the portable build's bin launcher is swapped for its mingw64 git", async () => {
  const file = await resolveGitForWindows(
    { PATH: 'D:\\PortableGit\\bin' },
    { isFile: files('D:\\PortableGit\\bin\\git.exe', 'D:\\PortableGit\\mingw64\\bin\\git.exe') },
  )
  assert.equal(file, 'D:\\PortableGit\\mingw64\\bin\\git.exe')
})

test('an ARM64 install runs its clangarm64 git', async () => {
  const file = await resolveGitForWindows(
    { PATH: 'C:\\Program Files\\Git\\cmd' },
    { isFile: files('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\clangarm64\\bin\\git.exe') },
  )
  assert.equal(file, 'C:\\Program Files\\Git\\clangarm64\\bin\\git.exe')
})

test('PATH spelled the way Windows spells it is read', async () => {
  const file = await resolveGitForWindows(
    { Path: 'C:\\Program Files\\Git\\cmd' },
    { isFile: files('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe') },
  )
  assert.equal(file, 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe')
})

test('the launcher stays when MSYSTEM is set, since the real git would not add its folders to PATH', async () => {
  let asked = 0
  const file = await resolveGitForWindows(
    { PATH: 'C:\\Program Files\\Git\\cmd', MSYSTEM: 'MINGW64' },
    {
      isFile: async () => {
        asked += 1
        return true
      },
    },
  )
  assert.equal(file, 'git')
  assert.equal(asked, 0)
})

test('the launcher stays when no real git sits beside it', async () => {
  const file = await resolveGitForWindows(
    { PATH: 'C:\\Program Files\\Git\\cmd' },
    { isFile: files('C:\\Program Files\\Git\\cmd\\git.exe') },
  )
  assert.equal(file, 'git')
})

test('a git that is not a Git for Windows launcher is left to the OS to find', async () => {
  const everything = async () => true
  assert.equal(await resolveGitForWindows({ PATH: 'C:\\Users\\dev\\scoop\\shims' }, { isFile: everything }), 'git')
  assert.equal(await resolveGitForWindows({ PATH: '' }, { isFile: everything }), 'git')
})

test('off Windows git is started at once, with no lookup', async () => {
  let started: string | null = null
  const run = withGitExecutable(
    { PATH: '/usr/bin' },
    async (file) => {
      started = file
      return file
    },
    {
      platform: 'darwin',
      isFile: async () => {
        throw new Error('no lookup off Windows')
      },
    },
  )
  assert.equal(started, 'git', 'started synchronously')
  assert.equal(await run, 'git')
})

test('the lookup is made once per PATH, not once per command', async () => {
  let asked = 0
  const isFile = async (path: string) => {
    asked += 1
    return path === 'C:\\Git\\cmd\\git.exe' || path === 'C:\\Git\\mingw64\\bin\\git.exe'
  }
  const env = { PATH: 'C:\\Git\\cmd' }
  const first = await withGitExecutable(env, async (file) => file, { platform: 'win32', isFile })
  const askedOnce = asked
  const second = await withGitExecutable(env, async (file) => file, { platform: 'win32', isFile })
  assert.equal(first, 'C:\\Git\\mingw64\\bin\\git.exe')
  assert.equal(second, first)
  assert.equal(asked, askedOnce)
})

test('a remembered git that has gone missing is looked up again and started once more', async () => {
  // An upgrade to 2.56 moves the real binary from mingw64 to ucrt64.
  let installed = 'C:\\Git\\mingw64\\bin\\git.exe'
  const isFile = async (path: string) => path === 'C:\\Git\\cmd\\git.exe' || path === installed
  const env = { PATH: 'C:\\Git\\cmd' }
  await withGitExecutable(env, async (file) => file, { platform: 'win32', isFile })
  installed = 'C:\\Git\\ucrt64\\bin\\git.exe'

  const started: string[] = []
  const result = await withGitExecutable(
    env,
    async (file) => {
      started.push(file)
      if (file !== installed) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
      return 'ok'
    },
    { platform: 'win32', isFile },
  )
  assert.equal(result, 'ok')
  assert.deepEqual(started, ['C:\\Git\\mingw64\\bin\\git.exe', 'C:\\Git\\ucrt64\\bin\\git.exe'])
})

test('a runner that reports a failed start instead of throwing is retried the same way', async () => {
  let installed = 'C:\\Git\\mingw64\\bin\\git.exe'
  const isFile = async (path: string) => path === 'C:\\Git\\cmd\\git.exe' || path === installed
  const env = { PATH: 'C:\\Git\\cmd' }
  await withGitExecutable(env, async (file) => file, { platform: 'win32', isFile })
  installed = 'C:\\Git\\ucrt64\\bin\\git.exe'

  const result = await withGitExecutable(env, async (file) => ({ file, spawnFailed: file !== installed }), {
    platform: 'win32',
    isFile,
    didNotStart: (outcome) => outcome.spawnFailed,
  })
  assert.deepEqual(result, { file: 'C:\\Git\\ucrt64\\bin\\git.exe', spawnFailed: false })
})

test('a git that started and failed is not run a second time', async () => {
  const isFile = files('C:\\Git\\cmd\\git.exe', 'C:\\Git\\mingw64\\bin\\git.exe')
  let starts = 0
  await assert.rejects(
    withGitExecutable(
      { PATH: 'C:\\Git\\cmd' },
      async () => {
        starts += 1
        throw Object.assign(new Error('git exited with code 128'), { code: 128 })
      },
      { platform: 'win32', isFile },
    ),
    /code 128/,
  )
  assert.equal(starts, 1)
})
