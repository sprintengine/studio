import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceSyncRoutingSnapshot } from '../shared/workspace-sync'
import { createWorkspaceSyncRoutingSnapshotStore } from './workspace-sync-routing-snapshot'

// The routing snapshot is the only cross-restart carrier of workspace routing
// state, so every optional field must survive a write→read round trip. The
// duplicate-automations-host bug hid here once already: `workspaceModes` was
// written but the reader's explicit whitelist dropped it, so hydration restored
// every workspace as 'standard' and the executor's host-by-mode lookup missed.

const userDataDir = mkdtempSync(join(tmpdir(), 'routing-snapshot-'))
try {
  const store = createWorkspaceSyncRoutingSnapshotStore({
    resolveUserDataDir: () => userDataDir,
  })

  assert.equal(store.read(), null, 'a missing snapshot file reads as null')

  const snapshot: WorkspaceSyncRoutingSnapshot = {
    sequence: 42,
    primaryWorkspaceWindowId: 'primary',
    workspaceWindows: [
      {
        id: 'primary',
        kind: 'primary',
        workspaceIds: ['ws-host', 'ws-plain'],
        activeWorkspaceId: 'ws-plain',
        bounds: null,
        isMaximized: false,
        displayId: null,
        createdAt: 1,
        lastFocusedAt: 2,
      },
    ],
    workspaceNames: { 'ws-host': 'Automations', 'ws-plain': 'App' },
    workspaceFolderPaths: { 'ws-host': '/repo/app', 'ws-plain': '/repo/app' },
    workspaceModes: { 'ws-host': 'automations-host' },
  }
  store.write(snapshot)
  assert.deepEqual(
    store.read(),
    snapshot,
    'every field — including workspaceModes — survives the write→read round trip',
  )

  // Corrupt-map hygiene: junk entries are dropped, and an all-junk map reads
  // back as an absent field rather than an empty object.
  const raw = JSON.parse(readFileSync(join(userDataDir, 'workspace-sync-routing-snapshot.json'), 'utf8'))
  raw.workspaceModes = { 'ws-host': 7, 'ws-junk': '' }
  store.write(raw as WorkspaceSyncRoutingSnapshot)
  assert.equal(store.read()?.workspaceModes, undefined, 'an all-invalid modes map reads back as absent')

  console.log('workspace-sync-routing-snapshot.test.ts: ok')
} finally {
  rmSync(userDataDir, { recursive: true, force: true })
}
