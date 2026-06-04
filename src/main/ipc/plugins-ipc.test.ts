import assert from 'node:assert/strict'
import { join } from 'node:path'

import { registerPluginIpc } from './plugins-ipc'
import type { PluginRegistryListResult } from '../../shared/electron-api'
import { createPluginRegistry } from '../plugin-registry'
import {
  __resetPluginRegistryForTest,
  __setPluginRegistryForTest,
} from '../plugin-registry-instance'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  return {
    handle(channel, handler): void {
      handlers.set(channel, handler)
    },
    handlers,
  }
}

async function main(): Promise<void> {
  await testReturnsBundledAndFixtureUserEntries()
  await testFailureIsExplicit()

  console.log('plugins-ipc tests passed')
}

async function testReturnsBundledAndFixtureUserEntries(): Promise<void> {
  const bundledRoot = join(process.cwd(), 'resources', 'plugins')
  const fixtureRoot = join(process.cwd(), 'tests', 'fixtures', 'plugin-manifests')
  const registry = createPluginRegistry({ bundledRoot, userRoot: fixtureRoot })
  const report = await registry.load()
  __setPluginRegistryForTest(registry, report, fixtureRoot)

  const ipcMain = createIpcMain()
  registerPluginIpc(ipcMain as unknown as Parameters<typeof registerPluginIpc>[0])

  const handler = ipcMain.handlers.get('plugins:list')
  assert.ok(handler, 'plugins:list should be registered')

  const result = (await handler?.(null)) as PluginRegistryListResult
  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.deepEqual(
    result.plugins.map((p) => p.id).sort(),
    ['aider', 'claude-code', 'codex', 'generic-shell', 'opencode', 'pi']
  )
  assert.equal(result.plugins.find((p) => p.id === 'codex')?.source, 'bundled')
  assert.equal(result.plugins.find((p) => p.id === 'opencode')?.source, 'user')

  __resetPluginRegistryForTest()
}

async function testFailureIsExplicit(): Promise<void> {
  const ipcMain = createIpcMain()
  registerPluginIpc(ipcMain as unknown as Parameters<typeof registerPluginIpc>[0], {
    list: () => {
      throw new Error('registry load failed')
    },
  })

  const result = (await ipcMain.handlers.get('plugins:list')?.(null)) as PluginRegistryListResult
  assert.deepEqual(result, { ok: false, message: 'registry load failed' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
