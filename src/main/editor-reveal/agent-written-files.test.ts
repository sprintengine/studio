import assert from 'node:assert/strict'
import { test } from 'vitest'

import { createAgentWrittenFiles } from './agent-written-files'

test("what one chat's agent wrote is not another chat's agent's, though they share an id", () => {
  // Nearly every chat's first agent is `agent-1`; only the workspace tells them apart.
  const written = createAgentWrittenFiles()
  written.note('ws-1', 'agent-1', '/tmp/mine.patch')
  written.note('ws-2', 'agent-1', '/tmp/theirs.patch')
  assert.deepEqual([...written.pathsOf('ws-1', 'agent-1')], ['/tmp/mine.patch'])
  assert.deepEqual([...written.pathsOf('ws-2', 'agent-1')], ['/tmp/theirs.patch'])
  assert.deepEqual([...written.pathsOf('ws-3', 'agent-1')], [])
})

test('a write with no agent is not recorded', () => {
  const written = createAgentWrittenFiles()
  written.note('ws-1', undefined, '/tmp/a.patch')
  written.note('ws-1', '  ', '/tmp/a.patch')
  assert.deepEqual([...written.pathsOf('ws-1', '')], [])
})
