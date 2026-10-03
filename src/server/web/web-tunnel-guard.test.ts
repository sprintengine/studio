import { expect, test } from 'vitest'

import { webTunnelAllows } from '../../shared/web-client'
import type { TunnelPort } from '../ipc/ipc-tunnel'
import { guardWebTunnelPort, webTunnelAudited } from './web-tunnel-guard'
import { tunnelPortOf, type WebSocketPeer } from './web-socket'

function fakePort() {
  const listeners: Array<(event: { data: unknown }) => void> = []
  const posted: unknown[] = []
  const port = {
    posted,
    postMessage: (message: unknown) => void posted.push(message),
    on: (event: string, listener: (event: { data: unknown }) => void) => {
      if (event === 'message') listeners.push(listener)
      return port
    },
    start: () => undefined,
    close: () => undefined,
    deliver: (data: unknown) => listeners.forEach((listener) => listener({ data })),
  }
  return port
}

test('a web tab reaches the domains it draws, and not the ones that act beyond this server', () => {
  for (const channel of [
    'workspace-sync:dispatch',
    'launch-settings:update',
    'conversation:sessions:send-turn',
    'credential:secrets:status',
  ])
    expect(webTunnelAllows(channel), channel).toBe(true)
  for (const channel of [
    'studio-local-apps:offer',
    'tailnet:set-enabled',
    'tailnet:approve-pair-request',
    'mesh:pair',
    'credential:secrets:set',
    'conversation:secrets:set',
    'github:set-token',
    'github:clone',
    'modules:bridge:invoke',
  ])
    expect(webTunnelAllows(channel), channel).toBe(false)
})

test('a channel the tab may not use is answered DesktopOnly and never reaches a handler', () => {
  const inner = fakePort()
  const heard: unknown[] = []
  const guarded = guardWebTunnelPort(inner as unknown as TunnelPort, { audit: () => undefined })
  guarded.on('message', (event) => heard.push(event.data))
  inner.deliver({ t: 'ipc.invoke', id: 7, channel: 'studio-local-apps:offer', args: [{ name: 'x' }] })
  inner.deliver({ t: 'ipc.send', channel: 'tailnet:set-enabled', args: [true] })
  expect(heard).toEqual([])
  expect(inner.posted).toEqual([
    {
      t: 'ipc.result',
      id: 7,
      ok: false,
      error: { name: 'DesktopOnly', message: 'studio-local-apps:offer is available in the desktop app only.' },
    },
  ])
})

test('a call that changes something is audited with its outcome; a read is not', () => {
  const inner = fakePort()
  const audit: Array<{ channel: string; ok: boolean; workspaceId?: string }> = []
  const guarded = guardWebTunnelPort(inner as unknown as TunnelPort, { audit: (entry) => void audit.push(entry) })
  guarded.on('message', () => undefined)
  inner.deliver({ t: 'ipc.invoke', id: 1, channel: 'workspace-sync:dispatch', args: [{ workspaceId: 'ws-1' }] })
  inner.deliver({ t: 'ipc.invoke', id: 2, channel: 'workspace-sync:get-snapshot', args: [] })
  guarded.postMessage({ t: 'ipc.result', id: 1, ok: true, value: {} })
  guarded.postMessage({ t: 'ipc.result', id: 2, ok: true, value: {} })
  expect(audit.map(({ channel, ok, workspaceId }) => ({ channel, ok, workspaceId }))).toEqual([
    { channel: 'workspace-sync:dispatch', ok: true, workspaceId: 'ws-1' },
  ])
  expect(webTunnelAudited('backlog:update-status')).toBe(true)
  expect(webTunnelAudited('conversation:threads')).toBe(false)
})

test('a result JSON would change is sent as the failure it is, not mangled', () => {
  const sent: string[] = []
  const peer = {
    send: (text: string) => {
      sent.push(text)
      return true
    },
    whenDrained: () => undefined,
    onText: () => undefined,
    onClose: () => undefined,
    close: () => undefined,
    isOpen: () => true,
  } satisfies WebSocketPeer
  const original = console.error
  console.error = () => undefined
  try {
    tunnelPortOf(peer).postMessage({ t: 'ipc.result', id: 3, ok: true, value: { at: new Date(0) } })
  } finally {
    console.error = original
  }
  expect(JSON.parse(sent[0])).toMatchObject({ t: 'ipc.result', id: 3, ok: false, error: { name: 'NotJsonSafe' } })
})
