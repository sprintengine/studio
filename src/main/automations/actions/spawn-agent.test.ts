import assert from 'node:assert/strict'

import { composeSpawnAgentPrompt } from './spawn-agent'

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

function main(): void {
  assertNoRunStatusFileInstruction()
  assertNonInteractiveDirectiveInBothModes()
  assertReviewOnlyIsStrictlyReadOnly()
  console.log('automations spawn-agent prompt tests passed')
}

main()
