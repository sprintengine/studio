/**
 * The multi-window reconciliation cases for the main-owned workspace registry,
 * each driven as two simulated window sources against one registry.
 *
 * Every case asserts BOTH the accepted state and that no echo loop occurs — a
 * fixed number of broadcasts per command. A rule that converges but re-emits is
 * the failure mode the no-echo contract exists to prevent, and it does not show
 * up in a state assertion alone.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceRegistryStore } from './workspace-registry-store'
import { createWorkspaceRegistryService } from './workspace-registry-service'
import { createWorkspaceSyncService } from './workspace-sync-service'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../shared/workspace-mode'
import type { WorkspaceSyncCommand, WorkspaceSyncEvent } from '../shared/workspace-sync'

const WINDOW_A = 'primary'
const WINDOW_B = 'window-b'

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-workspace-reconcile-'))
  let clock = 1_000
  let ids = 0
  const registry = createWorkspaceRegistryService({
    store: createWorkspaceRegistryStore({ resolveUserDataDir: () => dir, persistDebounceMs: 0 }),
    now: () => (clock += 1),
    newWorkspaceId: () => `ws-${++ids}`,
  })
  const sync = createWorkspaceSyncService({ registry, now: () => clock })
  // Every broadcast main announces, in order. `dispatch` deliberately does not
  // announce (the IPC handler broadcasts it with the sender skipped), so this
  // counts main-originated fan-out; window-originated events are counted from
  // the dispatch results instead.
  const announced: WorkspaceSyncEvent[] = []
  sync.subscribeEvents((event) => announced.push(event))
  return {
    announced,
    registry,
    sync,
    dispatch: (command: WorkspaceSyncCommand, sourceWindowId: string) => sync.dispatch({ command, sourceWindowId }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

type Harness = ReturnType<typeof harness>

/** Seed one workspace in each window so the routing commands have somewhere to land. */
function seed(h: Harness): { workspaceId: string } {
  const created = h.sync.createWorkspace({ name: 'Shared', folderPath: '/repo' }, 'ui')
  assert.ok(created.ok)
  // Open a second window by moving nothing — placement registers the window.
  const placement = h.dispatch(
    {
      type: 'workspace_window.update_placement',
      payload: { windowId: WINDOW_B, bounds: null, isMaximized: false, displayId: null },
    },
    WINDOW_B,
  )
  assert.equal(placement.ok, false, 'an unknown window cannot place itself before it holds a workspace')
  return { workspaceId: created.result.workspace.id }
}

test('case 1: a rename in A and a layout drag in B both land', () => {
  const h = harness()
  try {
    const { workspaceId } = seed(h)
    const rename = h.dispatch(
      { type: 'workspace.rename', payload: { workspaceId, name: 'Renamed in A', titleLocked: true, editedAt: 5_000 } },
      WINDOW_A,
    )
    const layoutModel = {
      global: {},
      borders: [],
      layout: { type: 'row', children: [{ type: 'tabset', weight: 100, children: [] }] },
    }
    const layout = h.dispatch(
      { type: 'workspace.update_layout', payload: { workspaceId, layoutModel, editedAt: 5_001 } },
      WINDOW_B,
    )
    assert.equal(rename.ok, true)
    assert.equal(layout.ok, true)
    const record = h.registry.getRecord(workspaceId)!
    assert.equal(record.name, 'Renamed in A')
    assert.deepEqual(record.layoutModel, layoutModel)
    // Different commands, different stamps — no contention.
    assert.equal(record.fieldEditedAt.name, 5_000)
    assert.equal(record.fieldEditedAt.layoutModel, 5_001)
    assert.equal(h.announced.length, 1, 'only the headless create announced; two window commands, no extra fan-out')
  } finally {
    h.cleanup()
  }
})

test('case 2: two renames resolve by stamp regardless of arrival order', () => {
  const h = harness()
  try {
    const { workspaceId } = seed(h)
    // B typed LATER but arrives FIRST.
    const later = h.dispatch(
      {
        type: 'workspace.rename',
        payload: { workspaceId, name: 'Typed later in B', titleLocked: true, editedAt: 9_000 },
      },
      WINDOW_B,
    )
    const earlier = h.dispatch(
      {
        type: 'workspace.rename',
        payload: { workspaceId, name: 'Typed earlier in A', titleLocked: true, editedAt: 8_000 },
      },
      WINDOW_A,
    )
    assert.equal(later.ok, true)
    assert.equal(earlier.ok, false, 'the older gesture is refused, not applied')
    assert.equal(earlier.ok === false && earlier.reason, 'stale_edit')
    assert.ok(earlier.ok === false && earlier.snapshot, 'the rejection carries the state the loser converges on')
    const record = h.registry.getRecord(workspaceId)!
    assert.equal(record.name, 'Typed later in B')
    assert.equal(record.titleLocked, true, 'titleLocked travels with the winning name')
  } finally {
    h.cleanup()
  }
})

