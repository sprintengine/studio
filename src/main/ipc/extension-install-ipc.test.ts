/**
 * Install extension from GitHub and uninstall, at the IPC boundary.
 *
 * What only these channels can be wrong about: that a GitHub install needs a
 * token a GitHub review issued (not a registry one, not a spent one), that
 * unsigned code needs the person's own "I trust this code", that an update
 * asks again only when the disclosure changed, and that uninstall removes a
 * module however it arrived — through its receipt when it has one, by its
 * folder (and only that folder) when it does not — and forgets its trust,
 * enablement choice and secrets with it.
 *
 * The handlers run for real against a scratch userData and module root; GitHub
 * is the recorded repository in marketplace/__fixtures__/github-extension-repo.ts.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, vi } from 'vitest'

import type {
  GithubExtensionCheckUpdateResult,
  GithubExtensionResolveResult,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadResult,
  ThirdPartyModuleUninstallResult,
} from '../../shared/electron-api'
import { PLUGIN_JSON, SHA, extensionRepo, github, type Served } from '../marketplace/__fixtures__/github-extension-repo'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

test('extension install and uninstall IPC', async () => {
  type Handler = (event: unknown, input: unknown) => Promise<unknown>
  const { webContents } = await import('../../../tests/stubs/electron')
  delete process.env['ELECTRON_RENDERER_URL']
  const appEvent = {
    sender: webContents,
    senderFrame: { parent: null, url: pathToFileURL('/Applications/Studio.app/out/renderer/index.html').href },
  }
  const subframeEvent = { ...appEvent, senderFrame: { ...appEvent.senderFrame, parent: {} } }

  const userData = mkdtempSync(join(tmpdir(), 'mc-extension-install-ipc-'))
  const moduleRoot = join(userData, 'modules')
  const openWorkspace = join(userData, 'workspace')
  mkdirSync(openWorkspace, { recursive: true })
  process.env.SPRINTENGINE_USER_DATA_DIR = userData
  process.env.SPRINTENGINE_USER_MODULE_ROOT = moduleRoot

  try {
    const { registerMarketplacePluginIpc } = await import('./marketplace-plugin-ipc')
    const { registerThirdPartyModuleIpc } = await import('./third-party-module-ipc')
    const { readTrustedModulesSync, setModuleTrust } = await import('../modules/trust-store')
    const { readModuleOverridesSync, writeModuleOverrides } = await import('../module-host/enablement-store')

    // GitHub as it is right now; a test moves the branch by replacing it.
    let repo: Served = github(extensionRepo())
    const registry: MarketplaceRegistryReadResult = {
      ok: true,
      state: 'ok',
      registryUrl: 'https://registry.test/marketplace.json',
      source: 'bundled',
      stale: false,
      fetchedAt: '2026-09-29T00:00:00.000Z',
      marketplace: {
        schemaVersion: 1,
        plugins: [
          {
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
          },
        ],
      },
    }
    const services = {
      mcpConfigService: { sync: () => ({ ok: true, targets: [] }) },
      workspaceSyncService: { getSnapshot: () => ({ state: { workspaces: [{ folderPath: openWorkspace }] } }) },
    } as unknown as Parameters<typeof registerMarketplacePluginIpc>[1]
    const handlers = new Map<string, Handler>()
    const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) } as unknown as Parameters<
      typeof registerMarketplacePluginIpc
    >[0]
    registerMarketplacePluginIpc(ipcMain, services, {
      registryReader: { read: async () => registry },
      fetcher: (url, init) => repo.fetcher(url, init),
    })
    registerThirdPartyModuleIpc(ipcMain, services)

    for (const channel of [
      'extensions:github:resolve',
      'extensions:github:install',
      'extensions:github:check-update',
      'modules:third-party:uninstall',
    ]) {
      assert.ok(handlers.has(channel), `${channel} is registered`)
    }
    const resolve = (event: unknown, input: unknown) =>
      handlers.get('extensions:github:resolve')!(event, input) as Promise<GithubExtensionResolveResult>
    const install = (event: unknown, input: unknown) =>
      handlers.get('extensions:github:install')!(event, input) as Promise<MarketplacePluginRegistryInstallResult>
    const checkUpdate = (input: unknown) =>
      handlers.get('extensions:github:check-update')!(appEvent, input) as Promise<GithubExtensionCheckUpdateResult>
    const uninstall = (event: unknown, input: unknown) =>
      handlers.get('modules:third-party:uninstall')!(event, input) as Promise<ThirdPartyModuleUninstallResult>

    // ── resolve: only the app window, only a GitHub URL ──────────────────────────
    const foreign = await resolve(subframeEvent, { url: 'https://github.com/acme/notes-ext' })
    assert.equal(foreign.ok, false)
    assert.match(foreign.ok ? '' : foreign.message, /did not come from a SprintEngine Studio window/)
    assert.equal((await resolve(appEvent, { url: '' })).ok, false)

    const reviewed = await resolve(appEvent, { url: 'https://github.com/acme/notes-ext' })
    assert.equal(reviewed.ok, true, reviewed.ok ? '' : reviewed.message)
    if (!reviewed.ok) return
    assert.equal(reviewed.preview.id, 'notes-ext')
    assert.equal(reviewed.preview.verify.classification, 'unsigned')
    assert.equal(reviewed.preview.verify.codeBearing, true)
    assert.equal(reviewed.preview.verify.pin?.commitSha, SHA)
    assert.deepEqual(reviewed.preview.origin, {
      url: 'https://github.com/acme/notes-ext',
      owner: 'acme',
      repo: 'notes-ext',
    })
    assert.equal(reviewed.preview.installed, undefined)

    // ── install: unsigned code needs "I trust this code", and the token is spent
    const unconfirmed = await install(appEvent, { trustToken: reviewed.trustToken })
    assert.equal(unconfirmed.ok, false)
    assert.match(unconfirmed.ok ? '' : unconfirmed.message, /confirm you trust the code/)
    const replayed = await install(appEvent, { trustToken: reviewed.trustToken, trustCode: true })
    assert.equal(replayed.ok, false, 'the refused request spent the token')
    assert.match(replayed.ok ? '' : replayed.message, /expired or was already used/)

    // A registry verify's token does not install here.
    const registryVerify = (await handlers.get('marketplace:plugins:verify')!(appEvent, {
      id: 'inline-mcp-plugin',
    })) as MarketplacePluginVerifyResult
    const crossed = await install(appEvent, { trustToken: registryVerify.trustToken, trustCode: true })
    assert.equal(crossed.ok, false)

    const again = await resolve(appEvent, { url: 'acme/notes-ext' })
    assert.ok(again.ok)
    const fromSubframe = await install(subframeEvent, { trustToken: again.trustToken, trustCode: true })
    assert.equal(fromSubframe.ok, false)
    const installed = await install(appEvent, { trustToken: again.trustToken, trustCode: true })
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    assert.ok(existsSync(join(moduleRoot, 'notes-ext', 'manifest.json')))
    assert.ok(readTrustedModulesSync(userData).has('notes-ext'), 'the review was the trust decision')

    // ── updates compare the branch's commit, and ask again only on change ───────
    const current = await checkUpdate({ id: 'notes-ext' })
    assert.deepEqual(current, { ok: true, state: 'current', sha: SHA })

    const moved = 'b2c3d4e'.padEnd(40, '0')
    repo = github(extensionRepo(), { sha: moved })
    const quiet = await checkUpdate({ id: 'notes-ext' })
    assert.equal(quiet.ok && quiet.state, 'available')
    if (quiet.ok && quiet.state === 'available') {
      assert.equal(quiet.reviewRequired, false, 'same permissions, servers and signing: no second prompt')
      assert.equal(quiet.preview.verify.pin?.commitSha, moved)
      assert.deepEqual(quiet.preview.installed?.changes, [])
      assert.equal(quiet.preview.installed?.sha, SHA)
    }

    const widened = JSON.stringify({ ...JSON.parse(PLUGIN_JSON), permissions: ['storage', 'network'] })
    repo = github(extensionRepo({ 'plugin.json': widened }), { sha: moved })
    const loud = await checkUpdate({ id: 'notes-ext' })
    assert.equal(loud.ok && loud.state, 'available')
    if (loud.ok && loud.state === 'available') {
      assert.equal(loud.reviewRequired, true)
      assert.deepEqual(loud.preview.installed?.changes, ['permissions'])
    }
    assert.equal((await checkUpdate({ id: 'inline-mcp-plugin' })).ok, false, 'not a GitHub install')

    // ── uninstall: a receipt-owned module goes out through its receipt ──────────
    await writeModuleOverrides(userData, { 'notes-ext': true })
    assert.equal((await uninstall(subframeEvent, { id: 'notes-ext' })).ok, false)
    const removed = await uninstall(appEvent, { id: 'notes-ext' })
    assert.equal(removed.ok, true, removed.ok ? '' : removed.message)
    assert.deepEqual(removed.ok && removed.removedModuleIds, ['notes-ext'])
    assert.equal(existsSync(join(moduleRoot, 'notes-ext')), false)
    assert.equal(readTrustedModulesSync(userData).has('notes-ext'), false)
    assert.equal('notes-ext' in readModuleOverridesSync(userData), false)
    const receipts = JSON.parse(readFileSync(join(userData, 'marketplace-plugin-installs.json'), 'utf8'))
    assert.equal(receipts.plugins['notes-ext'], undefined, 'the receipt goes with it')

    // ── uninstall: a folder-installed module, with everything kept about it ─────
    const folder = join(moduleRoot, 'folder-mod')
    mkdirSync(join(folder, 'dist'), { recursive: true })
    writeFileSync(join(folder, 'dist', 'renderer.mjs'), 'export default () => {}\n')
    writeFileSync(
      join(folder, 'manifest.json'),
      JSON.stringify({
        id: 'folder-mod',
        displayName: 'Folder module',
        version: 1,
        defaultEnabled: false,
        source: 'third-party',
        engines: { hostApi: 1 },
        entry: { renderer: 'dist/renderer.mjs' },
      }),
    )
    await setModuleTrust(userData, 'folder-mod', 'f'.repeat(64))
    await writeModuleOverrides(userData, { 'folder-mod': true, 'other-mod': false })
    const secrets = join(userData, 'module-secrets', 'folder-mod.bin')
    mkdirSync(join(userData, 'module-secrets'), { recursive: true })
    writeFileSync(secrets, 'sealed')
    // A sibling outside the module root must survive whatever id is asked for.
    const outside = join(userData, 'outside')
    mkdirSync(outside, { recursive: true })

    for (const id of ['', '..', '../outside', 'a/b']) {
      const refused = await uninstall(appEvent, { id })
      assert.equal(refused.ok, false, `"${id}" is not a module id`)
    }
    const unknown = await uninstall(appEvent, { id: 'never-installed' })
    assert.match(unknown.ok ? '' : unknown.message, /is not installed/)

    const folderRemoved = await uninstall(appEvent, { id: 'folder-mod' })
    assert.equal(folderRemoved.ok, true, folderRemoved.ok ? '' : folderRemoved.message)
    assert.equal(existsSync(folder), false)
    assert.ok(existsSync(outside))
    assert.ok(existsSync(moduleRoot), 'the module root itself stays')
    assert.equal(readTrustedModulesSync(userData).has('folder-mod'), false)
    assert.deepEqual(readModuleOverridesSync(userData), { 'other-mod': false })
    assert.equal(existsSync(secrets), false, 'a later module with this id inherits no secrets')
  } finally {
    delete process.env.SPRINTENGINE_USER_MODULE_ROOT
    rmSync(userData, { recursive: true, force: true })
  }
})
