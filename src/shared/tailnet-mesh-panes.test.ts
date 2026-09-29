import assert from 'node:assert/strict'
import { test } from 'vitest'

import { canonicalMeshPaneComponent, isMeshConversationPane, MESH_CONVERSATION_COMPONENT } from './tailnet-mesh'

test('a remote conversation pane reads the same under its current and pre-rename layout names', () => {
  assert.equal(isMeshConversationPane(MESH_CONVERSATION_COMPONENT), true)
  assert.equal(isMeshConversationPane('fleet-conversation'), true)
  assert.equal(isMeshConversationPane('terminal'), false)
  assert.equal(isMeshConversationPane(undefined), false)
  assert.equal(canonicalMeshPaneComponent('fleet-conversation'), MESH_CONVERSATION_COMPONENT)
  assert.equal(canonicalMeshPaneComponent('agent'), 'agent')
})

test('a remote terminal pane saved by an earlier build is a stale tab, not a remote pane', () => {
  // Terminals no longer cross the tailnet, so neither name is recognised: the
  // layout renders such a tab as its unavailable surface and nothing reads it
  // as a pane on another machine.
  for (const component of ['mesh-terminal', 'fleet-terminal']) {
    assert.equal(isMeshConversationPane(component), false)
    assert.equal(canonicalMeshPaneComponent(component), component)
  }
})
