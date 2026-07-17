import assert from 'node:assert/strict'

import type { AutomationDefinition } from '../../../shared/automations/contracts'
import { runSkillLoopAction } from './run-skill-loop'
import {
  composeSpawnAgentPrompt,
  fingerprintPrompt,
  runSpawnAgentAction,
  type SpawnAgentRuntime,
} from './spawn-agent'

function compose(autonomy: 'review_only' | 'allow_changes'): string {
  return composeSpawnAgentPrompt({
    userPrompt: '  Audit the build pipeline.  ',
    autonomy,
    automationId: 'auto-1',
    runId: 'run-7',
  })
}

function assertNoRunStatusFileInstruction(): void {
  // The run finalizes from the agent-state hooks; no run-status file exists for
  // the agent to write, in either mode.
  for (const autonomy of ['review_only', 'allow_changes'] as const) {
    const prompt = compose(autonomy)
    assert.ok(!prompt.includes('run-status'), `${autonomy}: prompt names no run-status file`)
    assert.ok(
      !prompt.includes('.multicode-automation-run-status.json'),
      `${autonomy}: prompt carries no signal filename`,
    )
    assert.ok(!prompt.includes('"status"'), `${autonomy}: prompt states no signal JSON shape`)
  }
}

function assertNonInteractiveDirectiveInBothModes(): void {
  for (const autonomy of ['review_only', 'allow_changes'] as const) {
    const prompt = compose(autonomy)
    assert.ok(prompt.includes('unattended'), `${autonomy}: prompt states the run is unattended`)
    assert.ok(prompt.includes('Do not ask questions'), `${autonomy}: prompt forbids questions`)
    // The directive follows the user task so it is the last thing the agent reads.
    assert.ok(
      prompt.indexOf('Do not ask questions') > prompt.indexOf('Audit the build pipeline.'),
      `${autonomy}: non-interactive directive follows the user task`,
    )
  }
}

function assertReviewOnlyIsStrictlyReadOnly(): void {
  const prompt = compose('review_only')
  assert.ok(prompt.includes('Automation execution mode: review_only.'), 'review_only mode declared')
  assert.ok(prompt.includes('Do not edit files, create files'), 'no-write rule stated')
  // The signal file was the only write carve-out; review_only now has none.
  assert.ok(!prompt.includes('Exception'), 'review_only carries no write exception')
}

const TRIGGER_PAYLOAD = {
  kind: 'sprint-engine.run-needs-input',
  taskId: 'T3',
  question: 'Which database should the migration target?',
}

function assertTriggerContextOffIsByteIdentical(): void {
  // Absent, explicit-false, and flag-off-with-a-payload must all reproduce the
  // baseline prompt exactly — no existing automation's prompt or fingerprint moves.
  const baseline = composeSpawnAgentPrompt({
    userPrompt: 'Audit the build pipeline.',
    autonomy: 'allow_changes',
    automationId: 'auto-1',
    runId: 'run-7',
  })
  const variants = [
    { includeTriggerContext: undefined },
    { includeTriggerContext: false },
    { includeTriggerContext: false, triggerPayload: TRIGGER_PAYLOAD },
    { includeTriggerContext: true, triggerPayload: {} },
  ]
  for (const variant of variants) {
    const prompt = composeSpawnAgentPrompt({
      userPrompt: 'Audit the build pipeline.',
      autonomy: 'allow_changes',
      automationId: 'auto-1',
      runId: 'run-7',
      ...variant,
    })
    assert.equal(prompt, baseline, `variant ${JSON.stringify(variant)}: prompt byte-identical to baseline`)
    assert.equal(fingerprintPrompt(prompt), fingerprintPrompt(baseline), 'fingerprint unchanged')
  }
}

function assertTriggerContextOnEmbedsPayload(): void {
  const prompt = composeSpawnAgentPrompt({
    userPrompt: 'React to the blocked run.',
    autonomy: 'allow_changes',
    automationId: 'auto-1',
    runId: 'run-7',
    includeTriggerContext: true,
    triggerPayload: TRIGGER_PAYLOAD,
  })
  assert.ok(prompt.includes('## Trigger event'), 'trigger heading present')
  assert.ok(prompt.includes('```json'), 'json fence present')
  // The exact serialized payload is embedded verbatim.
  assert.ok(prompt.includes(JSON.stringify(TRIGGER_PAYLOAD, null, 2)), 'exact payload embedded')
  // Block sits after the user task and before the non-interactive directive.
  assert.ok(
    prompt.indexOf('React to the blocked run.') < prompt.indexOf('## Trigger event'),
    'block follows the user task',
  )
  assert.ok(
    prompt.indexOf('## Trigger event') < prompt.indexOf('Do not ask questions'),
    'block precedes the non-interactive directive',
  )
}

