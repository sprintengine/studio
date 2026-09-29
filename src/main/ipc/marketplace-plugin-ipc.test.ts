/**
 * The marketplace plugin IPC surface, at the boundary the renderer crosses.
 *
 * What only this file can be wrong about is the SET of channels, what each one
 * delegates to, and what it refuses to take from the renderer. The lifecycle
 * has its own suite; the pipe to it did not — `marketplace:plugins:uninstall`
 * (G3) is the case that proves the point: the lifecycle could uninstall a
 * receipt from the day it was written, and nothing could reach it.
 *
 * M-F2 is the rest: the renderer names an entry by id and main resolves it;
 * the only approval is a one-time token main issued at verify; the workspace an
 * install writes into must be one the app has open; and only the app's own
 * window is answered at all.
 *
 * The handler runs for real against a scratch `userData` (the electron stub's
 * `app.getPath`), with the registry injected so nothing reaches the network.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, vi } from 'vitest'

import type {
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadResult,
} from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'

// The IPC wire between the real preload and the real main handlers.
vi.mock('electron', () => import('../../../tests/stubs/electron'))

test('marketplace-plugin-ipc', async () => {
  type Handler = (event: unknown, input: unknown) => Promise<unknown>

  const { webContents } = await import('../../../tests/stubs/electron')
  delete process.env['ELECTRON_RENDERER_URL']
  // The app's own window: its top-level document is the renderer's index.html.
  const appEvent = {
    sender: webContents,
    senderFrame: { parent: null, url: pathToFileURL('/Applications/Studio.app/out/renderer/index.html').href },
  }
  // An embedded page inside that window.
  const subframeEvent = { ...appEvent, senderFrame: { ...appEvent.senderFrame, parent: {} } }

  const INLINE_ENTRY: MarketplacePluginEntry = {
    id: 'inline-mcp-plugin',
    name: 'Inline MCP Plugin',
    publisher: { name: 'Community Author', verified: false },
    summary: 'Inline MCP server config.',
    category: 'dev-tools',
    icon: 'icons/inline.svg',
    latest: 1,
    provides: ['mcp'],
    mcp: {
      servers: [
        {
          id: 'inline-mcp',
          name: 'inline-mcp',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          clients: ['codex'],
          scope: 'workspace',
          source: 'custom',
          enabled: true,
          riskLevel: 'local-command',
        },
      ],
    },
  }

  async function main(): Promise<void> {
    const userData = mkdtempSync(join(tmpdir(), 'mc-marketplace-ipc-'))
    process.env.SPRINTENGINE_USER_DATA_DIR = userData
    const openWorkspace = join(userData, 'workspace')
    mkdirSync(openWorkspace, { recursive: true })
    try {
      // Imported after the env is set: the module reads `app.getPath('userData')`
      // when the surface is registered.
      const { registerMarketplacePluginIpc } = await import('./marketplace-plugin-ipc')

      const registry: MarketplaceRegistryReadResult = {
        ok: true,
        state: 'ok',
        registryUrl: 'https://registry.test/marketplace.json',
        source: 'bundled',
        stale: false,
        fetchedAt: '2026-09-29T00:00:00.000Z',
        marketplace: { schemaVersion: 1, plugins: [INLINE_ENTRY] },
      }
      const synced: unknown[] = []
      const handlers = new Map<string, Handler>()
      const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
      registerMarketplacePluginIpc(
        ipcMain as unknown as Parameters<typeof registerMarketplacePluginIpc>[0],
        {
          mcpConfigService: {
            sync: (input: unknown) => {
              synced.push(input)
              return { ok: true, targets: [] }
            },
          },
          getAutomationsAppFrontDoor: () => null,
          workspaceSyncService: { getSnapshot: () => ({ state: { workspaces: [{ folderPath: openWorkspace }] } }) },
        } as unknown as Parameters<typeof registerMarketplacePluginIpc>[1],
        { registryReader: { read: async () => registry } },
      )

      assert.deepEqual(
        [...handlers.keys()].sort(),
        [
          'extensions:github:check-update',
          'extensions:github:install',
          'extensions:github:resolve',
          'marketplace:plugins:install-entry',
          'marketplace:plugins:uninstall',
          'marketplace:plugins:update-entry',
          'marketplace:plugins:update-states',
          'marketplace:plugins:verify',
        ],
        'the uninstall channel is registered beside the install channels',
      )
      const verify = handlers.get('marketplace:plugins:verify')!
      const install = handlers.get('marketplace:plugins:install-entry')!
      const uninstall = handlers.get('marketplace:plugins:uninstall')!

      // --- verify resolves the entry in main and issues the only approval ---
      const verified = (await verify(appEvent, { id: INLINE_ENTRY.id })) as MarketplacePluginVerifyResult
      assert.equal(verified.classification, 'unsigned')
      assert.deepEqual(verified.mcpServers?.[0]?.args, ['server.js'])
      assert.equal(typeof verified.trustToken, 'string')

      // An id main's registry does not carry is refused, whatever else rides along.
      const unknown = (await verify(appEvent, {
        id: 'not-listed',
        entry: { ...INLINE_ENTRY, id: 'not-listed' },
      })) as MarketplacePluginVerifyResult
      assert.equal(unknown.classification, 'invalid')
      assert.match(unknown.message ?? '', /not in the marketplace/)
      assert.equal(unknown.trustToken, undefined)

      // --- install: no token, a forged token, a workspace nobody opened ---
      const noToken = (await install(appEvent, {
        id: INLINE_ENTRY.id,
        workspaceRoot: openWorkspace,
      })) as MarketplacePluginRegistryInstallResult
      assert.equal(noToken.ok, false)
      if (!noToken.ok) assert.match(noToken.message, /requires trust approval/)
      // The renderer's old yes/no is not a thing main reads any more.
      const oldBoolean = (await install(appEvent, {
        id: INLINE_ENTRY.id,
        workspaceRoot: openWorkspace,
        trustGranted: true,
      })) as MarketplacePluginRegistryInstallResult
      assert.equal(oldBoolean.ok, false)

      const forged = (await install(appEvent, {
        id: INLINE_ENTRY.id,
        workspaceRoot: openWorkspace,
        trustToken: 'forged',
      })) as MarketplacePluginRegistryInstallResult
      assert.equal(forged.ok, false)
      if (!forged.ok) assert.match(forged.message, /expired or was already used/)

      const elsewhere = (await install(appEvent, {
        id: INLINE_ENTRY.id,
        workspaceRoot: join(userData, 'not-open'),
        trustToken: verified.trustToken,
      })) as MarketplacePluginRegistryInstallResult
      assert.equal(elsewhere.ok, false)
      if (!elsewhere.ok) assert.match(elsewhere.message, /Open this workspace/)
      assert.equal(synced.length, 0, 'nothing was written for any refusal')

      // --- the approved install, once ---
      const again = (await verify(appEvent, { id: INLINE_ENTRY.id })) as MarketplacePluginVerifyResult
      const installed = (await install(appEvent, {
        id: INLINE_ENTRY.id,
        workspaceRoot: openWorkspace,
        mcpSettings: { syncEnabled: false, servers: {} },
        trustToken: again.trustToken,
      })) as MarketplacePluginRegistryInstallResult
      assert.equal(installed.ok, true, JSON.stringify(installed))
      assert.equal(synced.length, 1)
      const replayed = (await install(appEvent, {
        id: INLINE_ENTRY.id,
        workspaceRoot: openWorkspace,
        trustToken: again.trustToken,
      })) as MarketplacePluginRegistryInstallResult
      assert.equal(replayed.ok, false, 'a token is spent by the install it approved')

      // --- only the app's own window is answered ---
      const fromSubframe = (await verify(subframeEvent, { id: INLINE_ENTRY.id })) as MarketplacePluginVerifyResult
      assert.equal(fromSubframe.classification, 'invalid')
      assert.equal(fromSubframe.trustToken, undefined)
      assert.match(fromSubframe.message ?? '', /did not come from a SprintEngine Studio window/)
      const installFromSubframe = (await install(subframeEvent, {
        id: INLINE_ENTRY.id,
      })) as MarketplacePluginRegistryInstallResult
      assert.equal(installFromSubframe.ok, false)
      const uninstallFromNowhere = (await uninstall({}, { pluginId: INLINE_ENTRY.id })) as { ok: boolean }
      assert.equal(uninstallFromNowhere.ok, false)

      // --- uninstall delegates to the lifecycle ---
      // An id with no receipt is the lifecycle's own sentence, not a throw and
      // not a fabricated success.
      const missing = (await uninstall(appEvent, { pluginId: 'never-installed' })) as { ok: boolean; message?: string }
      assert.equal(missing.ok, false)
      assert.match(missing.message ?? '', /never-installed is not installed/)

      // An empty id is refused before any store is read.
      const blank = (await uninstall(appEvent, { pluginId: '   ' })) as { ok: boolean; message?: string }
      assert.equal(blank.ok, false)
      assert.match(blank.message ?? '', /Plugin id is required/)

      // A malformed envelope is an ok:false result, never an unhandled rejection
      // across the IPC boundary.
      const malformed = (await uninstall(appEvent, undefined)) as { ok: boolean; message?: string }
      assert.equal(malformed.ok, false)

      const removed = (await uninstall(appEvent, {
        pluginId: INLINE_ENTRY.id,
        workspaceRoot: openWorkspace,
      })) as { ok: boolean; message?: string }
      assert.equal(removed.ok, true, removed.message ?? '')

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
