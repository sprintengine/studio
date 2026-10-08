// A CLI session written as a chat's history: a long tool output is kept by
// its start and end, not whole.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { ImportedTranscriptBuilder, MAX_IMPORTED_TOOL_OUTPUT_CHARS } from './imported-transcript'

const AT = Date.parse('2026-09-01T10:00:00Z')

function outputOf(output: string): Record<string, unknown> {
  const builder = new ImportedTranscriptBuilder(AT)
  builder.userMessage('Run the tests', AT)
  builder.toolStarted({ toolUseId: 't1', tool: 'Bash' }, AT)
  builder.toolOutput({ toolUseId: 't1', output, isError: false }, AT)
  const event = builder.finish(null).events.find((entry) => entry.type === 'tool_output')
  assert.ok(event)
  return event.payload
}

test('a tool output under the cap is kept as it is', () => {
  const payload = outputOf('ok\n')
  assert.equal(payload.output, 'ok\n')
  assert.equal(payload.truncated, undefined)
})

test('a long tool output keeps its start and its end, and says it was cut', () => {
  const output = `START${'x'.repeat(MAX_IMPORTED_TOOL_OUTPUT_CHARS * 4)}END`
  const payload = outputOf(output)
  const kept = String(payload.output)
  assert.ok(kept.length < MAX_IMPORTED_TOOL_OUTPUT_CHARS + 100)
  assert.ok(kept.startsWith('START'))
  assert.ok(kept.endsWith('END'))
  assert.match(kept, /characters left out on import/u)
  assert.equal(payload.truncated, true)
})
