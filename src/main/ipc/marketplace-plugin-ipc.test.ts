/**
 * The marketplace plugin IPC surface, at the boundary the renderer crosses.
 *
 * What only this file can be wrong about is the SET of channels and what each
 * one delegates to. The lifecycle has its own suite; the pipe to it did not —
 * and `marketplace:plugins:uninstall` (G3) is the case that proves the point:
 * the lifecycle could uninstall a receipt from the day it was written, and
 * nothing could reach it, so a marketplace install was a one-way door.
 *
 * The handler runs for real against a scratch `userData` (the electron stub's
 * `app.getPath`), so an uninstall of something that was never installed comes
 * back as the lifecycle's own refusal rather than a thrown error — which is
 * also the assertion that this channel really is wired to the lifecycle.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

// The IPC wire between the real preload and the real main handlers.
vi.mock('electron', () => import('../../../tests/stubs/electron'))

test('marketplace-plugin-ipc', async () => {
  type Handler = (event: unknown, input: unknown) => Promise<unknown>

  async function main(): Promise<void> {
    const userData = mkdtempSync(join(tmpdir(), 'mc-marketplace-ipc-'))
    process.env.SPRINTENGINE_USER_DATA_DIR = userData
    try {
      // Imported after the env is set: the module reads `app.getPath('userData')`
      // when the surface is registered.
      const { registerMarketplacePluginIpc } = await import('./marketplace-plugin-ipc')

      const handlers = new Map<string, Handler>()
      const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
      registerMarketplacePluginIpc(
        ipcMain as unknown as Parameters<typeof registerMarketplacePluginIpc>[0],
        {
          mcpConfigService: { sync: () => ({ ok: true, targets: [] }) },
          getAutomationsAppFrontDoor: () => null,
        } as unknown as Parameters<typeof registerMarketplacePluginIpc>[1],
      )

      assert.deepEqual(
        [...handlers.keys()].sort(),
        [
          'marketplace:plugins:install-entry',
          'marketplace:plugins:uninstall',
          'marketplace:plugins:update-entry',
          'marketplace:plugins:update-states',
          'marketplace:plugins:verify',
        ],
        'the uninstall channel is registered beside the install channels',
      )

      const uninstall = handlers.get('marketplace:plugins:uninstall')!
      // Delegated to the lifecycle: an id with no receipt is the lifecycle's own
      // sentence, not a throw and not a fabricated success.
      const missing = (await uninstall({}, { pluginId: 'never-installed' })) as { ok: boolean; message?: string }
      assert.equal(missing.ok, false)
      assert.match(missing.message ?? '', /never-installed is not installed/)

      // An empty id is refused before any store is read.
      const blank = (await uninstall({}, { pluginId: '   ' })) as { ok: boolean; message?: string }
      assert.equal(blank.ok, false)
      assert.match(blank.message ?? '', /Plugin id is required/)

      // A malformed envelope is an ok:false result, never an unhandled rejection
      // across the IPC boundary.
      const malformed = (await uninstall({}, undefined)) as { ok: boolean; message?: string }
      assert.equal(malformed.ok, false)

      console.log('marketplace-plugin-ipc tests passed')
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
