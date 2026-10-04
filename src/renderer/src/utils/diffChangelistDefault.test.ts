import assert from 'node:assert/strict'

import { changelistOwnerId, type Changelist } from '../../../shared/git/changelists'
import { defaultDiffChangelistId } from './diffChangelistDefault'
import { test } from 'vitest'

test('diffChangelistDefault', async () => {
  const NADIA = changelistOwnerId({ workspaceId: 'ws-a', agentId: 'nadia-1' })

  testPicksTheLastActiveAgentsList()
  testAnotherChatsAgentIsNotThisOnes()
  testMissingListMeansAllChanges()
  testNoAgentMeansAllChanges()
  testEmptyListsMeanAllChanges()

  console.log('diffChangelistDefault.test.ts: ok')

  function list(id: string, name: string): Changelist {
    return { id, name, paths: [], active: false }
  }

  function testPicksTheLastActiveAgentsList(): void {
    const id = defaultDiffChangelistId({ id: 'ws-a', lastActiveAgentId: 'nadia-1' }, [
      list('default', 'Changes'),
      list(NADIA, 'Nadia'),
    ])
    assert.equal(id, NADIA)
  }

  function testAnotherChatsAgentIsNotThisOnes(): void {
    // Two chats on one checkout, both with an `agent-1`: chat B's diff must not
    // open filtered to chat A's agent's files. Nor onto a list an older build
    // named after the agent alone, which may hold either chat's work.
    const lists = [
      list('default', 'Changes'),
      list(changelistOwnerId({ workspaceId: 'ws-a', agentId: 'agent-1' }), 'Nadia'),
      list('agent:agent-1', 'Ivo'),
    ]
    assert.equal(defaultDiffChangelistId({ id: 'ws-b', lastActiveAgentId: 'agent-1' }, lists), null)
  }

  function testMissingListMeansAllChanges(): void {
    // The agent exited with nothing uncommitted and reconcile deleted its list.
    // The memory of the agent outlives the list on purpose; the answer is "all
    // changes", never a filter onto a list that is not there.
    assert.equal(
      defaultDiffChangelistId({ id: 'ws-a', lastActiveAgentId: 'nadia-1' }, [list('default', 'Changes')]),
      null,
    )
  }

  function testNoAgentMeansAllChanges(): void {
    const lists = [list('default', 'Changes'), list(NADIA, 'Nadia')]
    assert.equal(defaultDiffChangelistId({ id: 'ws-a' }, lists), null)
    assert.equal(defaultDiffChangelistId({ id: 'ws-a', lastActiveAgentId: null }, lists), null)
    assert.equal(defaultDiffChangelistId({ id: 'ws-a', lastActiveAgentId: '   ' }, lists), null)
    assert.equal(defaultDiffChangelistId(null, lists), null)
  }

  function testEmptyListsMeanAllChanges(): void {
    // Before the first read there are no lists to check against, and guessing
    // would filter the viewer onto a list nobody has confirmed exists.
    assert.equal(defaultDiffChangelistId({ id: 'ws-a', lastActiveAgentId: 'nadia-1' }, []), null)
    assert.equal(defaultDiffChangelistId({ id: 'ws-a', lastActiveAgentId: 'nadia-1' }, null), null)
  }
})
