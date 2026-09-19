import assert from 'node:assert/strict'

import { consumePendingFileReveal, dispatchFileReveal } from './fileReveal'
import { test } from 'vitest'

test('fileReveal', async () => {
  // Runs under node (no DOM): dispatch's window guard is a no-op, so these
  // exercise the latch — the part that covers the cold-panel mount race.
  function main(): void {
    // Drain-once: a pending reveal is read exactly once.
    dispatchFileReveal({ workspaceId: 'ws-1', path: '/repo/src/a.ts' })
    assert.equal(consumePendingFileReveal('ws-1'), '/repo/src/a.ts')
    assert.equal(consumePendingFileReveal('ws-1'), null, 'second drain is empty')

    // Per-workspace isolation.
    dispatchFileReveal({ workspaceId: 'ws-1', path: '/repo/src/a.ts' })
    assert.equal(consumePendingFileReveal('ws-2'), null, 'other workspaces are unaffected')
    assert.equal(consumePendingFileReveal('ws-1'), '/repo/src/a.ts')

    // Latest-wins: a second dispatch before draining supersedes the first.
    dispatchFileReveal({ workspaceId: 'ws-1', path: '/repo/src/a.ts' })
    dispatchFileReveal({ workspaceId: 'ws-1', path: '/repo/src/b.ts' })
    assert.equal(consumePendingFileReveal('ws-1'), '/repo/src/b.ts')

    console.log('fileReveal.test.ts passed')
  }

  main()
})
