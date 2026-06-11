import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import { MODULE_NOTIFICATIONS_RECENT_CHANNEL } from '../../shared/modules/notifications'
import { planThirdPartyMainModules } from '../modules/third-party-main-loader'
import type { InstalledModule } from '../modules/user-module-registry'
import { loadMainModules, type CapabilityModule } from './load-modules'
import { createServiceToken } from './main-host'

function createFakeIpcMain(): { ipcMain: IpcMain; handled: string[] } {
  const handled: string[] = []
  const ipcMain = {
    handle(channel: string, _handler: unknown): void {
      handled.push(channel)
    },
  } as unknown as IpcMain
  return { ipcMain, handled }
}

async function main(): Promise<void> {
  testEnabledModulesRegisterInDependencyOrder()
  testDisabledModuleNeverRegisters()
  testProvideServicesSeedsBeforeModules()
  testCrossModuleServiceWiring()
  testThrowingModuleIsIsolated()
  testDuplicateChannelIsReportedNotFatal()
  testLifecycleAndSidecarsCollected()
  await testRunStartupAndShutdownInvokeHooks()
  await testTrustedThirdPartyMainRegistersThroughHost()
  await testUntrustedAndInvalidThirdPartyMainNeverImports()
  await testThirdPartyPathSafetyAndBadEntriesAreLaunchErrors()
  testRejectedThirdPartyManifestIsLaunchError()
  await testTrustedThirdPartyRegistrationThrowIsIsolated()
  await testThirdPartyIneligibleDependencyCascades()

  console.log('module-host tests passed')
}

function testEnabledModulesRegisterInDependencyOrder(): void {
  const order: string[] = []
  const runtime: CapabilityModule = {
    manifest: { id: 'runtime', displayName: 'Runtime', version: 1, defaultEnabled: true, core: true },
    registerMain: () => order.push('runtime'),
  }
  const feature: CapabilityModule = {
    manifest: {
      id: 'feature',
      displayName: 'Feature',
      version: 1,
      defaultEnabled: true,
      dependsOn: ['runtime'],
    },
    registerMain: () => order.push('feature'),
  }

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: [feature, runtime] })

  assert.deepEqual(order, ['runtime', 'feature'])
  assert.deepEqual(report.loaded, ['runtime', 'feature'])
  assert.deepEqual(report.errors, [])
}

function testDisabledModuleNeverRegisters(): void {
  let registered = false
  const off: CapabilityModule = {
    manifest: { id: 'off', displayName: 'Off', version: 1, defaultEnabled: false },
    registerMain: () => {
      registered = true
    },
  }

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: [off] })

  assert.equal(registered, false, 'disabled module must not register')
  assert.deepEqual(report.loaded, [])
  assert.deepEqual(report.manifestOnly, [])
  assert.deepEqual(report.disabled, ['off'])
}

function testProvideServicesSeedsBeforeModules(): void {
  const token = createServiceToken<{ name: string }>('seeded.service')
  let seen: { name: string } | null = null
  const consumer: CapabilityModule = {
    manifest: { id: 'consumer', displayName: 'Consumer', version: 1, defaultEnabled: true },
    registerMain: (host) => {
      seen = host.requireService(token)
    },
  }

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({
    ipcMain,
    modules: [consumer],
    provideServices: (host) => host.provideService(token, () => ({ name: 'seeded' })),
  })

  assert.deepEqual(report.errors, [])
  assert.deepEqual(seen, { name: 'seeded' })
}

function testCrossModuleServiceWiring(): void {
  const token = createServiceToken<{ value: number }>('test.service')
  let received: { value: number } | null = null

  const provider: CapabilityModule = {
    manifest: { id: 'provider', displayName: 'Provider', version: 1, defaultEnabled: true },
    registerMain: (host) => {
      host.provideService(token, () => ({ value: 42 }))
    },
  }
  const consumer: CapabilityModule = {
    manifest: {
      id: 'consumer',
      displayName: 'Consumer',
      version: 1,
      defaultEnabled: true,
      dependsOn: ['provider'],
    },
    registerMain: (host) => {
      received = host.requireService(token)
    },
  }

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: [consumer, provider] })

  assert.deepEqual(report.errors, [])
  assert.deepEqual(received, { value: 42 })
}

