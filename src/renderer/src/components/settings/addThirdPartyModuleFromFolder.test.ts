import assert from 'node:assert/strict'

import { addThirdPartyModuleFromFolder } from './addThirdPartyModuleFromFolder'

async function run(): Promise<void> {
  assert.deepEqual(
    await addThirdPartyModuleFromFolder({}),
    { status: 'failed', message: 'Installing extension modules is unavailable in this build.' },
    'a build without the preload bridge reports an unavailable action',
  )

  let installs = 0
  assert.deepEqual(
    await addThirdPartyModuleFromFolder({
      openDir: async () => null,
      installThirdPartyModuleFolder: async () => {
        installs += 1
        return { ok: true }
      },
    }),
    { status: 'cancelled' },
    'closing the folder chooser is a quiet cancellation',
  )
  assert.equal(installs, 0, 'cancellation never calls the installer')

  let selected = ''
  assert.deepEqual(
    await addThirdPartyModuleFromFolder({
      openDir: async () => '/extensions/compass',
      installThirdPartyModuleFolder: async (folder) => {
        selected = folder
        return { ok: true, id: 'acme.compass', trust: 'unsigned' }
      },
    }),
    { status: 'installed', id: 'acme.compass', trust: 'unsigned' },
    'a selected folder is installed through the host and keeps its trust classification',
  )
  assert.equal(selected, '/extensions/compass')

  assert.deepEqual(
    await addThirdPartyModuleFromFolder({
      openDir: async () => '/extensions/not-a-module',
      installThirdPartyModuleFolder: async () => ({
        ok: false,
        issues: [{ path: 'manifest.json', message: 'No valid module manifest was found.' }],
      }),
    }),
    { status: 'failed', message: 'No valid module manifest was found.' },
    'manifest validation failures return the main process explanation',
  )
}

void run().then(() => console.log('addThirdPartyModuleFromFolder.test.ts: ok'))
