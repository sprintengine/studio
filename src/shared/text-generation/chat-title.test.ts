import assert from 'node:assert/strict'
import { MAX_WORKSPACE_TITLE_LENGTH } from '../workspace-title'
import {
  CHAT_TITLE_OUTPUT_SCHEMA,
  MAX_CHAT_TITLE_INPUT_CHARS,
  buildChatTitlePrompt,
  limitSection,
  readChatTitleOutput,
  sanitizeGeneratedChatTitle,
} from './chat-title'
import { test } from 'vitest'

test('chat-title', async () => {
  const tests: Array<{ name: string; body: () => void }> = []
  function run(name: string, body: () => void): void {
    tests.push({ name, body })
  }

  run('the prompt carries the rules first and the message last', () => {
    const prompt = buildChatTitlePrompt('  fix the sidebar flicker  ')
    assert.ok(prompt.startsWith('Generate a title'), 'instructions lead')
    assert.ok(prompt.endsWith('User message:\nfix the sidebar flicker'), 'the trimmed message closes the prompt')
    assert.ok(prompt.includes('Return JSON with exactly one key: title.'))
  })

  run('a long message is cut and the cut is marked', () => {
    const prompt = buildChatTitlePrompt('x'.repeat(MAX_CHAT_TITLE_INPUT_CHARS + 100))
    assert.ok(prompt.endsWith('[truncated]'))
    assert.equal(limitSection('short', 10), 'short')
  })

  run('the schema asks for one string key', () => {
    assert.deepEqual(CHAT_TITLE_OUTPUT_SCHEMA.required, ['title'])
    assert.equal(CHAT_TITLE_OUTPUT_SCHEMA.properties.title.type, 'string')
  })

  run('reads a title out of every shape a backend returns', () => {
    assert.equal(readChatTitleOutput({ title: 'Sidebar flicker on switch' }), 'Sidebar flicker on switch')
    assert.equal(readChatTitleOutput('{"title":"Sidebar flicker on switch"}'), 'Sidebar flicker on switch')
    assert.equal(readChatTitleOutput('```json\n{"title":"Fenced title"}\n```'), 'Fenced title')
    assert.equal(readChatTitleOutput('Here you go: {"title":"Embedded title"} done'), 'Embedded title')
    assert.equal(readChatTitleOutput('Bare title text'), 'Bare title text', 'plain text is the title itself')
    assert.equal(readChatTitleOutput({ nope: 1 }), null)
    assert.equal(readChatTitleOutput(''), null)
    assert.equal(readChatTitleOutput(42), null)
  })

  run('sanitises to one sidebar-safe line', () => {
    assert.equal(
      sanitizeGeneratedChatTitle('"Sidebar flicker on workspace switch"'),
      'Sidebar flicker on workspace switch',
    )
    assert.equal(sanitizeGeneratedChatTitle('  fix   git   stash\nsecond line'), 'Fix git stash')
    assert.equal(sanitizeGeneratedChatTitle('Trailing punctuation.'), 'Trailing punctuation')
    assert.equal(sanitizeGeneratedChatTitle('“Curly quotes”'), 'Curly quotes')
  })

  run('caps at the workspace title length on a word boundary', () => {
    const long = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa'
    const title = sanitizeGeneratedChatTitle(long)
    assert.ok(title !== null && title.length <= MAX_WORKSPACE_TITLE_LENGTH)
    assert.ok(!title.endsWith(' '), 'no trailing space after the cut')
    assert.ok(long.startsWith(title), 'cut on a word, never mid-word')
  })

  run('rejects noise rather than naming a chat after it', () => {
    assert.equal(sanitizeGeneratedChatTitle(''), null)
    assert.equal(sanitizeGeneratedChatTitle('   '), null)
    assert.equal(sanitizeGeneratedChatTitle('ok'), null, 'too short')
    assert.equal(sanitizeGeneratedChatTitle('12345'), null, 'no letters')
    assert.equal(sanitizeGeneratedChatTitle(null), null)
    assert.equal(sanitizeGeneratedChatTitle(undefined), null)
  })

  let failed = 0
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed += 1
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failed > 0) {
    throw new Error(`${failed} chat-title test(s) failed`)
  }
})