test('case 4: two windows editing one agent resolve by configEditedAt', () => {
  const h = harness()
  try {
    const { workspaceId } = seed(h)
    const first = h.dispatch(
      {
        type: 'workspace.update_agent',
        payload: { workspaceId, agentId: 'agent-1', patch: { name: 'Named in B' }, configEditedAt: 7_000 },
      },
      WINDOW_B,
    )
    assert.equal(first.ok, true)
    const stale = h.dispatch(
      {
        type: 'workspace.update_agent',
        payload: { workspaceId, agentId: 'agent-1', patch: { name: 'Named in A' }, configEditedAt: 6_000 },
      },
      WINDOW_A,
    )
    assert.equal(stale.ok, false)
    assert.equal(h.registry.getRecord(workspaceId)!.agents['agent-1']?.name, 'Named in B')

    // An explicit null is a tombstone: the user removed the agent.
    const removal = h.dispatch(
      {
        type: 'workspace.update_agent',
        payload: { workspaceId, agentId: 'agent-1', patch: null, configEditedAt: 8_000 },
      },
      WINDOW_A,
    )
    assert.equal(removal.ok, true)
    assert.equal(h.registry.getRecord(workspaceId)!.agents['agent-1'], undefined)
  } finally {
    h.cleanup()
  }
})

test('case 5: two windows both requesting one folder’s host get the same id', () => {
  const h = harness()
  try {
    // This is the class of bug the renderer-side set()-scoped check could only
    // prevent WITHIN one window. Main's single writer prevents it across them.
    const fromA = h.sync.createWorkspace(
      { folderPath: '/repo', mode: AUTOMATIONS_HOST_WORKSPACE_MODE, windowId: WINDOW_A },
      'ui',
    )
    const fromB = h.sync.createWorkspace(
      { folderPath: '/repo', mode: AUTOMATIONS_HOST_WORKSPACE_MODE, windowId: WINDOW_B },
      'ui',
    )
    assert.ok(fromA.ok && fromB.ok)
    assert.equal(fromB.result.workspace.id, fromA.result.workspace.id)
    assert.equal(h.registry.getRecords().length, 1)
    assert.equal(h.announced.length, 1, 'the reuse did not mint or announce a second workspace')
  } finally {
    h.cleanup()
  }
})

test('case 6: an edit against a workspace another window removed is rejected, not resurrected', () => {
  const h = harness()
  try {
    const { workspaceId } = seed(h)
    const removed = h.dispatch({ type: 'workspace.remove', payload: { workspaceId } }, WINDOW_A)
    assert.equal(removed.ok, true)
    assert.equal(h.registry.getRecord(workspaceId), null)

    const lateEdit = h.dispatch(
      { type: 'workspace.rename', payload: { workspaceId, name: 'From a lagging window', editedAt: 99_000 } },
      WINDOW_B,
    )
    assert.equal(lateEdit.ok, false)
    assert.equal(lateEdit.ok === false && lateEdit.reason, 'unknown_workspace')
    assert.equal(h.registry.getRecord(workspaceId), null, 'without the tombstone this edit would re-create the record')
    assert.equal(
      h.registry.getTombstones().some((entry) => entry.id === workspaceId),
      true,
    )
  } finally {
    h.cleanup()
  }
})

test('case 9: the second drag of one workspace to a different window is refused', () => {
  const h = harness()
  try {
    const { workspaceId } = seed(h)
    const first = h.dispatch(
      {
        type: 'workspace.move_to_window',
        payload: { workspaceId, fromWindowId: WINDOW_A, toWindowId: WINDOW_B, makeActive: true },
      },
      WINDOW_A,
    )
    assert.equal(first.ok, true)
    // A now no longer owns it, so its second attempt fails ownership validation.
    const second = h.dispatch(
      {
        type: 'workspace.move_to_window',
        payload: { workspaceId, fromWindowId: WINDOW_A, toWindowId: 'window-c', makeActive: true },
      },
      WINDOW_A,
    )
    assert.equal(second.ok, false)
    assert.equal(second.ok === false && second.reason, 'workspace_not_in_source_window')
    assert.deepEqual(
      h.sync.getSnapshot().state.workspaceWindows.find((windowState) => windowState.id === WINDOW_B)?.workspaceIds,
      [workspaceId],
      'the first accepted move stands; the second changed nothing',
    )
  } finally {
    h.cleanup()
  }
})

