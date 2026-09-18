import assert from 'node:assert/strict'

import { consumePendingBacklogReveal, dispatchBacklogReveal } from './backlogReveal'

// Runs under node (no DOM): dispatch's window guard is a no-op, so these
// exercise the latch — the part that covers the cold-panel mount race.
function main(): void {
  // Drain-once: a pending reveal is read exactly once.
  dispatchBacklogReveal({ workspaceId: 'ws-1', relativePath: 'backlog/a.md' })
  assert.equal(consumePendingBacklogReveal('ws-1'), 'backlog/a.md')
  assert.equal(consumePendingBacklogReveal('ws-1'), null, 'second drain is empty')

  // Per-workspace isolation.
  dispatchBacklogReveal({ workspaceId: 'ws-1', relativePath: 'backlog/a.md' })
  assert.equal(consumePendingBacklogReveal('ws-2'), null, 'other workspaces are unaffected')
  assert.equal(consumePendingBacklogReveal('ws-1'), 'backlog/a.md')

  // Latest-wins: a second dispatch before draining supersedes the first.
  dispatchBacklogReveal({ workspaceId: 'ws-1', relativePath: 'backlog/a.md' })
  dispatchBacklogReveal({ workspaceId: 'ws-1', relativePath: 'backlog/b.md' })
  assert.equal(consumePendingBacklogReveal('ws-1'), 'backlog/b.md')

  console.log('backlogReveal.test.ts passed')
}

main()
