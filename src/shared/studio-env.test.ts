import assert from 'node:assert/strict'
import { readStudioEnv, studioEnvEntry, withoutStudioEnv } from './studio-env'
import { test } from 'vitest'

test('studio-env', () => {
  // Presence decides, not truthiness: an empty value comes back as-is so a
  // caller keeps its own emptiness rule.
  assert.equal(readStudioEnv('SPRINTENGINE_AGENT_ID', { SPRINTENGINE_AGENT_ID: 'a1' }), 'a1')
  assert.equal(readStudioEnv('SPRINTENGINE_AGENT_ID', { SPRINTENGINE_AGENT_ID: '' }), '')
  assert.equal(readStudioEnv('SPRINTENGINE_AGENT_ID', {}), undefined)

  assert.deepEqual(studioEnvEntry('SPRINTENGINE_AGENT_ID', 'a1'), { SPRINTENGINE_AGENT_ID: 'a1' })
  assert.deepEqual(studioEnvEntry('SPRINTENGINE_AGENT_ID', ''), { SPRINTENGINE_AGENT_ID: '' })
  assert.deepEqual(studioEnvEntry('SPRINTENGINE_AGENT_ID', null), {})
  assert.deepEqual(studioEnvEntry('SPRINTENGINE_AGENT_ID', undefined), {})

  const env = { PATH: '/bin', SPRINTENGINE_AGENT_ID: 'a1', SPRINTENGINE_WORKSPACE_ID: 'w1' }
  assert.deepEqual(withoutStudioEnv(env, ['SPRINTENGINE_AGENT_ID', 'SPRINTENGINE_WORKSPACE_ID']), { PATH: '/bin' })
  assert.equal(env.SPRINTENGINE_AGENT_ID, 'a1', 'the input record is not modified')
})
