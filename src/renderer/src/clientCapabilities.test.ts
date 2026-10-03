import { expect, test } from 'vitest'

import { DESKTOP_CLIENT_CAPABILITIES } from '../../shared/client-capabilities'
import { clientPlatform, clientSupports, hostPlatform } from './clientCapabilities'
import { composerRosterRows } from './components/workspace/agentComposer/useAgentComposer'

test('a desktop window can do everything but show previews; an older preload counts as a desktop window', () => {
  expect(DESKTOP_CLIENT_CAPABILITIES).not.toContain('previews')
  expect(clientSupports('terminals', { clientCapabilities: DESKTOP_CLIENT_CAPABILITIES })).toBe(true)
  expect(clientSupports('terminals', { platform: 'darwin' })).toBe(true)
  expect(clientSupports('previews', { platform: 'darwin' })).toBe(false)
})

test('a browser tab answers from what it declared', () => {
  const tab = { clientCapabilities: ['previews' as const], platform: 'win32', hostPlatform: 'darwin' }
  expect(clientSupports('terminals', tab)).toBe(false)
  expect(clientSupports('window-controls', tab)).toBe(false)
  expect(clientSupports('previews', tab)).toBe(true)
  // A Windows browser on a Mac server: Ctrl on the keyboard, Mac paths on the server.
  expect(clientPlatform(tab)).toBe('win32')
  expect(hostPlatform(tab)).toBe('darwin')
  expect(hostPlatform({ platform: 'linux' })).toBe('linux')
})

test('with no terminals only the chat row is offered', () => {
  const rows = composerRosterRows({
    showTerminal: true,
    conversationAvailable: true,
    noAgentCliInstalled: false,
    terminals: false,
  })
  expect(rows.map((row) => row.kind)).toEqual(['conversation'])
})
