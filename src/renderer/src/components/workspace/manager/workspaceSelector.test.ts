import assert from 'node:assert/strict'
import { beforeEach, test } from 'vitest'

import type { Workspace } from '../../../types/workspace'
import {
  layoutFleetSignature,
  selectWorkspaceManagerWorkspaces,
  workspaceManagerWorkspaceCache,
} from './workspaceSelector'

function layoutWith(tabs: object[]): Workspace['layoutModel'] {
  return {
    global: {},
    borders: [],
    layout: { type: 'row', children: [{ type: 'tabset', weight: 100, children: tabs }] },
  } as unknown as Workspace['layoutModel']
}

const agentTab = { type: 'tab', id: 'tab-agent', component: 'agent', config: { agentId: 'agent-1' } }
const fleetTab = {
  type: 'tab',
  id: 'tab-fleet',
  component: 'fleet-terminal',
  config: { machineName: 'mac-mini', connectionId: 'conn-1', remoteSessionId: 'remote-1' },
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Chat',
    mode: 'standard',
    folderPath: '/Users/dev/app',
    agents: {},
    createdAt: 1_000,
    layoutModel: layoutWith([agentTab]),
    ...overrides,
  } as Workspace
}

beforeEach(() => {
  workspaceManagerWorkspaceCache.clear()
})

test('a layout change that leaves the fleet panes alone hands back the cached workspace', () => {
  const first = workspace()
  const [projected] = selectWorkspaceManagerWorkspaces([first])
  // A tab click writes a new layout object with the same structure.
  const clicked = { ...first, layoutModel: layoutWith([{ ...agentTab, name: 'renamed' }]) }
  const [again] = selectWorkspaceManagerWorkspaces([clicked])
  assert.equal(again, projected, 'the manager does not re-render for a layout write')
})

test('opening or closing a fleet pane moves the projection', () => {
  const first = workspace()
  const [projected] = selectWorkspaceManagerWorkspaces([first])
  const withFleet = { ...first, layoutModel: layoutWith([agentTab, fleetTab]) }
  const [again] = selectWorkspaceManagerWorkspaces([withFleet])
  assert.notEqual(again, projected, 'the sidebar draws fleet panes, so it has to see this')
  assert.equal(again, withFleet)
})

test('keystrokes in a chat that has been messaged do not move the projection', () => {
  const first = workspace({ lastUserMessageAt: 5_000, lastTerminalActivityAt: 6_000 })
  const [projected] = selectWorkspaceManagerWorkspaces([first])
  const [again] = selectWorkspaceManagerWorkspaces([{ ...first, lastTerminalActivityAt: 7_000 }])
  assert.equal(again, projected, 'the keystroke clock is not this row’s ordering key')
})

test('keystrokes in a chat that has never been messaged still reorder it', () => {
  // With no message clock, the keystroke clock IS the ordering key's fallback.
  const first = workspace({ lastTerminalActivityAt: 6_000 })
  const [projected] = selectWorkspaceManagerWorkspaces([first])
  const [again] = selectWorkspaceManagerWorkspaces([{ ...first, lastTerminalActivityAt: 7_000 }])
  assert.notEqual(again, projected)
})

test('the fleet signature is computed once per layout object', () => {
  const layout = layoutWith([agentTab, fleetTab])
  const signature = layoutFleetSignature({ layoutModel: layout })
  assert.equal(layoutFleetSignature({ layoutModel: layout }), signature)
  assert.equal(layoutFleetSignature({ layoutModel: layoutWith([agentTab]) }), '')
  assert.notEqual(signature, '')
})

// Every Workspace field the manager, the sidebar or its row reads off this
// projection, each given a new value. A field missing from the equality hands
// back the cached workspace, and the row keeps drawing the old value until
// something unrelated moves: Snooze and Wake did exactly that.
const RENDERED_FIELD_CHANGES: { [K in keyof Workspace]?: Workspace[K] } = {
  name: 'Renamed',
  mode: 'automations-host',
  folderPath: '/Users/dev/other',
  folderMissing: true,
  remoteOrigin: {
    connectionId: 'conn-1',
    machineName: 'mac-mini',
    workspaceId: 'remote-ws',
    workspaceName: 'Remote chat',
  } as Workspace['remoteOrigin'],
  hostId: 'wsl:Ubuntu',
  worktree: { branch: 'feature/row' },
  templateId: 'template-2',
  layoutModel: layoutWith([agentTab, fleetTab]),
  worktreeState: {} as Workspace['worktreeState'],
  memory: {} as Workspace['memory'],
  editorState: {} as Workspace['editorState'],
  fileExplorerState: {} as Workspace['fileExplorerState'],
  moduleState: {} as Workspace['moduleState'],
  highlight: { starred: true, color: null },
  createdAt: 2_000,
  lastUserMessageAt: 9_000,
  lastTurnEndedAt: 9_000,
  settledAt: 9_000,
  settledOverride: 'active',
  snoozedUntil: 9_000,
  paneState: {} as Workspace['paneState'],
}

for (const [field, value] of Object.entries(RENDERED_FIELD_CHANGES)) {
  test(`a change to ${field} moves the projection`, () => {
    const first = workspace()
    const [projected] = selectWorkspaceManagerWorkspaces([first])
    const changed = { ...first, [field]: value } as Workspace
    const [again] = selectWorkspaceManagerWorkspaces([changed])
    assert.notEqual(again, projected, `the sidebar reads ${field}, so it has to see the change`)
    assert.equal(again, changed)
  })
}
