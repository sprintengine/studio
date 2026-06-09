import assert from 'node:assert/strict'
import {
  EMPTY_WORKSPACE_NAVIGATION_HISTORY,
  WORKSPACE_NAVIGATION_HISTORY_CAP,
  recordWorkspaceVisit,
  stepWorkspaceHistory,
  type WorkspaceNavigationHistory,
} from './workspaceNavigationHistory'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function visits(...workspaceIds: string[]): WorkspaceNavigationHistory {
  let history = EMPTY_WORKSPACE_NAVIGATION_HISTORY
  for (const workspaceId of workspaceIds) {
    history = recordWorkspaceVisit(history, workspaceId)
  }
  return history
}

const navigableAmong = (...ids: string[]) => {
  const set = new Set(ids)
  return (id: string) => set.has(id)
}

run('recordWorkspaceVisit appends visits and keeps the cursor at the tail', () => {
  const history = visits('a', 'b', 'c')
  assert.deepEqual(history.entries, ['a', 'b', 'c'])
  assert.equal(history.index, 2)
})

run('recordWorkspaceVisit ignores re-recording the entry at the cursor', () => {
  const history = visits('a', 'b')
  assert.equal(recordWorkspaceVisit(history, 'b'), history)
})

run('recordWorkspaceVisit allows non-consecutive repeat visits', () => {
  const history = visits('a', 'b', 'a')
  assert.deepEqual(history.entries, ['a', 'b', 'a'])
})

run('stepping back walks to the previously visited workspace', () => {
  const history = visits('a', 'b', 'c')
  const step = stepWorkspaceHistory(history, -1, navigableAmong('a', 'b', 'c'))
  assert.ok(step)
  assert.equal(step.workspaceId, 'b')
  assert.equal(step.history.index, 1)
})

run('stepping forward retraces a back step', () => {
  const history = visits('a', 'b', 'c')
  const back = stepWorkspaceHistory(history, -1, navigableAmong('a', 'b', 'c'))
  assert.ok(back)
  const forward = stepWorkspaceHistory(back.history, 1, navigableAmong('a', 'b', 'c'))
  assert.ok(forward)
  assert.equal(forward.workspaceId, 'c')
  assert.equal(forward.history.index, 2)
})

run('a fresh visit after going back truncates the forward branch', () => {
  const back = stepWorkspaceHistory(visits('a', 'b', 'c'), -1, navigableAmong('a', 'b', 'c'))
  assert.ok(back)
  // Visiting d from b: c's forward entry is discarded, browser-style.
  const history = recordWorkspaceVisit(back.history, 'd')
  assert.deepEqual(history.entries, ['a', 'b', 'd'])
  assert.equal(history.index, 2)
  assert.equal(stepWorkspaceHistory(history, 1, navigableAmong('a', 'b', 'c', 'd')), null)
})

run('back returns null at the start of history and leaves history unchanged', () => {
  const history = visits('a')
  assert.equal(stepWorkspaceHistory(history, -1, () => true), null)
  assert.equal(stepWorkspaceHistory(EMPTY_WORKSPACE_NAVIGATION_HISTORY, -1, () => true), null)
})

run('non-navigable entries (closed or re-routed workspaces) are skipped in one press', () => {
  const history = visits('a', 'b', 'c')
  // b closed: back from c lands directly on a.
  const step = stepWorkspaceHistory(history, -1, navigableAmong('a', 'c'))
  assert.ok(step)
  assert.equal(step.workspaceId, 'a')
  assert.equal(step.history.index, 0)
})

run('back returns null when skips would only land on the active workspace', () => {
  // [a, b, a] with b closed and a currently active: the caller's predicate
  // excludes the active id, so back has nowhere meaningful to go.
  const history = visits('a', 'b', 'a')
  assert.equal(stepWorkspaceHistory(history, -1, navigableAmong()), null)
})

run('history is bounded by the cap, dropping the oldest visits', () => {
  let history = EMPTY_WORKSPACE_NAVIGATION_HISTORY
  for (let i = 0; i < WORKSPACE_NAVIGATION_HISTORY_CAP + 10; i += 1) {
    history = recordWorkspaceVisit(history, `ws-${i}`)
  }
  assert.equal(history.entries.length, WORKSPACE_NAVIGATION_HISTORY_CAP)
  assert.equal(history.entries[0], 'ws-10')
  assert.equal(history.index, WORKSPACE_NAVIGATION_HISTORY_CAP - 1)
})

console.log('workspaceNavigationHistory.test.ts: ok')
