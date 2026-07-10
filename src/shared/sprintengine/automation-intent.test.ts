import assert from 'node:assert/strict'
import {
  SPRINT_ENGINE_AUTOMATION_INTENT_SCHEMA_VERSION,
  nextSprintEngineAutomationIntentRecord,
  parseSprintEngineAutomationIntentRecord,
  serializeSprintEngineAutomationIntentRecord,
} from './automation-intent'

// parse: well-formed record round-trips through serialize
{
  const record = nextSprintEngineAutomationIntentRecord({
    current: null,
    mode: 'run_agents',
    actor: 'ui',
    now: 1_789_000_000_000,
  })
  assert.equal(record.schemaVersion, SPRINT_ENGINE_AUTOMATION_INTENT_SCHEMA_VERSION)
  assert.equal(record.revision, 1)
  assert.equal(record.desiredMode, 'run_agents')
  assert.equal(record.changedAt, 1_789_000_000_000)
  assert.equal(record.lastWrite.actor, 'ui')
  assert.equal(record.lastWrite.deviceId, null)
  assert.equal(record.lastWrite.at, new Date(1_789_000_000_000).toISOString())

  const parsed = parseSprintEngineAutomationIntentRecord(
    JSON.parse(serializeSprintEngineAutomationIntentRecord(record))
  )
  assert.deepEqual(parsed, record)
}

// next: revision increments from the current record; provenance replaced
{
  const first = nextSprintEngineAutomationIntentRecord({
    current: null,
    mode: 'run_agents',
    actor: 'ui',
    now: 1000,
  })
  const second = nextSprintEngineAutomationIntentRecord({
    current: first,
    mode: 'manual',
    actor: 'mobile',
    deviceId: 'device-7',
    now: 2000,
  })
  assert.equal(second.revision, 2)
  assert.equal(second.desiredMode, 'manual')
  assert.equal(second.lastWrite.actor, 'mobile')
  assert.equal(second.lastWrite.deviceId, 'device-7')
}

// parse: rejects non-records, wrong schema, bad mode, bad revision
{
  assert.equal(parseSprintEngineAutomationIntentRecord(null), null)
  assert.equal(parseSprintEngineAutomationIntentRecord([]), null)
  assert.equal(parseSprintEngineAutomationIntentRecord('run_agents'), null)
  assert.equal(
    parseSprintEngineAutomationIntentRecord({ schemaVersion: 2, revision: 1, desiredMode: 'manual' }),
    null,
    'a future-schema record is treated as absent, never guessed at'
  )
  assert.equal(
    parseSprintEngineAutomationIntentRecord({ schemaVersion: 1, revision: 1, desiredMode: 'sprint' }),
    null
  )
  assert.equal(
    parseSprintEngineAutomationIntentRecord({ schemaVersion: 1, revision: 0, desiredMode: 'manual' }),
    null
  )
  assert.equal(
    parseSprintEngineAutomationIntentRecord({ schemaVersion: 1, revision: 1.5, desiredMode: 'manual' }),
    null
  )
}

// parse: tolerant of missing/garbled provenance (actor defaults to system)
{
  const parsed = parseSprintEngineAutomationIntentRecord({
    schemaVersion: 1,
    revision: 3,
    desiredMode: 'run_agents_and_approve_artifacts',
    changedAt: 'not-a-number',
    lastWrite: { actor: 'martian', deviceId: 42 },
  })
  assert.ok(parsed)
  assert.equal(parsed.revision, 3)
  assert.equal(parsed.desiredMode, 'run_agents_and_approve_artifacts')
  assert.equal(parsed.changedAt, 0)
  assert.equal(parsed.lastWrite.actor, 'system')
  assert.equal(parsed.lastWrite.deviceId, null)
  assert.equal(parsed.lastWrite.at, '')
}

console.log('sprintengine automation-intent tests passed')
