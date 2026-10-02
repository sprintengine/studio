import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { createTicketAuthenticator, mintStudioTicket } from '../../server/rpc/studio-frame-port'
import { inProcessStudioTransport } from '../../server/rpc/studio-in-process-port'
import { createStudioRpcServer } from '../../server/rpc/studio-rpc-server'
import { createFakeAuthenticator, createFakeBackend } from '../../server/rpc/studio-rpc.test-helper'
import { createClientToolGateway } from '../../server/tools/client-tool-gateway'
import { createClientToolRegistry, type ClientToolRegistry } from '../../server/tools/client-tool-registry'
import { createClientToolsetStore } from '../../server/tools/client-toolset-store'
import { createDesktopShellTools, type DesktopShellToolset } from '../desktop-shell-tools'
import { createMcpDispatcher, type McpDispatcher } from './mcp-dispatch'

// The whole loop a client tool call takes on a desktop, in one process: an
// agent's tools/call to the gateway's dispatcher, the registry routing it to
// the shell's client over a port, the SDK running the handler main has always
// run, and the reply back. A parity test calls a tool this way and directly,
// and holds the two answers to be the same.

export type ClientToolLoop = {
  registry: ClientToolRegistry
  dispatcher: McpDispatcher
  /** The tools the gateway lists, as an agent's connection resolves them. */
  resolveTools(context?: McpConnectionContext): McpToolRegistration[]
  /** One tools/call, as an agent sends it; answers the result it would read. */
  call(name: string, args: Record<string, unknown>, context: McpConnectionContext): Promise<McpToolResult>
  close(): Promise<void>
}

export async function createClientToolLoop(input: {
  /** What the shell offers. */
  toolsets: DesktopShellToolset[]
  /** Studio's own tools, which the shell's toolsets come before. */
  ownTools?: McpToolRegistration[]
  /** The shell's toolsets a first list waits for. */
  expect?: string[]
  /** Offer only once `start` is called (the boot test). */
  deferStart?: boolean
}): Promise<ClientToolLoop & { start(): Promise<void> }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'client-tool-loop-'))
  const ownTools = input.ownTools ?? []
  const registry = createClientToolRegistry({
    store: createClientToolsetStore({}),
    servedFamilies: () => new Set(ownTools.map((tool) => tool.name.split('.')[0])),
  })
  const gateway = createClientToolGateway({
    registry,
    ...(input.expect ? { expectShellToolsets: input.expect, bootWaitMs: 5_000 } : {}),
  })
  const server = createStudioRpcServer({
    dataDir,
    version: '0.0.0-test',
    environmentId: 'env-test',
    backend: createFakeBackend(),
    authenticator: createFakeAuthenticator(),
    tools: registry,
  })
  const shell = createDesktopShellTools({
    transport: async () => {
      const ticket = mintStudioTicket()
      return inProcessStudioTransport(
        (stream) => {
          server.attach(stream, {
            authenticator: createTicketAuthenticator(ticket),
            ownWindow: false,
            shell: true,
          })
        },
        () => ({ token: ticket }),
      )()
    },
    toolsets: input.toolsets,
  })
  const resolveTools = (context?: McpConnectionContext) => [
    ...gateway.builtIns(context),
    ...ownTools,
    ...gateway.apps(context),
  ]
  const dispatcher = createMcpDispatcher({
    serverName: 'sprintengine-studio',
    serverVersion: '0.0.0-test',
    resolveTools,
    clientTools: {
      ready: () => gateway.ready(),
      fallback: (context, name) => gateway.fallback(context, name),
    },
  })
  const start = () => shell.start()
  if (!input.deferStart) await start()
  return {
    registry,
    dispatcher,
    resolveTools,
    start,
    async call(name, args, context) {
      const outcome = await dispatcher.dispatch('tools/call', { name, arguments: args }, context)
      assert.equal(outcome.kind, 'result', `${name} answered ${JSON.stringify(outcome)}`)
      return (outcome as { value: unknown }).value as McpToolResult
    },
    async close() {
      shell.stop()
      registry.close()
      await server.stop(10)
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
