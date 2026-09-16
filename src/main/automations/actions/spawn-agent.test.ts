import assert from 'node:assert/strict'

import { AUTOMATION_DEFAULT_PERMISSION_PRESET, type AutomationDefinition } from '../../../shared/automations/contracts'
import { runSkillLoopAction } from './run-skill-loop'
import {
  composeSpawnAgentPrompt,
  fingerprintPrompt,
  parseSpawnAgentConfig,
  runSpawnAgentAction,
  type SpawnAgentRuntime,
} from './spawn-agent'

function compose(): string {
  return composeSpawnAgentPrompt({
    userPrompt: '  Audit the build pipeline.  ',
    automationId: 'auto-1',
    runId: 'run-7',
  })
}

function assertNoRunStatusFileInstruction(): void {
  // The run finalizes from the agent-state hooks; no run-status file exists for
  // the agent to write.
  const prompt = compose()
  assert.ok(!prompt.includes('run-status'), 'prompt names no run-status file')
  assert.ok(!prompt.includes('.multicode-automation-run-status.json'), 'prompt carries no signal filename')
  assert.ok(!prompt.includes('"status"'), 'prompt states no signal JSON shape')
}

function assertNonInteractiveDirectiveStated(): void {
  const prompt = compose()
  assert.ok(prompt.includes('unattended'), 'prompt states the run is unattended')
  assert.ok(prompt.includes('Do not ask questions'), 'prompt forbids questions')
  // The directive follows the user task so it is the last thing the agent reads.
  assert.ok(
    prompt.indexOf('Do not ask questions') > prompt.indexOf('Audit the build pipeline.'),
    'non-interactive directive follows the user task',
  )
}

function assertSinglePolicyBlockPermitsPublishing(): void {
  // One unconditional policy block, and nothing in it forbids the commit and
  // push that opening a pull request requires — the contradiction that retired
  // the read-only execution mode.
  const prompt = compose()
  assert.ok(prompt.includes('You may modify files only when the requested task requires it.'), 'write policy stated')
  assert.ok(prompt.includes('report every file and command you touch'), 'reporting duty stated')
  assert.ok(!prompt.includes('Automation execution mode'), 'no execution mode is declared')
  for (const forbidden of ['Do not edit files', 'commit', 'push', 'Inspect and report findings only']) {
    assert.ok(!prompt.includes(forbidden), `prompt does not forbid "${forbidden}"`)
  }
}

const TRIGGER_PAYLOAD = {
  kind: 'weather-deck.forecast-ready',
  taskId: 'T3',
  question: 'Which database should the migration target?',
}

