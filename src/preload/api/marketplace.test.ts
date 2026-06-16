import assert from 'node:assert/strict'

import { createMarketplaceApi } from './marketplace'
import type {
  MarketplacePluginInstallResult,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadResult,
} from '../../shared/electron-api'

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
  const installResponse: MarketplacePluginInstallResult = {
    ok: true,
    id: 'bundle-plugin',
    displayName: 'Bundle Plugin',
    version: 1,
    trust: 'signed',
    loadEligible: false,
    installed: [{ kind: 'mcp', id: 'bundle-mcp' }],
  }
  const registryInstallResponse: MarketplacePluginRegistryInstallResult = {
    ...installResponse,
    classification: 'verified',
    sourceUrl: 'https://example.com/plugins/bundle-plugin/',
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
    removed: [{ kind: 'mcp', id: 'bundle-mcp' }],
  }

  const api = createMarketplaceApi({
    async invoke(channel: string, ...args: unknown[]) {
      calls.push({ channel, args })
      if (channel === 'marketplace:registry:read') return registryResponse
      if (channel === 'marketplace:plugins:verify') return verifyResponse
      if (channel === 'marketplace:plugins:install-entry') return registryInstallResponse
      if (channel === 'marketplace:plugins:update-entry') return { ...registryInstallResponse, updated: true }
      if (channel === 'marketplace:plugins:uninstall') return uninstallResponse
      return installResponse
    },
  } as unknown as Parameters<typeof createMarketplaceApi>[0])

  const registry = await api.readMarketplaceRegistry({ forceRefresh: true })
  const input = { localFolder: '/tmp/plugin', workspaceRoot: '/tmp/workspace' }
  const installed = await api.installMarketplacePluginFolder(input)
  const entryInput = {
    entry: {
      id: 'bundle-plugin',
      name: 'Bundle Plugin',
      publisher: { name: 'Multicode Labs', verified: true },
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
  const verified = await api.verifyMarketplacePlugin(entryInput.entry)
  const registryInstalled = await api.installMarketplacePluginFromRegistry(entryInput)
  const registryUpdated = await api.updateMarketplacePluginFromRegistry({ ...entryInput, trustGranted: true })
  const uninstalled = await api.uninstallMarketplacePlugin({ pluginId: 'bundle-plugin', workspaceRoot: '/tmp/workspace' })
  assert.deepEqual(registry, registryResponse)
  assert.deepEqual(installed, installResponse)
  assert.deepEqual(verified, verifyResponse)
  assert.deepEqual(registryInstalled, registryInstallResponse)
  assert.equal(registryUpdated.updated, true)
  assert.deepEqual(uninstalled, uninstallResponse)
  assert.deepEqual(calls, [
    { channel: 'marketplace:registry:read', args: [{ forceRefresh: true }] },
    { channel: 'marketplace:plugins:install-folder', args: [input] },
    { channel: 'marketplace:plugins:verify', args: [entryInput.entry] },
    { channel: 'marketplace:plugins:install-entry', args: [entryInput] },
    { channel: 'marketplace:plugins:update-entry', args: [{ ...entryInput, trustGranted: true }] },
    { channel: 'marketplace:plugins:uninstall', args: [{ pluginId: 'bundle-plugin', workspaceRoot: '/tmp/workspace' }] },
  ])

  console.log('marketplace-preload tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