function testThrowingModuleIsIsolated(): void {
  const bad: CapabilityModule = {
    manifest: { id: 'bad', displayName: 'Bad', version: 1, defaultEnabled: true },
    registerMain: () => {
      throw new Error('boom')
    },
  }
  const good: CapabilityModule = {
    manifest: { id: 'good', displayName: 'Good', version: 1, defaultEnabled: true },
    registerMain: (host) => host.registerIpc('good:ping', () => 'pong'),
  }

  const { ipcMain, handled } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: [bad, good] })

  assert.deepEqual(report.loaded, ['good'], 'a throwing module must not abort the others')
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].id, 'bad')
  assert.deepEqual(handled, [MODULE_NOTIFICATIONS_RECENT_CHANNEL, 'good:ping'])
}

function testDuplicateChannelIsReportedNotFatal(): void {
  const first: CapabilityModule = {
    manifest: { id: 'first', displayName: 'First', version: 1, defaultEnabled: true },
    registerMain: (host) => host.registerIpc('shared:channel', () => 1),
  }
  const second: CapabilityModule = {
    manifest: { id: 'second', displayName: 'Second', version: 1, defaultEnabled: true },
    registerMain: (host) => host.registerIpc('shared:channel', () => 2),
  }

  const { ipcMain, handled } = createFakeIpcMain()
  const { report, kernel } = loadMainModules({ ipcMain, modules: [first, second] })

  assert.deepEqual(report.loaded, ['first'])
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].id, 'second')
  assert.deepEqual(handled, [MODULE_NOTIFICATIONS_RECENT_CHANNEL, 'shared:channel'], 'channel handled exactly once')
  assert.equal(kernel.ownedChannels().get('shared:channel'), 'first')
}

function testLifecycleAndSidecarsCollected(): void {
  const mod: CapabilityModule = {
    manifest: { id: 'svc', displayName: 'Svc', version: 1, defaultEnabled: true },
    registerMain: (host) => {
      host.onStartup(() => undefined)
      host.onShutdown(() => undefined)
      host.registerSidecar({ id: 'svc-py', kind: 'python', module: 'svc_core' })
    },
  }

  const { ipcMain } = createFakeIpcMain()
  const { kernel, report } = loadMainModules({ ipcMain, modules: [mod] })

  assert.equal(kernel.startupHooks().length, 1)
  assert.equal(kernel.shutdownHooks().length, 1)
  assert.deepEqual(report.sidecars, [{ id: 'svc-py', kind: 'python', module: 'svc_core' }])
}

async function testRunStartupAndShutdownInvokeHooks(): Promise<void> {
  const order: string[] = []
  const mod: CapabilityModule = {
    manifest: { id: 'svc', displayName: 'Svc', version: 1, defaultEnabled: true },
    registerMain: (host) => {
      host.onStartup(() => {
        order.push('start')
      })
      host.onShutdown(() => {
        throw new Error('shutdown boom')
      })
      host.onShutdown(async () => {
        order.push('stop')
      })
    },
  }

  const { ipcMain } = createFakeIpcMain()
  const { kernel } = loadMainModules({ ipcMain, modules: [mod] })

  await kernel.runStartup()
  await kernel.runShutdown()

  // Startup ran; shutdown ran in reverse registration order and isolated the
  // throwing hook so the later-registered hook still ran.
  assert.deepEqual(order, ['start', 'stop'])
}

async function testTrustedThirdPartyMainRegistersThroughHost(): Promise<void> {
  const moduleRoot = await createThirdPartyModuleRoot('trusted')
  await writeFile(
    join(moduleRoot, 'main.cjs'),
    "exports.registerMain = (host) => host.registerIpc('trusted:ping', () => 'pong')\n"
  )
  const planned = planThirdPartyMainModules({
    modules: [installedThirdPartyModule({ id: 'trusted', moduleRoot, trust: 'trusted', main: 'main.cjs' })],
    rejected: [],
  })

  const { ipcMain, handled } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: planned.modules, ineligible: planned.ineligible })

  assert.deepEqual(report.loaded, ['trusted'])
  assert.deepEqual(report.manifestOnly, [])
  assert.deepEqual(report.errors, [])
  assert.deepEqual(handled, [MODULE_NOTIFICATIONS_RECENT_CHANNEL, 'trusted:ping'])
}

