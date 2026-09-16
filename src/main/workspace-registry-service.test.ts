import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceRegistryStore, WORKSPACE_REGISTRY_FILE_NAME } from './workspace-registry-store'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createWorkspaceSyncService } from './workspace-sync-service'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../shared/workspace-mode'
import { parseWorkspaceRegistryFile } from '../shared/workspace-registry'
import type { WorkspaceRegistryDiagnostic } from './workspace-registry-service'

type Harness = ReturnType<typeof harness>

function harness(options: { persistDebounceMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-workspace-registry-'))
  const diagnostics: WorkspaceRegistryDiagnostic[] = []
  let clock = 1_000
  const store = createWorkspaceRegistryStore({
    resolveUserDataDir: () => dir,
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    persistDebounceMs: options.persistDebounceMs ?? 0,
  })
  let ids = 0
  const registry = createWorkspaceRegistryService({
    store,
    now: () => (clock += 1),
    newWorkspaceId: () => `ws-${++ids}`,
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  })
  const sync = createWorkspaceSyncService({ registry, now: () => clock })
  return {
    dir,
    diagnostics,
    registry,
    store,
    sync,
    advanceClock: (ms: number) => { clock += ms },
    readFile: () => parseWorkspaceRegistryFile(JSON.parse(readFileSync(join(dir, WORKSPACE_REGISTRY_FILE_NAME), 'utf8'))),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function create(h: Harness, input: Parameters<Harness['sync']['createWorkspace']>[0]) {
  const outcome = h.sync.createWorkspace(input, 'gateway')
  assert.ok(outcome.ok, `create should succeed: ${outcome.ok ? '' : outcome.message}`)
  return outcome.result
}

test('a headless create is readable from the registry in the same tick', () => {
  const h = harness()
  try {
    // The property that retires `createWorkspaceConfirmed`'s 7s bus poll: the
    // caller never gets back an id it cannot observe.
    const result = create(h, { name: 'Gateway workspace', folderPath: '/repo' })
    assert.equal(h.registry.getRecord(result.workspace.id)?.name, 'Gateway workspace')
    assert.equal(
      h.sync.getSnapshot().state.workspaces.some((entry) => entry.id === result.workspace.id),
      true,
    )
    // Fully formed with zero windows: a window opening later can render it.
    assert.ok(result.workspace.layoutModel, 'a headless create carries a real layout')
    assert.notDeepEqual(result.workspace.layoutModel, {})
    assert.equal(result.workspace.folderPath, '/repo')
    assert.equal(result.workspace.mode, 'standard')
    assert.equal(result.windowId, 'primary', 'membership is main’s, not a window’s to claim later')
    assert.equal(h.sync.getSnapshot().state.workspaceWindows[0]?.workspaceIds.includes(result.workspace.id), true)
  } finally {
    h.cleanup()
  }
})

test('an explicitly named workspace locks its title at creation', () => {
  const h = harness()
  try {
    assert.equal(create(h, { name: 'Named' }).workspace.titleLocked, true)
    assert.equal(create(h, {}).workspace.titleLocked, undefined, 'a default name stays auto-titleable')
    assert.equal(
      create(h, { name: 'Chat 63' }).workspace.titleLocked,
      undefined,
      'an app-minted "Chat N" name passed explicitly is still a default name',
    )
  } finally {
    h.cleanup()
  }
})

test('the host mode mints its own single-surface layout headlessly', () => {
  const h = harness()
  try {
    const auto = create(h, { folderPath: '/repo', mode: AUTOMATIONS_HOST_WORKSPACE_MODE })
    assert.equal(auto.workspace.templateId, 'automations-mode')
    assert.equal(
      JSON.stringify(auto.workspace.layoutModel).includes('automations-control-center'),
      true,
      'a host minted with no window still gets its control centre, never a bare standard layout',
    )
    // The mode wins over a caller-named template: a host built on 'solo' would
    // have no control surface in it.
    const forced = create(h, { folderPath: '/other', mode: AUTOMATIONS_HOST_WORKSPACE_MODE, templateId: 'solo' })
    assert.equal(forced.workspace.templateId, 'automations-mode')
  } finally {
    h.cleanup()
  }
})

test('two creates for one folder’s host resolve to the same id', () => {
  const h = harness()
  try {
    const first = create(h, { folderPath: '/repo', name: 'Automations', mode: AUTOMATIONS_HOST_WORKSPACE_MODE })
    const second = create(h, { folderPath: '/Repo/', name: 'Automations', mode: AUTOMATIONS_HOST_WORKSPACE_MODE })
    assert.equal(second.workspace.id, first.workspace.id, 'reuse holds across callers, not only within one window')
    assert.equal(second.reused, true)
    assert.equal(h.registry.getRecords().length, 1, 'no duplicate host is minted')
    // Reuse clears folderMissing: the caller just named the folder.
    assert.equal(second.workspace.folderMissing, false)
  } finally {
    h.cleanup()
  }
})

test('two mutations in one tick land in revision order and persist', async () => {
  const h = harness()
  try {
    const first = create(h, { name: 'One' })
    const second = create(h, { name: 'Two' })
    assert.ok(
      h.registry.getRecord(second.workspace.id)!.revision > h.registry.getRecord(first.workspace.id)!.revision,
      'the later write carries the higher record revision',
    )
    await h.registry.flush()
    const persisted = h.readFile()
    assert.ok(persisted)
    assert.equal(persisted.file.revision, h.registry.getRevision())
    assert.deepEqual(
      persisted.file.workspaces.map((record) => record.name).sort(),
      ['One', 'Two'],
    )
  } finally {
    h.cleanup()
  }
})

test('a restart reloads a complete registry — no placeholders, every layout real', async () => {
  const h = harness()
  try {
    create(h, { name: 'Survivor', folderPath: '/repo', mode: AUTOMATIONS_HOST_WORKSPACE_MODE })
    await h.registry.flush()

    // Second boot against the same userData dir, with no window at any point.
    const reloadedStore = createWorkspaceRegistryStore({ resolveUserDataDir: () => h.dir, persistDebounceMs: 0 })
    const reloaded = createWorkspaceRegistryService({ store: reloadedStore })
    const records = reloaded.getRecords()
    assert.equal(records.length, 1)
    const record = records[0]!
    assert.equal(record.name, 'Survivor')
    assert.equal(record.folderPath, '/repo')
    assert.equal(record.mode, AUTOMATIONS_HOST_WORKSPACE_MODE, 'the mode survives, so host-by-folder lookup works')
    assert.notEqual(record.templateId, 'workspace-sync-routing-placeholder')
    assert.notDeepEqual(record.layoutModel, { global: {}, borders: [], layout: { type: 'row', children: [] } })
    assert.equal(reloaded.needsHydration(), false, 'a loaded registry is authoritative; hydration is over')

    // A restart survivor is reusable by folder, which is what a placeholder
    // could never be — the executor used to mint a duplicate host per restart.
    const reloadedSync = createWorkspaceSyncService({ registry: reloaded })
    const reuse = reloadedSync.createWorkspace(
      { folderPath: '/repo', mode: AUTOMATIONS_HOST_WORKSPACE_MODE },
      'automation',
    )
    assert.ok(reuse.ok)
    assert.equal(reuse.result.workspace.id, record.id)
  } finally {
    h.cleanup()
  }
})

test('a content-identical write does not churn the file', async () => {
  const h = harness()
  try {
    create(h, { name: 'One' })
    await h.registry.flush()
    const before = readFileSync(join(h.dir, WORKSPACE_REGISTRY_FILE_NAME), 'utf8')
    h.store.write(h.readFile()!.file)
    await h.store.flush()
    assert.equal(readFileSync(join(h.dir, WORKSPACE_REGISTRY_FILE_NAME), 'utf8'), before)
  } finally {
    h.cleanup()
  }
})

test('a failed write warns and leaves in-memory state usable', async () => {
  const diagnostics: WorkspaceRegistryDiagnostic[] = []
  // An unwritable userData path: the write fails, the app keeps working.
  const store = createWorkspaceRegistryStore({
    resolveUserDataDir: () => '/dev/null/not-a-directory',
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    persistDebounceMs: 0,
  })
  const registry = createWorkspaceRegistryService({ store, newWorkspaceId: () => 'ws-1' })
  const sync = createWorkspaceSyncService({ registry })
  const outcome = sync.createWorkspace({ name: 'Still works' }, 'ui')
  assert.ok(outcome.ok)
  await registry.flush()
  assert.equal(registry.getRecord('ws-1')?.name, 'Still works', 'in-memory state stays authoritative')
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.title === 'Workspace registry not persisted'),
    true,
    'a failed write is a named warning, never a silent success',
  )
})

test('hydration seeds once from a window and then no-ops', () => {
  const h = harness()
  try {
    assert.equal(h.registry.needsHydration(), true, 'a fresh install has nothing to mirror yet')
    const payload = {
      workspaces: [
        { ...create(h, { name: 'discarded' }).workspace, id: 'legacy-1', name: 'From localStorage' },
      ],
      activeWorkspaceId: 'legacy-1',
      rawLocalStorage: JSON.stringify({ state: { workspaces: [{ id: 'legacy-1' }] } }),
    }
    // The create above already wrote, so hydration must refuse to overwrite it.
    assert.equal(h.registry.hydrate(payload).reason, 'already_present')

    const fresh = harness()
    try {
      const first = fresh.registry.hydrate(payload)
      assert.equal(first.reason, 'seeded')
      assert.equal(first.seededWorkspaceCount, 1)
      assert.equal(fresh.registry.getRecord('legacy-1')?.name, 'From localStorage')
      // A second window racing the first is a no-op, not a merge.
      const second = fresh.registry.hydrate({ ...payload, workspaces: [] })
      assert.equal(second.reason, 'already_present')
      assert.equal(fresh.registry.getRecords().length, 1)
    } finally {
      fresh.cleanup()
    }
  } finally {
    h.cleanup()
  }
})

test('hydration refuses every dangerous-empty row and leaves the legacy key to retry', () => {
  for (const rawLocalStorage of [
    null,
    '{ not json',
    JSON.stringify({ state: { workspaces: [] } }),
  ]) {
    const h = harness()
    try {
      const result = h.registry.hydrate({ workspaces: [], rawLocalStorage })
      assert.equal(result.reason, 'refused_dangerous_empty')
      assert.equal(result.changed, false)
      assert.equal(h.registry.needsHydration(), true, 'a refusal retries on the next boot')
      assert.equal(
        h.diagnostics.some((diagnostic) => diagnostic.title === 'Workspace registry not seeded'),
        true,
        'a refusal is loud',
      )
    } finally {
      h.cleanup()
    }
  }
})

test('an empty offer WITH the intent record seeds an empty registry', () => {
  const h = harness()
  try {
    const result = h.registry.hydrate({
      workspaces: [],
      workspaceRegistryEmptyState: { reason: 'user_removed_all', updatedAt: '2026-08-06T00:00:00.000Z' },
      rawLocalStorage: JSON.stringify({ state: { workspaces: [] } }),
    })
    assert.equal(result.reason, 'seeded_empty_intent')
    assert.equal(h.registry.getRecords().length, 0)
    assert.equal(h.registry.needsHydration(), false, 'the user really did remove everything')
  } finally {
    h.cleanup()
  }
})

test('hydration drops one bad record and keeps the rest', () => {
  const h = harness()
  try {
    const good = create(h, { name: 'Good' }).workspace
    const fresh = harness()
    try {
      const result = fresh.registry.hydrate({
        workspaces: [good, { id: 'broken', name: 'Broken' }],
        rawLocalStorage: JSON.stringify({ state: { workspaces: [{ id: good.id }, { id: 'broken' }] } }),
      })
      assert.equal(result.reason, 'seeded')
      assert.deepEqual(result.droppedRecordIds, ['broken'])
      assert.deepEqual(fresh.registry.getRecords().map((record) => record.id), [good.id])
      assert.equal(
        fresh.diagnostics.some((diagnostic) => diagnostic.title === 'Workspace dropped during registry migration'),
        true,
      )
    } finally {
      fresh.cleanup()
    }
  } finally {
    h.cleanup()
  }
})

test('hydration validates a window routing block from an old profile', () => {
  const h = harness()
  try {
    const good = create(h, { name: 'Good' }).workspace
    const fresh = harness()
    try {
      const result = fresh.registry.hydrate({
        workspaces: [good],
        primaryWorkspaceWindowId: 'primary',
        // One well-formed window and one malformed entry, as an old profile can
        // carry. Seeding the malformed one verbatim would break routing on the
        // very first boot.
        workspaceWindows: [
          {
            id: 'primary',
            kind: 'primary',
            workspaceIds: [good.id],
            activeWorkspaceId: good.id,
            bounds: null,
            isMaximized: false,
            displayId: null,
            createdAt: 0,
            lastFocusedAt: 0,
          },
          { id: 'broken', kind: 'detached' },
        ],
        rawLocalStorage: JSON.stringify({ state: { workspaces: [{ id: good.id }] } }),
      })
      assert.equal(result.reason, 'seeded')
      assert.deepEqual(
        fresh.registry.getState().workspaceWindows.map((windowState) => windowState.id),
        ['primary'],
        'the malformed window is dropped; the valid one seeds normally',
      )
    } finally {
      fresh.cleanup()
    }
  } finally {
    h.cleanup()
  }
})

test('a corrupt registry file is refused rather than presented as an empty list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-workspace-registry-corrupt-'))
  try {
    writeFileSync(join(dir, WORKSPACE_REGISTRY_FILE_NAME), '{ truncated', 'utf8')
    const diagnostics: WorkspaceRegistryDiagnostic[] = []
    const registry = createWorkspaceRegistryService({
      store: createWorkspaceRegistryStore({ resolveUserDataDir: () => dir, persistDebounceMs: 0 }),
      logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    assert.equal(registry.getRecords().length, 0)
    assert.equal(registry.needsHydration(), true, 'the next boot re-seeds from the untouched legacy key')
    assert.equal(diagnostics.some((diagnostic) => diagnostic.title === 'Workspace registry unreadable'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a retired-mode row is dropped on load and cannot be proposed back', async () => {
  const h = harness()
  try {
    const kept = create(h, { name: 'Kept', folderPath: '/repo' })
    const retired = create(h, { name: 'Old sprint', folderPath: '/repo' })
    await h.registry.flush()

    // An older build wrote the second row as a sprint-engine workspace, and
    // left it the active one.
    const path = join(h.dir, WORKSPACE_REGISTRY_FILE_NAME)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      workspaces: { id: string; mode: string }[]
      activeWorkspaceId: string | null
      workspaceWindows: { workspaceIds: string[]; activeWorkspaceId: string | null }[]
    }
    raw.workspaces.find((record) => record.id === retired.workspace.id)!.mode = 'sprintengine'
    raw.activeWorkspaceId = retired.workspace.id
    raw.workspaceWindows[0]!.activeWorkspaceId = retired.workspace.id
    assert.equal(raw.workspaceWindows[0]!.workspaceIds.includes(retired.workspace.id), true)
    writeFileSync(path, JSON.stringify(raw), 'utf8')

    const diagnostics: WorkspaceRegistryDiagnostic[] = []
    const store = createWorkspaceRegistryStore({
      resolveUserDataDir: () => h.dir,
      persistDebounceMs: 0,
      logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    const registry = createWorkspaceRegistryService({ store, logDiagnostic: (diagnostic) => diagnostics.push(diagnostic) })
    const sync = createWorkspaceSyncService({ registry })

    // Main's own consumers read these: the gateway's workspace_list and the
    // phone snapshot never see the retired row.
    assert.deepEqual(registry.getRecords().map((record) => record.id), [kept.workspace.id])
    const snapshot = sync.getSnapshot().state
    assert.deepEqual(snapshot.workspaces.map((record) => record.id), [kept.workspace.id])
    assert.equal(snapshot.workspaceWindows[0]!.workspaceIds.includes(retired.workspace.id), false)
    assert.equal(snapshot.workspaceWindows[0]!.activeWorkspaceId, null)
    assert.equal(snapshot.activeWorkspaceId, null)
    assert.equal(diagnostics.length, 0, 'a retired row is filtered quietly, not reported as a malformed record')

    // A window that still holds the row cannot propose it back…
    const reproposed = sync.dispatch({
      sourceWindowId: 'primary',
      command: {
        type: 'workspace.created',
        payload: {
          workspace: { ...retired.workspace, mode: 'sprintengine' },
          windowId: 'primary',
          insert: { kind: 'folder_head', folderPath: '/repo' },
        },
      },
    })
    assert.equal(reproposed.ok, false)
    assert.equal(reproposed.ok ? '' : reproposed.reason, 'retired_workspace_mode')
    // …nor adopt it, nor mint a fresh one…
    const adopted = sync.adoptWorkspace({ ...retired.workspace, mode: 'sprintengine' }, 'primary', '/repo', 'module')
    assert.equal(adopted.ok ? '' : adopted.reason, 'retired_workspace_mode')
    const minted = sync.createWorkspace({ folderPath: '/repo', mode: 'sprintengine' }, 'gateway')
    assert.equal(minted.ok ? '' : minted.reason, 'retired_workspace_mode')
    // …and an edit naming it is refused as unknown.
    const renamed = sync.dispatch({
      sourceWindowId: 'primary',
      command: { type: 'workspace.rename', payload: { workspaceId: retired.workspace.id, name: 'Back', editedAt: 9_999_999 } },
    })
    assert.equal(renamed.ok ? '' : renamed.reason, 'unknown_workspace')
    assert.deepEqual(registry.getRecords().map((record) => record.id), [kept.workspace.id])

    // The next accepted write persists the registry without the row.
    const ok = sync.createWorkspace({ name: 'Fresh', folderPath: '/repo' }, 'gateway')
    assert.ok(ok.ok)
    await registry.flush()
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as { workspaces: { id: string }[] }
    assert.equal(persisted.workspaces.some((record) => record.id === retired.workspace.id), false)
  } finally {
    h.cleanup()
  }
})

console.log('workspace-registry-service.test.ts: ok')
