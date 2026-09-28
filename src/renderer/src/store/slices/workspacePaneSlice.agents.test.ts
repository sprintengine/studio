import assert from 'node:assert/strict'
import { test } from 'vitest'
import { paneKindDefinition, STATIC_PANE_KINDS } from '../../components/workspace/pane/paneKinds'
import { normalizeWorkspacePaneState } from './workspacePaneSlice'

test('the Agents tab is a pane kind of its own, offered by the "+" menu on A', () => {
  const agents = STATIC_PANE_KINDS.find((definition) => definition.kind === 'agents')
  assert.ok(agents, 'offered with the other kinds')
  assert.equal(agents.label, 'Agents')
  assert.equal(agents.letter, 'A')
  assert.equal(agents.moduleId, undefined, 'a core kind, never switched off with a module')
  assert.equal(paneKindDefinition('agents').label, 'Agents')
  const letters = STATIC_PANE_KINDS.map((definition) => definition.letter)
  assert.equal(new Set(letters).size, letters.length, 'no two kinds share a letter')
})

test('a workspace keeps one Agents tab, and it survives a restart', () => {
  const normalized = normalizeWorkspacePaneState({
    open: true,
    activeTabId: 'second',
    tabs: [
      { id: 'first', kind: 'agents' },
      { id: 'second', kind: 'agents' },
    ],
  })
  assert.deepEqual(normalized?.tabs, [{ id: 'first', kind: 'agents' }])
})
