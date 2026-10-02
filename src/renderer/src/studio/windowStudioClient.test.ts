import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { installStudioLoopback, type StudioLoopback } from '../../../../tests/studio-chat-loopback'
import { windowStudioClient } from './windowStudioClient'

// A window's client: one per window, kept while it is connected or
// reconnecting, and forgotten once it has closed for good, so the next use
// starts a fresh one rather than holding a dead client for the window's life.

beforeEach(() => vi.stubEnv('STUDIO_CHAT_TRANSPORT_UNDER_TEST', 'studio'))
afterEach(() => vi.unstubAllEnvs())

type Connect = () => Promise<{ connectionId: string; ticket: string }>

test('a window keeps one client; one parked by a refused ticket tries again when it is next asked for', async () => {
  const win: { api: Record<string, unknown> } = { api: {} }
  const loopback = installStudioLoopback(win) as StudioLoopback
  const api = win.api as never
  const first = await windowStudioClient(api)
  expect(await windowStudioClient(api)).toBe(first)
  expect(first.grant.owner).toBe(true)
  expect(loopback.connections()).toBe(1)

  // A reconnect Studio refuses parks the client: trying again would be refused again.
  const connect = win.api.studioConnect as Connect
  win.api.studioConnect = async () => ({ ...(await connect()), ticket: 'seport_not_the_ticket_000000' })
  loopback.drop()
  for (let tries = 0; first.state !== 'parked' && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(first.state).toBe('parked')

  // Asked for again, once a ticket would be good, it connects again.
  win.api.studioConnect = connect
  const again = await windowStudioClient(api)
  expect(again).toBe(first)
  for (let tries = 0; again.state !== 'open' && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(again.state).toBe('open')

  // A client that closed for good is forgotten, and the next use starts a new one.
  again.close()
  const second = await windowStudioClient(api)
  expect(second).not.toBe(first)
  expect(second.state).toBe('open')
  second.close()
})

test('a window belongs to the Studio it first reached, and refuses any other after', async () => {
  const win: { api: Record<string, unknown> } = { api: {} }
  const first = installStudioLoopback(win) as StudioLoopback
  const api = win.api as never
  const client = await windowStudioClient(api)
  expect(client.welcome.environment.id).toBe('studio-loopback')
  client.close()
  await client.closed
  first.drop()
  // Another Studio answers this window from now on.
  installStudioLoopback(win, { environmentId: 'elsewhere' })
  await expect(windowStudioClient(api)).rejects.toMatchObject({ code: 'environment_changed' })
})

test('a first connection that fails is forgotten, so the next use tries again', async () => {
  const win: { api: Record<string, unknown> } = { api: {} }
  installStudioLoopback(win)
  const connect = win.api.studioConnect as Connect
  win.api.studioConnect = async () => {
    throw new Error('Studio did not hand this window its connection.')
  }
  const api = win.api as never
  await expect(windowStudioClient(api)).rejects.toThrow(/did not hand this window/)
  win.api.studioConnect = connect
  const client = await windowStudioClient(api)
  expect(client.state).toBe('open')
  client.close()
})
