import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { createFakeIpcMain } from '../module-host/ipc-main-fake.test-helper'
import { loadMainModules } from '../module-host/load-modules'
import { computeModuleFileDigestsSync, manifestFingerprint } from './module-signature'
import { planThirdPartyMainModules } from './third-party-main-loader'
import { discoverUserModulesSync } from './user-module-registry'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// An unsigned module on disk the user can trust: its manifest lists the
// digests of its files. The entry registers an IPC channel, so a load shows up
// in what the host handled.
function writeModule(
  id: string,
  options: { files?: boolean; entry?: string } = {},
): { root: string; moduleRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'mc-main-loader-'))
  temps.push(root)
  const moduleRoot = join(root, id)
  mkdirSync(join(moduleRoot, 'dist'), { recursive: true })
  writeFileSync(
    join(moduleRoot, 'dist', 'main.cjs'),
    options.entry ?? `exports.registerMain = (host) => host.registerIpc('${id}:ping', () => 'pong')\n`,
  )
  const manifest = {
    id,
    displayName: id,
    version: 1,
    defaultEnabled: true,
    entry: { main: 'dist/main.cjs' },
    ...(options.files === false ? {} : { files: computeModuleFileDigestsSync(moduleRoot).files }),
  }
  writeFileSync(join(moduleRoot, 'manifest.json'), JSON.stringify(manifest))
  return { root, moduleRoot }
}

// The grant Settings → Modules records: the listed manifest's fingerprint.
function grantFor(root: string, id: string): ReadonlyMap<string, string> {
  const { modules } = discoverUserModulesSync(root, { trustedModules: new Map() })
  const module = modules.find((entry) => entry.manifest.id === id)
  assert.ok(module)
  return new Map([[id, manifestFingerprint(module.manifest)]])
}

test('a trusted module whose files are unchanged loads', () => {
  const { root } = writeModule('steady')
  const planned = planThirdPartyMainModules(discoverUserModulesSync(root, { trustedModules: grantFor(root, 'steady') }))
  const { ipcMain, handled } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, ['steady'])
  assert.ok(handled.includes('steady:ping'))
})

test('an entry swapped between discovery and load is refused, not run', () => {
  const { root, moduleRoot } = writeModule('swapped')
  const planned = planThirdPartyMainModules(
    discoverUserModulesSync(root, { trustedModules: grantFor(root, 'swapped') }),
  )
  // Discovery verified the files; the swap lands before registerMain runs.
  writeFileSync(
    join(moduleRoot, 'dist', 'main.cjs'),
    "exports.registerMain = (host) => host.registerIpc('swapped:evil', () => 'pwned')\n",
  )

  const { ipcMain, handled } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, [])
  assert.equal(handled.includes('swapped:evil'), false)
  assert.equal(report.errors[0]?.id, 'swapped')
  assert.match(report.errors[0]?.message ?? '', /changed after they were verified/)
  assert.match(report.errors[0]?.message ?? '', /files\.dist\/main\.cjs/)
})

test('a file added beside the entry between discovery and load is refused too', () => {
  const { root, moduleRoot } = writeModule('added')
  const planned = planThirdPartyMainModules(discoverUserModulesSync(root, { trustedModules: grantFor(root, 'added') }))
  writeFileSync(join(moduleRoot, 'dist', 'chunk.cjs'), 'module.exports = 1\n')

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, [])
  assert.match(report.errors[0]?.message ?? '', /files\.dist\/chunk\.cjs: is not listed/)
})

test('a user-trusted module whose manifest lists no files does not load', () => {
  const { root } = writeModule('undigested', { files: false })
  const planned = planThirdPartyMainModules(
    discoverUserModulesSync(root, { trustedModules: grantFor(root, 'undigested') }),
  )
  const { ipcMain, handled } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: planned.modules, ineligible: planned.ineligible })
  assert.deepEqual(report.loaded, [])
  assert.equal(handled.includes('undigested:ping'), false)
  assert.equal(planned.ineligible.undigested, 'untrusted')
})

test("an async registerMain's rejection reaches the loader, which drops the module", async () => {
  const { root } = writeModule('async-fails', {
    entry: 'exports.registerMain = async () => { throw new Error("boot failed") }\n',
  })
  const planned = planThirdPartyMainModules(
    discoverUserModulesSync(root, { trustedModules: grantFor(root, 'async-fails') }),
  )
  const { ipcMain } = createFakeIpcMain()
  const loaded = loadMainModules({ ipcMain, modules: planned.modules, ineligible: planned.ineligible })
  await loaded.ready
  assert.equal(loaded.report.loaded.includes('async-fails'), false)
  assert.match(loaded.report.errors.find((error) => error.id === 'async-fails')?.message ?? '', /boot failed/)
})
