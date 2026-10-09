import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspacePaneState } from '../../../../types/workspace'
import {
  AGENT_DRIVING_GRACE_MS,
  AGENT_SESSION_QUIET_MS,
  createAgentBrowserTracker,
  shouldFloatAgentOpen,
  shouldFloatForAgent,
} from './agentBrowserFloat'

// When the floating player comes up by itself for an agent, and when a Close
// keeps it down.

const closedPane = (overrides: Partial<WorkspacePaneState> = {}): WorkspacePaneState => ({
  open: false,
  activeTabId: 'page',
  tabs: [
    { id: 'page', kind: 'browser', url: 'http://localhost:5173/' },
    { id: 'term', kind: 'terminal', terminalId: 'term-1' },
  ],
  ...overrides,
})

test('the agent taking a page is reported once, not on every report while it holds it', () => {
  const tracker = createAgentBrowserTracker()
  assert.equal(tracker.observe('page', 'none', 0), false)
  assert.equal(tracker.observe('page', 'agent', 10), true)
  assert.equal(tracker.observe('page', 'agent', 20), false)
  assert.equal(tracker.observe('page', 'none', 1_500), false)
  assert.equal(tracker.observe('page', 'agent', 5_000), true, 'its next step takes the page again')
})

test('the agent taking a page from the person counts as taking it', () => {
  const tracker = createAgentBrowserTracker()
  tracker.observe('page', 'human', 0)
  assert.equal(tracker.observe('page', 'agent', 10), true)
})

test('a Close holds across the pauses between an agent session’s steps', () => {
  const tracker = createAgentBrowserTracker()
  tracker.observe('page', 'agent', 0)
  tracker.observe('page', 'none', 1_500)
  tracker.dismiss('page', 2_000)
  // The claim lapses after every step; that is not the session ending.
  tracker.observe('page', 'agent', 30_000)
  assert.equal(tracker.isSuppressed('page', 30_000), true)
  tracker.observe('page', 'none', 31_500)
  tracker.observe('page', 'agent', 31_500 + AGENT_SESSION_QUIET_MS - 1)
  assert.equal(tracker.isSuppressed('page', 31_500 + AGENT_SESSION_QUIET_MS - 1), true)
})

test('a Close is forgotten once the agent has left the page alone for a quiet minute', () => {
  const tracker = createAgentBrowserTracker()
  tracker.observe('page', 'agent', 0)
  tracker.observe('page', 'none', 1_500)
  tracker.dismiss('page', 2_000)
  const later = 2_000 + AGENT_SESSION_QUIET_MS + 1
  assert.equal(tracker.observe('page', 'agent', later), true)
  assert.equal(tracker.isSuppressed('page', later), false)
})

test('a Close on a player nobody was driving still holds for the agent that starts next', () => {
  const tracker = createAgentBrowserTracker()
  tracker.dismiss('page', 0)
  tracker.observe('page', 'agent', 5_000)
  assert.equal(tracker.isSuppressed('page', 5_000), true)
})

test('a Close on one tab does not hold another', () => {
  const tracker = createAgentBrowserTracker()
  tracker.dismiss('page', 0)
  assert.equal(tracker.isSuppressed('other', 0), false)
})

test('a page counts as driven while the agent holds it and for a moment after', () => {
  const tracker = createAgentBrowserTracker()
  assert.equal(tracker.isDriving('page', 0), false)
  tracker.observe('page', 'agent', 0)
  assert.equal(tracker.isDriving('page', 60_000), true, 'held is driven, however long')
  tracker.observe('page', 'none', 60_000)
  assert.equal(tracker.isDriving('page', 60_000 + AGENT_DRIVING_GRACE_MS), true)
  assert.equal(tracker.isDriving('page', 60_000 + AGENT_DRIVING_GRACE_MS + 1), false)
})

test('an agent taking a page in a closed pane floats it', () => {
  assert.equal(shouldFloatForAgent(closedPane(), 'page'), true)
})

test('an open pane is left as it is', () => {
  assert.equal(shouldFloatForAgent(closedPane({ open: true }), 'page'), false)
})

test('nothing floats over a player already up', () => {
  const pane = closedPane()
  pane.tabs.push({ id: 'other', kind: 'browser', floating: true })
  assert.equal(shouldFloatForAgent(pane, 'page'), false)
})

test('a tab out in a window of its own, or not a browser, never floats', () => {
  const popped = closedPane()
  popped.tabs[0] = { ...popped.tabs[0]!, poppedOut: 'pop-1' }
  assert.equal(shouldFloatForAgent(popped, 'page'), false)
  assert.equal(shouldFloatForAgent(closedPane(), 'term'), false)
  assert.equal(shouldFloatForAgent(closedPane(), 'missing'), false)
  assert.equal(shouldFloatForAgent(undefined, 'page'), false)
})

test('an agent opening a page floats it only into a closed pane, and only with the setting on', () => {
  assert.equal(shouldFloatAgentOpen(closedPane(), true), true)
  assert.equal(shouldFloatAgentOpen(undefined, true), true, 'a workspace that never had a pane has it closed')
  assert.equal(shouldFloatAgentOpen(closedPane({ open: true }), true), false)
  assert.equal(shouldFloatAgentOpen(closedPane(), false), false)
})
