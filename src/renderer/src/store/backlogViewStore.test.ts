import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_BACKLOG_PROJECT_VIEW,
  selectBacklogProjectView,
  useBacklogViewStore,
} from './backlogViewStore'

function reset(): void {
  useBacklogViewStore.setState({ viewByProject: {} })
}

function read(folderPath: string | null | undefined) {
  return selectBacklogProjectView(useBacklogViewStore.getState(), folderPath)
}

test('an absent project reads the default presentation', () => {
  reset()
  assert.deepEqual(read('/Users/me/proj'), DEFAULT_BACKLOG_PROJECT_VIEW)
  assert.deepEqual(read(null), DEFAULT_BACKLOG_PROJECT_VIEW)
})

test('two workspaces on the same project share one record (live sync)', () => {
  reset()
  // Different path strings that normalize to the same project key: trailing
  // slash, backslashes, and case must all resolve to the same shared entry — the
  // whole point of project-scoped view state.
  useBacklogViewStore.getState().setProjectView('/Users/me/Proj/', { view: 'all' })
  assert.equal(read('/Users/me/proj').view, 'all')
  assert.equal(read('/Users/me/proj/').view, 'all')
  assert.equal(read('\\Users\\me\\Proj').view, 'all')
})

test('setProjectView merges a partial patch', () => {
  reset()
  const set = useBacklogViewStore.getState().setProjectView
  set('/p', { view: 'completed' })
  set('/p', { sort: 'priority' })
  assert.deepEqual(read('/p'), { view: 'completed', sort: 'priority', group: 'none' })
})

test('an unknown enum value coerces to the field default', () => {
  reset()
  // Simulate a corrupt persisted record.
  useBacklogViewStore.setState({
    viewByProject: { '/p': { view: 'bogus', sort: 'nope', group: 'x' } as never },
  })
  assert.deepEqual(read('/p'), DEFAULT_BACKLOG_PROJECT_VIEW)
})

test('a null/blank folder path is a no-op for setProjectView', () => {
  reset()
  useBacklogViewStore.getState().setProjectView(null, { view: 'all' })
  useBacklogViewStore.getState().setProjectView('', { view: 'all' })
  assert.deepEqual(useBacklogViewStore.getState().viewByProject, {})
})

test('seedProjectViewIfAbsent migrates a legacy record only when absent', () => {
  reset()
  const seed = useBacklogViewStore.getState().seedProjectViewIfAbsent
  // First mount seeds from the legacy per-workspace state.
  seed('/p', { view: 'all', sort: 'priority', group: 'by_epic', search: 'x', selectedRelativePath: null })
  assert.deepEqual(read('/p'), { view: 'all', sort: 'priority', group: 'by_epic' })
  // A later mount with a different legacy record must NOT overwrite the shared one.
  seed('/p', { view: 'completed', sort: 'recent', group: 'none' })
  assert.equal(read('/p').view, 'all')
})

test('seedProjectViewIfAbsent skips a pure-default seed to stay sparse', () => {
  reset()
  useBacklogViewStore
    .getState()
    .seedProjectViewIfAbsent('/p', { view: 'active', sort: 'recent', group: 'none' })
  assert.deepEqual(useBacklogViewStore.getState().viewByProject, {})
  // Absent record still reads as default.
  assert.deepEqual(read('/p'), DEFAULT_BACKLOG_PROJECT_VIEW)
})