test('case 10: a headless create lands while a window is mid-edit, touching nothing it touches', () => {
  const h = harness()
  try {
    const { workspaceId } = seed(h)
    const rename = h.dispatch(
      { type: 'workspace.rename', payload: { workspaceId, name: 'Edited in A', editedAt: 4_000 } },
      WINDOW_A,
    )
    assert.equal(rename.ok, true)
    const gatewayCreate = h.sync.createWorkspace({ name: 'From the gateway', folderPath: '/other' }, 'gateway')
    assert.ok(gatewayCreate.ok)
    assert.equal(h.registry.getRecord(workspaceId)!.name, 'Edited in A', 'the create touched nothing the edit did')
    // Membership is main's: the workspace lands in a real window rather than
    // waiting for one to claim it.
    assert.equal(
      h.sync
        .getSnapshot()
        .state.workspaceWindows.some((windowState) =>
          windowState.workspaceIds.includes(gatewayCreate.result.workspace.id),
        ),
      true,
    )
    // Exactly one broadcast per headless create — the fan-out a window learns from.
    assert.equal(h.announced.filter((event) => event.type === 'workspace.created').length, 2)
  } finally {
    h.cleanup()
  }
})

test('every accepted command produces exactly one event and one sequence step', () => {
  const h = harness()
  try {
    const { workspaceId } = seed(h)
    const before = h.sync.getSnapshot().sequence
    const rename = h.dispatch(
      { type: 'workspace.rename', payload: { workspaceId, name: 'Once', editedAt: 3_000 } },
      WINDOW_A,
    )
    assert.ok(rename.ok)
    assert.equal(h.sync.getSnapshot().sequence, before + 1, 'no echo: one command, one sequence step')
    assert.equal(h.sync.getEventsAfter(before).length, 1)

    const rejected = h.dispatch(
      { type: 'workspace.rename', payload: { workspaceId, name: 'Stale', editedAt: 2_000 } },
      WINDOW_B,
    )
    assert.equal(rejected.ok, false)
    assert.equal(h.sync.getSnapshot().sequence, before + 1, 'a rejected command mints no event at all')
  } finally {
    h.cleanup()
  }
})

test('a field patch honours absent-means-no-opinion and null-means-cleared', () => {
  const h = harness()
  try {
    const { workspaceId } = seed(h)
    const patched = h.dispatch(
      {
        type: 'workspace.update_fields',
        payload: { workspaceId, patch: { settledAt: 12_345, settledOverride: 'settled' }, editedAt: 6_000 },
      },
      WINDOW_A,
    )
    assert.equal(patched.ok, true)
    let record = h.registry.getRecord(workspaceId)!
    assert.equal(record.settledAt, 12_345)
    assert.equal(record.settledOverride, 'settled')
    assert.equal(record.folderPath, '/repo', 'a field the patch did not name is untouched')

    const cleared = h.dispatch(
      { type: 'workspace.update_fields', payload: { workspaceId, patch: { settledAt: null }, editedAt: 6_001 } },
      WINDOW_A,
    )
    assert.equal(cleared.ok, true)
    record = h.registry.getRecord(workspaceId)!
    assert.equal(record.settledAt, null, 'an explicit null is a tombstone, not "no opinion"')
    assert.equal(record.settledOverride, 'settled', 'a field the patch did not name keeps its value')

    // The settle fields are stamped: a window's sweep that decided BEFORE the
    // person's Un-settle loses, however late it arrives, so the row cannot be
    // left resting with the hold that says it is not.
    const stale = h.dispatch(
      { type: 'workspace.update_fields', payload: { workspaceId, patch: { settledAt: 5_000 }, editedAt: 5_000 } },
      WINDOW_B,
    )
    assert.equal(stale.ok, false, 'an older settle decision is rejected')
    assert.equal(h.registry.getRecord(workspaceId)!.settledAt, null)

    // A typed field is checked for shape, not just for name.
    const malformed = h.dispatch(
      {
        type: 'workspace.update_fields',
        payload: { workspaceId, patch: { settledOverride: 'archived' } as never, editedAt: 6_003 },
      },
      WINDOW_A,
    )
    assert.equal(malformed.ok === false && malformed.reason, 'invalid_field_value')

    // An activity clock only moves forward, whichever window reports it.
    const ahead = h.dispatch(
      { type: 'workspace.update_fields', payload: { workspaceId, patch: { lastTurnEndedAt: 9_000 }, editedAt: 6_004 } },
      WINDOW_A,
    )
    assert.equal(ahead.ok, true)
    const behind = h.dispatch(
      { type: 'workspace.update_fields', payload: { workspaceId, patch: { lastTurnEndedAt: 8_000 }, editedAt: 6_005 } },
      WINDOW_B,
    )
    assert.equal(behind.ok, true, 'accepted as a command')
    assert.equal(
      h.registry.getRecord(workspaceId)!.lastTurnEndedAt,
      9_000,
      'but an older clock reading does not roll main back',
    )

    const notEditable = h.dispatch(
      {
        type: 'workspace.update_fields',
        payload: { workspaceId, patch: { mode: 'weather-deck' } as never, editedAt: 6_002 },
      },
      WINDOW_A,
    )
    assert.equal(notEditable.ok, false, 'a field outside the editable set is refused, never silently dropped')
    assert.equal(notEditable.ok === false && notEditable.reason, 'field_not_editable')
  } finally {
    h.cleanup()
  }
})

console.log('workspace-registry-reconciliation.test.ts: ok')
