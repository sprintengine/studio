import assert from 'node:assert/strict'

import { SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND } from '../../shared/automations/contracts'
import { SPRINT_ENGINE_START_ACTION_KIND } from './actions/sprint-engine'
import { parseDefinitionDraft, parseDefinitionPatch } from './definition-write'

function draftInput(overrides: {
  triggerKind: string
  actionKind: string
  disableAfterRun?: boolean
}): Record<string, unknown> {
  return {
    name: 'Chain',
    status: 'enabled',
    trigger: { kind: overrides.triggerKind, config: { kind: overrides.triggerKind, team: 'team-a' } },
    action: { kind: overrides.actionKind, config: { backlogItem: 'backlog/next.md' } },
    ...(overrides.disableAfterRun === undefined ? {} : { disableAfterRun: overrides.disableAfterRun }),
  }
}

function assertLandedStartPairDefaultsToRunOnce(): void {
  const result = parseDefinitionDraft(draftInput({
    triggerKind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
    actionKind: SPRINT_ENGINE_START_ACTION_KIND,
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.disableAfterRun, true, 'a landed→start chain fires once by default to bound ping-pong')
}

function assertExplicitFalseOptsOut(): void {
  const result = parseDefinitionDraft(draftInput({
    triggerKind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
    actionKind: SPRINT_ENGINE_START_ACTION_KIND,
    disableAfterRun: false,
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.disableAfterRun, false, 'an explicit choice wins over the default — opt-out, not a lock')
}

function assertOtherPairsAreUnaffected(): void {
  // A different action under the same trigger keeps the field absent (no default).
  const result = parseDefinitionDraft(draftInput({
    triggerKind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
    actionKind: 'spawn-agent',
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.disableAfterRun, undefined, 'only the landed→start pair defaults to run-once')
}

function assertRetiredAutonomyFieldIsIgnoredNotRejected(): void {
  // An MCP caller or module written against the old draft shape still sends
  // `autonomyDefault`. Rejecting would break those callers over a field that no
  // longer means anything, so the parse accepts the draft and drops the key.
  const result = parseDefinitionDraft({
    ...draftInput({ triggerKind: 'schedule', actionKind: 'spawn-agent' }),
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' } },
    autonomyDefault: 'review_only',
  })
  assert.equal(result.ok, true, 'a draft carrying the retired field still parses')
  if (!result.ok) return
  assert.equal(Object.hasOwn(result.value, 'autonomyDefault'), false, 'the retired field is not carried into the draft')

  const patch = parseDefinitionPatch({ name: 'Renamed', autonomyDefault: 'allow_changes' })
  assert.equal(patch.ok, true, 'a patch carrying the retired field still parses')
  if (!patch.ok) return
  assert.equal(patch.value.name, 'Renamed', 'the rest of the patch is applied')
  assert.equal(Object.hasOwn(patch.value, 'autonomyDefault'), false, 'the retired field is not carried into the patch')
}

function main(): void {
  assertLandedStartPairDefaultsToRunOnce()
  assertExplicitFalseOptsOut()
  assertOtherPairsAreUnaffected()
  assertRetiredAutonomyFieldIsIgnoredNotRejected()
  console.log('automations definition-write chain-default tests passed')
}

main()
