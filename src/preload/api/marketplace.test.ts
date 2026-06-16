import assert from 'node:assert/strict'

import { createMarketplaceApi } from './marketplace'
import type { MarketplacePluginInstallResult, MarketplaceRegistryReadResult } from '../../shared/electron-api'

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

  const api = createMarketplaceApi({
    async invoke(channel: string, ...args: unknown[]) {
      calls.push({ channel, args })
      if (channel === 'marketplace:registry:read') return registryResponse
      return installResponse
    },
  } as unknown as Parameters<typeof createMarketplaceApi>[0])

  const registry = await api.readMarketplaceRegistry({ forceRefresh: true })
  const input = { localFolder: '/tmp/plugin', workspaceRoot: '/tmp/workspace' }
  const installed = await api.installMarketplacePluginFolder(input)
  assert.deepEqual(registry, registryResponse)
  assert.deepEqual(installed, installResponse)
  assert.deepEqual(calls, [
    { channel: 'marketplace:registry:read', args: [{ forceRefresh: true }] },
    { channel: 'marketplace:plugins:install-folder', args: [input] },
  ])

  console.log('marketplace-preload tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
