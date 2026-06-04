import assert from 'node:assert/strict'

import { createPluginsApi } from './plugins'
import type { PluginRegistryListResult } from '../../shared/electron-api'

async function main(): Promise<void> {
  const calls: string[] = []
  const response: PluginRegistryListResult = {
    ok: true,
    plugins: [
      { id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' },
      { id: 'opencode', displayName: 'OpenCode', source: 'user', version: 1, binary: 'opencode' },
    ],
  }

  const api = createPluginsApi({
    async invoke(channel) {
      calls.push(channel)
      return response
    },
  })

  const result = await api.pluginsList()
  assert.deepEqual(calls, ['plugins:list'])
  assert.deepEqual(result, response)

  console.log('plugins-preload tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
