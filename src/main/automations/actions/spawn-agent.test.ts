import assert from 'node:assert/strict'

import { RUN_SIGNAL_FILENAME } from '../run-signal'
import { composeSpawnAgentPrompt } from './spawn-agent'

function compose(autonomy: 'review_only' | 'allow_changes'): string {
  return composeSpawnAgentPrompt({
    userPrompt: '  Audit the build pipeline.  ',
    autonomy,
    automationId: 'auto-1',
    runId: 'run-7',
  })
}

function assertSignalInstructionInBothModes(): void {
  for (const autonomy of ['review_only', 'allow_changes'] as const) {
    const prompt = compose(autonomy)
    assert.ok(prompt.includes(RUN_SIGNAL_FILENAME), `${autonomy}: prompt names the signal file`)
    assert.ok(
      prompt.includes('current working directory'),
      `${autonomy}: prompt anchors the signal file to cwd`,
    )
    assert.ok(
      prompt.includes('{ "status": "completed" | "failed", "summary"?: string }'),
      `${autonomy}: prompt states the exact signal JSON shape`,
    )
    assert.ok(prompt.includes('"completed"') && prompt.includes('"failed"'), `${autonomy}: both outcomes named`)
    // The "final action" instruction must come after the user task (the filename
    // itself may also appear earlier in the review_only carve-out).
    assert.ok(
      prompt.indexOf('your final action') > prompt.indexOf('Audit the build pipeline.'),
      `${autonomy}: signal instruction follows the user task`,
    )
  }
}

function assertReviewOnlyCarveOut(): void {
  const prompt = compose('review_only')
  assert.ok(prompt.includes('review_only'), 'review_only mode declared')
  assert.ok(prompt.includes('Exception'), 'review_only states an explicit exception')
  // The carve-out must reference the signal file so the no-file-writes rule does not block it.
  const exceptionLine = prompt.split('\n').find((line) => line.startsWith('Exception'))
  assert.ok(exceptionLine, 'exception line present')
  assert.ok(exceptionLine!.includes(RUN_SIGNAL_FILENAME), 'exception carves out the signal file specifically')
}

function assertNoSignalLiteralDuplication(): void {
  // The filename in the prompt must come from the run-signal constant, not a copy.
  assert.equal(RUN_SIGNAL_FILENAME, '.multicode-automation-run-status.json')
}

function main(): void {
  assertSignalInstructionInBothModes()
  assertReviewOnlyCarveOut()
  assertNoSignalLiteralDuplication()
  console.log('automations spawn-agent prompt tests passed')
}

main()
