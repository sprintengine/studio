import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkoutsFromIndex, sweepCheckpointRefs, sweepRetiredCheckpoints } from './checkpoint-sweep'

// The one-shot cleanup of the retired checkpoint machinery
// (the-diff-an-agent-made / remove-checkpoint-machinery). What it must never do
// matters more than what it does: nothing under refs/heads or refs/remotes may
// move, and a launch must not be able to fail because of it.

let failures = 0
async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })
}

const created: string[] = []

/** A repo carrying checkpoint refs exactly as the retired capture wrote them. */
function repoWithCheckpoints(turns = 3): string {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-sweep-'))
  created.push(dir)
  git(dir, 'init', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'seed')
  const head = git(dir, 'rev-parse', 'HEAD').trim()
  // Parentless snapshot commits under the hidden prefix, base64url workspace id.
  const encoded = Buffer.from('workspace-1', 'utf8').toString('base64url')
  for (let turn = 0; turn < turns; turn += 1) {
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}').trim()
    const commit = execFileSync('git', ['-C', dir, 'commit-tree', tree, '-m', `checkpoint ${turn}`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Multicode',
        GIT_AUTHOR_EMAIL: 'checkpoints@multicode.local',
        GIT_COMMITTER_NAME: 'Multicode',
        GIT_COMMITTER_EMAIL: 'checkpoints@multicode.local',
      },
    }).trim()
    git(dir, 'update-ref', `refs/multicode/checkpoints/${encoded}/turn/${turn}`, commit)
  }
  // Refs of other people's that must survive untouched — including two NEAR
  // MISSES under our own namespace, which are what a prefix guard gets wrong.
  git(dir, 'update-ref', 'refs/notes/someone-elses', head)
  git(dir, 'update-ref', 'refs/remotes/origin/main', head)
  git(dir, 'update-ref', 'refs/multicode/mybackup', head)
  git(dir, 'update-ref', 'refs/multicode/checkpointsOTHER/x', head)
  return dir
}

function userData(indexJson: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-sweep-userdata-'))
  created.push(dir)
  if (indexJson !== null) writeFileSync(join(dir, 'checkpoint-index.json'), indexJson)
  return dir
}

// Name AND object: comparing names alone would pass a sweep that reset a branch
// to a different commit, which is precisely the harm the invariant forbids.
function refsIn(dir: string, prefix: string): string[] {
  return git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', `${prefix}**`).split('\n').filter(Boolean)
}

