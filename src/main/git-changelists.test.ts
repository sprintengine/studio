/**
 * The changelist store against a temp user-data dir and a real repository
 * (epic `git-commit-window`, T6). The model's own rules are proved in
 * `src/shared/git/changelists.test.ts`; what is proved HERE is the half that
 * touches the world — that two lists survive a restart, that a mutation lands
 * on the file the next read opens, that a committed file leaves the list it was
 * in, and that concurrent writes do not overwrite each other.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CHANGELIST_ID, type Changelist } from '../shared/git/changelists'
import {
  changelistsStorePath,
  createGitChangelist,
  deleteGitChangelist,
  getGitChangelists,
  moveGitChangelistPaths,
  renameGitChangelist,
  setActiveGitChangelist,
} from './git-changelists'
import { createGitPatch, gitPatchArgs, gitUntrackedPatchArgs, suggestedPatchFileName } from './git-patch'

void main()

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function configureRepo(repo: string): void {
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
}

function pathsOf(lists: Changelist[], id: string): string[] {
  return lists.find((list) => list.id === id)?.paths ?? []
}

function byName(lists: Changelist[], name: string): Changelist {
  const found = lists.find((list) => list.name === name)
  assert.ok(found, `expected a changelist named ${name}`)
  return found
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-changelists-'))
  const userData = join(root, 'user-data')
  const repo = join(root, 'repo')

  try {
    git(root, ['init', '--initial-branch=main', repo])
    configureRepo(repo)
    writeFileSync(join(repo, 'a.ts'), 'base\n')
    writeFileSync(join(repo, 'b.ts'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'base'])

    // A repository nobody has touched opens on the default list alone, and the
    // first read writes the file the second one will find.
    writeFileSync(join(repo, 'a.ts'), 'changed\n')
    const first = await getGitChangelists(userData, repo)
    assert.deepEqual(first.map((list) => list.id), [DEFAULT_CHANGELIST_ID])
    assert.deepEqual(pathsOf(first, DEFAULT_CHANGELIST_ID), ['a.ts'], 'the change is adopted into the active list')
    assert.equal(
      changelistsStorePath(userData, repo).startsWith(join(userData, 'git-changelists')),
      true,
      'the store lives under the user-data dir, keyed by repository',
    )

    // Two repositories do not share a file.
    assert.notEqual(changelistsStorePath(userData, repo), changelistsStorePath(userData, join(root, 'other')))

    // A second list, made active. The file already in Changes stays there.
    const withFeature = await createGitChangelist(userData, repo, {
      name: 'Modal header group',
      comment: 'Modal header group: leading mark before the title',
      activate: true,
    })
    const feature = byName(withFeature, 'Modal header group')
    assert.equal(feature.active, true)
    assert.equal(withFeature.filter((list) => list.active).length, 1)
    assert.deepEqual(pathsOf(withFeature, DEFAULT_CHANGELIST_ID), ['a.ts'])
    assert.deepEqual(feature.paths, [])

    // The next file to change lands in the ACTIVE list — the whole point of the
    // flag, and the case that would otherwise sweep every existing change in.
    writeFileSync(join(repo, 'b.ts'), 'changed\n')
    const afterEdit = await getGitChangelists(userData, repo)
    assert.deepEqual(pathsOf(afterEdit, DEFAULT_CHANGELIST_ID), ['a.ts'])
    assert.deepEqual(pathsOf(afterEdit, feature.id), ['b.ts'])

    // Everything round-trips through the file: a fresh read (this is what a
    // restart is, the process holding no state between them) sees both lists.
    const reopened = await getGitChangelists(userData, repo)
    assert.deepEqual(reopened.map((list) => list.name).sort(), ['Changes', 'Modal header group'])
    assert.equal(byName(reopened, 'Modal header group').comment, 'Modal header group: leading mark before the title')

    // Moving takes the path out of the list it was in, and accepts the absolute
    // path the panel's rows carry.
    const moved = await moveGitChangelistPaths(userData, repo, feature.id, [join(repo, 'a.ts')])
    assert.deepEqual(pathsOf(moved, DEFAULT_CHANGELIST_ID), [])
    assert.deepEqual(pathsOf(moved, feature.id), ['a.ts', 'b.ts'])

    // Rename round-trips, and the default is renameable without losing its id.
    const renamed = await renameGitChangelist(userData, repo, feature.id, { name: 'Modal header', comment: 'chip on the band' })
    assert.equal(byName(renamed, 'Modal header').id, feature.id)
    assert.deepEqual(pathsOf(renamed, feature.id), ['a.ts', 'b.ts'], 'a rename does not disturb the paths')

    // Set-active round-trips and stays exclusive.
    const activeDefault = await setActiveGitChangelist(userData, repo, DEFAULT_CHANGELIST_ID)
    assert.deepEqual(activeDefault.filter((list) => list.active).map((list) => list.id), [DEFAULT_CHANGELIST_ID])

    // A file that leaves git's status leaves the list, so a collapsed group can
    // never show a count of files that are no longer changed.
    git(repo, ['add', 'b.ts'])
    git(repo, ['commit', '-m', 'b'])
    const afterCommit = await getGitChangelists(userData, repo)
    assert.deepEqual(pathsOf(afterCommit, feature.id), ['a.ts'])

    // The default refuses its own delete; a real delete returns the paths.
    assert.deepEqual(
      (await deleteGitChangelist(userData, repo, DEFAULT_CHANGELIST_ID)).map((list) => list.id).sort(),
      [DEFAULT_CHANGELIST_ID, feature.id].sort(),
    )
    const afterDelete = await deleteGitChangelist(userData, repo, feature.id)
    assert.deepEqual(afterDelete.map((list) => list.id), [DEFAULT_CHANGELIST_ID])
    assert.deepEqual(pathsOf(afterDelete, DEFAULT_CHANGELIST_ID), ['a.ts'])

    // Concurrency: two creates fired without awaiting the first must both land.
    // Without the per-repository write queue the second read-modify-write would
    // be built on the state the first one replaced, and one list would vanish.
    const [, second] = await Promise.all([
      createGitChangelist(userData, repo, { name: 'Race one' }),
      createGitChangelist(userData, repo, { name: 'Race two' }),
    ])
    assert.equal(second.length, 3, 'both concurrent creates survive')
    assert.deepEqual(
      (await getGitChangelists(userData, repo)).map((list) => list.name).sort(),
      ['Changes', 'Race one', 'Race two'],
    )
    assert.equal(
      (await getGitChangelists(userData, repo)).filter((list) => list.active).length,
      1,
      'and the race cannot leave two lists active',
    )

    await assertPatches(repo)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  console.log('git changelists store ok')
}

async function assertPatches(repo: string): Promise<void> {
  // The argv is the contract: `--` guards a path that looks like a flag,
  // `:(literal)` guards a path that looks like a glob, and `--cached` is the
  // only difference between the two sides of the index.
  assert.deepEqual(gitPatchArgs(['a.ts'], false), ['diff', '--no-color', '--binary', '--', ':(literal)a.ts'])
  assert.deepEqual(gitPatchArgs(['a.ts'], true), ['diff', '--cached', '--no-color', '--binary', '--', ':(literal)a.ts'])
  assert.deepEqual(gitUntrackedPatchArgs('new.ts'), [
    'diff',
    '--no-index',
    '--no-color',
    '--binary',
    '--',
    '/dev/null',
    'new.ts',
  ])
  assert.match(suggestedPatchFileName('/tmp/My Repo', new Date(2026, 8, 9)), /^my-repo-2026-09-09\.patch$/)

  const unstaged = await createGitPatch(repo, [join(repo, 'a.ts')])
  assert.equal(unstaged.ok, true, unstaged.message ?? '')
  assert.match(unstaged.patch, /^diff --git a\/a\.ts b\/a\.ts/m)
  assert.match(unstaged.patch, /\+changed/)

  // Nothing is staged, so the cached side says so rather than handing back an
  // empty file that looks like a successful patch.
  const cached = await createGitPatch(repo, [join(repo, 'a.ts')], { cached: true })
  assert.equal(cached.ok, true)
  assert.equal(cached.patch, '')
  assert.equal(cached.message, 'Nothing staged in the selected files.')

  // An untracked file has no diff for git to show, and must still patch — via
  // `--no-index`, which never touches the index.
  writeFileSync(join(repo, 'fresh.ts'), 'brand new\n')
  const untracked = await createGitPatch(repo, [join(repo, 'fresh.ts')])
  assert.equal(untracked.ok, true, untracked.message ?? '')
  assert.match(untracked.patch, /\+brand new/)
  assert.equal(
    execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim(),
    '',
    'and building it staged nothing',
  )
}
