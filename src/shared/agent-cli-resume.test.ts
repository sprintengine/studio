import assert from 'node:assert/strict'
import {
  agentCliSupportsConversationResume,
  agentCliUsesStableSessionIdForResume,
  type ResumeCapabilities,
} from './agent-cli-resume'
import { test } from 'vitest'

test('agent-cli-resume', async () => {
  const tests: Array<{ name: string; body: () => void }> = []

  function run(name: string, body: () => void): void {
    tests.push({ name, body })
  }

  // The predicates are now pure functions of the two manifest capabilities, with
  // no hardcoded cli-id allowlist. These profiles mirror the bundled plugin.json
  // capabilities so the behavior is anchored to real manifests.
  const caps = (resumeSession: boolean, sessionIdFromCaller: boolean): ResumeCapabilities => ({
    resumeSession,
    sessionIdFromCaller,
  })

  run('agentCliSupportsConversationResume returns capabilities.resumeSession', () => {
    assert.equal(agentCliSupportsConversationResume(caps(true, true)), true) // claude-code / zai
    assert.equal(agentCliSupportsConversationResume(caps(true, false)), true) // codex
    assert.equal(agentCliSupportsConversationResume(caps(false, false)), false) // generic-shell / opencode (off)
    assert.equal(agentCliSupportsConversationResume(undefined), false, 'unknown cli → no resume')
  })

  run('agentCliUsesStableSessionIdForResume returns capabilities.sessionIdFromCaller', () => {
    assert.equal(agentCliUsesStableSessionIdForResume(caps(true, true)), true) // claude-code / zai
    assert.equal(agentCliUsesStableSessionIdForResume(caps(true, false)), false) // codex mints its own id
    assert.equal(agentCliUsesStableSessionIdForResume(caps(false, false)), false)
    assert.equal(agentCliUsesStableSessionIdForResume(undefined), false, 'unknown cli → not stable-session')
  })

  run('a new capability-declaring CLI resumes with no predicate edit', () => {
    // The whole point of the refactor: any future CLI that declares the capability
    // resumes purely by its manifest — this test would already pass for it.
    assert.equal(agentCliSupportsConversationResume(caps(true, true)), true)
    assert.equal(agentCliUsesStableSessionIdForResume(caps(true, true)), true)
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
})
