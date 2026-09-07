import assert from 'node:assert/strict'
import {
  claudeChatTitleInvocation,
  codexChatTitleInvocation,
  readClaudeChatTitleStdout,
  readCodexChatTitleOutput,
} from './backends'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

run('claude runs print mode with structured output and every door shut', () => {
  const { file, args } = claudeChatTitleInvocation({
    binaryPath: '/usr/local/bin/claude',
    model: 'claude-haiku-4-5',
    reasoning: 'low',
    schemaJson: '{"type":"object"}',
  })
  assert.equal(file, '/usr/local/bin/claude')
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'json', '--json-schema', '{"type":"object"}'])
  assert.deepEqual(args.slice(5, 9), ['--model', 'claude-haiku-4-5', '--effort', 'low'])
  assert.ok(args.includes('--tools') && args[args.indexOf('--tools') + 1] === '', 'no tools at all')
  assert.ok(args.includes('--disable-slash-commands'))
  assert.ok(args.includes('--strict-mcp-config'))
  assert.equal(args[args.indexOf('--settings') + 1], '{"disableAllHooks":true}')
})

run('claude passes no effort flag when none is chosen', () => {
  const { args } = claudeChatTitleInvocation({ binaryPath: 'claude', model: 'fable', schemaJson: '{}' })
  assert.ok(!args.includes('--effort'))
})

run('codex runs exec ephemeral, read-only, schema and last-message on files, prompt on stdin', () => {
  const { file, args } = codexChatTitleInvocation({
    binaryPath: '/opt/homebrew/bin/codex',
    model: 'gpt-5.6-luna',
    reasoning: 'low',
    schemaPath: '/tmp/x/schema.json',
    outputPath: '/tmp/x/last-message.txt',
  })
  assert.equal(file, '/opt/homebrew/bin/codex')
  assert.deepEqual(args.slice(0, 5), ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only'])
  assert.deepEqual(args.slice(5, 9), ['--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"'])
  assert.deepEqual(args.slice(9), ['--output-schema', '/tmp/x/schema.json', '--output-last-message', '/tmp/x/last-message.txt', '-'])
})

run('reads the claude envelope, verbose arrays, and refuses an error envelope', () => {
  assert.equal(
    readClaudeChatTitleStdout('{"type":"result","is_error":false,"structured_output":{"title":"Sidebar flicker"},"result":"{\\"title\\":\\"Sidebar flicker\\"}"}'),
    'Sidebar flicker',
  )
  assert.equal(
    readClaudeChatTitleStdout('[{"type":"system"},{"type":"result","structured_output":{"title":"From the array"}}]'),
    'From the array',
  )
  assert.equal(
    readClaudeChatTitleStdout('{"type":"result","result":"{\\"title\\":\\"Only in result\\"}"}'),
    'Only in result',
    'an envelope without structured_output still yields its result text',
  )
  assert.equal(readClaudeChatTitleStdout('{"type":"result","is_error":true,"result":"rate limited"}'), null)
  assert.equal(readClaudeChatTitleStdout('not json at all'), 'not json at all', 'plain stdout is read as the title itself')
  assert.equal(readClaudeChatTitleStdout('[]'), null)
})

run('reads the codex last-message file in any of its shapes', () => {
  assert.equal(readCodexChatTitleOutput('{"title":"Fix Mobile Sidebar Flicker"}\n'), 'Fix Mobile Sidebar Flicker')
  assert.equal(readCodexChatTitleOutput('Bare answer'), 'Bare answer')
  assert.equal(readCodexChatTitleOutput(''), null)
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
if (failed > 0) throw new Error(`${failed} backends test(s) failed`)
