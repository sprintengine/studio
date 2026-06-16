import assert from 'node:assert/strict'

import { createMarketplaceApi } from './marketplace'
import type { MarketplacePluginInstallResult } from '../../shared/electron-api'

async function main(): Promise<void> {
  const calls: Array<{ channel: string; args: unknown[] }> = []
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
      return installResponse
    },
  } as unknown as Parameters<typeof createMarketplaceApi>[0])

  const input = { localFolder: '/tmp/plugin', workspaceRoot: '/tmp/workspace' }
  const installed = await api.installMarketplacePluginFolder(input)
  assert.deepEqual(installed, installResponse)
  assert.deepEqual(calls, [{ channel: 'marketplace:plugins:install-folder', args: [input] }])

  console.log('marketplace-preload tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
