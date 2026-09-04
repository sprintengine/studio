import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCheckpointIndex, MAX_TURNS_PER_WORKSPACE } from './checkpoint-index'
import { CHECKPOINT_REFS_PREFIX } from './checkpoint-store'

// Refs must live in our namespace to survive parsing — the index hands them to
// `git update-ref -d`, so anything else is rejected on read.
function refFor(name: string): string {
  return `${CHECKPOINT_REFS_PREFIX}/${name}`
}

// The per-workspace checkpoint timeline (the-diff-an-agent-made /
// checkpoint-turn-reactor): turn accounting, the baseline-preserving cap, and
// the quiet shape for anything unreadable.

let failures = 0
function run(name: string, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-checkpoint-index-'))
  try {
    currentDir = dir
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let currentDir = ''
function index() {
  return createCheckpointIndex({ resolveUserDataDir: () => currentDir })
}

run('a fresh workspace starts at turn 0 with no baseline', () => {
  const store = index()
  assert.equal(store.timelineFor('w1'), null)
  assert.equal(store.nextTurn('w1'), 0)
  assert.equal(store.hasBaseline('w1'), false)
})

run('turns accumulate in order and the next turn follows the highest', () => {
  const store = index()
  store.recordTurn({ workspaceId: 'w1', cwd: '/repo', turn: 0, ref: refFor('r0'), at: 1 })
  assert.equal(store.hasBaseline('w1'), true)
  assert.equal(store.nextTurn('w1'), 1)
  store.recordTurn({ workspaceId: 'w1', cwd: '/repo', turn: 1, ref: refFor('r1'), at: 2 })
  assert.equal(store.nextTurn('w1'), 2)
  assert.deepEqual(
    store.timelineFor('w1')?.turns.map((turn) => turn.turn),
    [0, 1]
  )
})

run('recording a turn twice corrects it rather than duplicating it', () => {
  const store = index()
  store.recordTurn({ workspaceId: 'w1', cwd: '/repo', turn: 0, ref: refFor('old'), at: 1 })
  store.recordTurn({ workspaceId: 'w1', cwd: '/repo', turn: 0, ref: refFor('new'), at: 5 })
  const turns = store.timelineFor('w1')?.turns ?? []
  assert.equal(turns.length, 1, 'one entry per turn, always')
  assert.equal(turns[0].ref, refFor('new'))
  assert.equal(store.nextTurn('w1'), 1)
})

run('the cap evicts the oldest turns but NEVER the baseline', () => {
  const store = index()
  // One over the cap, so exactly one turn must be evicted.
  for (let turn = 0; turn <= MAX_TURNS_PER_WORKSPACE; turn += 1) {
    const result = store.recordTurn({
      workspaceId: 'w1',
      cwd: '/repo',
      turn,
      ref: refFor(`r${turn}`),
      at: turn,
    })
    if (turn < MAX_TURNS_PER_WORKSPACE) {
      assert.deepEqual(result.evicted, [], `nothing evicted at turn ${turn}`)
    } else {
      // The oldest NON-baseline turn goes; turn 0 is what every span diff
      // measures from, so losing it would silently rescope the workspace.
      assert.deepEqual(result.evicted, [refFor('r1')], 'the oldest non-baseline turn is evicted')
    }
  }
  const turns = store.timelineFor('w1')?.turns ?? []
  assert.equal(turns.length, MAX_TURNS_PER_WORKSPACE)
  assert.equal(turns[0].turn, 0, 'the baseline survives the cap')
  assert.equal(store.hasBaseline('w1'), true)
  assert.equal(turns[turns.length - 1].turn, MAX_TURNS_PER_WORKSPACE)
})

run('forget returns what the caller must delete, and only that workspace', () => {
  const store = index()
  store.recordTurn({ workspaceId: 'w1', cwd: '/repo', turn: 0, ref: refFor('a'), at: 1 })
  store.recordTurn({ workspaceId: 'w1', cwd: '/repo', turn: 1, ref: refFor('b'), at: 2 })
  store.recordTurn({ workspaceId: 'w2', cwd: '/repo', turn: 0, ref: refFor('c'), at: 3 })

  const forgotten = store.forget('w1')
  assert.deepEqual(forgotten, {
    refs: [
      { ref: refFor('a'), cwd: '/repo' },
      { ref: refFor('b'), cwd: '/repo' },
    ],
  })
  assert.equal(store.timelineFor('w1'), null)
  assert.ok(store.timelineFor('w2'), 'the other workspace is untouched')
  assert.equal(store.forget('never-existed'), null)
})

run('a moved worktree keeps its timeline under the new cwd', () => {
  const store = index()
  store.recordTurn({ workspaceId: 'w1', cwd: '/old', turn: 0, ref: refFor('a'), at: 1 })
  store.recordTurn({ workspaceId: 'w1', cwd: '/new', turn: 1, ref: refFor('b'), at: 2 })
  assert.equal(store.timelineFor('w1')?.cwd, '/new')
  assert.equal(store.timelineFor('w1')?.turns.length, 2)
})

run('the timeline survives a restart', () => {
  const first = index()
  first.recordTurn({ workspaceId: 'w1', cwd: '/repo', turn: 0, ref: refFor('a'), at: 1 })
  first.recordTurn({ workspaceId: 'w1', cwd: '/repo', turn: 1, ref: refFor('b'), at: 2 })

  // A second instance over the same userData dir reads what the first wrote.
  const second = index()
  assert.equal(second.nextTurn('w1'), 2)
  assert.equal(second.hasBaseline('w1'), true)
  assert.deepEqual(second.timelineFor('w1')?.turns.map((turn) => turn.ref), [refFor('a'), refFor('b')])
})

run('a malformed or absent file reads as no timelines, never a throw', () => {
  const store = index()
  assert.deepEqual(store.workspaceIds(), [], 'absent file')

  writeFileSync(join(currentDir, 'checkpoint-index.json'), 'not json at all', 'utf8')
  assert.deepEqual(index().workspaceIds(), [])

  // Shapes that must not survive parsing: a ref we would otherwise hand to
  // `git update-ref -d` has to be a real string we wrote.
  writeFileSync(
    join(currentDir, 'checkpoint-index.json'),
    JSON.stringify({
      good: { cwd: '/repo', turns: [{ turn: 0, ref: refFor('a'), at: 1, cwd: '/repo' }] },
      noCwd: { turns: [{ turn: 0, ref: refFor('a'), at: 1, cwd: '/repo' }] },
      noTurns: { cwd: '/repo' },
      emptyTurns: { cwd: '/repo', turns: [] },
      badTurn: { cwd: '/repo', turns: [{ turn: 'zero', ref: refFor('a'), at: 1, cwd: '/repo' }] },
      emptyRef: { cwd: '/repo', turns: [{ turn: 0, ref: '', at: 1, cwd: '/repo' }] },
      foreignRef: { cwd: '/repo', turns: [{ turn: 0, ref: 'refs/heads/main', at: 1, cwd: '/repo' }] },
      turnWithoutCwd: { cwd: '/repo', turns: [{ turn: 0, ref: refFor('a'), at: 1 }] },
      notAnObject: 'nope',
    }),
    'utf8'
  )
  assert.deepEqual(index().workspaceIds(), ['good'], 'only the well-formed entry survives')
})

run('a torn file is moved aside, never silently overwritten', () => {
  // Finding from review: `load()` caches its answer for the process, so an
  // unreadable file used to become an empty index that the next write persisted
  // OVER every other workspace's timeline — orphaning their refs beyond the
  // reach of forget(). The bytes must survive somewhere.
  const path = join(currentDir, 'checkpoint-index.json')
  writeFileSync(path, '{"wA":{"cwd":"/repo","turns":[{"turn":0,"ref":"refs/multi', 'utf8')

  const store = index()
  assert.deepEqual(store.workspaceIds(), [], 'unreadable reads as empty')
  store.recordTurn({ workspaceId: 'wC', cwd: '/repo', turn: 0, ref: refFor('c'), at: 1 })

  assert.ok(existsSync(`${path}.corrupt`), 'the unreadable bytes are kept, not destroyed')
  assert.match(readFileSync(`${path}.corrupt`, 'utf8'), /wA/)
  assert.deepEqual(index().workspaceIds(), ['wC'], 'and the new write lands cleanly')
})

run('a write that cannot land reports so, and evicts nothing', () => {
  // The caller deletes evicted refs from the repo on the strength of this.
  const store = createCheckpointIndex({ resolveUserDataDir: () => join(currentDir, 'no', 'such') })
  const result = store.recordTurn({
    workspaceId: 'w1',
    cwd: '/repo',
    turn: 0,
    ref: refFor('a'),
    at: 1,
  })
  assert.equal(result.persisted, false)
  assert.deepEqual(result.evicted, [], 'no ref is deleted on the strength of a write that failed')
  assert.equal(store.forget('w1'), null, 'and forget declines rather than half-doing it')
})

run('out-of-order entries on disk are sorted on read', () => {
  writeFileSync(
    join(currentDir, 'checkpoint-index.json'),
    JSON.stringify({
      w1: {
        cwd: '/repo',
        turns: [
          { turn: 2, ref: refFor('c'), at: 3, cwd: '/repo' },
          { turn: 0, ref: refFor('a'), at: 1, cwd: '/repo' },
          { turn: 1, ref: refFor('b'), at: 2, cwd: '/repo' },
        ],
      },
    }),
    'utf8'
  )
  const store = index()
  assert.deepEqual(store.timelineFor('w1')?.turns.map((turn) => turn.turn), [0, 1, 2])
  assert.equal(store.nextTurn('w1'), 3, 'nextTurn reads the true highest, not the last written')
})

if (failures > 0) {
  console.error(`checkpoint-index.test.ts: ${failures} failing`)
  process.exit(1)
}
console.log('checkpoint-index.test.ts: ok')
