import { test } from 'vitest'
import assert from 'node:assert/strict'
import { compactTerminalAgent, type AgentCompactIpcDependencies } from './agent-compact-ipc'

const idle = {
  cli: 'claude-code',
  processAlive: true,
  suspended: false,
  agentState: { phase: 'idle' },
  lastInputAt: 100,
  lastTurnEndedAt: 200,
}

function deps(session: (typeof idle & Record<string, unknown>) | null) {
  const sent: Array<{ sessionId: string; text: string }> = []
  const state = { session }
  const value: AgentCompactIpcDependencies = {
    findTerminal: () => state.session,
    sendPrompt: async (sessionId, text, precondition) => {
      // The control plane runs the precondition inside the session's queue,
      // right before typing.
      const blocked = precondition()
      if (blocked) return { ok: false, message: blocked }
      sent.push({ sessionId, text })
      return { ok: true }
    },
  }
  return { value, sent, state }
}

test('compacting types /compact at an idle Claude Code prompt, and only there', async () => {
  const ok = deps(idle)
  assert.deepEqual(await compactTerminalAgent(ok.value, 'terminal-1'), { ok: true })
  assert.deepEqual(ok.sent, [{ sessionId: 'terminal-1', text: '/compact' }], 'the text is main’s, never the caller’s')

  // Main checks the session as it stands now, not as the button last saw it.
  const busy = deps({ ...idle, agentState: { phase: 'tool_use' } })
  const refused = await compactTerminalAgent(busy.value, 'terminal-1')
  assert.equal(refused.ok, false)
  assert.equal(busy.sent.length, 0)

  const drafted = deps({ ...idle, lastInputAt: 250 })
  assert.equal((await compactTerminalAgent(drafted.value, 'terminal-1')).ok, false, 'a draft may be at the prompt')
  assert.equal(drafted.sent.length, 0)

  // The agent starting to work between the click and the typing stops it too.
  const raced = deps(idle)
  const racing = {
    ...raced.value,
    sendPrompt: async (sessionId: string, text: string, precondition: () => string | null) => {
      raced.state.session = { ...idle, agentState: { phase: 'thinking' } }
      return raced.value.sendPrompt(sessionId, text, precondition)
    },
  }
  assert.equal((await compactTerminalAgent(racing, 'terminal-1')).ok, false)
  assert.equal(raced.sent.length, 0, 'checked again at the moment of typing')

  const gone = deps(null)
  assert.deepEqual(await compactTerminalAgent(gone.value, 'terminal-1'), {
    ok: false,
    message: 'The agent session is gone.',
  })
  for (const bad of [undefined, 42, '', 'x'.repeat(600), 'a\0b']) {
    assert.equal((await compactTerminalAgent(ok.value, bad)).ok, false, `refuses ${String(bad).slice(0, 10)}`)
  }
  assert.equal(ok.sent.length, 1)
})
