import assert from 'node:assert/strict'
import {
  agentCliSupportsConversationResume,
  agentCliUsesStableSessionIdForResume,
} from './agent-cli-resume'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

run('agentCliSupportsConversationResume covers the claude-harness + codex CLIs', () => {
  assert.equal(agentCliSupportsConversationResume('zai'), true)
  assert.equal(agentCliSupportsConversationResume('claude-code'), true)
  assert.equal(agentCliSupportsConversationResume('codex'), true)
  assert.equal(agentCliSupportsConversationResume('opencode'), false)
  assert.equal(agentCliSupportsConversationResume('generic-shell'), false)
  assert.equal(agentCliSupportsConversationResume(undefined), false)
})

run('agentCliUsesStableSessionIdForResume covers only caller-minted-id CLIs', () => {
  assert.equal(agentCliUsesStableSessionIdForResume('zai'), true)
  assert.equal(agentCliUsesStableSessionIdForResume('claude-code'), true)
  // codex mints its own ids, so our terminal key is not its resume token.
  assert.equal(agentCliUsesStableSessionIdForResume('codex'), false)
  assert.equal(agentCliUsesStableSessionIdForResume('opencode'), false)
  assert.equal(agentCliUsesStableSessionIdForResume(undefined), false)
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('agent-cli-resume.test.ts: ok')
}

main()
