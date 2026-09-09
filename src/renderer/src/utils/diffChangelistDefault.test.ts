import assert from 'node:assert/strict'

import type { Changelist } from '../../../shared/git/changelists'
import { defaultDiffChangelistId } from './diffChangelistDefault'

testPicksTheLastActiveAgentsList()
testMissingListMeansAllChanges()
testNoAgentMeansAllChanges()
testEmptyListsMeanAllChanges()

console.log('diffChangelistDefault.test.ts: ok')

function list(id: string, name: string): Changelist {
  return { id, name, paths: [], active: false }
}

function testPicksTheLastActiveAgentsList(): void {
  const id = defaultDiffChangelistId({ lastActiveAgentId: 'nadia-1' }, [
    list('default', 'Changes'),
    list('agent:nadia-1', 'Nadia'),
  ])
  assert.equal(id, 'agent:nadia-1')
}

function testMissingListMeansAllChanges(): void {
  // The agent exited with nothing uncommitted and reconcile deleted its list.
  // The memory of the agent outlives the list on purpose; the answer is "all
  // changes", never a filter onto a list that is not there.
  assert.equal(defaultDiffChangelistId({ lastActiveAgentId: 'nadia-1' }, [list('default', 'Changes')]), null)
}

function testNoAgentMeansAllChanges(): void {
  const lists = [list('default', 'Changes'), list('agent:nadia-1', 'Nadia')]
  assert.equal(defaultDiffChangelistId({}, lists), null)
  assert.equal(defaultDiffChangelistId({ lastActiveAgentId: null }, lists), null)
  assert.equal(defaultDiffChangelistId({ lastActiveAgentId: '   ' }, lists), null)
  assert.equal(defaultDiffChangelistId(null, lists), null)
}

function testEmptyListsMeanAllChanges(): void {
  // Before the first read there are no lists to check against, and guessing
  // would filter the viewer onto a list nobody has confirmed exists.
  assert.equal(defaultDiffChangelistId({ lastActiveAgentId: 'nadia-1' }, []), null)
  assert.equal(defaultDiffChangelistId({ lastActiveAgentId: 'nadia-1' }, null), null)
}