void (async () => {
  // ---- reading the retired index -----------------------------------------

  await run('checkoutsFromIndex collects distinct cwds', () => {
    const raw = JSON.stringify({
      workspaces: {
        a: {
          turns: [
            { cwd: '/repo/one', ref: 'r1' },
            { cwd: '/repo/one', ref: 'r2' },
          ],
        },
        b: { turns: [{ cwd: '/repo/two', ref: 'r3' }] },
      },
    })
    assert.deepEqual(checkoutsFromIndex(raw).sort(), ['/repo/one', '/repo/two'])
  })

  await run('a torn, empty or foreign index yields nothing rather than throwing', () => {
    assert.deepEqual(checkoutsFromIndex(''), [])
    assert.deepEqual(checkoutsFromIndex('{"workspaces":'), [])
    assert.deepEqual(checkoutsFromIndex('null'), [])
    assert.deepEqual(checkoutsFromIndex('[]'), [])
    assert.deepEqual(checkoutsFromIndex('{"workspaces":{"a":{"turns":"nope"}}}'), [])
    assert.deepEqual(checkoutsFromIndex('{"workspaces":{"a":{"turns":[{"cwd":7},null,{}]}}}'), [])
  })

  // ---- the invariant ------------------------------------------------------

  await run('the sweep takes our refs and NOTHING else', async () => {
    const dir = repoWithCheckpoints(4)
    const headsBefore = refsIn(dir, 'refs/heads/')
    const notesBefore = refsIn(dir, 'refs/notes/')
    assert.equal(refsIn(dir, 'refs/multicode/checkpoints/').length, 4, 'four of ours, plus two near misses beside them')

    const remotesBefore = refsIn(dir, 'refs/remotes/')
    const swept = await sweepCheckpointRefs(dir)

    assert.equal(swept.deleted, 4)
    assert.equal(swept.ok, true)
    assert.deepEqual(
      refsIn(dir, 'refs/multicode/')
        .map((line) => line.split(' ')[0])
        .sort(),
      ['refs/multicode/checkpointsOTHER/x', 'refs/multicode/mybackup'],
      'the near misses under our own namespace survive',
    )
    assert.deepEqual(refsIn(dir, 'refs/heads/'), headsBefore, 'branches byte-identical')
    assert.deepEqual(refsIn(dir, 'refs/notes/'), notesBefore, 'other refs byte-identical')
    assert.deepEqual(refsIn(dir, 'refs/remotes/'), remotesBefore, 'remotes byte-identical')
    // The working tree and index are not something this can reach, but assert it
    // anyway: it is the promise the retired machinery made and this inherits.
    assert.equal(git(dir, 'status', '--porcelain').trim(), '')
    // fsck must still pass. Dangling objects ARE expected — the snapshot commits
    // are parentless and now unreachable, which is exactly what gc collects —
    // so the assertion is that fsck EXITS CLEAN, not that it prints nothing.
    execFileSync('git', ['-C', dir, 'fsck', '--no-progress'], { encoding: 'utf8', stdio: 'pipe' })
  })

  await run('a repo with no checkpoint refs is a clean no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-sweep-clean-'))
    created.push(dir)
    git(dir, 'init', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'seed')
    const swept = await sweepCheckpointRefs(dir)
    assert.equal(swept.deleted, 0)
    assert.equal(swept.ok, true, 'nothing to do IS finished')
  })

  await run('a non-repo and a missing folder report zero, and NOT finished', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'multicode-sweep-plain-'))
    created.push(plain)
    // Not a repo we could read, so not a repo we may forget: ok:false keeps the
    // index and the next launch's attempt alive.
    assert.deepEqual(await sweepCheckpointRefs(plain), { deleted: 0, ok: false })
    assert.deepEqual(await sweepCheckpointRefs(join(plain, 'gone')), { deleted: 0, ok: false })
  })

  await run('a repo that cannot be swept KEEPS the index for the next launch', async () => {
    const alive = repoWithCheckpoints(2)
    const unreachable = join(tmpdir(), 'multicode-sweep-unmounted-volume')
    const data = userData(
      JSON.stringify({
        workspaces: {
          alive: { turns: [{ cwd: alive, ref: 'x' }] },
          gone: { turns: [{ cwd: unreachable, ref: 'y' }] },
        },
      }),
    )
    const result = await sweepRetiredCheckpoints(data)
    assert.equal(result.refsDeleted, 2, 'the reachable repo is still swept')
    assert.equal(result.indexRemoved, false, 'the marker survives so the other repo is retried')
    assert.equal(existsSync(join(data, 'checkpoint-index.json')), true)
  })

  await run('stale temp index files go with the refs', async () => {
    const dir = repoWithCheckpoints(1)
    const gitDir = join(dir, '.git')
    writeFileSync(join(gitDir, 'multicode-checkpoint-index-abc'), 'stale')
    writeFileSync(join(gitDir, 'index'), readFileSync(join(gitDir, 'index')))
    await sweepCheckpointRefs(dir)
    assert.equal(existsSync(join(gitDir, 'multicode-checkpoint-index-abc')), false)
    assert.equal(existsSync(join(gitDir, 'index')), true, 'the real index is not ours to delete')
  })

  // ---- the whole run ------------------------------------------------------

  await run('a full sweep visits the index’s repos, then removes the index', async () => {
    const repoA = repoWithCheckpoints(2)
    const repoB = repoWithCheckpoints(3)
    const data = userData(
      JSON.stringify({
        workspaces: {
          a: { turns: [{ cwd: repoA, ref: 'x' }] },
          b: { turns: [{ cwd: repoB, ref: 'y' }] },
        },
      }),
    )
    const result = await sweepRetiredCheckpoints(data)
    assert.equal(result.reposVisited, 2)
    assert.equal(result.refsDeleted, 5)
    assert.equal(result.indexRemoved, true)
    assert.deepEqual(refsIn(repoA, 'refs/multicode/checkpoints/'), [])
    assert.deepEqual(refsIn(repoB, 'refs/multicode/checkpoints/'), [])
    // And the near misses beside them are still there in both.
    assert.equal(refsIn(repoA, 'refs/multicode/').length, 2)
    assert.equal(existsSync(join(data, 'checkpoint-index.json')), false)
  })

  await run('the second launch does no work at all', async () => {
    const repo = repoWithCheckpoints(2)
    const data = userData(JSON.stringify({ workspaces: { a: { turns: [{ cwd: repo, ref: 'x' }] } } }))
    await sweepRetiredCheckpoints(data)
    const second = await sweepRetiredCheckpoints(data)
    assert.deepEqual(second, { reposVisited: 0, refsDeleted: 0, indexRemoved: false })
  })

  await run('a machine that never ran the checkpoint builds does nothing', async () => {
    const data = userData(null)
    assert.deepEqual(await sweepRetiredCheckpoints(data), {
      reposVisited: 0,
      refsDeleted: 0,
      indexRemoved: false,
    })
  })

  await run('a corrupt-only leftover is still collected', async () => {
    const data = userData(null)
    writeFileSync(join(data, 'checkpoint-index.json.corrupt'), '{torn')
    const result = await sweepRetiredCheckpoints(data)
    assert.equal(result.indexRemoved, true)
    assert.equal(existsSync(join(data, 'checkpoint-index.json.corrupt')), false)
  })

  await run('a linked worktree in the index sweeps the shared ref store once', async () => {
    const dir = repoWithCheckpoints(2)
    const tree = join(dir, '..', `multicode-sweep-wt-${process.pid}`)
    created.push(tree)
    git(dir, 'worktree', 'add', '-b', 'wt', tree)
    // Refs live in the COMMON dir, so sweeping from the worktree clears them.
    const swept = await sweepCheckpointRefs(tree)
    assert.equal(swept.deleted, 2)
    assert.deepEqual(refsIn(dir, 'refs/multicode/checkpoints/'), [])
  })

  for (const dir of created) rmSync(dir, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`checkpoint-sweep.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('checkpoint-sweep.test.ts: ok')
})()