async function testUntrustedAndInvalidThirdPartyMainNeverImports(): Promise<void> {
  const unsignedRoot = await createThirdPartyModuleRoot('unsigned')
  const signedRoot = await createThirdPartyModuleRoot('signed')
  const invalidRoot = await createThirdPartyModuleRoot('invalid')
  await Promise.all(
    [unsignedRoot, signedRoot, invalidRoot].map((moduleRoot) =>
      writeFile(join(moduleRoot, 'main.cjs'), "throw new Error('entry must not import')\n")
    )
  )
  const planned = planThirdPartyMainModules({
    modules: [
      installedThirdPartyModule({ id: 'unsigned', moduleRoot: unsignedRoot, trust: 'unsigned', main: 'main.cjs' }),
      installedThirdPartyModule({ id: 'signed', moduleRoot: signedRoot, trust: 'signed', main: 'main.cjs' }),
      installedThirdPartyModule({ id: 'invalid', moduleRoot: invalidRoot, trust: 'invalid', main: 'main.cjs' }),
    ],
    rejected: [],
  })

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: planned.modules, ineligible: planned.ineligible })

  assert.deepEqual(report.loaded, [])
  assert.deepEqual(report.manifestOnly, [])
  assert.deepEqual(
    report.errors.map((error) => ({ id: error.id, message: error.message })),
    [
      { id: 'invalid', message: 'Module "invalid" has an invalid signature and will not load.' },
      { id: 'signed', message: 'Module "signed" is not trusted yet; trust it in Settings → Modules to enable.' },
      { id: 'unsigned', message: 'Module "unsigned" is not trusted yet; trust it in Settings → Modules to enable.' },
    ]
  )
}

async function testThirdPartyPathSafetyAndBadEntriesAreLaunchErrors(): Promise<void> {
  const missingEntryRoot = await createThirdPartyModuleRoot('manifest-only')
  const escapedRoot = await createThirdPartyModuleRoot('escaped')
  const badExportRoot = await createThirdPartyModuleRoot('bad-export')
  const importFailureRoot = await createThirdPartyModuleRoot('import-failure')
  await writeFile(join(badExportRoot, 'main.cjs'), 'exports.registerMain = 42\n')
  const good: CapabilityModule = {
    manifest: { id: 'good', displayName: 'Good', version: 1, defaultEnabled: true },
    registerMain: (host) => host.registerIpc('good:ping', () => 'pong'),
  }
  const planned = planThirdPartyMainModules({
    modules: [
      installedThirdPartyModule({ id: 'manifest-only', moduleRoot: missingEntryRoot, trust: 'trusted' }),
      installedThirdPartyModule({ id: 'escaped', moduleRoot: escapedRoot, trust: 'trusted', main: '../outside.cjs' }),
      installedThirdPartyModule({ id: 'bad-export', moduleRoot: badExportRoot, trust: 'trusted', main: 'main.cjs' }),
      installedThirdPartyModule({
        id: 'import-failure',
        moduleRoot: importFailureRoot,
        trust: 'trusted',
        main: 'missing.cjs',
      }),
    ],
    rejected: [],
  })

  const { ipcMain, handled } = createFakeIpcMain()
  const { report } = loadMainModules({
    ipcMain,
    modules: [...planned.modules, good],
    ineligible: planned.ineligible,
  })

  assert.deepEqual(report.loaded, ['good'])
  assert.deepEqual(report.manifestOnly, ['manifest-only'])
  assert.deepEqual(handled, [MODULE_NOTIFICATIONS_RECENT_CHANNEL, 'good:ping'])
  assert.equal(report.errors.length, 3)
  assert.equal(report.errors.find((error) => error.id === 'escaped')?.message, 'entry.main must resolve inside the module root.')
  assert.equal(
    report.errors.find((error) => error.id === 'bad-export')?.message,
    'entry.main must export a callable registerMain(host).'
  )
  assert.match(report.errors.find((error) => error.id === 'import-failure')?.message ?? '', /Cannot find module/)
}

