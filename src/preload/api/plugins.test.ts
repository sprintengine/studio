import assert from 'node:assert/strict'

import { createPluginsApi } from './plugins'
import type { PluginInstallResult, PluginRegistryListResult } from '../../shared/electron-api'
import { test } from 'vitest'

test('plugins', async () => {
  async function main(): Promise<void> {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const listResponse: PluginRegistryListResult = {
      ok: true,
      plugins: [
        {
          id: 'codex',
          displayName: 'Codex',
          source: 'bundled',
          version: 1,
          binary: 'codex',
          resumeSession: true,
          sessionIdFromCaller: false,
          agentStateCapable: true,
        },
        {
          id: 'opencode',
          displayName: 'OpenCode',
          source: 'user',
          version: 1,
          binary: 'opencode',
          resumeSession: false,
          sessionIdFromCaller: false,
          agentStateCapable: true,
        },
      ],
    }
    const installResponse: PluginInstallResult = { ok: true, id: 'opencode', kind: 'cli', displayName: 'OpenCode' }

    const api = createPluginsApi({
      async invoke(channel: string, ...args: unknown[]) {
        calls.push({ channel, args })
        if (channel === 'plugins:install-folder') return installResponse
        return listResponse
      },
    } as unknown as Parameters<typeof createPluginsApi>[0])

    const list = await api.pluginsList()
    assert.deepEqual(list, listResponse)

    const installed = await api.installPluginFolder('/tmp/some-cli')
    assert.deepEqual(installed, installResponse)

    assert.deepEqual(
      calls.map((call) => call.channel),
      ['plugins:list', 'plugins:install-folder'],
    )
    assert.deepEqual(calls[1].args, ['/tmp/some-cli'])

    console.log('plugins-preload tests passed')
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})
