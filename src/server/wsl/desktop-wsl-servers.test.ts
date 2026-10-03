import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ExecutionHostId, ExecutionHostSettings } from '../../shared/execution-host'
import { createDesktopWslServers } from './desktop-wsl-servers'

// The per-distribution switch is the only thing that sends a distribution's
// chats to a Studio server inside it, whichever process owns the core: a
// person who never turned it on gets no server, no install and no listener.

function servers(hosts: Partial<Record<ExecutionHostId, Partial<ExecutionHostSettings>>>) {
  return createDesktopWslServers({
    readHostSettings: () => hosts as Partial<Record<ExecutionHostId, ExecutionHostSettings>>,
    userDataDir: '/Users/dev/Library/Application Support/SprintEngine Studio',
    app: { version: '0.4.0', channel: 'latest' },
    packaged: false,
    resourcesDir: null,
    appRoot: null,
    isDefaultProfile: false,
  })
}

test('chats run on a distribution’s server only where the person turned it on', () => {
  assert.equal(servers({}).chatServerOn('Ubuntu'), false, 'off by default')
  assert.equal(servers({ 'wsl:Ubuntu': { chatServer: 'off' } }).chatServerOn('Ubuntu'), false)
  const on = servers({ 'wsl:Ubuntu': { chatServer: 'on' } })
  assert.equal(on.chatServerOn('Ubuntu'), true)
  assert.equal(on.chatServerOn('Debian'), false, 'one distribution’s switch is its own')
  assert.deepEqual(on.manager.statuses(), [], 'nothing is started by asking')
})
