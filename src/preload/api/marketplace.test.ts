import assert from 'node:assert/strict'

import { createMarketplaceApi } from './marketplace'
import type {
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
} from '../../shared/electron-api'
import { test } from 'vitest'

test('marketplace', async () => {
  async function main(): Promise<void> {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const registryResponse: MarketplaceRegistryReadResult = {
      ok: true,
      state: 'empty',
      registryUrl: 'https://example.com/marketplace.json',
      source: 'network',
      stale: false,
      fetchedAt: '2026-06-16T00:00:00.000Z',
      marketplace: { schemaVersion: 1, plugins: [] },
    }
    const registryInstallResponse: MarketplacePluginRegistryInstallResult = {
      ok: true,
      id: 'bundle-plugin',
      displayName: 'Bundle Plugin',
      version: 1,
      trust: 'signed',
      loadEligible: false,
      installed: [{ kind: 'mcp', id: 'bundle-mcp' }],
      classification: 'verified',
      sourceUrl: 'https://example.com/plugins/bundle-plugin/',
      updated: false,
    }
    const inlineInstallResponse: MarketplacePluginRegistryInstallResult = {
      ok: true,
      id: 'inline-mcp-plugin',
      displayName: 'Inline MCP Plugin',
      version: 1,
      trust: 'unsigned',
      loadEligible: false,
      installed: [{ kind: 'mcp', id: 'inline-mcp' }],
      classification: 'unsigned',
      sourceUrl: '',
      updated: false,
    }
    const verifyResponse: MarketplacePluginVerifyResult = {
      classification: 'verified',
      permissions: ['network'],
      sourceUrl: 'https://example.com/plugins/bundle-plugin/',
    }
    const uninstallResponse: MarketplacePluginUninstallResult = {
      ok: true,
      id: 'bundle-plugin',
      removed: [{ kind: 'module', id: 'bundle-module' }],
    }
    const updateStatesResponse: MarketplaceUpdateStatesResult = {
      ok: true,
      checked: true,
      registryState: 'ok',
      registrySource: 'bundled',
      stale: false,
      fetchedAt: '2026-06-16T00:00:00.000Z',
      entries: [
        {
          id: 'bundle-plugin',
          displayName: 'Bundle Plugin',
          availability: { state: 'update-available', installedVersion: 1, latestVersion: 2 },
        },
      ],
    }

    const api = createMarketplaceApi({
      async invoke(channel: string, ...args: unknown[]) {
        calls.push({ channel, args })
        if (channel === 'marketplace:registry:read') return registryResponse
        if (channel === 'marketplace:plugins:verify') return verifyResponse
        if (channel === 'marketplace:plugins:install-entry') {
          const entryInput = args[0] as { entry?: { mcp?: unknown } }
          return entryInput.entry?.mcp ? inlineInstallResponse : registryInstallResponse
        }
        if (channel === 'marketplace:plugins:update-entry') return { ...registryInstallResponse, updated: true }
        if (channel === 'marketplace:plugins:uninstall') return uninstallResponse
        if (channel === 'marketplace:plugins:update-states') return updateStatesResponse
        return registryInstallResponse
      },
    } as unknown as Parameters<typeof createMarketplaceApi>[0])

    const registry = await api.readMarketplaceRegistry({ forceRefresh: true })
    const entryInput = {
      entry: {
        id: 'bundle-plugin',
        name: 'Bundle Plugin',
        publisher: { name: 'SprintEngine Labs', verified: true },
        summary: 'Bundle plugin.',
        category: 'dev-tools',
        icon: 'icons/bundle.svg',
        latest: 1,
        source: 'https://example.com/plugins/bundle-plugin/',
        provides: ['mcp' as const],
        signature: { algorithm: 'ed25519' as const, publicKey: 'YWJj', signature: 'ZGVm' },
      },
      workspaceRoot: '/tmp/workspace',
    }
    const inlineEntryInput = {
      entry: {
        id: 'inline-mcp-plugin',
        name: 'Inline MCP Plugin',
        publisher: { name: 'Community Author', verified: false },
        summary: 'Inline MCP server config.',
        category: 'dev-tools',
        icon: 'icons/inline.svg',
        latest: 1,
        provides: ['mcp' as const],
        mcp: {
          servers: [
            {
              id: 'inline-mcp',
              name: 'inline-mcp',
              transport: 'stdio' as const,
              command: 'node',
              args: ['-e', 'console.log("inline")'],
              clients: ['codex' as const],
              scope: 'workspace' as const,
              source: 'custom' as const,
              enabled: true,
              riskLevel: 'local-command' as const,
            },
          ],
        },
      },
      workspaceRoot: '/tmp/workspace',
      trustGranted: true,
    }
    const verified = await api.verifyMarketplacePlugin(entryInput.entry)
    const registryInstalled = await api.installMarketplacePluginFromRegistry(entryInput)
    const inlineInstalled = await api.installMarketplacePluginFromRegistry(inlineEntryInput)
    const registryUpdated = await api.updateMarketplacePluginFromRegistry({ ...entryInput, trustGranted: true })
    // G3: uninstall speaks the same envelope install does — an MCP component's
    // removal writes the CLI configs, which needs the workspace and settings.
    const uninstallInput = { pluginId: 'bundle-plugin', workspaceRoot: '/tmp/workspace' }
    const uninstalled = await api.uninstallMarketplacePlugin(uninstallInput)
    const updateStates = await api.readMarketplacePluginUpdateStates({ forceRefresh: true })
    assert.deepEqual(registry, registryResponse)
    assert.deepEqual(verified, verifyResponse)
    assert.deepEqual(registryInstalled, registryInstallResponse)
    assert.deepEqual(inlineInstalled, inlineInstallResponse)
    assert.equal(inlineInstalled.ok && inlineInstalled.classification, 'unsigned')
    assert.equal(registryUpdated.updated, true)
    assert.deepEqual(uninstalled, uninstallResponse)
    assert.deepEqual(updateStates, updateStatesResponse)
    assert.deepEqual(calls, [
      { channel: 'marketplace:registry:read', args: [{ forceRefresh: true }] },
      { channel: 'marketplace:plugins:verify', args: [entryInput.entry] },
      { channel: 'marketplace:plugins:install-entry', args: [entryInput] },
      { channel: 'marketplace:plugins:install-entry', args: [inlineEntryInput] },
      { channel: 'marketplace:plugins:update-entry', args: [{ ...entryInput, trustGranted: true }] },
      { channel: 'marketplace:plugins:uninstall', args: [uninstallInput] },
      { channel: 'marketplace:plugins:update-states', args: [{ forceRefresh: true }] },
    ])

    console.log('marketplace-preload tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
