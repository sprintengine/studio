import assert from 'node:assert/strict'

import {
  AUTOMATIONS_DOOR_TARGET_KIND,
  RUN_TARGET_KIND,
  automationsDoorTarget,
  decodeAutomationTargetRef,
  encodeRunRef,
} from './runTarget'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

run('door target carries the run ref under the door kind', () => {
  const target = automationsDoorTarget('auto-1', 'run-9', '/repo/project')
  assert.equal(target.kind, AUTOMATIONS_DOOR_TARGET_KIND)
  assert.deepEqual(decodeAutomationTargetRef(target), {
    automationId: 'auto-1',
    runId: 'run-9',
    folderPath: '/repo/project',
  })
})

run('decode accepts the legacy run kind (reveal path stays working)', () => {
  const legacy = { kind: RUN_TARGET_KIND, ref: encodeRunRef('auto-2', 'run-3', null) }
  assert.deepEqual(decodeAutomationTargetRef(legacy), {
    automationId: 'auto-2',
    runId: 'run-3',
    folderPath: null,
  })
})

run('decode rejects foreign kinds and malformed refs', () => {
  assert.equal(decodeAutomationTargetRef({ kind: 'task', ref: encodeRunRef('a', 'b', null) }), null)
  assert.equal(decodeAutomationTargetRef({ kind: AUTOMATIONS_DOOR_TARGET_KIND, ref: 'not json' }), null)
  assert.equal(decodeAutomationTargetRef(null), null)
  assert.equal(decodeAutomationTargetRef({ kind: RUN_TARGET_KIND }), null)
})
