import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  canonicalMeshPaneComponent,
  MESH_CONVERSATION_COMPONENT,
  MESH_TERMINAL_COMPONENT,
  meshPaneKind,
} from './tailnet-mesh'

test('remote panes read the same under their current and pre-rename layout names', () => {
  assert.equal(meshPaneKind(MESH_TERMINAL_COMPONENT), 'terminal')
  assert.equal(meshPaneKind('fleet-terminal'), 'terminal')
  assert.equal(meshPaneKind(MESH_CONVERSATION_COMPONENT), 'conversation')
  assert.equal(meshPaneKind('fleet-conversation'), 'conversation')
  assert.equal(meshPaneKind('terminal'), null)
  assert.equal(meshPaneKind(undefined), null)
  assert.equal(canonicalMeshPaneComponent('fleet-terminal'), MESH_TERMINAL_COMPONENT)
  assert.equal(canonicalMeshPaneComponent('fleet-conversation'), MESH_CONVERSATION_COMPONENT)
  assert.equal(canonicalMeshPaneComponent('agent'), 'agent')
})