function testRejectedThirdPartyManifestIsLaunchError(): void {
  const planned = planThirdPartyMainModules({
    modules: [],
    rejected: [
      {
        path: 'broken/manifest.json',
        issues: [{ path: 'entry.main', message: 'must be a safe relative path inside the module.' }],
      },
    ],
  })

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({
    ipcMain,
    modules: planned.modules,
    launchErrors: planned.launchErrors,
  })

  assert.deepEqual(report.loaded, [])
  assert.deepEqual(report.manifestOnly, [])
  assert.deepEqual(report.errors, [
    {
      id: 'broken/manifest.json',
      message: 'entry.main: must be a safe relative path inside the module.',
    },
  ])
}

async function testTrustedThirdPartyRegistrationThrowIsIsolated(): Promise<void> {
  const badRoot = await createThirdPartyModuleRoot('bad')
  await writeFile(join(badRoot, 'main.cjs'), "exports.registerMain = () => { throw new Error('boom') }\n")
  const good: CapabilityModule = {
    manifest: { id: 'good', displayName: 'Good', version: 1, defaultEnabled: true },
    registerMain: (host) => host.registerIpc('good:ping', () => 'pong'),
  }
  const planned = planThirdPartyMainModules({
    modules: [installedThirdPartyModule({ id: 'bad', moduleRoot: badRoot, trust: 'trusted', main: 'main.cjs' })],
    rejected: [],
  })

  const { ipcMain, handled } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: [...planned.modules, good] })

  assert.deepEqual(report.loaded, ['good'])
  assert.deepEqual(handled, [MODULE_NOTIFICATIONS_RECENT_CHANNEL, 'good:ping'])
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0].id, 'bad')
  assert.equal(report.errors[0].message, 'boom')
}

async function testThirdPartyIneligibleDependencyCascades(): Promise<void> {
  const dependencyRoot = await createThirdPartyModuleRoot('dependency')
  const dependentRoot = await createThirdPartyModuleRoot('dependent')
  await writeFile(join(dependencyRoot, 'main.cjs'), "throw new Error('dependency must not import')\n")
  await writeFile(join(dependentRoot, 'main.cjs'), "exports.registerMain = () => undefined\n")
  const planned = planThirdPartyMainModules({
    modules: [
      installedThirdPartyModule({ id: 'dependency', moduleRoot: dependencyRoot, trust: 'unsigned', main: 'main.cjs' }),
      installedThirdPartyModule({
        id: 'dependent',
        moduleRoot: dependentRoot,
        trust: 'trusted',
        main: 'main.cjs',
        dependsOn: ['dependency'],
      }),
    ],
    rejected: [],
  })

  const { ipcMain } = createFakeIpcMain()
  const { report } = loadMainModules({ ipcMain, modules: planned.modules, ineligible: planned.ineligible })

  assert.deepEqual(report.loaded, [])
  assert.deepEqual(
    report.errors.map((error) => ({ id: error.id, message: error.message })),
    [
      { id: 'dependency', message: 'Module "dependency" is not trusted yet; trust it in Settings → Modules to enable.' },
      { id: 'dependent', message: 'Module "dependent" requires "dependency", which is not enabled.' },
    ]
  )
}

async function createThirdPartyModuleRoot(id: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `mc-third-party-${id}-`))
}

function installedThirdPartyModule(options: {
  id: string
  moduleRoot: string
  trust: InstalledModule['trust']['status']
  main?: string
  dependsOn?: string[]
}): InstalledModule {
  const manifest: CapabilityManifest = {
    id: options.id,
    displayName: options.id,
    version: 1,
    defaultEnabled: true,
    source: 'third-party',
  }
  if (options.main) manifest.entry = { main: options.main }
  if (options.dependsOn) manifest.dependsOn = options.dependsOn
  return {
    manifest,
    moduleRoot: options.moduleRoot,
    trust: { status: options.trust },
  }
}

void main()
