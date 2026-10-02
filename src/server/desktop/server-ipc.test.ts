import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import { SERVER_IPC_CHANNELS } from '../../shared/ipc-channel-owners'
import { createIpcTunnel } from '../ipc/ipc-tunnel'
import { registerServerDomainIpc, type ServerDomainIpcDeps } from './server-ipc'

// The channel table and the server's registrations, held to each other in
// both directions (phase 6 spec, 6.2): a channel the server registers that the
// table misses would be sent to the shell and answered "no handler"; a table
// entry the server does not register would be sent to a server that cannot
// answer it.

const scratch = mkdtempSync(join(tmpdir(), 'se-server-ipc-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A stand-in that answers any member with another stand-in, and any call with one too. */
function anything(): any {
  const target = function () {} as unknown as Record<PropertyKey, unknown>
  return new Proxy(target, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === Symbol.toPrimitive) return () => ''
      return anything()
    },
    apply: () => anything(),
  })
}

function serverDomainStubs(dataDir: string): ServerDomainIpcDeps {
  return {
    core: {
      ...anything(),
      platform: { paths: { dataDir: () => dataDir } },
      workspaceSyncService: { subscribeEvents: () => () => undefined },
      agentLaunchSettings: { subscribe: () => () => undefined, get: () => ({ cliRuntimes: {} }) },
      hosts: { subscribe: () => () => undefined },
      workspaceRegistry: { getRecords: () => [] },
      conversations: anything(),
    } as never,
    gateway: anything(),
    studioRpc: { provideChat: () => undefined } as never,
    githubTokenStore: anything(),
    workspaceBackup: anything(),
    terminalHandoff: anything(),
    files: anything(),
    assertAppSender: () => undefined,
  }
}

test('every channel the server registers is in the table, and every table entry is registered', () => {
  const tunnel = createIpcTunnel()
  const handles = registerServerDomainIpc(tunnel.registry as never, serverDomainStubs(scratch))
  void handles.conversationCommands.dispose()
  const registered = tunnel.channels()
  const listed = Object.keys(SERVER_IPC_CHANNELS).sort()
  assert.deepEqual(
    registered.filter((channel) => !listed.includes(channel)),
    [],
    'registered by the server but missing from SERVER_IPC_CHANNELS',
  )
  assert.deepEqual(
    listed.filter((channel) => !registered.includes(channel)),
    [],
    'listed in SERVER_IPC_CHANNELS but not registered by the server',
  )
})
