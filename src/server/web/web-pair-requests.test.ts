import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { PAIR_REQUEST_TTL_MS, createPairRequests } from './web-pair-requests'
import { createWebSessionStore } from './web-sessions'

let dir: string
let now: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pair-requests-'))
  now = Date.parse('2026-10-03T00:00:00Z')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup() {
  const sessions = createWebSessionStore({
    dataDir: dir,
    environmentId: '05763914-5fa0-449b-96d7-15af49e0ec86',
    now: () => now,
  })
  return { sessions, requests: createPairRequests({ sessions, now: () => now }) }
}

test('a browser asks, the owner types its six digits, and its next poll carries a session once', () => {
  const { sessions, requests } = setup()
  const asked = requests.create({ name: 'Phone', userAgent: null, route: 'tailnet' })
  if (!asked.ok) throw new Error(asked.message)
  expect(asked.code).toMatch(/^\d{6}$/u)
  expect(requests.collect(asked.requestId, asked.collect)).toEqual({ status: 'pending' })
  expect(requests.pending().map((request) => request.name)).toEqual(['Phone'])
  expect(requests.approve(asked.requestId, asked.code)).toEqual({ ok: true })
  const collected = requests.collect(asked.requestId, asked.collect)
  expect(collected.status).toBe('approved')
  if (collected.status !== 'approved') return
  expect(collected.session).toMatchObject({ name: 'Phone', route: 'tailnet' })
  expect(collected.session.scopes).not.toContain('tools:offer')
  expect(sessions.authenticate([collected.secret])?.id).toBe(collected.session.id)
  expect(requests.collect(asked.requestId, asked.collect).status).toBe('expired')
})

test('only the browser that asked can collect, by its secret', () => {
  const { requests } = setup()
  const asked = requests.create({ userAgent: null, route: 'tailnet' })
  if (!asked.ok) throw new Error(asked.message)
  requests.approve(asked.requestId, asked.code)
  expect(requests.collect(asked.requestId, 'secollect_guessed').status).toBe('expired')
  expect(requests.collect(asked.requestId, asked.collect).status).toBe('approved')
})

test('three wrong codes decline the request', () => {
  const { requests } = setup()
  const asked = requests.create({ userAgent: null, route: 'tailnet' })
  if (!asked.ok) throw new Error(asked.message)
  const wrong = asked.code === '000000' ? '111111' : '000000'
  expect(requests.approve(asked.requestId, wrong).ok).toBe(false)
  expect(requests.approve(asked.requestId, wrong).ok).toBe(false)
  expect(requests.approve(asked.requestId, wrong)).toEqual({
    ok: false,
    message: 'Three wrong codes: the request was declined.',
  })
  expect(requests.approve(asked.requestId, asked.code).ok).toBe(false)
  expect(requests.collect(asked.requestId, asked.collect).status).toBe('declined')
})

test('a request lives five minutes, and at most eight wait', () => {
  const { requests } = setup()
  const asked = requests.create({ userAgent: null, route: 'tailnet' })
  if (!asked.ok) throw new Error(asked.message)
  now += PAIR_REQUEST_TTL_MS + 1
  expect(requests.collect(asked.requestId, asked.collect).status).toBe('expired')
  for (let index = 0; index < 8; index++) expect(requests.create({ userAgent: null, route: 'tailnet' }).ok).toBe(true)
  expect(requests.create({ userAgent: null, route: 'tailnet' }).ok).toBe(false)
})
