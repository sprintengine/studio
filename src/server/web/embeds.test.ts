import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { EMBED_MAX_TTL_MS, EMBEDS_FILENAME, createEmbedStore, embedFrameAllowed, gateEmbedFrames } from './embeds'

let dataDir: string
let now: number
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'embeds-'))
  now = Date.parse('2026-10-03T00:00:00Z')
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const store = () => createEmbedStore({ dataDir, now: () => now })
const conversation = { workspaceId: 'ws-1', agentId: 'agent-1' }

test('an embed names one conversation, read-only, and its token is kept as a hash', () => {
  const embeds = store()
  const created = embeds.create({ conversation, origins: ['https://dashboard.example.com'] })
  if (!created.ok) throw new Error(created.message)
  expect(created.token).toMatch(/^mcemb_/u)
  expect(readFileSync(join(dataDir, EMBEDS_FILENAME), 'utf8')).not.toContain(created.token)
  expect(embeds.authenticate(created.embed.embedId, created.token)?.conversation).toEqual(conversation)
  expect(embeds.authenticate(created.embed.embedId, 'mcemb_wrong')).toBeNull()
  expect(embeds.grantFor(created.embed.embedId)).toMatchObject({ owner: false, scopes: ['conversation:read'] })
})

test('origins are normalized, and anything that is not one is refused', () => {
  const embeds = store()
  const created = embeds.create({ conversation, origins: ['https://dashboard.example.com:443'] })
  expect(created.ok && created.embed.origins).toEqual(['https://dashboard.example.com'])
  expect(embeds.create({ conversation, origins: ['https://dashboard.example.com/page'] }).ok).toBe(false)
  expect(embeds.create({ conversation, origins: ['*'] }).ok).toBe(false)
})

test('an embed expires: a day unless asked, thirty days at most', () => {
  const embeds = store()
  const day = embeds.create({ conversation })
  const long = embeds.create({ conversation, ttlMs: EMBED_MAX_TTL_MS * 4 })
  if (!day.ok || !long.ok) throw new Error('not created')
  expect(Date.parse(long.embed.expiresAt) - now).toBe(EMBED_MAX_TTL_MS)
  now += 24 * 60 * 60 * 1000 + 1
  expect(embeds.authenticate(day.embed.embedId, day.token)).toBeNull()
  expect(embeds.grantFor(day.embed.embedId)).toBeNull()
  expect(embeds.authenticate(long.embed.embedId, long.token)).not.toBeNull()
})

test('revoking an embed refuses its token and tells its listeners', () => {
  const embeds = store()
  const created = embeds.create({ conversation })
  if (!created.ok) throw new Error(created.message)
  const heard: string[] = []
  embeds.onRevoked((id) => heard.push(id))
  embeds.revoke(created.embed.embedId)
  expect(heard).toEqual([created.embed.embedId])
  expect(embeds.authenticate(created.embed.embedId, created.token)).toBeNull()
})

test('the socket gate passes only what follows or pages through the one conversation', () => {
  const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const frame = (value: unknown) => JSON.stringify(value)
  expect(embedFrameAllowed(frame({ t: 'hello' }), conversation)).toBe(true)
  expect(
    embedFrameAllowed(frame({ t: 'sub', id: 's', topic: 'conversation.session', params: { key } }), conversation),
  ).toBe(true)
  expect(
    embedFrameAllowed(frame({ t: 'req', id: 'r', method: 'conversation.loadEarlier', params: { key } }), conversation),
  ).toBe(true)
  // Another conversation, a folder address, a write, another topic: all refused.
  expect(
    embedFrameAllowed(
      frame({ t: 'sub', topic: 'conversation.session', params: { key: { ...key, agentId: 'other' } } }),
      conversation,
    ),
  ).toBe(false)
  expect(
    embedFrameAllowed(
      frame({ t: 'sub', topic: 'conversation.session', params: { key: { ...key, workspaceRoot: '/Users/dev/app' } } }),
      conversation,
    ),
  ).toBe(false)
  expect(
    embedFrameAllowed(frame({ t: 'req', method: 'conversation.send', params: { key, message: 'hi' } }), conversation),
  ).toBe(false)
  expect(embedFrameAllowed(frame({ t: 'req', method: 'conversation.list' }), conversation)).toBe(false)
  expect(embedFrameAllowed(frame({ t: 'sub', topic: 'tools.catalog' }), conversation)).toBe(false)
  expect(embedFrameAllowed('not json', conversation)).toBe(false)
})

test('a frame outside the embed ends the socket', async () => {
  const inner = new PassThrough()
  const gated = gateEmbedFrames(inner, conversation)
  const passed: string[] = []
  gated.on('data', (chunk: Buffer) => passed.push(chunk.toString('utf8')))
  inner.write(`${JSON.stringify({ t: 'hello' })}\n`)
  inner.write(`${JSON.stringify({ t: 'req', id: 'r', method: 'conversation.list' })}\n`)
  await new Promise((resolve) => setImmediate(resolve))
  expect(passed.join('')).toContain('"hello"')
  expect(passed.join('')).not.toContain('conversation.list')
  expect(inner.destroyed).toBe(true)
})
