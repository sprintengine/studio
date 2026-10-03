import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { browseFolders } from './folder-browser'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'folder-browser-')))
  mkdirSync(join(home, 'app', '.git'), { recursive: true })
  mkdirSync(join(home, 'node_modules'))
  mkdirSync(join(home, '.config'))
  writeFileSync(join(home, 'notes.txt'), 'a file is never listed')
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

test('lists folders only, hides dot-folders, and marks projects and non-projects', async () => {
  const listing = await browseFolders({}, home)
  expect(listing.ok).toBe(true)
  if (!listing.ok) return
  expect(listing.path).toBe(home)
  expect(listing.entries.map((entry) => entry.name)).toEqual(['app', 'node_modules'])
  expect(listing.entries.find((entry) => entry.name === 'app')?.project).toBe(true)
  expect(listing.entries.find((entry) => entry.name === 'node_modules')?.hint).toBe('not-a-project')
})

test('shows dot-folders when asked, and expands ~', async () => {
  const listing = await browseFolders({ path: '~', showHidden: true }, home)
  expect(listing.ok && listing.entries.map((entry) => entry.name)).toEqual(['.config', 'app', 'node_modules'])
})

test('a link loop is one folder by its real name', async () => {
  symlinkSync(home, join(home, 'app', 'loop'))
  const listing = await browseFolders({ path: join(home, 'app', 'loop', 'app', 'loop') }, home)
  expect(listing.ok && listing.path).toBe(home)
})

test('refuses a relative path, a file, and a path that is not there', async () => {
  expect((await browseFolders({ path: 'relative/path' }, home)).ok).toBe(false)
  expect((await browseFolders({ path: join(home, 'notes.txt') }, home)).ok).toBe(false)
  expect((await browseFolders({ path: join(home, 'missing') }, home)).ok).toBe(false)
})

test('refuses a folder on an SSH machine in words, never reading this disk for it', async () => {
  const listing = await browseFolders({ path: 'ssh://m1/home/dev/repo' }, home)
  expect(listing.ok).toBe(false)
  expect(listing.ok ? '' : listing.message).toMatch(/SSH machine/)
})
