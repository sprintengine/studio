import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { compileCacheBuildKey, enableMainCompileCache } from './compile-cache'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function userData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'compile-cache-test-'))
  created.push(dir)
  return dir
}

function fakeApi(status: number, calls: { enabled: string[]; flushed: number }) {
  return {
    enable: (directory: string) => {
      calls.enabled.push(directory)
      return { status }
    },
    flush: () => {
      calls.flushed += 1
    },
  }
}

test('the build key is a plain directory name taken from the build stamp', () => {
  assert.equal(compileCacheBuildKey('2026-10-06T18:13:05.284Z'), '20261006T181305284Z')
  assert.equal(compileCacheBuildKey(''), 'unstamped')
})

test('each build caches into a directory of its own under userData', async () => {
  const dir = await userData()
  const calls = { enabled: [] as string[], flushed: 0 }
  const cache = enableMainCompileCache(dir, 'build-b', fakeApi(constants.compileCacheStatus.ENABLED, calls))
  assert.ok(cache)
  assert.deepEqual(calls.enabled, [join(dir, 'main-compile-cache', 'build-b')])
  cache.flush()
  assert.equal(calls.flushed, 1)
})

test('pruning removes the previous builds and keeps this one', async () => {
  const dir = await userData()
  const root = join(dir, 'main-compile-cache')
  for (const build of ['build-a', 'build-b', 'build-c']) {
    await mkdir(join(root, build), { recursive: true })
    await writeFile(join(root, build, 'entry'), 'cached')
  }
  const calls = { enabled: [] as string[], flushed: 0 }
  const cache = enableMainCompileCache(dir, 'build-b', fakeApi(constants.compileCacheStatus.ENABLED, calls))
  await cache?.prunePreviousBuilds()
  assert.deepEqual(await readdir(root), ['build-b'])
  assert.deepEqual(await readdir(join(root, 'build-b')), ['entry'])
})

test('a cache Node cannot use leaves the app compiling from source', async () => {
  const dir = await userData()
  const calls = { enabled: [] as string[], flushed: 0 }
  assert.equal(enableMainCompileCache(dir, 'build-b', fakeApi(constants.compileCacheStatus.FAILED, calls)), null)
  assert.equal(
    enableMainCompileCache(dir, 'build-b', {
      enable: () => {
        throw new Error('no such directory')
      },
      flush: () => {},
    }),
    null,
  )
})
