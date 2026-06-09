import assert from 'node:assert/strict'

import { createModulesApi } from './modules'
import type { ModuleEnablementWriteResult } from '../../shared/electron-api'
import type {
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
} from '../../shared/modules/manifest'

async function main(): Promise<void> {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const listResponse: ThirdPartyModuleListResult = {
    modules: [
      {
        manifest: {
          id: 'trusted-main',
          displayName: 'Trusted main',
          version: 1,
          defaultEnabled: true,
          source: 'third-party',
          entry: { main: 'main.cjs' },
        },
        trust: 'trusted',
        launch: {
          status: 'trusted_executable',
          hasMainEntry: true,
          expectedToLoad: true,
        },
      },
    ],
    rejected: [],
  }
  const installResponse: ThirdPartyModuleInstallResult = { ok: true, id: 'trusted-main', trust: 'unsigned' }
  const trustResponse: ThirdPartyModuleTrustResult = { ok: true }
  const enablementResponse: ModuleEnablementWriteResult = { ok: true }

  const api = createModulesApi({
    async invoke(channel: string, ...args: unknown[]) {
      calls.push({ channel, args })
      if (channel === 'modules:third-party:list') return listResponse
      if (channel === 'modules:third-party:install-folder') return installResponse
      if (channel === 'modules:third-party:set-trust') return trustResponse
      if (channel === 'modules:set-enablement') return enablementResponse
      throw new Error(`unexpected channel ${channel}`)
    },
  } as Parameters<typeof createModulesApi>[0])

  assert.deepEqual(await api.listThirdPartyModules(), listResponse)
  assert.deepEqual(await api.installThirdPartyModuleFolder('/tmp/module'), installResponse)
  assert.deepEqual(await api.setThirdPartyModuleTrust('trusted-main', true), trustResponse)
  assert.deepEqual(await api.setModuleEnablement({ 'trusted-main': true }), enablementResponse)
  assert.deepEqual(calls, [
    { channel: 'modules:third-party:list', args: [] },
    { channel: 'modules:third-party:install-folder', args: ['/tmp/module'] },
    { channel: 'modules:third-party:set-trust', args: [{ id: 'trusted-main', trusted: true }] },
    { channel: 'modules:set-enablement', args: [{ 'trusted-main': true }] },
  ])

  console.log('modules-preload tests passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
