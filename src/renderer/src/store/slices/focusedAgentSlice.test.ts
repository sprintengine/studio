import assert from 'node:assert/strict'

import { createFocusedAgentSlice, resolveFocusedAgentId, type FocusFallbackSession } from './focusedAgentSlice'

// The focused agent (sidebar-lists-every-terminal): written on selection,
// never cleared on blur, forgotten only when the agent is gone. DOM-free.

function harness() {
  const carrier = { focusedAgentByWorkspaceId: {} as Record<string, string> }
  let writes = 0
  const slice = createFocusedAgentSlice((mutator) => {
    const before = JSON.stringify(carrier.focusedAgentByWorkspaceId)
    mutator(carrier)
    if (JSON.stringify(carrier.focusedAgentByWorkspaceId) !== before) writes += 1
  })
  return { carrier, slice, writes: () => writes }
}

// Selecting a tab focuses its agent; selecting it again changes nothing.
{
  const h = harness()
  h.slice.setFocusedAgent('ws', 'a1')
  assert.equal(h.carrier.focusedAgentByWorkspaceId.ws, 'a1')
  h.slice.setFocusedAgent('ws', 'a1')
  assert.equal(h.writes(), 1, 'the same agent again is a no-op write')
  h.slice.setFocusedAgent('ws', 'a2')
  assert.equal(h.carrier.focusedAgentByWorkspaceId.ws, 'a2')
  assert.equal(h.writes(), 2)
}

// Forgetting is scoped: only the agent named, only when it is the focused one.
{
  const h = harness()
  h.slice.setFocusedAgent('ws', 'a1')
  h.slice.setFocusedAgent('other', 'b1')
  h.slice.forgetFocusedAgent('ws', 'a9')
  assert.equal(h.carrier.focusedAgentByWorkspaceId.ws, 'a1', 'a different agent leaves the focus alone')
  h.slice.forgetFocusedAgent('ws', 'a1')
  assert.equal('ws' in h.carrier.focusedAgentByWorkspaceId, false)
  assert.equal(h.carrier.focusedAgentByWorkspaceId.other, 'b1', 'another workspace is untouched')
}

const session = (over: Partial<FocusFallbackSession>): FocusFallbackSession => ({
  agentId: 'a1',
  workspaceId: 'ws',
  kind: 'agent',
  processAlive: true,
  suspended: false,
  lastInputAt: null,
  lastOutputAt: null,
  ...over,
});

// The last focused agent wins while it still exists — even with its tab
// closed and its session gone.
{
  assert.equal(resolveFocusedAgentId('ws', 'a1', ['a1', 'a2'], []), 'a1')
  assert.equal(resolveFocusedAgentId('ws', 'a1', new Set(['a1']), [session({ agentId: 'a2', lastOutputAt: 99 })]), 'a1')
}

// A removed agent falls back to the live agent that did something most recently.
{
  const sessions = [
    session({ agentId: 'a2', lastOutputAt: 50 }),
    session({ agentId: 'a3', lastInputAt: 80, lastOutputAt: 10 }),
  ]
  assert.equal(resolveFocusedAgentId('ws', 'gone', ['a2', 'a3'], sessions), 'a3')
  assert.equal(resolveFocusedAgentId('ws', undefined, ['a2', 'a3'], sessions), 'a3', 'never focused: the same fallback')
}

// Dead, suspended, foreign-workspace and plain-shell sessions never win; a
// session whose agent the workspace no longer lists is ignored too.
{
  const sessions = [
    session({ agentId: 'a2', lastOutputAt: 900, processAlive: false }),
    session({ agentId: 'a3', lastOutputAt: 800, suspended: true }),
    session({ agentId: 'a4', lastOutputAt: 700, workspaceId: 'elsewhere' }),
    session({ agentId: 'a5', lastOutputAt: 600, kind: 'terminal' }),
    session({ agentId: 'a6', lastOutputAt: 500 }),
    session({ agentId: 'a7', lastOutputAt: 100 }),
  ]
  assert.equal(resolveFocusedAgentId('ws', undefined, ['a2', 'a3', 'a4', 'a5', 'a7'], sessions), 'a7')
  assert.equal(resolveFocusedAgentId('ws', undefined, ['a2', 'a3'], sessions), null, 'nothing live: none')
}

console.log('focusedAgentSlice: ok')
