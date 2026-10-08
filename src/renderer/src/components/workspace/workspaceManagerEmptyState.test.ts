import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

import { showsNoWorkspaceState } from './workspaceManagerHelpers'

test('an empty window shows "No workspace open" with its New chat button', () => {
  assert.equal(
    showsNoWorkspaceState({ railWorkspaceCount: 0, hasActiveWorkspace: false, newChatPanelOpen: false }),
    true,
  )
})

test('the New chat panel open over an empty window hides the state under it', () => {
  // Drawn under the panel, its button was a Tab stop nobody could see and its
  // title was read aloud over the panel the person was using.
  assert.equal(
    showsNoWorkspaceState({ railWorkspaceCount: 0, hasActiveWorkspace: false, newChatPanelOpen: true }),
    false,
  )
})

test('a window with a workspace never shows it', () => {
  assert.equal(
    showsNoWorkspaceState({ railWorkspaceCount: 1, hasActiveWorkspace: false, newChatPanelOpen: false }),
    false,
  )
  assert.equal(
    showsNoWorkspaceState({ railWorkspaceCount: 0, hasActiveWorkspace: true, newChatPanelOpen: false }),
    false,
  )
})

test('the canvas asks the predicate, with the panel state, before drawing the empty state', () => {
  const source = readFileSync(join(__dirname, 'WorkspaceManager.tsx'), 'utf8')
  assert.match(source, /showsNoWorkspaceState\(\{[^}]*newChatPanelOpen: newChatPanelState !== null/su)
  assert.doesNotMatch(source, /railWorkspaces\.length === 0 && !activeWorkspace && \(/u)
})
