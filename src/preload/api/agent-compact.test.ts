import assert from 'node:assert/strict'

import { createAgentCompactApi } from './agent-compact'
import { test } from 'vitest'

test('compacting sends the session id and nothing else: the text typed is main’s', async () => {
  const calls: { channel: string; payload: unknown }[] = []
  const api = createAgentCompactApi({
    async invoke(channel: string, payload?: unknown): Promise<any> {
      calls.push({ channel, payload })
      return { ok: true }
    },
  })

  assert.deepEqual(await api.compactAgentSession('terminal-1'), { ok: true })
  assert.deepEqual(calls, [{ channel: 'agent:compact', payload: 'terminal-1' }])
  assert.deepEqual(Object.keys(api), ['compactAgentSession'], 'no way to send any other text')
})
