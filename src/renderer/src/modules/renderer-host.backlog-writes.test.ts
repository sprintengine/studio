import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { CapabilityManifest } from '../../../shared/modules/manifest'
import type { ModuleHostServiceRequest } from '../../../shared/modules/host-service-bridge'
import type { BacklogScanSnapshot } from '../hooks/useSharedBacklogScan'
import type { BacklogItem, BacklogScanResult } from '../utils/backlog'
import { createBacklogReader } from './backlog-reader'
import { createRendererHost } from './renderer-host'

// The Backlog write methods, `queryUsage`, the `backlog.read` check and the
// watch's error channel on the renderer host.

const thirdParty = (permissions: string[]): CapabilityManifest => ({
  id: 'task-board',
  displayName: 'Task Board',
  version: 1,
  defaultEnabled: true,
  source: 'third-party',
  permissions,
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function withApi(invoke: (request: ModuleHostServiceRequest) => Promise<unknown>): ModuleHostServiceRequest[] {
  const calls: ModuleHostServiceRequest[] = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      moduleHostServiceInvoke: (request: ModuleHostServiceRequest) => {
        calls.push(request)
        return invoke(request)
      },
    },
  }
  return calls
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

test('each Backlog write goes to main with the calling module id and answers what main answered', async () => {
  const calls = withApi(async (request) =>
    request.method === 'create' ? { ok: true, id: 'backlog/unfiled/x.md', numericId: 3 } : { ok: true },
  )
  const host = createRendererHost().hostFor('task-board', thirdParty(['backlog.write']))
  const link = { id: 'l', type: 'external' as const, label: 'L', target: { kind: 'url', id: 'u' } }
  assert.deepEqual(await host.createBacklogItem('ws-1', { title: 'X' }), {
    ok: true,
    id: 'backlog/unfiled/x.md',
    numericId: 3,
  })
  await host.updateBacklogStatus('ws-1', 'backlog/a.md', 'ready')
  await host.updateBacklogTriage('ws-1', 'backlog/a.md', { risk: null })
  await host.addBacklogLink('ws-1', 'backlog/a.md', link)
  await host.updateBacklogModuleMetadata('ws-1', 'backlog/a.md', { lane: 1 })
  await host.getBacklogLocation('ws-1')
  assert.deepEqual(calls, [
    { moduleId: 'task-board', service: 'backlog', method: 'create', args: ['ws-1', { title: 'X' }] },
    { moduleId: 'task-board', service: 'backlog', method: 'updateStatus', args: ['ws-1', 'backlog/a.md', 'ready'] },
    {
      moduleId: 'task-board',
      service: 'backlog',
      method: 'updateTriage',
      args: ['ws-1', 'backlog/a.md', { risk: null }],
    },
    { moduleId: 'task-board', service: 'backlog', method: 'addLink', args: ['ws-1', 'backlog/a.md', link] },
    {
      moduleId: 'task-board',
      service: 'backlog',
      method: 'updateModuleMetadata',
      args: ['ws-1', 'backlog/a.md', { lane: 1 }],
    },
    { moduleId: 'task-board', service: 'backlog', method: 'getLocation', args: ['ws-1'] },
  ])
})

test('queryUsage goes to the usage service', async () => {
  const calls = withApi(async () => ({ ok: true, rows: [], scannedAt: 1, sources: [] }))
  const host = createRendererHost().hostFor('insights', thirdParty(['usage:read']))
  assert.deepEqual(await host.queryUsage({ from: 0, to: 10, groupBy: ['day'] }), {
    ok: true,
    rows: [],
    scannedAt: 1,
    sources: [],
  })
  assert.deepEqual(calls, [
    { moduleId: 'insights', service: 'usage', method: 'query', args: [{ from: 0, to: 10, groupBy: ['day'] }] },
  ])
})

test('a write answers a result, never a throw, when there is no door or the call fails', async () => {
  const host = createRendererHost().hostFor('task-board', thirdParty(['backlog.write']))
  const noApi = await host.updateBacklogStatus('ws-1', 'backlog/a.md', 'ready')
  assert.equal(noApi.ok ? null : noApi.code, 'backlog_unavailable')
  withApi(async () => {
    throw new Error('ipc gone')
  })
  const thrown = await host.updateBacklogStatus('ws-1', 'backlog/a.md', 'ready')
  assert.deepEqual(thrown, { ok: false, code: 'backlog_unavailable', message: 'ipc gone' })
  const usage = await host.queryUsage({ from: 0, to: 1 })
  assert.equal(usage.ok ? null : usage.code, 'unavailable')
})

test('a disabled Backlog module refuses writes without asking main', async () => {
  const calls = withApi(async () => ({ ok: true }))
  const kernel = createRendererHost()
  kernel.hostFor('backlog').provideBacklogReader({ list: async () => [], watch: () => () => {} })
  kernel.setModuleEnablementResolver((moduleId) => moduleId !== 'backlog')
  const result = await kernel.hostFor('task-board', thirdParty(['backlog.write'])).createBacklogItem('ws-1', {
    title: 'X',
  })
  assert.deepEqual(result, { ok: false, code: 'backlog_unavailable', message: 'The Backlog module is disabled.' })
  assert.equal(calls.length, 0)
})

test('a third-party module must declare backlog.read to list or watch', async () => {
  const kernel = createRendererHost()
  kernel.hostFor('backlog').provideBacklogReader({ list: async () => [], watch: () => () => {} })
  const undeclared = kernel.hostFor('task-board', thirdParty([]))
  await assert.rejects(() => undeclared.listBacklogItems('ws-1'), /"backlog\.read" permission/)
  assert.throws(() => undeclared.watchBacklogItems('ws-1', () => {}), /"backlog\.read" permission/)
  const declared = kernel.hostFor('task-board', thirdParty(['backlog.read']))
  assert.deepEqual(await declared.listBacklogItems('ws-1'), [])
  // The app's own modules declare nothing and are not held to the list.
  assert.deepEqual(await kernel.hostFor('git').listBacklogItems('ws-1'), [])
})

test('watch errors reach onError through the kernel, and stop while the Backlog is off', () => {
  const kernel = createRendererHost()
  let raise: ((error: { code: 'scan_failed'; message: string }) => void) | undefined
  kernel.hostFor('backlog').provideBacklogReader({
    list: async () => [],
    watch: (_workspaceId, _cb, onError) => {
      raise = onError
      return () => {}
    },
  })
  let enabled = true
  kernel.setModuleEnablementResolver((moduleId) => moduleId !== 'backlog' || enabled)
  const heard: string[] = []
  kernel.hostFor('task-board', thirdParty(['backlog.read'])).watchBacklogItems('ws-1', () => {}, {
    onError: (error) => heard.push(error.code),
  })
  raise?.({ code: 'scan_failed', message: 'unreadable' })
  enabled = false
  raise?.({ code: 'scan_failed', message: 'unreadable' })
  assert.deepEqual(heard, ['scan_failed'])

  // A throwing onError is contained like a throwing callback.
  enabled = true
  kernel.hostFor('task-board', thirdParty(['backlog.read'])).watchBacklogItems('ws-1', () => {}, {
    onError: () => {
      throw new Error('module bug')
    },
  })
  assert.doesNotThrow(() => raise?.({ code: 'scan_failed', message: 'unreadable' }))
})

test('the reader says a folderless workspace and a failed scan to onError, and recovers', async () => {
  const emitters: Array<(snapshot: BacklogScanSnapshot) => void> = []
  const reader = createBacklogReader({
    resolveFolderPath: async (workspaceId) => (workspaceId === 'ws-1' ? '/tmp/project' : null),
    subscribe: (_folder, cb) => {
      emitters.push(cb)
      return () => {}
    },
  })
  const errors: string[] = []
  reader.watch(
    'ws-bare',
    () => {},
    (error) => errors.push(error.code),
  )
  await settle()
  assert.deepEqual(errors, ['workspace_folder_missing'])

  const delivered: number[] = []
  reader.watch(
    'ws-1',
    (items) => delivered.push(items.length),
    (error) => errors.push(error.code),
  )
  await settle()
  emitters[0]!({
    scan: { state: 'error', items: [], errors: [{ relativePath: 'backlog/', message: 'EACCES' }] } as BacklogScanResult,
    loading: false,
  })
  emitters[0]!({
    scan: { state: 'ready', items: [{ id: 'a' } as unknown as BacklogItem], errors: [] } as BacklogScanResult,
    loading: false,
  })
  assert.deepEqual(errors, ['workspace_folder_missing', 'scan_failed'])
  assert.deepEqual(delivered, [1], 'the next readable scan is delivered')

  const failing = createBacklogReader({
    resolveFolderPath: async () => {
      throw new Error('store not ready')
    },
    subscribe: () => () => {},
  })
  failing.watch(
    'ws-1',
    () => {},
    (error) => errors.push(error.code),
  )
  await settle()
  assert.equal(errors.at(-1), 'unknown_workspace')
})
