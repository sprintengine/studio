import assert from 'node:assert/strict'
import {
  EMPTY_WORKSPACE_NAVIGATION_HISTORY,
  WORKSPACE_NAVIGATION_HISTORY_CAP,
  recordNavigationVisit,
  stepNavigationHistory,
  type NavHistoryEntry,
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

const ws = (id: string): NavHistoryEntry => ({ kind: 'workspace', id })
const surf = (id: string): NavHistoryEntry => ({ kind: 'surface', id })

function visits(...workspaceIds: string[]): WorkspaceNavigationHistory {
  let history = EMPTY_WORKSPACE_NAVIGATION_HISTORY
  for (const workspaceId of workspaceIds) {
    history = recordNavigationVisit(history, ws(workspaceId))
  }
  return history
}

const navigableAmong = (...ids: string[]) => {
  const set = new Set(ids)
  return (entry: NavHistoryEntry) => set.has(entry.id)
}

run('recordNavigationVisit appends visits and keeps the cursor at the tail', () => {
  const history = visits('a', 'b', 'c')
  assert.deepEqual(history.entries, [ws('a'), ws('b'), ws('c')])
  assert.equal(history.index, 2)
})

run('recordNavigationVisit ignores re-recording the entry at the cursor', () => {
  const history = visits('a', 'b')
  assert.equal(recordNavigationVisit(history, ws('b')), history)
})

run('same id but different kind is a distinct entry (a door over its workspace)', () => {
  // Opening a door surface that happens to share an id string with the active
  // workspace must still record a new visit — kind is part of identity.
  const history = recordNavigationVisit(visits('a'), surf('a'))
  assert.deepEqual(history.entries, [ws('a'), surf('a')])
  assert.equal(history.index, 1)
})

run('recordNavigationVisit allows non-consecutive repeat visits', () => {
  const history = visits('a', 'b', 'a')
  assert.deepEqual(history.entries, [ws('a'), ws('b'), ws('a')])
})

run('stepping back walks to the previously visited location', () => {
  const history = visits('a', 'b', 'c')
  const step = stepNavigationHistory(history, -1, navigableAmong('a', 'b', 'c'))
  assert.ok(step)
  assert.deepEqual(step.entry, ws('b'))
  assert.equal(step.history.index, 1)
})

run('back from a door returns to the previously-visited door, not the workspace', () => {
  // workspace X, then door automations, then door roadmap: back lands on
  // automations (the previous door), matching the reported expectation.
  let history = visits('X')
  history = recordNavigationVisit(history, surf('automations'))
  history = recordNavigationVisit(history, surf('roadmap'))
  const step = stepNavigationHistory(history, -1, () => true)
  assert.ok(step)
  assert.deepEqual(step.entry, surf('automations'))
  assert.equal(step.history.index, 1)
})

run('stepping forward retraces a back step', () => {
  const history = visits('a', 'b', 'c')
  const back = stepNavigationHistory(history, -1, navigableAmong('a', 'b', 'c'))
  assert.ok(back)
  const forward = stepNavigationHistory(back.history, 1, navigableAmong('a', 'b', 'c'))
  assert.ok(forward)
  assert.deepEqual(forward.entry, ws('c'))
  assert.equal(forward.history.index, 2)
})

run('a fresh visit after going back truncates the forward branch', () => {
  const back = stepNavigationHistory(visits('a', 'b', 'c'), -1, navigableAmong('a', 'b', 'c'))
  assert.ok(back)
  // Visiting d from b: c's forward entry is discarded, browser-style.
  const history = recordNavigationVisit(back.history, ws('d'))
  assert.deepEqual(history.entries, [ws('a'), ws('b'), ws('d')])
  assert.equal(history.index, 2)
  assert.equal(stepNavigationHistory(history, 1, navigableAmong('a', 'b', 'c', 'd')), null)
})

run('back returns null at the start of history and leaves history unchanged', () => {
  const history = visits('a')
  assert.equal(stepNavigationHistory(history, -1, () => true), null)
  assert.equal(stepNavigationHistory(EMPTY_WORKSPACE_NAVIGATION_HISTORY, -1, () => true), null)
})

run('non-navigable entries (closed or re-routed workspaces, disabled doors) are skipped in one press', () => {
  const history = visits('a', 'b', 'c')
  // b closed: back from c lands directly on a.
  const step = stepNavigationHistory(history, -1, navigableAmong('a', 'c'))
  assert.ok(step)
  assert.deepEqual(step.entry, ws('a'))
  assert.equal(step.history.index, 0)
})

run('back returns null when skips would only land on the active location', () => {
  // [a, b, a] with b closed and a currently active: the caller's predicate
  // excludes the active id, so back has nowhere meaningful to go.
  const history = visits('a', 'b', 'a')
  assert.equal(stepNavigationHistory(history, -1, navigableAmong()), null)
})

run('history is bounded by the cap, dropping the oldest visits', () => {
  let history = EMPTY_WORKSPACE_NAVIGATION_HISTORY
  for (let i = 0; i < WORKSPACE_NAVIGATION_HISTORY_CAP + 10; i += 1) {
    history = recordNavigationVisit(history, ws(`ws-${i}`))
  }
  assert.equal(history.entries.length, WORKSPACE_NAVIGATION_HISTORY_CAP)
  assert.deepEqual(history.entries[0], ws('ws-10'))
  assert.equal(history.index, WORKSPACE_NAVIGATION_HISTORY_CAP - 1)
})

console.log('workspaceNavigationHistory.test.ts: ok')