function assertTriggerContextOffIsByteIdentical(): void {
  // Absent, explicit-false, and flag-off-with-a-payload must all reproduce the
  // baseline prompt exactly — no existing automation's prompt or fingerprint moves.
  const baseline = composeSpawnAgentPrompt({
    userPrompt: 'Audit the build pipeline.',
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

// Extract the JSON that sits inside the ```json fence, and whether the fence is
// intact (exactly its own open + close — no extra ``` smuggled in by the payload).
function readFencedJsonBlock(prompt: string): { block: string; fenceRuns: number } {
  const open = '```json\n'
  const start = prompt.indexOf(open)
  assert.notEqual(start, -1, 'json fence opens')
  const contentStart = start + open.length
  const end = prompt.indexOf('\n```', contentStart)
  assert.notEqual(end, -1, 'json fence closes')
  return {
    block: prompt.slice(contentStart, end),
    // '```json' contributes one run, the closing '```' another: an unbroken fence
    // has exactly two. A raw ``` from the payload would push this to 3+.
    fenceRuns: prompt.split('```').length - 1,
  }
}

function assertPayloadFenceIsNeutralized(): void {
  const note = 'before ``` after'
  const prompt = composeSpawnAgentPrompt({
    userPrompt: 'React.',
    automationId: 'auto-1',
    runId: 'run-7',
    includeTriggerContext: true,
    triggerPayload: { note },
  })
  const { block, fenceRuns } = readFencedJsonBlock(prompt)
  assert.equal(fenceRuns, 2, 'a payload ``` cannot break out of the json fence')
  assert.ok(!block.includes('```'), 'the raw triple-backtick is escaped out of the block')
  // The block is still valid JSON and round-trips to the original value.
  assert.equal((JSON.parse(block) as { note: string }).note, note, 'escaped block parses back to the payload')
}

function assertMultibytePayloadTruncatesByBytes(): void {
  // '你' is 3 UTF-8 bytes: 10k of them is ~30 KB, far over the 8 KB cap. Slicing by
  // string length (UTF-16 code units) would keep ~24 KB of bytes; the byte-accurate
  // cut must keep the fenced JSON at or under 8 KB and never split a character.
  const prompt = composeSpawnAgentPrompt({
    userPrompt: 'React.',
    automationId: 'auto-1',
    runId: 'run-7',
    includeTriggerContext: true,
    triggerPayload: { blob: '你'.repeat(10_000) },
  })
  const marker = '\n[truncated]'
  const { block } = readFencedJsonBlock(prompt)
  assert.ok(block.endsWith(marker), 'oversize multibyte payload carries the truncation marker')
  const jsonPart = block.slice(0, block.length - marker.length)
  assert.ok(Buffer.byteLength(jsonPart, 'utf8') <= 8192, 'the fenced JSON is capped by BYTES, not code units')
  assert.ok(!jsonPart.includes('�'), 'the byte cut never splits a multibyte character')
}

type CapturedLaunch = { prompt: string; permissionPreset?: string }

function stubRuntime(
  triggerPayload: Record<string, unknown> | undefined,
  captured: CapturedLaunch
): SpawnAgentRuntime {
  return {
    definition: { id: 'auto-1', name: 'Nightly' } as unknown as AutomationDefinition,
    runId: 'run-7',
    workspaceRoot: '/repo',
    triggerPayload,
    resolveSpawnAgentTarget: async () => ({ folderPath: '/repo' }),
    spawnAgent: async (input) => {
      captured.prompt = input.prompt
      captured.permissionPreset = input.permissionPreset
      return { workspaceId: 'ws-1', agentId: 'agent-1' }
    },
    requireIntegration: () => {},
  }
}

// The unattended default is resolved in the config parse, so it reaches the
// launch whichever start path built the run — and a definition that names a
// preset keeps exactly that.
async function assertUnspecifiedPresetResolvesToBypass(): Promise<void> {
  assert.equal(AUTOMATION_DEFAULT_PERMISSION_PRESET, 'bypass', 'the automation default is bypass')
  assert.equal(
    parseSpawnAgentConfig({ prompt: 'Sweep.' }).permissionPreset,
    'bypass',
    'a config with no preset parses to the unattended default',
  )

  const unset: CapturedLaunch = { prompt: '' }
  await runSpawnAgentAction({ prompt: 'Sweep the repo.' }, stubRuntime(undefined, unset))
  assert.equal(unset.permissionPreset, 'bypass', 'an automation with no preset launches unattended')

  for (const preset of ['none', 'manual', 'auto', 'bypass'] as const) {
    const explicit: CapturedLaunch = { prompt: '' }
    await runSpawnAgentAction({ prompt: 'Sweep the repo.', permissionPreset: preset }, stubRuntime(undefined, explicit))
    assert.equal(explicit.permissionPreset, preset, `an explicit "${preset}" is honored verbatim`)
  }

  // Pre-MC-2210 spellings still parse: a definition saved before the rename
  // names one, and it resolves to the preset it was renamed to rather than
  // being rejected.
  for (const [legacy, canonical] of [
    ['default', 'manual'],
    ['auto_workspace', 'auto'],
    ['bypass_all', 'bypass'],
  ] as const) {
    const saved: CapturedLaunch = { prompt: '' }
    await runSpawnAgentAction(
      { prompt: 'Sweep the repo.', permissionPreset: legacy },
      stubRuntime(undefined, saved),
    )
    assert.equal(saved.permissionPreset, canonical, `the legacy "${legacy}" normalizes to "${canonical}"`)
  }

  // The skill-loop wrapper re-parses its config through the same parse, so it
  // cannot drift to a different answer.
  const loop: CapturedLaunch = { prompt: '' }
  await runSkillLoopAction({ prompt: 'Work an item.', skill: 'backlog' }, stubRuntime(undefined, loop))
  assert.equal(loop.permissionPreset, 'bypass', 'run-skill-loop takes the same default')
  const loopExplicit: CapturedLaunch = { prompt: '' }
  await runSkillLoopAction(
    { prompt: 'Work an item.', skill: 'backlog', permissionPreset: 'auto' },
    stubRuntime(undefined, loopExplicit),
  )
  assert.equal(loopExplicit.permissionPreset, 'auto', 'run-skill-loop honors an explicit preset')

  // An out-of-vocabulary preset is still a hard parse failure — the default
  // never launders a bad value into bypass.
  assert.throws(
    () => parseSpawnAgentConfig({ prompt: 'Sweep.', permissionPreset: 'root' }),
    /permissionPreset must be one of/,
  )
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
    { prompt: 'Answer the question.', skill: 'backlog-steward', includeTriggerContext: true },
    stubRuntime({ kind: 'weather-deck.forecast-ready', taskId: 'T3' }, captured),
  )
  assert.ok(captured.prompt.includes('/loop backlog-steward'), 'skill loop prompt built')
  assert.ok(captured.prompt.includes('## Trigger event'), 'run-skill-loop threads includeTriggerContext through')
  assert.ok(captured.prompt.includes('"taskId": "T3"'), 'run-skill-loop carries the payload')
}

async function main(): Promise<void> {
  assertNoRunStatusFileInstruction()
  assertNonInteractiveDirectiveStated()
  assertSinglePolicyBlockPermitsPublishing()
  assertTriggerContextOffIsByteIdentical()
  assertTriggerContextOnEmbedsPayload()
  assertManualRunPayloadIncludedAsIs()
  assertOversizePayloadTruncated()
  assertPayloadFenceIsNeutralized()
  assertMultibytePayloadTruncatesByBytes()
  await assertExecutorThreadsPayloadWhenOptedIn()
  await assertRunSkillLoopPassesFlagThrough()
  await assertUnspecifiedPresetResolvesToBypass()
  console.log('automations spawn-agent prompt tests passed')
}

void main()
