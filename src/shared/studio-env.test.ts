import assert from 'node:assert/strict'
import {
  compatStudioEnvEntry,
  legacyEnvName,
  readStudioEnv,
  studioEnvEntry,
  studioEnvNames,
  withoutStudioEnv,
} from './studio-env'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

run('a plain variable maps back to its MULTICODE_ spelling', () => {
  assert.equal(legacyEnvName('SPRINTENGINE_AGENT_ID'), 'MULTICODE_AGENT_ID')
  assert.equal(legacyEnvName('SPRINTENGINE_AGENT_STATE_SOCKET'), 'MULTICODE_AGENT_STATE_SOCKET')
  assert.equal(legacyEnvName('SPRINTENGINE_USER_DATA_DIR'), 'MULTICODE_USER_DATA_DIR')
})

// The suffix already said SPRINTENGINE on these, so the swap drops the repeat
// instead of stuttering it. That is what makes the mapping untabulated in one
// direction and is the whole reason the overrides exist.
run('a variable whose suffix already said SPRINTENGINE keeps its old full name', () => {
  assert.equal(legacyEnvName('SPRINTENGINE_TOOL_PATH'), 'MULTICODE_SPRINTENGINE_TOOL_PATH')
  assert.equal(legacyEnvName('SPRINTENGINE_MCP_RUN_ID'), 'MULTICODE_SPRINTENGINE_MCP_RUN_ID')
  assert.equal(legacyEnvName('SPRINTENGINE_DISABLE_SYNC'), 'MULTICODE_DISABLE_SPRINTENGINE_SYNC')
  assert.equal(legacyEnvName('SPRINTENGINE_DISABLE_AUTORUN'), 'MULTICODE_DISABLE_SPRINTENGINE_AUTORUN')
  assert.equal(legacyEnvName('SPRINTENGINE_DISABLE_TERMINALS'), 'MULTICODE_DISABLE_SPRINTENGINE_TERMINALS')
})

run('a variable that is not ours has no legacy spelling', () => {
  for (const name of ['PATH', 'HOME', 'CLAUDE_CODE_ENTRYPOINT', 'MULTICODE_AGENT_ID']) {
    assert.equal(legacyEnvName(name), null, `${name} must not be rewritten`)
  }
})

run('the read order is new name first, legacy second', () => {
  assert.deepEqual(studioEnvNames('SPRINTENGINE_AGENT_ID'), ['SPRINTENGINE_AGENT_ID', 'MULTICODE_AGENT_ID'])
  assert.deepEqual(studioEnvNames('PATH'), ['PATH'])
})

run('the new name wins when both are set', () => {
  const env = { SPRINTENGINE_AGENT_ID: 'new', MULTICODE_AGENT_ID: 'old' }
  assert.equal(readStudioEnv('SPRINTENGINE_AGENT_ID', env), 'new')
})

// The fallback is the whole point: an agent launched by a build from before the
// sweep, or a shell a person exported the old name into, still reads.
run('the legacy name is read when the new one is absent', () => {
  assert.equal(readStudioEnv('SPRINTENGINE_AGENT_ID', { MULTICODE_AGENT_ID: 'old' }), 'old')
  assert.equal(readStudioEnv('SPRINTENGINE_TOOL_PATH', { MULTICODE_SPRINTENGINE_TOOL_PATH: '/t' }), '/t')
  assert.equal(readStudioEnv('SPRINTENGINE_DISABLE_SYNC', { MULTICODE_DISABLE_SPRINTENGINE_SYNC: '1' }), '1')
})

run('an unset variable reads as undefined under either name', () => {
  assert.equal(readStudioEnv('SPRINTENGINE_AGENT_ID', {}), undefined)
  assert.equal(readStudioEnv('SPRINTENGINE_AGENT_ID', { SPRINTENGINE_OTHER: 'x' }), undefined)
})

// Presence decides, not truthiness. A launcher clears identity by setting the
// new name to empty; if emptiness fell through, a stale MULTICODE_AGENT_ID
// inherited from the shell that started the app would be read as this session's
// agent — which is the leak the clearing was written to prevent.
run('an empty new name masks a legacy value rather than falling through', () => {
  assert.equal(readStudioEnv('SPRINTENGINE_AGENT_ID', { SPRINTENGINE_AGENT_ID: '', MULTICODE_AGENT_ID: 'stale' }), '')
})

run('a variable the app owns both ends of is written under one name', () => {
  assert.deepEqual(studioEnvEntry('SPRINTENGINE_WORKSPACE_ID', 'ws-1'), { SPRINTENGINE_WORKSPACE_ID: 'ws-1' })
  assert.deepEqual(studioEnvEntry('SPRINTENGINE_WORKSPACE_ID', null), {})
  assert.deepEqual(studioEnvEntry('SPRINTENGINE_WORKSPACE_ID', undefined), {})
  // Empty is a value, not an absence: clearing is done by writing one.
  assert.deepEqual(studioEnvEntry('SPRINTENGINE_WORKSPACE_ID', ''), { SPRINTENGINE_WORKSPACE_ID: '' })
})

// Hook copies already on people's disks read the old name and are not ours to
// update, so anything injected for them carries both spellings of the value.
run('a variable read by an installed hook copy is written under both names', () => {
  assert.deepEqual(compatStudioEnvEntry('SPRINTENGINE_AGENT_ID', 'agent-1'), {
    SPRINTENGINE_AGENT_ID: 'agent-1',
    MULTICODE_AGENT_ID: 'agent-1',
  })
  assert.deepEqual(compatStudioEnvEntry('SPRINTENGINE_AGENT_ID', null), {})
})

run('stripping a variable removes both of its spellings', () => {
  const stripped = withoutStudioEnv(
    { PATH: '/bin', SPRINTENGINE_AGENT_ID: 'new', MULTICODE_AGENT_ID: 'old', MULTICODE_WORKSPACE_ID: 'ws' },
    ['SPRINTENGINE_AGENT_ID', 'SPRINTENGINE_WORKSPACE_ID'],
  )
  assert.deepEqual(stripped, { PATH: '/bin' })
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('studio-env.test.ts: ok')
}

main()
