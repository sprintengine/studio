import assert from 'node:assert/strict'
import {
  createGuidedInterviewParser,
  parseGuidedInterviewOutput,
  EMPTY_GUIDED_INTERVIEW_STATE,
} from './interviewProtocol'

const questionJson = JSON.stringify({
  id: 'q1',
  question: 'Where should account data live?',
  options: [
    { key: '1', label: 'Managed Postgres', detail: 'One region, simplest ops.', recommended: true },
    { key: '2', label: 'SQLite per workspace', detail: 'Cheap but sync-hostile.' },
  ],
  allowOther: true,
})

const fencedQuestion = `GUIDED_QUESTION_BEGIN\n${questionJson}\nGUIDED_QUESTION_END\n`

// A clean fenced block parses into a current question.
{
  const state = parseGuidedInterviewOutput(fencedQuestion)
  assert.equal(state.currentQuestion?.id, 'q1')
  assert.equal(state.currentQuestion?.question, 'Where should account data live?')
  assert.equal(state.currentQuestion?.options.length, 2)
  assert.equal(state.currentQuestion?.options[0].recommended, true)
  assert.equal(state.currentQuestion?.allowOther, true)
  assert.equal(state.decisions.length, 0)
  assert.equal(state.malformedCount, 0)
}

// ANSI noise and prompt chrome around the fences still parse — CLIs wrap
// lines in box-drawing and colors.
{
  const wrapped = [
    '\x1b[32m│ GUIDED_QUESTION_BEGIN │\x1b[0m',
    `│ ${questionJson} │`,
    '│ GUIDED_QUESTION_END │',
    '',
  ].join('\n')
  const state = parseGuidedInterviewOutput(wrapped)
  assert.equal(state.currentQuestion?.id, 'q1', 'chrome-wrapped fences parse')
}

// A decision after the question resolves it: no current question, one decision.
{
  const decided = `${fencedQuestion}GUIDED_DECISION: {"id":"q1","question":"Where should account data live?","label":"Managed Postgres"}\n`
  const state = parseGuidedInterviewOutput(decided)
  assert.equal(state.currentQuestion, null, 'a decision for the question clears it')
  assert.deepEqual(state.decisions, [
    { id: 'q1', question: 'Where should account data live?', label: 'Managed Postgres' },
  ])
}

// A later question supersedes; earlier decisions accumulate and dedupe.
{
  const q2 = JSON.stringify({
    id: 'q2',
    question: 'Auth?',
    options: [{ key: '1', label: 'Magic links' }],
  })
  const output = [
    fencedQuestion,
    'GUIDED_DECISION: {"id":"q1","label":"Managed Postgres"}',
    'GUIDED_DECISION: {"id":"q1","label":"Managed Postgres (EU region)"}',
    `GUIDED_QUESTION_BEGIN\n${q2}\nGUIDED_QUESTION_END`,
    '',
  ].join('\n')
  const state = parseGuidedInterviewOutput(output)
  assert.equal(state.currentQuestion?.id, 'q2')
  assert.equal(state.decisions.length, 1, 'decisions dedupe by id')
  assert.equal(state.decisions[0].label, 'Managed Postgres (EU region)', 'last decision wins')
}

// Malformed JSON inside the fence is dropped and counted, never rendered.
{
  const state = parseGuidedInterviewOutput(
    'GUIDED_QUESTION_BEGIN\n{not json}\nGUIDED_QUESTION_END\n',
  )
  assert.equal(state.currentQuestion, null)
  assert.equal(state.malformedCount, 1)
}

// Questions missing required fields are malformed, not partially rendered.
{
  const noOptions = JSON.stringify({ id: 'q3', question: 'No options?', options: [] })
  const state = parseGuidedInterviewOutput(
    `GUIDED_QUESTION_BEGIN\n${noOptions}\nGUIDED_QUESTION_END\n`,
  )
  assert.equal(state.currentQuestion, null)
  assert.equal(state.malformedCount, 1)
}

// Instruction echoes do not trigger: tokens inline in sentences are not fences,
// and a decision-prefix mid-sentence does not start with the prefix.
{
  const echo = [
    'print a line containing only the token GUIDED_QUESTION_BEGIN, then JSON,',
    'then a line containing only the token GUIDED_QUESTION_END.',
    'print one line that starts with the token GUIDED_DECISION: followed by JSON.',
    '',
  ].join('\n')
  const state = parseGuidedInterviewOutput(echo)
  assert.deepEqual(state, { ...EMPTY_GUIDED_INTERVIEW_STATE, decisions: [] })
}

// Chunk-split delivery: the stateful parser reassembles fences across pushes.
{
  const parser = createGuidedInterviewParser()
  const full = fencedQuestion
  let state = parser.state()
  for (let index = 0; index < full.length; index += 7) {
    state = parser.push(full.slice(index, index + 7))
  }
  assert.equal(state.currentQuestion?.id, 'q1', 'fences survive chunk splits')
  state = parser.push('GUIDED_DECISION: {"id":"q1","label":"Managed Postgres"}\n')
  assert.equal(state.currentQuestion, null)
  assert.equal(state.decisions.length, 1)
}

// A torn redraw (BEGIN without END, then a fresh block) recovers cleanly.
{
  const torn = `GUIDED_QUESTION_BEGIN\n{"id":"q9"\n${fencedQuestion}`
  const state = parseGuidedInterviewOutput(torn)
  assert.equal(state.currentQuestion?.id, 'q1', 'a new BEGIN abandons the torn block')
}

console.log('interviewProtocol: ok')
