import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import {
  clearProjectRepositoriesCache,
  discoverProjectRepositories,
  parseJsonWithComments,
} from './project-repositories'
import { PROJECT_REPOSITORY_LIMIT } from '../shared/project-repositories'

let base: string
let acme: string

beforeEach(() => {
  clearProjectRepositoriesCache()
  base = mkdtempSync(join(tmpdir(), 'project-repositories-'))
  acme = join(base, 'acme')
  mkdirSync(acme)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A folder with a `.git` directory: all discovery looks for. */
function repo(path: string): string {
  mkdirSync(join(path, '.git'), { recursive: true })
  return path
}

function relativePaths(folder: string): string[] | null {
  return discoverProjectRepositories(folder)?.repositories.map((repository) => repository.relativePath) ?? null
}

test('immediate child repositories are the members, sorted by name', () => {
  repo(join(acme, 'web'))
  repo(join(acme, 'api'))
  mkdirSync(join(acme, 'notes'))
  const found = discoverProjectRepositories(acme)
  assert.ok(found)
  assert.deepEqual(found.source, { kind: 'children' })
  assert.deepEqual(
    found.repositories.map((repository) => [repository.relativePath, repository.name, repository.path]),
    [
      ['api', 'api', join(acme, 'api')],
      ['web', 'web', join(acme, 'web')],
    ],
  )
  assert.equal(found.truncated, false)
})

test('a linked worktree or submodule, whose .git is a file, counts as a repository', () => {
  mkdirSync(join(acme, 'api'))
  writeFileSync(join(acme, 'api', '.git'), 'gitdir: /Users/dev/elsewhere/.git/worktrees/api\n')
  assert.deepEqual(relativePaths(acme), ['api'])
})

test('a folder holding no repository is not a project of several', () => {
  mkdirSync(join(acme, 'notes'))
  assert.equal(discoverProjectRepositories(acme), null)
})

test('a folder that is a repository, or inside one, is never a project of several', () => {
  repo(join(acme, 'api'))
  repo(acme)
  assert.equal(discoverProjectRepositories(acme), null)
  clearProjectRepositoriesCache()
  // Inside: the outer repository is the project, whatever is below.
  const inner = join(acme, 'packages')
  repo(join(inner, 'vendored'))
  assert.equal(discoverProjectRepositories(inner), null)
})

test('hidden folders, node_modules and grandchildren are never members', () => {
  repo(join(acme, '.sprintengine-worktrees', 'api', 'pool-01'))
  repo(join(acme, '.hidden'))
  repo(join(acme, 'node_modules'))
  repo(join(acme, 'group', 'deep'))
  repo(join(acme, 'api'))
  assert.deepEqual(relativePaths(acme), ['api'])
})

test('a child that is a symlink is not followed', () => {
  const outside = repo(join(base, 'outside'))
  symlinkSync(outside, join(acme, 'linked'), 'dir')
  repo(join(acme, 'api'))
  assert.deepEqual(relativePaths(acme), ['api'])
})

test('a single .code-workspace file lists the members, in its order, comments and trailing commas allowed', () => {
  repo(join(acme, 'web'))
  repo(join(acme, 'services', 'billing'))
  repo(join(acme, 'unlisted'))
  writeFileSync(
    join(acme, 'acme.code-workspace'),
    `{
      // The front end first.
      "folders": [
        { "path": "web" },
        /* a service, two down */
        { "path": "./services/billing", },
        { "path": "." },
      ],
      "settings": { "url": "https://example.com//not-a-comment" },
    }`,
  )
  const found = discoverProjectRepositories(acme)
  assert.ok(found)
  assert.deepEqual(found.source, { kind: 'code-workspace', file: 'acme.code-workspace' })
  assert.deepEqual(
    found.repositories.map((repository) => [repository.relativePath, repository.name]),
    [
      ['web', 'web'],
      ['services/billing', 'billing'],
    ],
  )
})

test('workspace entries outside the project folder are rejected, by path or by symlink', () => {
  const outside = repo(join(base, 'outside'))
  repo(join(acme, 'api'))
  symlinkSync(outside, join(acme, 'escape'), 'dir')
  writeFileSync(
    join(acme, 'acme.code-workspace'),
    JSON.stringify({
      folders: [{ path: '../outside' }, { path: outside }, { path: 'escape' }, { path: 'api' }],
    }),
  )
  assert.deepEqual(relativePaths(acme), ['api'])
})

test('workspace entries deeper than three folders, or not repository roots, are skipped', () => {
  repo(join(acme, 'a', 'b', 'c', 'd'))
  repo(join(acme, 'api'))
  mkdirSync(join(acme, 'api', 'src'))
  writeFileSync(
    join(acme, 'acme.code-workspace'),
    JSON.stringify({ folders: [{ path: 'a/b/c/d' }, { path: 'api/src' }, { path: 'api' }] }),
  )
  assert.deepEqual(relativePaths(acme), ['api'])
})

test('a repository nested inside another member is ignored', () => {
  repo(join(acme, 'api'))
  repo(join(acme, 'api', 'vendor', 'lib'))
  repo(join(acme, 'web'))
  writeFileSync(
    join(acme, 'acme.code-workspace'),
    JSON.stringify({ folders: [{ path: 'api/vendor/lib' }, { path: 'api' }, { path: 'web' }] }),
  )
  assert.deepEqual(relativePaths(acme), ['api', 'web'])
})

test('two workspace files, an unreadable one, or one listing no repository fall back to the children', () => {
  repo(join(acme, 'api'))
  repo(join(acme, 'web'))
  writeFileSync(join(acme, 'one.code-workspace'), JSON.stringify({ folders: [{ path: 'api' }] }))
  writeFileSync(join(acme, 'two.code-workspace'), JSON.stringify({ folders: [{ path: 'web' }] }))
  assert.deepEqual(discoverProjectRepositories(acme)?.source, { kind: 'children' })
  assert.deepEqual(relativePaths(acme), ['api', 'web'])

  rmSync(join(acme, 'two.code-workspace'))
  writeFileSync(join(acme, 'one.code-workspace'), '{ "folders": [ ')
  clearProjectRepositoriesCache()
  assert.deepEqual(discoverProjectRepositories(acme)?.source, { kind: 'children' })

  writeFileSync(join(acme, 'one.code-workspace'), JSON.stringify({ folders: [{ path: '.' }] }))
  clearProjectRepositoriesCache()
  assert.deepEqual(discoverProjectRepositories(acme)?.source, { kind: 'children' })
  assert.deepEqual(relativePaths(acme), ['api', 'web'])
})

test('past the cap, the first ones are listed and the answer says there are more', () => {
  for (let index = 0; index < PROJECT_REPOSITORY_LIMIT + 3; index++)
    repo(join(acme, `repo-${String(index).padStart(2, '0')}`))
  const found = discoverProjectRepositories(acme)
  assert.ok(found)
  assert.equal(found.repositories.length, PROJECT_REPOSITORY_LIMIT)
  assert.equal(found.repositories[0].relativePath, 'repo-00')
  assert.equal(found.truncated, true)
})

test('the answer is cached until the folder changes, the hold lapses, or a refresh asks', () => {
  repo(join(acme, 'api'))
  const stamp = new Date(Date.now() - 60_000)
  utimesSync(acme, stamp, stamp)
  const now = Date.now()
  assert.equal(discoverProjectRepositories(acme, { now })?.repositories.length, 1)
  // `git init` in an existing child does not touch the parent's time.
  repo(join(acme, 'web'))
  utimesSync(acme, stamp, stamp)
  assert.equal(discoverProjectRepositories(acme, { now: now + 1_000 })?.repositories.length, 1, 'held')
  assert.equal(discoverProjectRepositories(acme, { now: now + 1_000, refresh: true })?.repositories.length, 2)
  repo(join(acme, 'infra'))
  utimesSync(acme, stamp, stamp)
  assert.equal(discoverProjectRepositories(acme, { now: now + 20_000 })?.repositories.length, 2, 'held')
  assert.equal(discoverProjectRepositories(acme, { now: now + 62_000 })?.repositories.length, 3, 'the hold lapsed')
  // A clone added beside the others moves the folder's own time.
  repo(join(acme, 'tools'))
  assert.equal(discoverProjectRepositories(acme, { now: now + 63_000 })?.repositories.length, 4)
})

test('a missing folder, a file or a relative path is answered with null, never a throw', () => {
  assert.equal(discoverProjectRepositories(join(base, 'missing')), null)
  writeFileSync(join(base, 'file'), '')
  assert.equal(discoverProjectRepositories(join(base, 'file')), null)
  assert.equal(discoverProjectRepositories('acme'), null)
  assert.equal(discoverProjectRepositories(''), null)
  assert.equal(discoverProjectRepositories(null), null)
})

test('the workspace-file reader keeps strings intact and drops only real comments and trailing commas', () => {
  assert.deepEqual(parseJsonWithComments('﻿{ "a": "x // y", /* c */ "b": [1, 2,], }'), { a: 'x // y', b: [1, 2] })
  assert.deepEqual(parseJsonWithComments('{ "a": "q\\" ,]" }'), { a: 'q" ,]' })
  assert.throws(() => parseJsonWithComments('{ "a": }'))
})

test('the home folder and a filesystem root are never a project of several repositories', () => {
  repo(join(acme, 'api'))
  assert.equal(discoverProjectRepositories(acme, { home: acme }), null)
  assert.ok(discoverProjectRepositories(acme, { home: base, refresh: true }), 'any other folder is')
  assert.equal(discoverProjectRepositories(parse(acme).root), null)
})