function assertManualRunPayloadIncludedAsIs(): void {
  const prompt = composeSpawnAgentPrompt({
    userPrompt: 'Nightly sweep.',
    autonomy: 'review_only',
    automationId: 'auto-1',
    runId: 'run-7',
    includeTriggerContext: true,
    triggerPayload: { kind: 'manual', dueAt: '2026-07-17T00:00:00.000Z' },
  })
  assert.ok(prompt.includes('"kind": "manual"'), 'manual payload embedded as-is')
  assert.ok(prompt.includes('"dueAt": "2026-07-17T00:00:00.000Z"'), 'manual dueAt embedded')
}

function assertOversizePayloadTruncated(): void {
  const prompt = composeSpawnAgentPrompt({
    userPrompt: 'React.',
    autonomy: 'allow_changes',
    automationId: 'auto-1',
    runId: 'run-7',
    includeTriggerContext: true,
    triggerPayload: { blob: 'x'.repeat(20_000) },
  })
  assert.ok(prompt.includes('[truncated]'), 'oversize payload carries the truncation marker')
  // Bounded: the 8 KB JSON cap plus marker and prompt scaffolding stays well under
  // the untruncated 20 KB payload — proving the cap actually fired.
  assert.ok(prompt.length < 10_000, 'truncated prompt stays bounded')
}

function stubRuntime(triggerPayload: Record<string, unknown> | undefined, captured: { prompt: string }): SpawnAgentRuntime {
  return {
    definition: { id: 'auto-1', name: 'Nightly', autonomyDefault: 'allow_changes' } as unknown as AutomationDefinition,
    runId: 'run-7',
    workspaceRoot: '/repo',
    triggerPayload,
    resolveSpawnAgentTarget: async () => ({ folderPath: '/repo' }),
    spawnAgent: async (input) => {
      captured.prompt = input.prompt
      return { workspaceId: 'ws-1', agentId: 'agent-1' }
    },
    requireIntegration: () => {},
  }
}

async function assertExecutorThreadsPayloadWhenOptedIn(): Promise<void> {
  // Proves the runtime.triggerPayload wiring (executor-local → composeSpawnAgentPrompt).
  const captured = { prompt: '' }
  await runSpawnAgentAction(
    { prompt: 'React to the run.', includeTriggerContext: true },
    stubRuntime({ kind: 'manual', dueAt: '2026-07-17T00:00:00.000Z' }, captured),
  )
  assert.ok(captured.prompt.includes('## Trigger event'), 'opted-in spawn-agent embeds the trigger block')

  const off = { prompt: '' }
  await runSpawnAgentAction({ prompt: 'React to the run.' }, stubRuntime({ kind: 'manual' }, off))
  assert.ok(!off.prompt.includes('## Trigger event'), 'default spawn-agent omits the trigger block')
}

async function assertRunSkillLoopPassesFlagThrough(): Promise<void> {
  const captured = { prompt: '' }
  await runSkillLoopAction(
    { prompt: 'Answer the question.', skill: 'sprint-steward', includeTriggerContext: true },
    stubRuntime({ kind: 'sprint-engine.run-needs-input', taskId: 'T3' }, captured),
  )
  assert.ok(captured.prompt.includes('/loop sprint-steward'), 'skill loop prompt built')
  assert.ok(captured.prompt.includes('## Trigger event'), 'run-skill-loop threads includeTriggerContext through')
  assert.ok(captured.prompt.includes('"taskId": "T3"'), 'run-skill-loop carries the payload')
}

async function main(): Promise<void> {
  assertNoRunStatusFileInstruction()
  assertNonInteractiveDirectiveInBothModes()
  assertReviewOnlyIsStrictlyReadOnly()
  assertTriggerContextOffIsByteIdentical()
  assertTriggerContextOnEmbedsPayload()
  assertManualRunPayloadIncludedAsIs()
  assertOversizePayloadTruncated()
  await assertExecutorThreadsPayloadWhenOptedIn()
  await assertRunSkillLoopPassesFlagThrough()
  console.log('automations spawn-agent prompt tests passed')
}

void main()
