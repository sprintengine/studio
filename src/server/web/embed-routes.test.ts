import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createEmbedRoutes } from './embed-routes'
import { createEmbedStore, type EmbedStore } from './embeds'
import { createWebListener, type WebListener } from './web-listener'
import { createWebSessionStore, type WebSessionStore } from './web-sessions'
import { openWebStaticRoot } from './web-static'

const MINT_KEY = 'mint-key-for-the-test-only-0123456789'
let dir: string
let sessions: WebSessionStore
let embeds: EmbedStore
let listener: WebListener
let port: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'embed-routes-'))
  const web = join(dir, 'web')
  mkdirSync(web)
  writeFileSync(
    join(web, 'embed.html'),
    '<!doctype html><html><head><script src="./assets/embed.js"></script></head></html>',
  )
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head></head></html>')
  sessions = createWebSessionStore({ dataDir: dir, environmentId: '05763914-5fa0-449b-96d7-15af49e0ec86' })
  embeds = createEmbedStore({ dataDir: dir })
  const staticRoot = openWebStaticRoot(web)
  listener = createWebListener({
    sessions,
    staticRoot,
    port: 0,
    publicOrigins: [],
    mintKey: MINT_KEY,
    version: 'test',
    studio: { connect: () => undefined },
    extraRoutes: [
      createEmbedRoutes({
        embeds,
        sessions,
        staticRoot: () => staticRoot,
        pageHeaders: (origin, ancestors) => listener.pageHeaders(origin, ancestors),
        mintKey: MINT_KEY,
      }),
    ],
  })
  port = (await listener.start()).port
})

afterEach(async () => {
  await listener.stop()
  rmSync(dir, { recursive: true, force: true })
})

function ask(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        )
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

const own = () => `http://127.0.0.1:${port}`

test('the embed page may be framed by the embed’s origins only, and its assets resolve from the bundle', async () => {
  const created = embeds.create({
    conversation: { workspaceId: 'ws-1', agentId: 'agent-1' },
    origins: ['https://dashboard.example.com'],
  })
  if (!created.ok) throw new Error(created.message)
  const page = await ask(`/embed/conversation/${created.embed.embedId}`)
  expect(page.status).toBe(200)
  expect(String(page.headers['content-security-policy'])).toContain('frame-ancestors https://dashboard.example.com')
  expect(page.headers['x-frame-options']).toBeUndefined()
  expect(page.body).toContain('"../../assets/embed.js"')
  expect(page.body).toContain('content="https://dashboard.example.com"')
})

test('an embed with no origins cannot be framed at all', async () => {
  const created = embeds.create({ conversation: { workspaceId: 'ws-1', agentId: 'agent-1' } })
  if (!created.ok) throw new Error(created.message)
  const page = await ask(`/embed/conversation/${created.embed.embedId}`)
  expect(String(page.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
  expect(page.headers['x-frame-options']).toBe('DENY')
})

test('the rest of the app keeps frame-ancestors none', async () => {
  const pair = await ask('/pair')
  expect(pair.status).not.toBe(200) // no pairing page in this bundle; the policy is checked on the app below
  const { code } = sessions.mintPairingCode()
  const exchanged = sessions.exchange(code, { route: 'loopback' })
  if (!exchanged.ok) throw new Error('not paired')
  const app = await ask('/', { headers: { Cookie: `${sessions.cookieName}=${exchanged.secret}` } })
  expect(String(app.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
})

test('a revoked or unknown embed is not served', async () => {
  const created = embeds.create({ conversation: { workspaceId: 'ws-1', agentId: 'agent-1' } })
  if (!created.ok) throw new Error(created.message)
  embeds.revoke(created.embed.embedId)
  expect((await ask(`/embed/conversation/${created.embed.embedId}`)).status).toBe(404)
  expect((await ask('/embed/conversation/not-an-embed')).status).toBe(404)
})

test('the token is traded for a single-use ticket, from the page’s own origin only', async () => {
  const created = embeds.create({ conversation: { workspaceId: 'ws-1', agentId: 'agent-1' } })
  if (!created.ok) throw new Error(created.message)
  const body = JSON.stringify({ embedId: created.embed.embedId, token: created.token })
  const foreign = await ask('/embed/session', {
    method: 'POST',
    headers: { Origin: 'https://dashboard.example.com', 'Content-Type': 'application/json' },
    body,
  })
  expect(foreign.status).toBe(403)
  const exchanged = await ask('/embed/session', {
    method: 'POST',
    headers: { Origin: own(), 'Content-Type': 'application/json' },
    body,
  })
  expect(exchanged.status).toBe(200)
  const { ticket } = JSON.parse(exchanged.body) as { ticket: string }
  expect(sessions.redeemTicket(ticket)).toEqual({ kind: 'embed', embedId: created.embed.embedId })
  const wrong = await ask('/embed/session', {
    method: 'POST',
    headers: { Origin: own(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ embedId: created.embed.embedId, token: 'mcemb_wrong' }),
  })
  expect(wrong.status).toBe(401)
})

test('studio-server embed mints with the run file key; a page cannot', async () => {
  const body = JSON.stringify({ workspaceId: 'ws-1', agentId: 'agent-1', origins: ['https://dashboard.example.com'] })
  const minted = await ask('/embed/mint', { method: 'POST', headers: { Authorization: `Bearer ${MINT_KEY}` }, body })
  expect(minted.status).toBe(200)
  expect((JSON.parse(minted.body) as { url: string }).url).toMatch(/\/embed\/conversation\/[\w-]+#token=mcemb_/u)
  const fromPage = await ask('/embed/mint', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MINT_KEY}`, Origin: own() },
    body,
  })
  expect(fromPage.status).toBe(403)
})
