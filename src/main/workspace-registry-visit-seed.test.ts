import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceRegistryStore, WORKSPACE_REGISTRY_FILE_NAME } from './workspace-registry-store'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createWorkspaceSyncService } from './workspace-sync-service'

// The visit clock's first load: everything from before the build that keeps
// it counts as seen, once, and a chat made since never does by default.

function boot(dir: string, now: number) {
  const store = createWorkspaceRegistryStore({ resolveUserDataDir: () => dir, persistDebounceMs: 0 })
  let ids = 0
  const registry = createWorkspaceRegistryService({ store, now: () => now, newWorkspaceId: () => `ws-${++ids}` })
  const sync = createWorkspaceSyncService({ registry, now: () => now })
  return { store, registry, sync }
}

function withDir(run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sprintengine-visit-seed-'))
    try {
      await run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Rewrite the registry on disk as a build before the visit clock wrote it, keeping `kept` ids' clocks. */
function asWrittenBeforeVisits(dir: string, kept: Record<string, number> = {}) {
  const path = join(dir, WORKSPACE_REGISTRY_FILE_NAME)
  const file = JSON.parse(readFileSync(path, 'utf8'))
  for (const record of file.workspaces) {
    delete record.lastVisitedAt
    if (record.id in kept) record.lastVisitedAt = kept[record.id]
  }
  writeFileSync(path, JSON.stringify(file))
}

test(
  'a registry from before the visit clock loads with every chat seen at the load, and keeps that',
  withDir(async (dir) => {
    const first = boot(dir, 1_000)
    assert.ok(first.sync.createWorkspace({ name: 'Read yesterday' }, 'gateway').ok)
    await first.registry.flush()
    asWrittenBeforeVisits(dir)

    const upgraded = boot(dir, 5_000)
    assert.equal(upgraded.registry.getRecord('ws-1')?.lastVisitedAt, 5_000)
    await upgraded.store.flush()

    // Persisted: a later boot finds the seed rather than seeding again.
    const later = boot(dir, 9_000)
    assert.equal(later.registry.getRecord('ws-1')?.lastVisitedAt, 5_000)
  }),
)

test(
  'a chat that already has a visit clock keeps it',
  withDir(async (dir) => {
    const first = boot(dir, 1_000)
    assert.ok(first.sync.createWorkspace({ name: 'One' }, 'gateway').ok)
    assert.ok(first.sync.createWorkspace({ name: 'Two' }, 'gateway').ok)
    await first.registry.flush()
    asWrittenBeforeVisits(dir, { 'ws-2': 3_000 })

    const upgraded = boot(dir, 5_000)
    assert.equal(upgraded.registry.getRecord('ws-1')?.lastVisitedAt, 5_000)
    assert.equal(upgraded.registry.getRecord('ws-2')?.lastVisitedAt, 3_000)
  }),
)

test(
  'a chat made under this build is born with its creation as its visit, so no later load marks it seen',
  withDir(async (dir) => {
    const first = boot(dir, 1_000)
    const created = first.sync.createWorkspace({ name: 'Never opened' }, 'gateway')
    assert.ok(created.ok)
    const record = first.registry.getRecord('ws-1')
    assert.equal(record?.lastVisitedAt, record?.createdAt)
    await first.registry.flush()

    const later = boot(dir, 9_000)
    assert.equal(later.registry.getRecord('ws-1')?.lastVisitedAt, record?.createdAt)
  }),
)

test(
  'a window’s own registry, hydrated on the first boot, is seen as a loaded one is',
  withDir((dir) => {
    const donorDir = mkdtempSync(join(tmpdir(), 'sprintengine-visit-donor-'))
    const created = boot(donorDir, 1_000).sync.createWorkspace({ name: 'From the window' }, 'gateway')
    rmSync(donorDir, { recursive: true, force: true })
    assert.ok(created.ok)
    const { lastVisitedAt: _born, ...legacy } = created.result.workspace

    const fresh = boot(dir, 7_000)
    const seeded = fresh.registry.hydrate({
      workspaces: [{ ...legacy, id: 'legacy-1' }],
      activeWorkspaceId: 'legacy-1',
      rawLocalStorage: JSON.stringify({ state: { workspaces: [{ id: 'legacy-1' }] } }),
    })
    assert.equal(seeded.reason, 'seeded')
    assert.equal(fresh.registry.getRecord('legacy-1')?.lastVisitedAt, 7_000)
  }),
)

test(
  'a chat imported from an agent CLI’s history is born seen as of its last move, not unread from its start',
  withDir((dir) => {
    const { registry, sync } = boot(dir, 90_000)
    const created = sync.createWorkspace(
      { name: 'Imported', imported: { startedAt: 1_000, lastActiveAt: 40_000 } },
      'gateway',
    )
    assert.ok(created.ok)
    const record = registry.getRecord('ws-1')
    assert.equal(record?.createdAt, 1_000)
    assert.equal(record?.lastTurnEndedAt, 40_000)
    assert.equal(record?.lastVisitedAt, 40_000, 'its last finish is not one nobody has seen')
  }),
)
