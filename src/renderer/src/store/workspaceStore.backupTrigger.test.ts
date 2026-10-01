import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { Workspace } from '../types/workspace'

// Main serializes its whole registry for every backup a window asks for, so a
// window asks only when its workspace list changed in something worth
// recovering, and never for the keystroke clock alone.

const { workspacesChangedForBackup } = await import('./workspaceStore')

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return { id: 'ws-1', name: 'Chat', folderPath: '/Users/dev/app', createdAt: 1, ...overrides } as Workspace
}

test('the keystroke clock alone does not ask for a backup', () => {
  const before = [workspace({ lastTerminalActivityAt: 1_000 }), workspace({ id: 'ws-2' })]
  const after = [{ ...before[0]!, lastTerminalActivityAt: 2_000 }, before[1]!]
  assert.equal(workspacesChangedForBackup(before, after), false)
})

test('any other change to a workspace, or to the list, does', () => {
  const before = [workspace({ lastTerminalActivityAt: 1_000 })]
  assert.equal(workspacesChangedForBackup(before, [{ ...before[0]!, name: 'Renamed' }]), true)
  assert.equal(
    workspacesChangedForBackup(before, [{ ...before[0]!, lastTerminalActivityAt: 2_000, snoozedUntil: 5_000 }]),
    true,
    'a clock riding along with a real change still counts',
  )
  const { folderPath: _dropped, ...withoutFolder } = before[0]!
  assert.equal(workspacesChangedForBackup(before, [withoutFolder as Workspace]), true, 'a field removed')
  assert.equal(workspacesChangedForBackup(before, [...before, workspace({ id: 'ws-2' })]), true, 'a workspace added')
  assert.equal(workspacesChangedForBackup(before, [workspace({ id: 'ws-2' })]), true, 'a workspace replaced')
})
