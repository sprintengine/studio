import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, test } from 'vitest'

import { toolSuccess, type McpToolRegistration } from '../shared/modules/mcp-tools'
import { createTicketAuthenticator, mintStudioTicket } from '../server/rpc/studio-frame-port'
import { inProcessStudioTransport } from '../server/rpc/studio-in-process-port'
import { createStudioRpcServer } from '../server/rpc/studio-rpc-server'
import { createFakeAuthenticator, createFakeBackend } from '../server/rpc/studio-rpc.test-helper'
import { createClientToolRegistry } from '../server/tools/client-tool-registry'
import { createClientToolsetStore } from '../server/tools/client-toolset-store'
import { createDesktopShellTools } from './desktop-shell-tools'

// The shell's client of its server, as the server process sees it (phase 6,
// 6.3): a first connect that fails while the server starts is tried again; a
// server that goes away and comes back gets every toolset offered again; and
// the terminal family arrives as `terminal` and `agent` toolsets, which a
// server that serves either family itself refuses.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const tool = (name: string): McpToolRegistration => ({
  name,
  description: `${name} for the test`,
  inputSchema: { type: 'object', properties: {} },
  mutates: false,
  handler: async () => toolSuccess({ ok: true, name }),
})

function studio(ownTools: string[] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), 'shell-tools-'))
  const registry = createClientToolRegistry({
    store: createClientToolsetStore({}),
    servedFamilies: () => new Set(ownTools.map((name) => name.split('.')[0])),
  })
  const server = createStudioRpcServer({
    dataDir,
    version: '0.0.0-test',
    environmentId: 'env-test',
    backend: createFakeBackend(),
    authenticator: createFakeAuthenticator(),
    tools: registry,
  })
  const streams: Duplex[] = []
  let refuse = 0
  const transport = async () => {
    if (refuse > 0) {
      refuse--
      throw new Error('Studio server is not running yet.')
    }
    const ticket = mintStudioTicket()
    return inProcessStudioTransport(
      (stream) => {
        streams.push(stream)
        server.attach(stream, { authenticator: createTicketAuthenticator(ticket), ownWindow: false, shell: true })
      },
      () => ({ token: ticket }),
    )()
  }
  cleanups.push(async () => {
    registry.close()
    await server.stop(10)
    rmSync(dataDir, { recursive: true, force: true })
  })
  return {
    registry,
    transport,
    refuseNext: (count: number) => {
      refuse = count
    },
    /** The server goes: every connection it holds ends, as a restart ends them. */
    drop: () => {
      for (const stream of streams.splice(0)) stream.destroy()
    },
    offered: () => new Set(registry.catalog({ clientId: 'owner', owner: true }).map((listing) => listing.name)),
  }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('a first connect that fails while the server starts is tried again until it succeeds', async () => {
  const fixture = studio()
  fixture.refuseNext(2)
  const logged: string[] = []
  const shell = createDesktopShellTools({
    transport: fixture.transport,
    toolsets: [{ name: 'browser', registrations: [tool('browser.open')] }],
    retry: { initialMs: 5, maxMs: 20 },
    log: (line) => logged.push(line),
  })
  cleanups.push(() => shell.stop())
  await shell.start()
  assert.ok(shell.client())
  assert.ok(fixture.offered().has('browser'))
  // Said once, not once per attempt.
  assert.equal(logged.filter((line) => line.includes('keeps trying')).length, 1)
})

test('a server that goes away and comes back is offered every toolset again', async () => {
  const fixture = studio()
  const shell = createDesktopShellTools({
    transport: fixture.transport,
    toolsets: [
      { name: 'editor', registrations: [tool('editor.open')] },
      { name: 'tour', registrations: [tool('tour.status')] },
    ],
  })
  cleanups.push(() => shell.stop())
  await shell.start()
  await waitFor(() => fixture.offered().has('editor') && fixture.offered().has('tour'), 'the first offer')
  const before = fixture.registry.catalog({ clientId: 'owner', owner: true })
  assert.ok(before.every((listing) => listing.offeredBy.some((by) => by.connected)))
  fixture.drop()
  await waitFor(
    () =>
      fixture.registry
        .catalog({ clientId: 'owner', owner: true })
        .filter((listing) => ['editor', 'tour'].includes(listing.name))
        .every((listing) => listing.offeredBy.some((by) => by.connected)),
    'the toolsets offered again on the new connection',
  )
})

test('the terminal family is offered as terminal and agent, and refused where the server serves it', async () => {
  const fixture = studio(['backlog.work', 'workspace.list'])
  const shell = createDesktopShellTools({
    transport: fixture.transport,
    toolsets: [
      { name: 'terminal', registrations: [tool('terminal.list'), tool('terminal.create')] },
      { name: 'agent', registrations: [tool('agent.launch'), tool('agent.status')] },
    ],
  })
  cleanups.push(() => shell.stop())
  await shell.start()
  await waitFor(() => fixture.offered().has('terminal') && fixture.offered().has('agent'), 'both offered')

  const serving = studio(['agent.launch'])
  const logged: string[] = []
  const refused = createDesktopShellTools({
    transport: serving.transport,
    toolsets: [{ name: 'agent', registrations: [tool('agent.launch')] }],
    log: (line) => logged.push(line),
  })
  cleanups.push(() => refused.stop())
  await refused.start()
  assert.equal(serving.offered().has('agent'), false)
  assert.match(logged.join('\n'), /could not offer its agent tools/)
})
