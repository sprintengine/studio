import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { createRoadmapOrchestratorStore, roadmapRuntimePath } from './roadmap-orchestrator-store'
import type { RoadmapLaneRuntime } from '../shared/sprintengine/roadmap-orchestrator'

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-roadmap-store-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('write then read round-trips lane runtime', async () => {
  await withTempRoot(async (root) => {
    const store = createRoadmapOrchestratorStore(root)
    const lanes = new Map<string, RoadmapLaneRuntime>([
      ['Backend', { lane: 'Backend', activeItemRef: 'backlog/a.md', activeStatePath: '/w/run.yaml', activeRepoId: 'primary' }],
      ['Infra', { lane: 'Infra', parked: { reason: 'run_failed', itemRef: 'backlog/c.md', at: '2026-07-18T00:00:00Z' } }],
    ])
    await store.write('backlog/roadmaps/platform.md', lanes)

    const read = await store.read('backlog/roadmaps/platform.md')
    assert.equal(read.get('Backend')?.activeItemRef, 'backlog/a.md')
    assert.equal(read.get('Infra')?.parked?.reason, 'run_failed')
  })
})

test('missing sidecar reads as empty', async () => {
  await withTempRoot(async (root) => {
    const store = createRoadmapOrchestratorStore(root)
    const read = await store.read('backlog/roadmaps/none.md')
    assert.equal(read.size, 0)
  })
})

test('malformed sidecar reads as empty, never throws', async () => {
  await withTempRoot(async (root) => {
    const { path } = roadmapRuntimePath(root, 'backlog/roadmaps/broken.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{ not json', 'utf8')
    const store = createRoadmapOrchestratorStore(root)
    const read = await store.read('backlog/roadmaps/broken.md')
    assert.equal(read.size, 0)
  })
})

test('invalid park reason is dropped, valid rows survive', async () => {
  await withTempRoot(async (root) => {
    const { path } = roadmapRuntimePath(root, 'backlog/roadmaps/mixed.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        roadmapRef: 'backlog/roadmaps/mixed.md',
        lanes: [
          { lane: 'Good', activeItemRef: 'backlog/a.md' },
          { lane: 'BadPark', parked: { reason: 'not_a_reason', itemRef: 'x', at: '' } },
          { notALane: true },
        ],
      }),
      'utf8',
    )
    const store = createRoadmapOrchestratorStore(root)
    const read = await store.read('backlog/roadmaps/mixed.md')
    assert.equal(read.get('Good')?.activeItemRef, 'backlog/a.md')
    // A row with an invalid park reason keeps the lane but drops the bad parked.
    assert.equal(read.get('BadPark')?.parked, undefined)
  })
})

test('sidecar path is contained to a single safe segment', async () => {
  await withTempRoot(async (root) => {
    const { path } = roadmapRuntimePath(root, 'backlog/roadmaps/../../etc/passwd.md')
    // The slug is the sanitized file-name stem, never an escaping path.
    assert.ok(path.startsWith(join(root, '.multi-code', 'sprintengine', 'roadmaps')))
    assert.ok(!path.includes('..'))
  })
})

test('absorbs a legacy non-home sidecar once, then deletes every legacy copy', async () => {
  await withTempRoot(async (homeRoot) => {
    await withTempRoot(async (repoA) => {
      await withTempRoot(async (repoB) => {
        // A pre-instance build left sidecars under two NON-home projects.
        const legacyA = roadmapRuntimePath(repoA, 'backlog/roadmaps/platform.md').path
        const legacyB = roadmapRuntimePath(repoB, 'backlog/roadmaps/platform.md').path
        for (const [path, ref] of [[legacyA, 'backlog/a.md'], [legacyB, 'backlog/z.md']] as const) {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(
            path,
            JSON.stringify({ schemaVersion: 1, roadmapRef: 'backlog/roadmaps/platform.md', lanes: [{ lane: 'Backend', activeItemRef: ref }] }),
            'utf8',
          )
        }

        // The home store (empty) absorbs the first legacy sidecar found.
        const store = createRoadmapOrchestratorStore(homeRoot)
        const read = await store.read('backlog/roadmaps/platform.md', [repoA, repoB])
        assert.equal(read.get('Backend')?.activeItemRef, 'backlog/a.md')
        const { path: instancePath } = roadmapRuntimePath(homeRoot, 'backlog/roadmaps/platform.md')
        assert.match(await readFile(instancePath, 'utf8'), /"activeItemRef": "backlog\/a.md"/)
        // ...and every legacy copy is gone.
        await assert.rejects(() => readFile(legacyA, 'utf8'))
        await assert.rejects(() => readFile(legacyB, 'utf8'))
        // A second read reads the home store directly (no legacy left).
        const again = await store.read('backlog/roadmaps/platform.md', [repoA, repoB])
        assert.equal(again.get('Backend')?.activeItemRef, 'backlog/a.md')
      })
    })
  })
})

test('the home store is never swept as its own legacy copy', async () => {
  await withTempRoot(async (homeRoot) => {
    const store = createRoadmapOrchestratorStore(homeRoot)
    await store.write('backlog/roadmaps/platform.md', new Map([['L', { lane: 'L', activeItemRef: ':backlog/x.md' }]]))
    // Passing the home root itself as a "legacy" root must not delete the store.
    const read = await store.read('backlog/roadmaps/platform.md', [homeRoot])
    assert.equal(read.get('L')?.activeItemRef, ':backlog/x.md')
  })
})

test('write is atomic (no .tmp left behind)', async () => {
  await withTempRoot(async (root) => {
    const store = createRoadmapOrchestratorStore(root)
    await store.write('backlog/roadmaps/atomic.md', new Map([['L', { lane: 'L' }]]))
    const { path } = roadmapRuntimePath(root, 'backlog/roadmaps/atomic.md')
    const written = await readFile(path, 'utf8')
    assert.match(written, /"roadmapRef": "backlog\/roadmaps\/atomic.md"/)
    await assert.rejects(() => readFile(`${path}.tmp-${process.pid}`, 'utf8'))
  })
})
