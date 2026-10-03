import { expect, test } from 'vitest'

import { createCanvasTools } from '../../../../main/automation/canvas-tools'
import {
  BUILT_IN_TOOL_TIMEOUTS_MS,
  connectionContextOf,
  gatewayToolDefinitions,
} from '../../../../main/automation/offer-gateway-tools'
import { createCanvasService } from '../../../../main/canvas/canvas-service'
import type { CanvasWorkerTransport } from '../../../../main/canvas/canvas-worker-host'
import { WEB_CANVAS_TOOL_TIMEOUTS_MS, createWebCanvasTools, webConnectionContextOf } from './webCanvasTools'

// The web tab's canvas toolset is the desktop's, tool for tool.

const idleWorker: CanvasWorkerTransport = {
  ensureStarted: () => new Promise(() => undefined),
  post: () => undefined,
  onResponse: () => () => undefined,
  onCrashed: () => () => undefined,
  report: () => null,
  stop: () => undefined,
}

const client = {
  request: (async () => ({ workspaces: [{ id: 'ws-1', name: 'app', folderPath: '/Users/dev/app' }] })) as never,
  subscribe: (() => () => undefined) as never,
  welcome: { environment: { os: 'linux' } } as never,
}

test('the tools, their schemas, reads and writes and deadlines are the desktop shell’s', () => {
  const web = createWebCanvasTools(client, { worker: idleWorker }).definitions
  const desktopService = createCanvasService({
    fs: {} as never,
    now: () => 0,
    resolveWorkspaceRoot: () => null,
    broadcast: () => undefined,
    sendTo: () => undefined,
    watch: () => ({ close: () => undefined }),
    worker: { call: async () => ({ ok: false }) as never, report: () => null, dispose: async () => undefined },
  })
  const desktop = gatewayToolDefinitions(
    'canvas',
    createCanvasTools({ service: desktopService, hasWorkspace: () => true, isCanvasEnabled: () => true }),
  )
  const shape = (definitions: typeof web) =>
    definitions.map(({ name, description, inputSchema, mutates, timeoutMs }) => ({
      name,
      description,
      inputSchema,
      mutates,
      timeoutMs,
    }))
  expect(shape(web)).toEqual(shape(desktop))
  for (const [name, timeout] of Object.entries(WEB_CANVAS_TOOL_TIMEOUTS_MS))
    expect(timeout, name).toBe(BUILT_IN_TOOL_TIMEOUTS_MS[name])
})

test('a call’s connection is read as the desktop reads it', () => {
  const call = {
    context: { connection: { kind: 'agent', workspaceId: 'ws-1', agentId: 'agent-1', agentName: 'Tadhg' } },
  } as never
  expect(webConnectionContextOf(call)).toEqual(connectionContextOf(call))
})
