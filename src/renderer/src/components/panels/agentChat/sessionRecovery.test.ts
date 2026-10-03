import { expect, test } from 'vitest'

import { sendRecoveringSession, sessionWasLost } from './sessionRecovery'

const lost = { ok: false as const, code: 'session_not_found', message: 'Conversation session is invalid.' }

test('a send on a session its server no longer holds starts the session again and goes out on that one', async () => {
  const sentOn: string[] = []
  let restarts = 0
  const result = await sendRecoveringSession({
    sessionId: 'conv_old',
    send: async (sessionId) => {
      sentOn.push(sessionId)
      return sessionId === 'conv_old' ? lost : { ok: true as const }
    },
    restart: async () => {
      restarts++
      return { ok: true, sessionId: 'conv_new' }
    },
  })
  expect(result).toEqual({ ok: true })
  expect(sentOn).toEqual(['conv_old', 'conv_new'])
  expect(restarts).toBe(1)
})

test('a restart that fails says why, and any other refusal is answered as it came', async () => {
  const failed = await sendRecoveringSession({
    sessionId: 'conv_old',
    send: async () => lost,
    restart: async () => ({
      ok: false,
      message: 'The Studio server in Ubuntu stopped a moment ago; it is tried again in 2 s.',
    }),
  })
  expect(failed).toEqual({
    ok: false,
    message: 'The Studio server in Ubuntu stopped a moment ago; it is tried again in 2 s.',
  })

  let restarts = 0
  const busy = { ok: false as const, message: 'Conversation turn is already in progress.' }
  const refused = await sendRecoveringSession({
    sessionId: 'conv_live',
    send: async () => busy,
    restart: async () => {
      restarts++
      return { ok: true, sessionId: 'never' }
    },
  })
  expect(refused).toBe(busy)
  expect(restarts).toBe(0)
  expect(sessionWasLost({ ok: true })).toBe(false)
})
