import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { RipgrepBinary } from './ripgrep-binary'

const binary = vi.hoisted(() => ({ current: null as RipgrepBinary | null }))

vi.mock('./ripgrep-binary', async (importActual) => {
  const actual = await importActual<typeof import('./ripgrep-binary')>()
  return {
    ...actual,
    ripgrepBinary: async () => binary.current ?? actual.ripgrepBinary(),
    markRipgrepUnusable: (message: string) => {
      binary.current = { ok: false, message }
    },
  }
})

const { searchContent, searchFiles } = await import('./filesystem-search')

let scratch = ''
let sender = 1000

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'sprintengine-search-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** A fresh root per case: the quick-open list is held per root, and each case wants its own engine's. */
async function project(name: string): Promise<string> {
  const root = join(scratch, name)
  await mkdir(join(root, 'src', 'deep'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(root, '.cache'), { recursive: true })
  await writeFile(join(root, 'src', 'app.ts'), 'export const needle = 1\n')
  await writeFile(join(root, 'src', 'deep', 'app.test.ts'), 'needle\n')
  await writeFile(join(root, 'README.md'), 'no match here\n')
  await writeFile(join(root, 'node_modules', 'dep', 'app.js'), 'needle\n')
  await writeFile(join(root, '.cache', 'app.json'), 'needle\n')
  // Excluded as a directory, listed as a file.
  await mkdir(join(root, 'build'), { recursive: true })
  await writeFile(join(root, 'build', 'app.o'), '')
  await writeFile(join(root, 'src', 'build'), '#!/bin/sh\n')
  return root
}

function relativeNames(root: string, paths: string[]): string[] {
  return paths.map((path) => path.slice(root.length + 1).replace(/\\/g, '/')).sort()
}

test('the bundled ripgrep lists and greps a folder', async () => {
  binary.current = null
  const root = await project('ripgrep')

  const files = await searchFiles(++sender, { rootPath: root, query: 'app' })
  assert.equal(files.ok, true, files.ok ? '' : files.message)
  assert.equal(files.ok && files.engine, 'ripgrep')
  assert.deepEqual(relativeNames(root, files.ok ? files.results.map((entry) => entry.path) : []), [
    'src/app.ts',
    'src/deep/app.test.ts',
  ])
  const built = await searchFiles(++sender, { rootPath: root, query: 'build' })
  assert.deepEqual(relativeNames(root, built.ok ? built.results.map((entry) => entry.path) : []), ['src/build'])

  const content = await searchContent(++sender, { rootPath: root, query: 'needle' })
  assert.equal(content.ok, true, content.ok ? '' : content.message)
  assert.deepEqual(relativeNames(root, content.ok ? content.results.map((entry) => entry.path) : []), [
    'src/app.ts',
    'src/deep/app.test.ts',
  ])
})

test('without a ripgrep, file-name search walks the folder and text search says why it cannot run', async () => {
  binary.current = { ok: false, message: "Search can't run: ripgrep is missing from this install (/x/rg)." }
  const root = await project('walker')

  const files = await searchFiles(++sender, { rootPath: root, query: 'APP' })
  assert.equal(files.ok, true, files.ok ? '' : files.message)
  assert.equal(files.ok && files.engine, 'walker')
  assert.deepEqual(
    relativeNames(root, files.ok ? files.results.map((entry) => entry.path) : []),
    ['src/app.ts', 'src/deep/app.test.ts'],
    'hidden entries and the built-in excludes are skipped, as ripgrep skips them',
  )
  assert.equal(files.ok && files.results[0]?.name, 'app.ts', 'ranked the same way as a ripgrep listing')
  const built = await searchFiles(++sender, { rootPath: root, query: 'build' })
  assert.deepEqual(
    relativeNames(root, built.ok ? built.results.map((entry) => entry.path) : []),
    ['src/build'],
    'an excluded name skips a directory, not a file, exactly as the ripgrep test above lists it',
  )

  const content = await searchContent(++sender, { rootPath: root, query: 'needle' })
  assert.deepEqual(content, {
    ok: false,
    message: "Search can't run: ripgrep is missing from this install (/x/rg).",
    engine: 'ripgrep',
  })
})

test('a ripgrep that cannot be started is given up on: file names are walked, text search says why', async () => {
  const root = await project('unspawnable')
  // A path through a regular file, as a binary inside app.asar is to the OS.
  const archive = join(scratch, 'app.asar')
  await writeFile(archive, 'not a directory')
  binary.current = { ok: true, path: join(archive, 'rg') }

  const files = await searchFiles(++sender, { rootPath: root, query: 'app' })
  assert.equal(files.ok, true, files.ok ? '' : files.message)
  assert.equal(files.ok && files.engine, 'walker')
  assert.deepEqual(relativeNames(root, files.ok ? files.results.map((entry) => entry.path) : []), [
    'src/app.ts',
    'src/deep/app.test.ts',
  ])

  const content = await searchContent(++sender, { rootPath: root, query: 'needle' })
  assert.equal(content.ok, false)
  assert.match(
    !content.ok ? content.message : '',
    /^Search can't run: ripgrep at .*app\.asar.rg could not be started \(E\w+\)\.$/,
  )
})
