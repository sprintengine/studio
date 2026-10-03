import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import { createFakeIpcMain } from '../../main/module-host/ipc-main-fake.test-helper'
import { loadMainModules } from '../../main/module-host/load-modules'
import { computeModuleFileDigestsSync } from '../../main/modules/module-signature'
import {
  NEEDS_ELECTRON_MAIN,
  planThirdPartyMainModules,
  skippedForElectronMain,
} from '../../main/modules/third-party-main-loader'
import type { InstalledModule } from '../../main/modules/user-module-registry'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import { installElectronRequireGuard } from './electron-require-guard'

// Third-party modules whose main half needs Electron, where the main half runs
// in the Studio server (phase 6 spec, 12.4): declared, they load manifest-only;
// undeclared, the require is refused by name and the load says why; and the
// host says it cannot provide `electron-main`.

const scratch = mkdtempSync(join(tmpdir(), 'se-electron-guard-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function trustedModule(id: string, source: string, manifest: Partial<CapabilityManifest> = {}): InstalledModule {
  const moduleRoot = join(scratch, id)
  mkdirSync(moduleRoot, { recursive: true })
  writeFileSync(join(moduleRoot, 'main.cjs'), source)
  const digests = computeModuleFileDigestsSync(moduleRoot)
  assert.ok(digests.ok)
  return {
    moduleRoot,
    manifest: {
      id,
      displayName: id,
      version: 1,
      defaultEnabled: true,
      source: 'third-party',
      engines: { hostApi: 1 },
      entry: { main: 'main.cjs' },
      ...manifest,
    },
    trust: { status: 'trusted', via: 'grant', verifiedFiles: digests.files },
  }
}

test('a module that requires electron from its own folder is refused by name; code elsewhere is not', () => {
  const inside = join(scratch, 'guarded')
  mkdirSync(inside, { recursive: true })
  writeFileSync(join(inside, 'reaches.cjs'), "module.exports = () => require('electron/main')\n")
  const undo = installElectronRequireGuard(() => [inside])
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reaches = require(join(inside, 'reaches.cjs')) as () => unknown
    assert.throws(reaches, (error: unknown) => {
      assert.equal((error as Error).name, 'ElectronUnavailableError', String(error))
      assert.match((error as Error).message, new RegExp(NEEDS_ELECTRON_MAIN))
      return true
    })
  } finally {
    undo()
  }
})

test('a module that declares it needs electron-main loads manifest-only where there is none', () => {
  const declared = trustedModule('needs-electron', 'module.exports = { registerMain() {} }\n', {
    requires: { hostCapabilities: ['electron-main'] },
  })
  const inServer = planThirdPartyMainModules({ modules: [declared], rejected: [] }, { electronMain: false })
  assert.equal(inServer.modules[0].registerMain, undefined)
  assert.equal(skippedForElectronMain('needs-electron'), true)
  // In the desktop's own main process it loads as it always did.
  const inMain = planThirdPartyMainModules({ modules: [declared], rejected: [] })
  assert.equal(typeof inMain.modules[0].registerMain, 'function')
})

test('an undeclared require during registerMain is reported as needing electron-main, not as a crash', () => {
  const undeclared = trustedModule(
    'reaches-for-electron',
    "module.exports = { registerMain(host) { host.registerIpc('x:y', () => 1); require('electron') } }\n",
  )
  const plan = planThirdPartyMainModules({ modules: [undeclared], rejected: [] }, { electronMain: false })
  const undo = installElectronRequireGuard(() => Object.values(plan.moduleRoots))
  try {
    const fake = createFakeIpcMain()
    const loaded = loadMainModules({
      ipcMain: fake.ipcMain,
      modules: plan.modules,
      moduleRoots: plan.moduleRoots,
      electronMain: false,
    })
    const error = loaded.report.errors.find((entry) => entry.id === 'reaches-for-electron')
    assert.ok(error, JSON.stringify(loaded.report))
    assert.match(error.message, new RegExp(NEEDS_ELECTRON_MAIN))
    assert.equal(skippedForElectronMain('reaches-for-electron'), true)
  } finally {
    undo()
  }
})

test("the server's host says it cannot provide electron-main; the desktop's says it can", () => {
  for (const [electronMain, expected] of [
    [false, false],
    [undefined, true],
  ] as const) {
    let answer: boolean | null = null
    loadMainModules({
      ipcMain: createFakeIpcMain().ipcMain,
      modules: [
        {
          manifest: { id: 'probe', displayName: 'Probe', version: 1, defaultEnabled: true },
          registerMain(host) {
            answer = host.supports('electron-main')
          },
        },
      ],
      ...(electronMain === undefined ? {} : { electronMain }),
    })
    assert.equal(answer, expected)
  }
})
